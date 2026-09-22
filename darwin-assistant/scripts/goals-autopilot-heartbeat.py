#!/usr/bin/env python3
"""Goals Autopilot — HAND-RUN heartbeat (v0, 2026-09-21) until the server driver
(src/goals-autopilot.ts, tree-a2a9e6b2) deploys. Usage: goals-autopilot-heartbeat.py <goal_id>
Computes ONE deterministic next action from the goal tree (AUTOPILOT.md §2.3 order) and posts a
cue into cockpit:goal-<id> so JARVIS takes the turn. Zero model calls here. Stop: touch /tmp/goals-autopilot.stop
Log: /tmp/goals-autopilot-heartbeat.log"""
import json, os, sys, urllib.request, urllib.parse, datetime
GOAL = int(sys.argv[1]); PARALLEL = int(os.environ.get('AP_PARALLEL', '1')); MAX_DEPTH = int(os.environ.get('AP_MAX_DEPTH', '4'))
BUILD_MODEL = os.environ.get('AP_BUILD_MODEL', 'claude-sonnet-5'); VERIFY_MODEL = os.environ.get('AP_VERIFY_MODEL', 'claude-opus-5')
KEY = open('/home/kevin/paperclip/jarvis-command-center/.env').read().split('JARVIS_COCKPIT_KEY=')[1].split('\n')[0].strip()
LOG = open('/tmp/goals-autopilot-heartbeat.log', 'a')
def log(m):
    LOG.write(f"{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} goal {GOAL}: {m}\n"); LOG.flush(); print(m)
def api(path, body=None):
    req = urllib.request.Request('http://localhost:3201/api/v1' + path, data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}, method='POST' if body is not None else 'GET')
    return json.load(urllib.request.urlopen(req, timeout=30))
if os.path.exists('/tmp/goals-autopilot.stop'): log('stop file present — skip'); sys.exit(0)
gov = api('/hopper-engine/governor')
if not gov.get('providers', {}).get('claude', gov).get('allow', True):
    log(f"governor hold ({gov.get('reason')}) — skip"); sys.exit(0)
ext = f'cockpit:goal-{GOAL}'
th = api('/threads/' + urllib.parse.quote(ext, safe=''))
if th.get('running'): log('goal chat mid-turn — skip'); sys.exit(0)
d = api(f'/goals/{GOAL}'); g = d['goal']; nodes = [n for n in d['nodes'] if n['state'] != 'discarded']
by_parent = {}
for n in nodes: by_parent.setdefault(n['parent_id'], []).append(n)
for k in by_parent: by_parent[k].sort(key=lambda n: (n.get('sort_order', 0), n['id']))
def dfs(pid=None, depth=1):
    for n in by_parent.get(pid, []):
        n['_depth'] = depth; yield n
        yield from dfs(n['id'], depth + 1)
order = list(dfs())
kids = lambda n: by_parent.get(n['id'], [])
def settled(n): return n['state'] in ('done', 'parked') or n['leaf_kind'] == 'human'
def earlier_siblings_settled(n):
    sibs = by_parent.get(n['parent_id'], [])
    return all(settled(s) for s in sibs[:sibs.index(n)])
def ancestors_clear(n):
    cur = n
    while cur['parent_id'] is not None:
        parent = next(x for x in nodes if x['id'] == cur['parent_id'])
        if not earlier_siblings_settled(parent): return False
        cur = parent
    return True
def path(n):
    p = []; cur = n
    while cur is not None:
        p.append(f"#{cur['id']} {cur['title']}"); cur = next((x for x in nodes if x['id'] == cur['parent_id']), None)
    return ' › '.join(reversed(p))
working = [n for n in order if n['state'] == 'working']
action = None
for n in order:
    if n['state'] == 'check' and n['leaf_kind'] == 'machine': action = ('verify', n); break
for n in order:
    if n['state'] == 'working' and n.get('tree_status_cache') == 'blocked': action = ('unblock', n); break
if action is None and len(working) < PARALLEL:
    for n in order:
        if n['state'] != 'set' or not (earlier_siblings_settled(n) and ancestors_clear(n)): continue
        if n['leaf_kind'] == 'machine' and n.get('plan_state') == 'none': action = ('plan', n); break
        if n['leaf_kind'] == 'none' and not kids(n): action = ('decompose' if n['_depth'] < MAX_DEPTH else 'classify', n); break
awaiting = [n for n in order if n.get('review_state') == 'awaiting_jarvis']
if action is None and not working and not any(n['state'] in ('ghost', 'check') for n in order):
    action = ('wrap', None)
if action is None:
    log(f"nothing to cue (working={[n['id'] for n in working]})"); sys.exit(0)
act, n = action
key = f"autopilot:{GOAL}:{act}:{n['id'] if n else 'root'}"
last = open('/tmp/goals-autopilot-last-cue').read().strip() if os.path.exists('/tmp/goals-autopilot-last-cue') else ''
if last == key and act != 'wrap':
    # same action re-cued: allow only if the last cue is older than 45 min (turn may have died)
    age = datetime.datetime.now().timestamp() - os.path.getmtime('/tmp/goals-autopilot-last-cue')
    if age < 45 * 60: log(f"dedupe {key} ({int(age/60)}m old) — skip"); sys.exit(0)
