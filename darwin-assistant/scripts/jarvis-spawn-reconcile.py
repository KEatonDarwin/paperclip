#!/usr/bin/env python3
"""JARVIS spawn-task heartbeat reconciler.
Runs every 5 min (systemd timer). Reconciles the spawn_tasks table against live
cockpit run-state, flips stuck/dead workers, captures results, surfaces stuck/failed
via a cockpit notification. Server-owned run-state is the liveness signal (no OS PID
exposed by the API yet). See skills/jarvis-worker-protocol/SKILL.md.
"""
import sqlite3, json, urllib.parse, urllib.request, datetime, sys, os
import re, subprocess

DB = os.environ.get("JARVIS_DB_PATH", "/home/kevin/paperclip/darwin-assistant/jarvis.db")
ENV = os.environ.get("JARVIS_COCKPIT_ENV", "/home/kevin/paperclip/jarvis-command-center/.env")
BASE = os.environ.get("JARVIS_COCKPIT_API_BASE", "http://localhost:3201/api/v1").rstrip("/")
STALE_MINUTES = 25          # running but no progress this long -> stuck
DISPATCH_TIMEOUT_MIN = 15   # never ran (turn_count 0) this long -> failed
RECOVERY_GRACE_MINUTES = 5  # commit-evidence recovery opens just before lease expiry
LOG = "/tmp/jarvis-spawn-reconcile.log"
HOPPER_EXT = re.compile(r"^cockpit:hopper-node-(\d+)-")
OUTCOMES = ("done", "split", "blocked_question", "blocked")
RECOVERY_MARKER = "[recovered from spawn ledger]"
RECOVERY_ERROR_PREFIX = "HOPPER_FINISH_RECOVERY:"
RECOVERY_DEFER_PREFIX = "HOPPER_FINISH_RECOVERY_PENDING:"  # keep the ledger row live; re-evaluate next tick

def key():
    for line in open(ENV):
        if line.startswith("JARVIS_COCKPIT_KEY"):
            return line.split("=", 1)[1].strip().strip('"')
    return ""

KEY = key()

def api_get(path):
    req = urllib.request.Request(BASE + path, headers={"Authorization": "Bearer " + KEY})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

def api_post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
          headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

def notify(sev, title, body):
    try:
        data = json.dumps({"severity": sev, "title": title, "body": body,
                           "source": "spawn-reconciler"}).encode()
        req = urllib.request.Request(BASE + "/notifications", data=data,
              headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        log(f"notify failed: {e}")

def parse_ts(s):
    if not s: return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
        try: return datetime.datetime.strptime(s[:19] if "%H:%M:%S" in fmt else s, fmt)
        except Exception: pass
    try: return datetime.datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S")
    except Exception: return None

def log(msg):
    line = f"{datetime.datetime.utcnow().isoformat()}Z {msg}"
    print(line)
    try:
        with open(LOG, "a") as f: f.write(line + "\n")
    except Exception: pass

# --- Hopper finish recovery -------------------------------------------------
# A Hopper worker can complete its actual work, then fail to send the final
# finish POST. The reconciler is allowed to recover only from visible evidence:
# a well-formed finish JSON payload, or a commit named by the finished worker and
# present on the branch/worktree named in the node spec. It never edits repos.

def row_has(row, key_name):
    return key_name in row.keys()

def find_payload(text):
    """Return the last well-formed {"outcome": ...} object in text, or None."""
    if not text or '"outcome"' not in text:
        return None
    starts = set()
    for m in re.finditer(r'"outcome"', text):
        window = max(0, m.start() - 2000)
        starts.update(i for i, ch in enumerate(text[window:m.start() + 1], window) if ch == "{")
    found = None
    for start in sorted(starts):
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc: esc = False
                elif ch == "\\": esc = True
                elif ch == '"': in_str = False
                continue
            if ch == '"': in_str = True
            elif ch == "{": depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[start:i + 1])
                    except Exception:
                        obj = None
                    if isinstance(obj, dict) and obj.get("outcome") in OUTCOMES and not is_template_payload(obj):
                        if obj["outcome"] != "split" or (isinstance(obj.get("children"), list) and obj["children"]):
                            found = obj
                    break
    return found

def is_template_payload(obj):
    """The worker prompt's finish-contract EXAMPLES are themselves valid JSON
    ({"outcome":"done","result":"<what you did + ...>"}). A worker that restates
    the contract in its final message must not get 'recovered' with a template."""
    for k in ("result", "question"):
        v = obj.get(k)
        if isinstance(v, str):
            t = v.strip()
            if not t or (t.startswith("<") and t.endswith(">")) or "<PAYLOAD>" in t:
                return True
    if obj.get("outcome") in ("done", "blocked") and not isinstance(obj.get("result"), str):
        return True
    if obj.get("outcome") == "blocked_question" and not isinstance(obj.get("question"), str):
        return True
    return False

def append_recovery_marker(payload):
    recovered = json.loads(json.dumps(payload))
    text = (recovered.get("result") or "").strip()
    recovered["result"] = f"{text}\n\n{RECOVERY_MARKER}".strip() if text else RECOVERY_MARKER
    return recovered

def hopper_node_for_spawn(c, row, ext):
    node_id = row["hopper_node_id"] if row_has(row, "hopper_node_id") else None
    if node_id:
        node = c.execute("SELECT * FROM hopper_nodes WHERE id = ?", (node_id,)).fetchone()
        if node:
            return node
    node = c.execute("SELECT * FROM hopper_nodes WHERE worker_thread_ext = ?", (ext,)).fetchone()
    if node:
        return node
    m = HOPPER_EXT.match(ext)
    if m:
        return c.execute("SELECT * FROM hopper_nodes WHERE id = ?", (int(m.group(1)),)).fetchone()
    return None

def worker_text(c, ext, descriptor):
    pieces = []
    latest_summary = descriptor.get("latest_summary") if isinstance(descriptor, dict) else None
    if latest_summary:
        pieces.append(str(latest_summary))
    for t in c.execute("""SELECT content, claude_output FROM turns
                          WHERE conversation_id = (SELECT id FROM conversations WHERE external_id = ?)
                            AND role = 'assistant'
                          ORDER BY turn_index DESC LIMIT 3""", (ext,)).fetchall():
        if t["content"]:
            pieces.append(t["content"])
        if t["claude_output"]:
            pieces.append(t["claude_output"])
    return "\n\n".join(pieces)

def recovery_window_open(node, now):
    expires = parse_ts(node["lease_expires_at"])
    if not expires:
        return False
    return now >= (expires - datetime.timedelta(minutes=RECOVERY_GRACE_MINUTES))

def git_run(repo, args):
    try:
        proc = subprocess.run(["git", "-C", repo, *args], capture_output=True,
                              text=True, timeout=10)
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()

def git_root(path):
    current = path
    if not os.path.exists(current):
        return None
    if os.path.isfile(current):
        current = os.path.dirname(current)
    while current.startswith("/home/kevin"):
        root = git_run(current, ["rev-parse", "--show-toplevel"])
        if root:
            return root
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return None

def discover_git_roots(text):
    roots, seen = [], set()
    for m in re.finditer(r"/home/kevin/[^\s`'\"<>]+", text or ""):
        candidate = m.group(0).rstrip(".,;:)]}")
        root = git_root(candidate)
        if root and root not in seen:
            seen.add(root)
            roots.append(root)
    return roots

def extract_branch_names(text):
    branches, seen = [], set()
    patterns = [
        r"(?:branch|on branch|Commit on|committed on)\s+`?([A-Za-z0-9._/-]+)`?",
        r"\s-b\s+([A-Za-z0-9._/-]+)",
    ]
    for pat in patterns:
        for m in re.finditer(pat, text or "", re.IGNORECASE):
            value = m.group(1).strip().strip("`'\".,;:)]}")
            if not value or value.lower() in ("branch", "the"):
                continue
            if "/" not in value and value not in ("main", "master"):
                continue
            if value not in seen:
                seen.add(value)
                branches.append(value)
    return branches