now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M %Z')
head = f"🌙 AUTOPILOT CUE (automated heartbeat, {now}) — goal #{GOAL} is on AUTOPILOT (Kevin's 2026-09-21 directive, read skills/goals/AUTOPILOT.md §4 + §7). Kevin is asleep: NEVER ask him anything, never end on a question — if something truly needs him, `park` the node with a `log` line and move on. Do ONLY the action below, reply in ≤4 lines, then a `log` op with your one-sentence decision.\n"
rules = {
 'decompose': lambda n: f"ACTION: DECOMPOSE {path(n)}\n  done_means: {n.get('done_means')}\n  notes: {n.get('notes') or '-'}\nPropose 2–6 children under #{n['id']} (`propose` with parent_id {n['id']}), IN EXECUTION ORDER, each with a stranger-verifiable one-line done_means and `notes` = the exact instructions a sonnet worker needs (files, commands, acceptance). Then, because this goal is on autopilot, `accept` your own batch (batch_id from the propose result) in the SAME turn, and `set_leaf_kind` (machine|human) on every child you can classify now. Push back internally: only children that serve the parent's done_means.",
 'classify': lambda n: f"ACTION: CLASSIFY {path(n)} (max depth reached)\n  done_means: {n.get('done_means')}\nCall `set_leaf_kind` machine if you can write a self-contained spec, human if only Kevin can do it, else `park` with a reason.",
 'plan': lambda n: f"ACTION: PLAN + DISPATCH {path(n)}\n  done_means: {n.get('done_means')}\n  notes: {n.get('notes') or '-'}\n  attempts so far: (see log)\n`propose_plan` with ≤6 flat nodes, adapter claude, builds on {BUILD_MODEL} (mechanical steps claude-haiku-4-5), specs self-contained for a worker with no chat context, worktree/branch named explicitly, never fable/gpt-6-astra. THE LAST NODE MUST BE A VERIFY NODE on {VERIFY_MODEL} depending on all build nodes: spec = 'Independently verify this done_means: \"{n.get('done_means')}\". Read the build nodes' results + the branch; run/query/hit whatever proves it. NEVER fix anything. Your result MUST start with a first line `VERDICT: PASS` or `VERDICT: FAIL`, then `evidence:` and `gaps:` blocks.' Then call `dispatch` {{node_id: {n['id']}}} in the same turn (autopilot allowance).",
 'verify': lambda n: f"ACTION: VERIFY {path(n)}\n  done_means: {n.get('done_means')}\n  tree: {n.get('tree_id')}\nRead the tree's nodes (GET /api/v1/hopper-trees/{n.get('tree_id')} via curl with the cockpit key, or the goals tool's tree overlay) — find the VERIFY node's result line `VERDICT: PASS|FAIL` + evidence/gaps. PASS → `verify` {{node_id: {n['id']}, passed: true, note: <evidence in one line>}}. FAIL (or no verdict line) → `verify` {{passed: false, note: <gaps>}} and, if this node has been re-planned fewer than 2 times (check the goal `log` lines), immediately `propose_plan` again with the gaps fixed in the specs + the VERIFY node, then `dispatch`; otherwise `park` it with the gaps as the reason.",
 'unblock': lambda n: f"ACTION: UNBLOCK {path(n)}\n  tree: {n.get('tree_id')}\nRead the blocked hopper node's block reason + its worker thread's last turn. If you can fix it (reroute model, patch the spec, answer a blocked_question yourself from what you know) — do it via the hopper-node routes and re-pend the node. If it genuinely needs Kevin → `park` the goal node with the reason.",
}
if act == 'wrap':
    body = ("ACTION: WRAP THE NIGHT. Nothing is runnable and nothing is working. Write the night report to the wiki at outbox/goals/autopilot-" + str(GOAL) + "-" + datetime.date.today().isoformat() + ".md (write_wiki_page) with sections: Plan (the tree as you shaped it, 🌙 on self-set nodes) · What ran (each leaf: plan summary, tree id, attempts, VERDICT + evidence, wall time) · What's waiting on Kevin (human leaves, parked nodes + reasons, his edits awaiting weigh-in) · Where it stopped and why · Your own read of how execution went vs the plan. Post the same markdown as your reply so Kevin reads it here first thing, and propose (do NOT call) `verify {goal:true}` if every node is done. Then touch /tmp/goals-autopilot.stop via the `log` op text 'autopilot: wrapped' (JARVIS cannot touch files — the next heartbeat sees the wrap log and stops).")
else:
    body = rules[act](n)
if awaiting: body += "\n\nALSO (Kevin edited these during the night, weigh in with `accept`/`push_back`): " + ', '.join(f"#{x['id']}" for x in awaiting)
text = head + body
if os.environ.get('AP_DRY'): print('DRY', key); print(text); sys.exit(0)
r = api('/threads/' + urllib.parse.quote(ext, safe='') + '/messages', {'text': text})
open('/tmp/goals-autopilot-last-cue', 'w').write(key)
log(f"cued {key} → message {r.get('message_id')}")