def extract_commit_tokens(text):
    tokens, seen = [], set()
    for m in re.finditer(r"\b[0-9a-f]{7,40}\b", text or "", re.IGNORECASE):
        token = m.group(0)
        if token not in seen:
            seen.add(token)
            tokens.append(token)
    return tokens[:12]

def normalize_branch_name(line):
    name = line.strip().lstrip("*").strip()
    for prefix in ("remotes/origin/", "origin/"):
        if name.startswith(prefix):
            name = name[len(prefix):]
    return name

def branch_contains(repo, sha, branches):
    out = git_run(repo, ["branch", "--all", "--contains", sha])
    if not out:
        return None
    containing = {normalize_branch_name(line) for line in out.splitlines() if line.strip()}
    if not branches:
        current = git_run(repo, ["branch", "--show-current"])
        return current if current and current in containing else (next(iter(containing)) if containing else None)
    for branch in branches:
        if branch in containing:
            return branch
    return None

def commit_evidence(node, row, text):
    spec_text = "\n\n".join(str(x or "") for x in (node["spec"], row["task_prompt"], text))
    branches = extract_branch_names(spec_text)
    roots = discover_git_roots(spec_text)
    commits = extract_commit_tokens(text)
    if not commits:
        return [], "no finish JSON and no commit sha in final worker output"
    if not roots:
        return [], "commit sha found, but no /home/kevin git repo/worktree path was found in the node spec"
    if not branches:
        return [], "commit sha found, but no branch name was found in the node spec"
    cutoff = max([dt for dt in (parse_ts(node["created_at"]), parse_ts(node["updated_at"])) if dt] or [datetime.datetime.utcfromtimestamp(0)])
    evidence = []
    for root in roots:
        for token in commits:
            full = git_run(root, ["rev-parse", "--verify", f"{token}^{{commit}}"])
            if not full:
                continue
            ts = git_run(root, ["show", "-s", "--format=%ct", full])
            try:
                committed_at = datetime.datetime.utcfromtimestamp(int(ts or "0"))
            except Exception:
                continue
            if committed_at < (cutoff - datetime.timedelta(seconds=120)):
                continue
            branch = branch_contains(root, full, branches)
            if not branch:
                continue
            evidence.append({"repo": root, "branch": branch, "sha": full, "committed_at": committed_at.isoformat() + "Z"})
    if not evidence:
        return [], "commit sha(s) were present, but none resolved to a post-claim commit on the branch named in the node spec"
    return evidence, None

def recover_hopper_finish(c, row, ext, label, descriptor, now):
    node = hopper_node_for_spawn(c, row, ext)
    if not node or node["status"] != "running":
        return None
    # Attempt pin: this spawn row is evidence for ONE attempt. If the node has
    # since expired its lease and been re-leased to a different worker thread,
    # this row's text/commits must never finish the node out from under the
    # live attempt (the engine's finish route only checks status=running, so
    # without this pin a stale attempt could complete a re-attempted node).
    if node["worker_thread_ext"] != ext:
        log(f"  {label}: node {node['id']} is now leased to {node['worker_thread_ext']}; stale attempt {ext} — no recovery")
        return None
    text = worker_text(c, ext, descriptor)
    payload = find_payload(text)
    if payload:
        recovered = append_recovery_marker(payload)
        recovered["worker_thread_ext"] = ext
        api_post(f"/hopper-nodes/{node['id']}/finish", recovered)
        log(f"  {label}: recovered finish JSON for node {node['id']} (outcome={recovered['outcome']})")
        return None
    if not recovery_window_open(node, now):
        return f"{RECOVERY_DEFER_PREFIX} no finish JSON yet; commit-evidence recovery waits until node {node['id']} is within {RECOVERY_GRACE_MINUTES}m of lease expiry"
    evidence, reason = commit_evidence(node, row, text)
    if not evidence:
        return f"{RECOVERY_ERROR_PREFIX} {reason}"
    lines = [
        f"Recovered completion from spawn ledger for node {node['id']}.",
        f"Worker thread: {ext}",
        "Commit evidence:",
        *[f"- {e['sha']} on {e['branch']} in {e['repo']} ({e['committed_at']})" for e in evidence],
        "",
        RECOVERY_MARKER,
    ]
    api_post(f"/hopper-nodes/{node['id']}/finish",
             {"outcome": "done", "result": "\n".join(lines), "worker_thread_ext": ext})
    log(f"  {label}: recovered node {node['id']} from commit evidence ({len(evidence)} commit(s))")
    return None

def main():
    now = datetime.datetime.utcnow()
    c = sqlite3.connect(DB, timeout=15, isolation_level=None)
    c.row_factory = sqlite3.Row
    rows = c.execute("SELECT * FROM spawn_tasks WHERE status IN ('running','stuck')").fetchall()
    log(f"reconcile start: {len(rows)} active worker(s)")
    for row in rows:
        ext = row["thread_ext"]; prev = row["status"]
        try:
            d = api_get("/threads/" + urllib.parse.quote(ext, safe=""))
        except Exception as e:
            log(f"  {row['label']}: descriptor fetch failed ({e}) — leaving as-is"); continue
        running = bool(d.get("running"))
        turns = d.get("turn_count") or 0
        upd = parse_ts(d.get("updated_at"))
        created = parse_ts(row["created_at"]) or now
        new_status, result, error = prev, None, None
        if running:
            new_status = "running"
            if upd and (now - upd).total_seconds() > STALE_MINUTES * 60 and turns <= (row["turn_count"] or 0):
                new_status = "stuck"; error = f"no progress >{STALE_MINUTES}m while running"
        else:
            if turns >= 1:
                new_status = "done"
                result = d.get("latest_summary") or f"completed (turn_count={turns}); open thread for detail"
                if row_has(row, "hopper_node_id") or HOPPER_EXT.match(ext):
                    try:
                        recovery_note = recover_hopper_finish(c, row, ext, row["label"], d, now)
                        if recovery_note:
                            error = recovery_note
                            log(f"  {row['label']}: {recovery_note}")
                            if recovery_note.startswith(RECOVERY_DEFER_PREFIX):
                                # Deferred (lease not near expiry yet): keep the
                                # ledger row live so the next tick re-evaluates.
                                # Marking it done here would make the deferral
                                # permanent — the query only revisits running/stuck.
                                new_status = prev
                    except Exception as e:
                        error = f"{RECOVERY_ERROR_PREFIX} finish recovery failed: {e}"
                        log(f"  {row['label']}: {error}")
            elif (now - created).total_seconds() > DISPATCH_TIMEOUT_MIN * 60:
                new_status = "failed"; error = f"never processed (turn_count=0) after {DISPATCH_TIMEOUT_MIN}m"
            else:
                new_status = "running"  # young, give it time
        c.execute("""UPDATE spawn_tasks SET status=?, turn_count=?, last_seen_running=?,
                     result=COALESCE(?,result), error=COALESCE(?,error),
                     updated_at=datetime('now'), last_heartbeat=datetime('now') WHERE id=?""",
                  (new_status, turns, 1 if running else 0, result, error, row["id"]))
        log(f"  {row['label']}: {prev} -> {new_status} (running={running}, turns={turns})")
        if new_status in ("stuck", "failed") and prev not in ("stuck", "failed"):
            notify("warning", f"Worker {new_status}: {row['label']}",
                   f"{error or ''} — thread {ext} (parent {row['parent_thread_ext']})")
    c.commit(); c.close()
    log("reconcile done")

if __name__ == "__main__":
    main()
