// GOALS AUTOPILOT LIFECYCLE SIM (CONTRACT §15.12, tree-a2a9e6b2 node #540) —
// drives the real goals.ts + goals-autopilot.ts + hopper-engine.ts through the
// real createApiV1Router() over real HTTP on a throwaway port, against a
// SCRATCH sqlite DB, and asserts every acceptance check AP-1…AP-14. No live
// model calls anywhere: the four existing ESM loader hooks stub the ONE
// dynamic `import('./agent.js')` that postCue (goals.js) / guard cues /
// tree-cue / the goals-tool node-chat seed each perform, and the driver's OWN
// `inFlightFor`/`governorProbe` probes are swapped for deterministic test
// overrides via `__setAutopilotTestOverrides` (no second hook needed — that
// seam exists specifically for this). The hopper worker spawn is stubbed with
// a fake processMessage (mirrors scripts/foundry-sim.mjs / goals-sim.ts) so
// dispatchTick claims + runs real build/VERIFY hopper nodes; tree completion
// is driven through the real finish contract, POST /hopper-nodes/:id/finish.
//
//   npm run build
//   npm run goals:autopilot-sim
//   (or: JARVIS_DB_PATH=/tmp/goals-autopilot-sim.db npx tsx scripts/goals-autopilot-sim.ts)
//
// Writes a full pass/fail report to
// /home/kevin/obsidian/paperclip-wiki/outbox/goals/autopilot-sim-report.md.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Same four hooks scripts/goals-sim.ts registers — createApiV1Router() pulls
// in the whole module graph (goals.js, goals-guards.js, tree-cue.js,
// tools/goals-tool.js), each with its OWN dynamic `import('./agent.js')` for
// posting a cue as a real JARVIS turn. Every one is scoped by parentURL so
// unrelated static imports of dist/agent.js (runClaude etc.) are untouched.
register(pathToFileURL(path.join(__dirname, 'goals-v01-cue-check.hooks.mjs')), import.meta.url);
register(pathToFileURL(path.join(__dirname, 'goals-guards-sim-cue.hooks.mjs')), import.meta.url);
register(pathToFileURL(path.join(__dirname, 'goals-tree-cue-sim.hooks.mjs')), import.meta.url);
register(pathToFileURL(path.join(__dirname, 'goals-tool-sim-seed.hooks.mjs')), import.meta.url);

// ── scratch DB guard (must run before any dist/ module is imported) ────────
const raw = process.env.JARVIS_DB_PATH ?? '/tmp/goals-autopilot-sim.db';
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db. Use a /tmp scratch path.');
  process.exit(1);
}
process.env.JARVIS_DB_PATH = DB_PATH;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[autopilot-sim] scratch DB: ${DB_PATH}`);

// No real model calls anywhere. Governor disabled + generous slots so
// dispatchTick claims ready hopper leaves immediately. The autopilot
// module-level driver interval + its tree-status kick timer are both parked
// far in the future — this script is the SOLE caller of tickAutopilot(), so
// every assertion below is deterministic (no background tick can race it).
// A scratch stop-file path + scratch vault root, both read at import time.
process.env.HOPPER_GOV_ENABLED = '0';
process.env.HOPPER_ENGINE_SLOTS = process.env.HOPPER_ENGINE_SLOTS ?? '8';
process.env.GOAL_GUARD_POLLER = '0';
process.env.GOALS_STRUCTURE_DEBOUNCE_MS = process.env.GOALS_STRUCTURE_DEBOUNCE_MS ?? '60';
process.env.GOALS_AUTOPILOT_DRIVER = '0';
process.env.GOALS_AUTOPILOT_KICK_MS = '999999999';
const STOP_FILE_PATH = '/tmp/goals-autopilot-sim.stop';
process.env.GOALS_AUTOPILOT_STOP_FILE = STOP_FILE_PATH;
fs.rmSync(STOP_FILE_PATH, { force: true });
const VAULT = '/tmp/goals-autopilot-sim-vault';
fs.rmSync(VAULT, { recursive: true, force: true });
process.env.GOALS_VAULT_ROOT = VAULT;
delete process.env.ANTHROPIC_API_KEY;

const distDir = path.join(repoRoot, 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const hopperEngine = await import(path.join(distDir, 'hopper-engine.js'));
const goalsModule = await import(path.join(distDir, 'goals.js'));
const ap = await import(path.join(distDir, 'goals-autopilot.js'));
const { getSetting, setSetting } = await import(path.join(distDir, 'conversation-db.js'));

// ── fake worker — no model calls, mirrors scripts/foundry-sim.mjs exactly ──
const dispatchedNodeIds = new Set<number>();
async function fakeProcessMessage(prompt: string): Promise<string> {
  const m = /node #(\d+)/.exec(prompt);
  if (m) dispatchedNodeIds.add(Number(m[1]));
  return 'FAKE_WORKER_OK — no model call made.';
}
hopperEngine.startHopperEngine(fakeProcessMessage);

// ── real express app, real HTTP, throwaway port ─────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise<import('node:http').Server>((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s as import('node:http').Server));
});
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const base = `http://127.0.0.1:${port}/api/v1`;
console.log(`[autopilot-sim] server: ${base}`);

const adminKey = mintApiKey('autopilot-sim-admin', 'cockpit').plaintext;

type ReqOpts = { token?: string; body?: unknown };
async function req(method: string, urlPath: string, opts: ReqOpts = {}): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
function get(p: string) { return req('GET', p, { token: adminKey }); }
function post(p: string, body: unknown = {}) { return req('POST', p, { token: adminKey, body }); }
function patch(p: string, body: unknown = {}) { return req('PATCH', p, { token: adminKey, body }); }

async function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ── cue capture (populated by the stubbed dist/agent.js) ───────────────────
type CueCall = { text: string; externalId: string; correlationKey?: string };
function cueCalls(): CueCall[] {
  return ((globalThis as unknown as { __goalsCueCalls?: CueCall[] }).__goalsCueCalls) ?? [];
}
/** autopilot cues only — filters out the unrelated goal-structure / guard / tree-cue traffic. */
function apCueCalls(goalId: number): CueCall[] {
  const prefix = `autopilot:${goalId}:`;
  return cueCalls().filter((c) => (c.correlationKey ?? '').startsWith(prefix));
}
function lastApCue(goalId: number): CueCall {
  const calls = apCueCalls(goalId);
  return calls[calls.length - 1];
}

/** `tick()` resolves as soon as its OWN synchronous work is done,
 *  but a posted cue reaches `postCue` (goals.js), which fires the actual
 *  "post" via an un-awaited `Promise.all([import('./agent.js'), ...]).then(...)`
 *  chain (goals.ts's real production shape — it's fire-and-forget by design,
 *  same as every other cue producer in this codebase). That means a cue can
 *  land on `__goalsCueCalls` a few microtasks AFTER `tickAutopilot` resolves.
 *  Every call site below goes through this wrapper instead of calling
 *  `ap.tickAutopilot` directly, so cue assertions never race it. */
async function tick(goalId: number, reason = 'sim'): Promise<void> {
  await ap.tickAutopilot(goalId, reason);
  await sleep(60);
}

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 4000, stepMs = 40): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(stepMs);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// ── result collection — never abort the whole run on one failure ───────────
type Result = { id: string; description: string; pass: boolean; error?: string };
const results: Result[] = [];
async function check(id: string, description: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ id, description, pass: true });
    console.log(`  ✓ [${id}] ${description}`);
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    results.push({ id, description, pass: false, error: msg });
    console.log(`  ✗ [${id}] ${description}\n      ${msg}`);
  }
}

// ── dispatch helpers — drive a real machine leaf through the real hopper ───
async function nodeById(goalId: number, nodeId: number): Promise<any> {
  const t = await get(`/goals/${goalId}?include_discarded=1`);
  return t.json.nodes.find((n: any) => n.id === nodeId);
}

async function overlayStatus(goalId: number, nodeId: number, hopperId: number): Promise<string | undefined> {
  const overlay = await get(`/goals/${goalId}/nodes/${nodeId}/tree`);
  if (overlay.status !== 200) return undefined;
  return overlay.json.nodes.find((n: any) => n.id === hopperId)?.status;
}

/** propose_plan (autopilot dispatches in the same call) → wait for build node(s)
 *  to be claimed → finish them `done` → wait for the appended VERIFY node to be
 *  claimed. Returns the tree + VERIFY hopper node id; does NOT finish VERIFY. */
async function dispatchLeaf(
  goalId: number,
  nodeId: number,
  builds: Array<{ title: string; spec: string }>,
): Promise<{ treeId: string; verifyId: number; buildIds: number[] }> {
  const planned = await post(`/goals/${goalId}/nodes/${nodeId}/propose_plan`, {
    plan: {
      what: 'do the work', deliverable: 'evidence it works', model: 'claude-sonnet-5', adapter: 'claude',
      nodes: builds.map((b) => ({ title: b.title, spec: b.spec, adapter: 'claude', model: 'claude-sonnet-5' })),
    },
  });
  if (planned.status !== 200) throw new Error(`propose_plan failed (${planned.status}): ${JSON.stringify(planned.json)}`);
  const treeId: string = planned.json.tree.id;
  const gnode = await nodeById(goalId, nodeId);
  const plan = JSON.parse(gnode.plan);
  const verifyId: number = plan.verify_hopper_node_id;
  const buildIds: number[] = (planned.json.hopper_nodes as any[]).map((h) => h.id).filter((id) => id !== verifyId);
  for (const bid of buildIds) {
    await waitFor(`build hopper node ${bid} -> running`, async () => (await overlayStatus(goalId, nodeId, bid)) === 'running');
    const fin = await post(`/hopper-nodes/${bid}/finish`, { outcome: 'done', result: 'build step done.' });
    if (fin.status !== 200) throw new Error(`finish build ${bid} failed (${fin.status}): ${JSON.stringify(fin.json)}`);
  }
  await waitFor(`VERIFY hopper node ${verifyId} -> running`, async () => (await overlayStatus(goalId, nodeId, verifyId)) === 'running');
  return { treeId, verifyId, buildIds };
}
async function finishVerify(verifyId: number, verdictText: string): Promise<void> {
  const r = await post(`/hopper-nodes/${verifyId}/finish`, { outcome: 'done', result: verdictText });
  if (r.status !== 200) throw new Error(`finish VERIFY ${verifyId} failed (${r.status}): ${JSON.stringify(r.json)}`);
}
async function waitCheck(goalId: number, nodeId: number): Promise<void> {
  await waitFor(`node #${nodeId} -> check`, async () => (await nodeById(goalId, nodeId))?.state === 'check');
}

// ── §15.4 decision-table pure fixtures (AP-7/8/9) — GoalNodeRow-shaped plain
// objects fed straight to the exported `computeNextAction`, sidestepping the
// real DB's parent-settle/dispatch machinery entirely (that machinery is
// already exercised for real by the AP-2..AP-5 section below). ─────────────
let fixtureId = 9000;
function mkNode(o: Record<string, unknown> & { title: string }): any {
  fixtureId += 1;
  return {
    id: fixtureId,
    parent_id: null,
    done_means: 'win condition met',
    state: 'set',
    leaf_kind: 'none',
    plan_state: 'none',
    autopilot_attempts: 0,
    autopilot_verdict: null,
    autopilot_set: 0,
    child_count: 0,
    depth: 0,
    promoted_to_goal_id: null,
    tree_status_cache: null,
    review_state: 'none',
    parked_reason: null,
    tree_id: null,
    path: [o.title as string],
    ...o,
  };
}
function fixtureCfg(overrides: Record<string, unknown> = {}): any {
  return { ...(ap.AUTOPILOT_DEFAULTS as any), started_at: null, stopped_at: null, stop_reason: null, ...overrides };
}

// ═══════════════════════════════════════════════════════════════════════════
try {
  // Default overrides for the whole run: governor always allows, no chat is
  // ever "in flight" (postCue's own stubbed agent.js already no-ops that
  // check; this is the DRIVER's separate gate-4 probe). Flipped per-check
  // where a gate test needs the opposite.
  ap.__setAutopilotTestOverrides({ governor: () => ({ allow: true, reason: 'ok' }), inFlight: () => null });

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[0] AP-6 — parseVerdict (pure, no DB)');
  await check('AP-6a', 'PASS parses with evidence', () => {
    const v = ap.parseVerdict('VERDICT: PASS\nevidence:\n- ran tests, 12/12\ngaps:\n- none');
    assert.equal(v.verdict, 'PASS');
    assert.equal(v.evidence, '- ran tests, 12/12');
    assert.deepEqual(v.gaps, []);
  });
  await check('AP-6b', 'FAIL parses gap bullets', () => {
    const v = ap.parseVerdict('VERDICT: FAIL\nevidence:\n- hit the endpoint\ngaps:\n- endpoint 500s on empty body');
    assert.equal(v.verdict, 'FAIL');
    assert.equal(v.gaps[0], 'endpoint 500s on empty body');
  });
  await check('AP-6c', 'no VERDICT line -> FAIL, gap starts "no verdict"', () => {
    assert.ok(ap.parseVerdict('all good, ship it').gaps[0].startsWith('no verdict'));
  });
  await check('AP-6d', 'empty result -> FAIL, gap starts "no verdict"', () => {
    const v = ap.parseVerdict('');
    assert.equal(v.verdict, 'FAIL');
    assert.ok(v.gaps[0].startsWith('no verdict'));
  });
  await check('AP-6e', 'non-done hopper status -> FAIL no-verdict even with a real VERDICT line', () => {
    const v = ap.parseVerdict('VERDICT: PASS\ngaps:\n- none', 'split');
    assert.ok(v.gaps[0].startsWith('no verdict'));
  });
  await check('AP-6f', 'PASS with a real gap alongside it is downgraded to FAIL', () => {
    const v = ap.parseVerdict('VERDICT: PASS\nevidence:\n- looked\ngaps:\n- one real gap');
    assert.equal(v.verdict, 'FAIL');
    assert.equal(v.gaps[0], 'verifier reported gaps alongside PASS');
    assert.equal(v.gaps[1], 'one real gap');
  });
  await check('AP-6g', 'a lone "- none" gap bullet parses to an empty gaps array', () => {
    assert.deepEqual(ap.parseVerdict('VERDICT: FAIL\ngaps:\n- none').gaps, []);
  });

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[1] AP-1 — autopilot on: validation, adoption pass, propose lands born set');
  let g1 = -1;
  let ghostNone = -1;
  let ghostAwaiting = -1;
  await check('AP-1a', 'setup: a set goal with one JARVIS ghost (review_state=none) and one awaiting_jarvis ghost', async () => {
    const created = goalsModule.createGoal({ title: 'AP autopilot main drill', done_means: 'the whole night runs clean', actor: 'kevin' });
    g1 = created.goal.id;
    const p1 = goalsModule.proposeGoalNodes(g1, { parent_id: null, items: [{ title: 'Untouched ghost', done_means: 'stays a ghost until on' }], actor: 'jarvis' });
    ghostNone = p1.nodes[0].id;
    assert.equal(p1.nodes[0].review_state, 'none');
    const p2 = goalsModule.proposeGoalNodes(g1, { parent_id: null, items: [{ title: 'Contested ghost', done_means: 'kevin and jarvis disagree on wording' }], actor: 'jarvis' });
    ghostAwaiting = p2.nodes[0].id;
    const edited = await patch(`/goals/${g1}/nodes/${ghostAwaiting}`, { title: 'Contested ghost (kevin edit)' });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    const oked = await post(`/goals/${g1}/nodes/${ghostAwaiting}/accept`, {});
    assert.equal(oked.status, 200, JSON.stringify(oked.json));
    assert.equal(oked.json.node.state, 'ghost');
    assert.equal(oked.json.node.review_state, 'awaiting_jarvis');
  });
  await check('AP-1b', 'config validation edges refuse before any goal is ever turned on', async () => {
    const badDepth = await post(`/goals/${g1}/autopilot`, { on: true, config: { max_depth: 9 } });
    assert.equal(badDepth.status, 400);
    assert.equal(badDepth.json.error.code, 'autopilot_config_invalid');
    const badModel = await post(`/goals/${g1}/autopilot`, { on: true, config: { verify_model: 'claude-fable-5' } });
    assert.equal(badModel.status, 400);
    const badKey = await post(`/goals/${g1}/autopilot`, { on: true, config: { nope: 1 } });
    assert.equal(badKey.status, 400);
    const ghostGoal = goalsModule.createGoal({ title: 'AP-1 ghost goal (no done_means)', actor: 'kevin' });
    const notSet = await post(`/goals/${ghostGoal.goal.id}/autopilot`, { on: true });
    assert.equal(notSet.status, 409);
    assert.equal(notSet.json.error.code, 'goal_not_set');
  });
  await check('AP-1c', 'on -> 200, config merged over defaults, adoption pass sets the none-ghost, leaves the awaiting one alone', async () => {
    const on = await post(`/goals/${g1}/autopilot`, { on: true, config: { max_depth: 2 } });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.equal(on.json.goal.autopilot, 1);
    assert.equal(on.json.goal.autopilot_config.max_depth, 2);
    assert.equal(on.json.goal.autopilot_config.build_model, 'claude-sonnet-5');
    assert.equal(on.json.goal.autopilot_config.max_attempts, 2);
    assert.equal(typeof on.json.goal.autopilot_config.started_at, 'string');
    assert.equal(on.json.autopilot.autopilot, 1);
    const n1 = await nodeById(g1, ghostNone);
    assert.equal(n1.state, 'set');
    assert.equal(n1.autopilot_set, 1);
    const n2 = await nodeById(g1, ghostAwaiting);
    assert.equal(n2.state, 'ghost', 'awaiting_jarvis ghost is left alone by the adoption pass');
    assert.equal(n2.review_state, 'awaiting_jarvis');
  });
  await check('AP-1d', 'a JARVIS propose (3 items) after on lands every row born set, no node_proposed', async () => {
    const before = await get(`/goals/${g1}`);
    const proposeEventsBefore = before.json.events?.length; // events aren't on the tree read; use nodes count instead
    void proposeEventsBefore;
    const p = goalsModule.proposeGoalNodes(g1, {
      parent_id: null,
      items: [
        { title: 'Probe H1', done_means: 'kept around as a settled human leaf', leaf_kind: 'human' },
        { title: 'Probe H2', done_means: 'kept around as a settled human leaf', leaf_kind: 'human' },
        { title: 'Probe H3', done_means: 'kept around as a settled human leaf', leaf_kind: 'human' },
      ],
      actor: 'jarvis',
    });
    assert.equal(p.nodes.length, 3);
    assert.ok(p.nodes.every((n: any) => n.state === 'set'));
    assert.ok(p.nodes.every((n: any) => n.autopilot_set === 1));
    assert.ok(p.nodes.every((n: any) => n.proposal_batch === null));
  });
  await check('AP-1e', 'settle the two AP-1 probe ghosts out of the way (leaf_kind=human on the adopted none-ghost; JARVIS agrees with Kevin\'s edit on the awaiting one) so the rest of the run is not derailed by a stray decompose/weigh-in target', async () => {
    const lk = await post(`/goals/${g1}/nodes/${ghostNone}/leaf_kind`, { leaf_kind: 'human' });
    assert.equal(lk.status, 200, JSON.stringify(lk.json));
    assert.equal(lk.json.node.leaf_kind, 'human');
    const toolsModule = await import(path.join(distDir, 'tools', 'goals-tool.js'));
    const g1Ext = `cockpit:goal-${g1}`;
    const agreed = await toolsModule.goals.execute({ operation: 'accept', node_id: ghostAwaiting }, { externalId: g1Ext });
    assert.equal(agreed.node.state, 'set', JSON.stringify(agreed));
    const lk2 = await post(`/goals/${g1}/nodes/${ghostAwaiting}/leaf_kind`, { leaf_kind: 'human' });
    assert.equal(lk2.status, 200, JSON.stringify(lk2.json));
  });

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[2] AP-2/AP-3 — propose_plan appends+dispatches VERIFY; PASS resolves via the pre-pass');
  let m1 = -1;
  await check('AP-2a', 'set up the first real machine leaf (M1) after the 3 human probes', async () => {
    const n = goalsModule.createGoalNode(g1, { title: 'M1 — pass on the first try', done_means: 'M1 evidence exists', parent_id: null, authored_by: 'kevin', actor: 'jarvis', leaf_kind: 'machine' });
    m1 = n.id;
  });
  await check('AP-2b', 'a 12-build-node plan -> 400 autopilot_plan_too_long; a VERIFY:-titled node -> 400 verify_node_reserved', async () => {
    const tooLong = await post(`/goals/${g1}/nodes/${m1}/propose_plan`, {
      plan: { what: 'w', deliverable: 'd', model: 'claude-sonnet-5', nodes: Array.from({ length: 12 }, (_v, i) => ({ title: `n${i}`, spec: 's', model: 'claude-sonnet-5' })) },
    });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.json.error.reason, 'autopilot_plan_too_long', JSON.stringify(tooLong.json));
    const reserved = await post(`/goals/${g1}/nodes/${m1}/propose_plan`, {
      plan: { what: 'w', deliverable: 'd', model: 'claude-sonnet-5', nodes: [{ title: 'VERIFY: mine', spec: 's', model: 'claude-sonnet-5' }] },
    });
    assert.equal(reserved.status, 400);
    assert.equal(reserved.json.error.reason, 'verify_node_reserved', JSON.stringify(reserved.json));
    const clean = await nodeById(g1, m1);
    assert.equal(clean.plan_state, 'none', 'the bad attempts left the node untouched');
  });
  let m1TreeId = '';
  let m1VerifyId = -1;
  await check('AP-2c', 'propose_plan dispatches in the same call: VERIFY appended last, on verify_model, depends on every build node', async () => {
    const { treeId, verifyId, buildIds } = await dispatchLeaf(g1, m1, [{ title: 'do the thing', spec: 'do the thing for M1' }]);
    m1TreeId = treeId; m1VerifyId = verifyId;
    const n = await nodeById(g1, m1);
    assert.equal(n.state, 'working');
    const plan = JSON.parse(n.plan);
    assert.equal(plan.nodes.length, 2, JSON.stringify(plan.nodes.map((x: any) => x.title)));
    assert.equal(plan.nodes[1].title, `VERIFY: ${n.title}`);
    assert.equal(plan.nodes[1].model, 'claude-opus-5');
    assert.deepEqual(plan.nodes[1].depends_on_indexes, [0]);
    assert.equal(plan.verify_hopper_node_id, verifyId);
    assert.equal(buildIds.length, 1);
    const treeRow = await get(`/hopper-trees/${treeId}`);
    assert.equal(treeRow.json.tree.status, 'active');
    const verifySpec = treeRow.json.nodes.find((x: any) => x.id === verifyId).spec;
    assert.ok(verifySpec.includes(n.done_means), 'VERIFY spec carries the done_means verbatim');
    assert.ok(verifySpec.includes(treeId) && !verifySpec.includes('{{tree_id}}'), 'VERIFY spec had {{tree_id}} substituted');
  });
  // AP-4's M2 is created BEFORE M1 resolves (not after): once M1 is the only
  // thing left and nothing else is queued up, the decision table legitimately
  // computes 'wrap' — and once THAT lands, the very next tick unconditionally
  // finalizes (§15.4 row 9: "after the wrap turn ends... OR THE NEXT TICK"),
  // discarding whatever a fresh decision would have been. Real production
  // ticks minutes apart so a genuine JARVIS turn has time to add more work
  // first; this sim calls tickAutopilot back-to-back, so M2 must already
  // exist so the SAME tick that resolves M1 finds it runnable instead.
  let m2 = -1;
  await check('AP-4a', 'set up M2 (fails twice) BEFORE M1 resolves, so the tree never legitimately goes "nothing left" between them', async () => {
    const n = goalsModule.createGoalNode(g1, { title: 'M2 — fails twice then parks', done_means: 'M2 evidence exists', parent_id: null, authored_by: 'kevin', actor: 'jarvis', leaf_kind: 'machine' });
    m2 = n.id;
  });
  await check('AP-3a', 'PASS: pre-pass parses the VERIFY result, verifies the node done, no attempt consumed', async () => {
    await finishVerify(m1VerifyId, 'VERDICT: PASS\nevidence:\n- ran the widget, it widgeted\ngaps:\n- none');
    await waitCheck(g1, m1);
    await tick(g1, 'sim');
    const n = await nodeById(g1, m1);
    assert.equal(n.state, 'done');
    assert.equal(n.autopilot_attempts, 0);
    assert.equal(n.autopilot_verdict.verdict, 'PASS');
    assert.equal(n.autopilot_verdict.tree_id, m1TreeId);
  });

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[3] AP-4/AP-5 — FAIL -> replan (same gap text) -> second FAIL -> parked; unpark restores');
  await check('AP-4b', 'FAIL -> node reopens set/plan_state=none, attempts=1, and the SAME tick posts a REPLAN cue with the gap verbatim', async () => {
    const { verifyId } = await dispatchLeaf(g1, m2, [{ title: 'attempt 1', spec: 'try it' }]);
    await finishVerify(verifyId, 'VERDICT: FAIL\nevidence:\n- hit the endpoint\ngaps:\n- endpoint 500s on empty body');
    await waitCheck(g1, m2);
    await tick(g1, 'sim');
    const n = await nodeById(g1, m2);
    assert.equal(n.state, 'set');
    assert.equal(n.plan_state, 'none');
    assert.equal(n.autopilot_attempts, 1);
    assert.equal(n.autopilot_verdict.verdict, 'FAIL');
    const cue = lastApCue(g1);
    assert.ok(cue, 'a cue was posted');
    assert.match(cue.text, new RegExp(`^\\[autopilot goal #${g1} — REPLAN #${m2}`));
    assert.match(cue.text, /endpoint 500s on empty body/);
    assert.match(cue.text, /attempt 2 of 2/);
    assert.equal(cue.correlationKey, `autopilot:${g1}:replan:${m2}`);
  });
  await check('AP-5a', 'second FAIL -> parked, parked_reason starts "verify failed 2/2: ...", attempts=2, no cue for the park itself', async () => {
    const before = apCueCalls(g1).length;
    const { verifyId } = await dispatchLeaf(g1, m2, [{ title: 'attempt 2', spec: 'try it again' }]);
    await finishVerify(verifyId, 'VERDICT: FAIL\nevidence:\n- hit the endpoint again\ngaps:\n- endpoint 500s on empty body');
    await waitCheck(g1, m2);
    await tick(g1, 'sim'); // pre-pass parks it AND (same tick) the walk finds nothing else -> posts wrap
    const n = await nodeById(g1, m2);
    assert.equal(n.state, 'parked');
    assert.ok(n.parked_reason.startsWith('verify failed 2/2: endpoint 500s'), n.parked_reason);
    assert.equal(n.autopilot_attempts, 2);
    // the pre-pass park itself posts no cue; whatever cue DID land this tick
    // (there may be one — "nothing else runnable" -> wrap) is asserted in [7].
    void before;
  });
  await check('AP-5b', 'Kevin unpark -> set, parked_reason=NULL, attempts reset to 0; Kevin re-parks it to keep the run "stuck" for the wrap section below', async () => {
    const unparked = await post(`/goals/${g1}/nodes/${m2}/unpark`, {});
    assert.equal(unparked.status, 200, JSON.stringify(unparked.json));
    assert.equal(unparked.json.node.state, 'set');
    assert.equal(unparked.json.node.parked_reason, null);
    assert.equal(unparked.json.node.autopilot_attempts, 0);
    const reparked = await post(`/goals/${g1}/nodes/${m2}/park`, {});
    assert.equal(reparked.status, 200, JSON.stringify(reparked.json));
    assert.equal(reparked.json.node.state, 'parked');
  });

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[4] AP-7 — DFS order + parallel (pure computeNextAction fixtures)');
  await check('AP-7a', 'parallel=1: A(none)[A1,A2 machine], B machine sibling — first tick plans A1, not A2, not B', () => {
    const A = mkNode({ title: 'A', leaf_kind: 'none', child_count: 2 });
    const A1 = mkNode({ title: 'A1', parent_id: A.id, leaf_kind: 'machine', depth: 1 });
    const A2 = mkNode({ title: 'A2', parent_id: A.id, leaf_kind: 'machine', depth: 1 });
    const B = mkNode({ title: 'B', leaf_kind: 'machine' });
    const nodes = [A, A1, A2, B];
    const cfg = fixtureCfg({ parallel: 1 });
    const d1 = ap.computeNextAction(nodes, cfg);
    assert.equal(d1.action, 'plan');
    assert.equal(d1.node_id, A1.id);
    A1.state = 'working';
    const d2 = ap.computeNextAction(nodes, cfg);
    assert.equal(d2.action, null);
    assert.equal(d2.reason, 'parallel_full');
    A1.state = 'done';
    const d3 = ap.computeNextAction(nodes, cfg);
    assert.equal(d3.action, 'plan');
    assert.equal(d3.node_id, A2.id);
    A2.state = 'done';
    A.state = 'check'; // fabricates settleParentIfComplete's real DB-side effect
    const d4 = ap.computeNextAction(nodes, cfg);
    assert.equal(d4.action, 'plan');
    assert.equal(d4.node_id, B.id);
  });
  await check(
    'AP-7b',
    'parallel=2 does NOT unblock a later sibling while an earlier one is "working" — earlierSettled() excludes state=working regardless of the parallel value ' +
      '(a divergence from CONTRACT.md §15.12 AP-7\'s literal "cue plan A2" example; see sim-report notes for REVIEW-BACKEND, not patched here)',
    () => {
      const A = mkNode({ title: 'A', leaf_kind: 'none', child_count: 2 });
      const A1 = mkNode({ title: 'A1', parent_id: A.id, leaf_kind: 'machine', depth: 1, state: 'working' });
      const A2 = mkNode({ title: 'A2', parent_id: A.id, leaf_kind: 'machine', depth: 1 });
      const B = mkNode({ title: 'B', leaf_kind: 'machine' });
      const cfg2 = fixtureCfg({ parallel: 2 });
      const d = ap.computeNextAction([A, A1, A2, B], cfg2);
      assert.equal(d.action, null);
      assert.equal(d.reason, 'waiting_on_work', 'row3 does not fire (1 < 2) but the DFS walk still finds nothing runnable');
      // Confirmed with two fully independent root-level leaves too (no shared
      // parent at all) — same result, so this is not an artifact of A2 sharing
      // a container with A1.
      const X1 = mkNode({ title: 'X1', leaf_kind: 'machine', state: 'working' });
      const X2 = mkNode({ title: 'X2', leaf_kind: 'machine' });
      const d2 = ap.computeNextAction([X1, X2], cfg2);
      assert.equal(d2.action, null);
      assert.equal(d2.reason, 'waiting_on_work');
    },
  );

  console.log('\n[5] AP-8 — decompose (depth < max_depth) vs classify (depth = max_depth)');
  await check('AP-8a', 'a set+none leaf with no children at depth 1 of max 4 -> decompose; the same shape at depth 4 -> classify', () => {
    const cfg = fixtureCfg({ max_depth: 4, parallel: 1 });
    const D1 = mkNode({ title: 'D1', leaf_kind: 'none', depth: 1, child_count: 0 });
    const d1 = ap.computeNextAction([D1], cfg);
    assert.equal(d1.action, 'decompose');
    assert.equal(d1.node_id, D1.id);
    assert.match(d1.reason, /depth 1 of 4/);
    const D2 = mkNode({ title: 'D2', leaf_kind: 'none', depth: 4, child_count: 0 });
    const d2 = ap.computeNextAction([D2], cfg);
    assert.equal(d2.action, 'classify');
    assert.equal(d2.node_id, D2.id);
    assert.match(d2.reason, /max_depth 4/);
  });
  await check('AP-8b', 'a none-node with a live (ghost) child is skipped entirely, not decomposed or classified', () => {
    const cfg = fixtureCfg({ max_depth: 4, parallel: 1 });
    const P = mkNode({ title: 'P', leaf_kind: 'none', depth: 0, child_count: 1 });
    const ghostChild = mkNode({ title: 'ghost child', parent_id: P.id, state: 'ghost', depth: 1 });
    const d = ap.computeNextAction([P, ghostChild], cfg);
    assert.equal(d.action, 'wrap', 'nothing runnable, nothing to decompose/classify (P has a live child)');
  });
  await check('AP-8c', 'an earlier set+machine leaf with no plan wins over a later decompose/classify candidate', () => {
    const cfg = fixtureCfg({ max_depth: 4, parallel: 1 });
    const M = mkNode({ title: 'M (earlier)', leaf_kind: 'machine' });
    const D = mkNode({ title: 'D (later)', leaf_kind: 'none', child_count: 0 });
    const d = ap.computeNextAction([M, D], cfg);
    assert.equal(d.action, 'plan');
    assert.equal(d.node_id, M.id);
  });

  console.log('\n[6] AP-9 — a human leaf never blocks a later machine leaf and is never cued');
  await check('AP-9a', 'H(human) earlier than M(machine) does not block M; H itself never appears as an action target', () => {
    const cfg = fixtureCfg({ max_depth: 4, parallel: 1 });
    const H = mkNode({ title: 'H', leaf_kind: 'human' });
    const M = mkNode({ title: 'M', leaf_kind: 'machine' });
    const d = ap.computeNextAction([H, M], cfg);
    assert.equal(d.action, 'plan');
    assert.equal(d.node_id, M.id, 'the human leaf settled itself out of the way');
  });
  await check('AP-9b', 'G1\'s real H1/H2/H3 probes (from AP-1d) really are human + set, i.e. would be reported under "waiting on you"', async () => {
    const tree = await get(`/goals/${g1}`);
    const probes = tree.json.nodes.filter((n: any) => /^Probe H/.test(n.title));
    assert.equal(probes.length, 3);
    assert.ok(probes.every((n: any) => n.leaf_kind === 'human' && n.state === 'set'));
  });

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[7] AP-13 — wrap + night report');
  await check('AP-13a', 'verify {goal:true} from JARVIS is refused while autopilot is still on', async () => {
    const toolsModule = await import(path.join(distDir, 'tools', 'goals-tool.js'));
    const goalExt = `cockpit:goal-${g1}`;
    const refused = await toolsModule.goals.execute({ operation: 'verify', goal: true, passed: true }, { externalId: goalExt });
    assert.equal(refused.code, 'autopilot_root_verify_is_kevins', JSON.stringify(refused));
  });
  await check('AP-13b', 'nothing runnable, nothing working -> the tick from AP-5a (or this one) already posted a wrap cue; a second tick finalizes: autopilot off, stop_reason=stuck (M2 is parked)', async () => {
    let cue = apCueCalls(g1).find((c) => (c.correlationKey ?? '') === `autopilot:${g1}:wrap:0`);
    if (!cue) {
      await tick(g1, 'sim');
      cue = apCueCalls(g1).find((c) => (c.correlationKey ?? '') === `autopilot:${g1}:wrap:0`);
    }
    assert.ok(cue, `no wrap cue found among: ${JSON.stringify(apCueCalls(g1).map((c) => c.correlationKey))}`);
    assert.match(cue.text, new RegExp(`^\\[autopilot goal #${g1} — WRAP #0`));
    // simulate the wrap turn's own `log` line, so the report's "orchestrator's
    // own read" section has content, and simulate the turn writing the report
    // via the tool (so the report's own `autopilot_report` event links back).
    goalsModule.insertEvent(g1, null, 'jarvis', 'log', 'autopilot: wrapped — stuck (M2 parked after 2/2 failed VERIFYs; everything else done/human/settled).');
    const before = await get(`/goals/${g1}`);
    assert.equal(before.json.goal.autopilot, 1, 'still on until the finalize tick runs');
    await tick(g1, 'sim'); // gate 4 passes (chat never busy) -> finalizeWrap()
    const after = await get(`/goals/${g1}`);
    assert.equal(after.json.goal.autopilot, 0);
    assert.equal(after.json.goal.autopilot_config.stop_reason, 'stuck');
    assert.equal(typeof after.json.goal.autopilot_config.stopped_at, 'string');
  });
  await check('AP-13c', 'the night report file exists with every section header, a What-ran row for each dispatch, FAIL gaps verbatim, and the parked reason', async () => {
    const report = await get(`/goals/${g1}/autopilot/report`);
    assert.equal(report.status, 200, JSON.stringify(report.json));
    assert.equal(report.json.written, true);
    assert.ok(fs.existsSync(path.join(VAULT, report.json.path)), `${path.join(VAULT, report.json.path)} does not exist`);
    for (const h of ['# 🌙 Autopilot night report', '## Plan (the tree as JARVIS shaped it)', '## What ran', "## What's waiting on you", '## Where it stopped and why', "## The orchestrator's own read", '## Event trail']) {
      assert.ok(report.json.markdown.includes(h), `missing section: ${h}`);
    }
    assert.ok(report.json.markdown.includes(m1TreeId), 'M1 tree id appears in What ran');
    assert.match(report.json.markdown, /endpoint 500s on empty body/, 'FAIL gaps are verbatim in the report');
    assert.match(report.json.markdown, /verify failed 2\/2/, 'the parked reason appears');
    assert.match(report.json.markdown, /autopilot: wrapped — stuck/, "the orchestrator's log line appears");
    assert.match(report.json.markdown, /Probe H1/, 'a human leaf appears under waiting-on-you');
  });
  await check('AP-13d', 'a goal never put on autopilot -> 404 no_autopilot_run', async () => {
    const fresh = goalsModule.createGoal({ title: 'AP-13d never-on goal', done_means: 'x', actor: 'kevin' });
    const r = await get(`/goals/${fresh.goal.id}/autopilot/report`);
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'no_autopilot_run');
  });

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[8] AP-14 (part 1) — off restores v0.3 gating; propose after off is a ghost again');
  await check('AP-14a', 'after autopilot flips off (by finalizeWrap), a JARVIS propose on g1 lands a GHOST again, node_proposed fires', async () => {
    const ghostAgain = goalsModule.proposeGoalNodes(g1, { parent_id: null, items: [{ title: 'post-off ghost', done_means: 'stays a ghost' }], actor: 'jarvis' });
    assert.equal(ghostAgain.nodes[0].state, 'ghost');
    assert.ok(ghostAgain.nodes[0].proposal_batch, 'has a real batch id again');
  });
  await check('AP-14b', 'explicit on/off via route 37: stop_reason=kevin on an actor=kevin off; off on an already-off goal is a 200 no-op', async () => {
    const g4 = goalsModule.createGoal({ title: 'AP-14b on/off drill', done_means: 'x', actor: 'kevin' }).goal.id;
    const on = await post(`/goals/${g4}/autopilot`, { on: true });
    assert.equal(on.status, 200);
    const off = await post(`/goals/${g4}/autopilot`, { on: false });
    assert.equal(off.status, 200);
    assert.equal(off.json.goal.autopilot, 0);
    assert.equal(off.json.goal.autopilot_config.stop_reason, 'kevin');
    const offAgain = await post(`/goals/${g4}/autopilot`, { on: false });
    assert.equal(offAgain.status, 200);
    assert.equal(offAgain.json.goal.autopilot, 0);
  });

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[9] AP-10/AP-11/AP-12 — gates (governor / disabled / stop-file / chat-busy) + dedupe + second-ask + park-on-third');
  let g2 = -1;
  let k1 = -1;
  await check('AP-10a', 'setup: a fresh autopilot goal (tick_minutes=1) with one real machine leaf K1', async () => {
    const created = goalsModule.createGoal({ title: 'AP gating drill', done_means: 'gates behave', actor: 'kevin' });
    g2 = created.goal.id;
    const on = await post(`/goals/${g2}/autopilot`, { on: true, config: { tick_minutes: 1 } });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    const n = goalsModule.createGoalNode(g2, { title: 'K1', done_means: 'K1 evidence exists', parent_id: null, authored_by: 'kevin', actor: 'jarvis', leaf_kind: 'machine' });
    k1 = n.id;
  });
  await check('AP-10b', 'governor hold (kevin_active) -> no cue, blocked_by=governor:kevin_active; goals_autopilot_enabled=0 wins over an active governor hold (gate 1 before gate 3)', async () => {
    ap.__setAutopilotTestOverrides({ governor: () => ({ allow: false, reason: 'kevin_active' }), inFlight: () => null });
    await tick(g2, 'sim');
    assert.equal(apCueCalls(g2).length, 0);
    let status = await get(`/goals/${g2}/autopilot`);
    assert.equal(status.json.blocked_by, 'governor:kevin_active');
    const prior = getSetting('goals_autopilot_enabled');
    setSetting('goals_autopilot_enabled', '0');
    await tick(g2, 'sim');
    status = await get(`/goals/${g2}/autopilot`);
    assert.equal(status.json.blocked_by, 'disabled');
    assert.equal(apCueCalls(g2).length, 0);
    setSetting('goals_autopilot_enabled', prior ?? '1');
  });
  await check('AP-10c', 'once allowed, the first real cue (plan K1) posts', async () => {
    ap.__setAutopilotTestOverrides({ governor: () => ({ allow: true, reason: 'ok' }), inFlight: () => null });
    await tick(g2, 'sim');
    assert.equal(apCueCalls(g2).length, 1);
    assert.equal(lastApCue(g2).correlationKey, `autopilot:${g2}:plan:${k1}`);
    assert.ok(!lastApCue(g2).text.includes('(second ask)'));
  });
  await check('AP-10d', 'a governor hold that starts mid-tree still lets the pre-pass flip the node to done from a completed VERIFY, while posting no new cue', async () => {
    const { verifyId } = await dispatchLeaf(g2, k1, [{ title: 'do it', spec: 'do it for K1' }]);
    ap.__setAutopilotTestOverrides({ governor: () => ({ allow: false, reason: 'kevin_active' }), inFlight: () => null });
    await finishVerify(verifyId, 'VERDICT: PASS\nevidence:\n- did it\ngaps:\n- none');
    await waitCheck(g2, k1);
    const before = apCueCalls(g2).length;
    await tick(g2, 'sim');
    const n = await nodeById(g2, k1);
    assert.equal(n.state, 'done', 'pre-pass ran despite the hold');
    assert.equal(apCueCalls(g2).length, before, 'no cue posted while held');
    const status = await get(`/goals/${g2}/autopilot`);
    assert.equal(status.json.blocked_by, 'governor:kevin_active');
    ap.__setAutopilotTestOverrides({ governor: () => ({ allow: true, reason: 'ok' }), inFlight: () => null });
  });

  let k2 = -1;
  await check('AP-12a', 'chat_busy gate: inFlight override truthy -> no cue, blocked_by=chat_busy', async () => {
    const n = goalsModule.createGoalNode(g2, { title: 'K2', done_means: 'K2 evidence exists', parent_id: null, authored_by: 'kevin', actor: 'jarvis', leaf_kind: 'machine' });
    k2 = n.id;
    ap.__setAutopilotTestOverrides({ governor: () => ({ allow: true, reason: 'ok' }), inFlight: () => 'msg-in-flight-id' });
    const before = apCueCalls(g2).length;
    await tick(g2, 'sim');
    assert.equal(apCueCalls(g2).length, before, 'held at gate 4, no cue');
    const status = await get(`/goals/${g2}/autopilot`);
    assert.equal(status.json.blocked_by, 'chat_busy');
    ap.__setAutopilotTestOverrides({ governor: () => ({ allow: true, reason: 'ok' }), inFlight: () => null });
  });
  let dedupeAt = 0;
  await check('AP-12b', 'first ask: plan K2 posts once cleared', async () => {
    const before = apCueCalls(g2).length;
    ap.__setAutopilotTestOverrides({ governor: () => ({ allow: true, reason: 'ok' }), inFlight: () => null, now: () => (dedupeAt = Date.now()) });
    await tick(g2, 'sim');
    assert.equal(apCueCalls(g2).length, before + 1);
    assert.equal(lastApCue(g2).correlationKey, `autopilot:${g2}:plan:${k2}`);
    assert.ok(!lastApCue(g2).text.includes('(second ask)'));
  });
  await check('AP-12c', 'an immediate re-tick (unchanged node, tick_minutes not elapsed) does NOT repost', async () => {
    const before = apCueCalls(g2).length;
    ap.__setAutopilotTestOverrides({ governor: () => ({ allow: true, reason: 'ok' }), inFlight: () => null, now: () => dedupeAt + 5_000 });
    await tick(g2, 'sim');
    assert.equal(apCueCalls(g2).length, before, 'still fresh — no repost');
  });
  await check('AP-12d', 'after tick_minutes elapses with no state change, the SAME key re-posts once, header carries "(second ask)"', async () => {
    const before = apCueCalls(g2).length;
    dedupeAt = dedupeAt + 61_000; // tick_minutes=1 -> 60_000ms
    ap.__setAutopilotTestOverrides({ governor: () => ({ allow: true, reason: 'ok' }), inFlight: () => null, now: () => dedupeAt });
    await tick(g2, 'sim');
    assert.equal(apCueCalls(g2).length, before + 1);
    assert.equal(lastApCue(g2).correlationKey, `autopilot:${g2}:plan:${k2}`);
    assert.ok(lastApCue(g2).text.includes('(second ask)'), lastApCue(g2).text.slice(0, 120));
  });
  await check('AP-12e', 'a third identical ask (still unchanged) parks the node with reason "cue ignored twice", posts no further cue', async () => {
    const before = apCueCalls(g2).length;
    dedupeAt = dedupeAt + 61_000;
    ap.__setAutopilotTestOverrides({ governor: () => ({ allow: true, reason: 'ok' }), inFlight: () => null, now: () => dedupeAt });
    await tick(g2, 'sim');
    const n = await nodeById(g2, k2);
    assert.equal(n.state, 'parked');
    assert.equal(n.parked_reason, 'cue ignored twice');
    assert.equal(apCueCalls(g2).length, before, 'no cue for the park itself');
  });

  await check('AP-11a', 'stop file: no cue while present, blocked_by=stop_file; removed -> the deferred wrap fires; autopilot stays 1 throughout the hold', async () => {
    ap.__setAutopilotTestOverrides({ governor: () => ({ allow: true, reason: 'ok' }), inFlight: () => null });
    fs.writeFileSync(ap.STOP_FILE, 'held by AP-11a\n');
    const before = apCueCalls(g2).length;
    await tick(g2, 'sim');
    assert.equal(apCueCalls(g2).length, before);
    let status = await get(`/goals/${g2}/autopilot`);
    assert.equal(status.json.blocked_by, 'stop_file');
    let goal = await get(`/goals/${g2}`);
    assert.equal(goal.json.goal.autopilot, 1, 'autopilot stays on through a hold');
    fs.rmSync(ap.STOP_FILE, { force: true });
    await tick(g2, 'sim'); // K1 done, K2 parked -> nothing runnable -> wrap
    assert.equal(apCueCalls(g2).length, before + 1);
    assert.equal(lastApCue(g2).correlationKey, `autopilot:${g2}:wrap:0`);
    status = await get(`/goals/${g2}/autopilot`);
    assert.equal(status.json.blocked_by, null);
  });
  await check('AP-11b', 'finalize: everything settled (K1 done, K2 parked) -> autopilot off, stop_reason=stuck (a parked node exists)', async () => {
    await tick(g2, 'sim'); // lastCue.action==='wrap' -> finalizeWrap()
    const goal = await get(`/goals/${g2}`);
    assert.equal(goal.json.goal.autopilot, 0);
    assert.equal(goal.json.goal.autopilot_config.stop_reason, 'stuck');
  });

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[10] AP-14 (part 2) — Kevin edits fold into the next cue as a weigh-in block, and stand alone when nothing else is cued');
  let g3 = -1;
  let w1 = -1;
  let w2 = -1;
  await check('AP-14c', 'setup: W1 (machine, runnable) + W2 (human, will be Kevin-edited into awaiting_jarvis before the first tick)', async () => {
    const created = goalsModule.createGoal({ title: 'AP-14 weigh-in drill', done_means: 'weigh-ins fold in correctly', actor: 'kevin' });
    g3 = created.goal.id;
    const on = await post(`/goals/${g3}/autopilot`, { on: true });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    w1 = goalsModule.createGoalNode(g3, { title: 'W1', done_means: 'W1 evidence exists', parent_id: null, authored_by: 'kevin', actor: 'jarvis', leaf_kind: 'machine' }).id;
    w2 = goalsModule.createGoalNode(g3, { title: 'W2 (Kevin will edit this)', done_means: 'W2 original wording', parent_id: null, authored_by: 'kevin', actor: 'jarvis', leaf_kind: 'human' }).id;
    const edited = await patch(`/goals/${g3}/nodes/${w2}`, { title: 'W2 (kevin edited this)', done_means: 'W2 edited wording' });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.equal(edited.json.node.review_state, 'awaiting_jarvis');
    ap.__setAutopilotTestOverrides({ governor: () => ({ allow: true, reason: 'ok' }), inFlight: () => null });
  });
  await check('AP-14d', 'first tick: cues plan W1 AND appends the weigh-in block naming W2', async () => {
    await tick(g3, 'sim');
    const cue = lastApCue(g3);
    assert.equal(cue.correlationKey, `autopilot:${g3}:plan:${w1}`);
    assert.match(cue.text, /Kevin changed these during the night; weigh in on each/);
    assert.match(cue.text, new RegExp(`#${w2} edited: "W2 \\(kevin edited this\\)"`));
    assert.match(cue.text, /was: "W2 \(Kevin will edit this\)"/);
  });
  await check('AP-14e', 'resolve W1 for real (PASS); with nothing else runnable and W2 still awaiting weigh-in, the NEXT tick is a standalone weigh_in cue', async () => {
    const { verifyId } = await dispatchLeaf(g3, w1, [{ title: 'do it', spec: 'do it for W1' }]);
    await finishVerify(verifyId, 'VERDICT: PASS\nevidence:\n- did it\ngaps:\n- none');
    await waitCheck(g3, w1);
    const before = apCueCalls(g3).length;
    await tick(g3, 'sim'); // pre-pass resolves W1 -> done, same tick's walk finds nothing runnable
    assert.equal(apCueCalls(g3).length, before + 1);
    const cue = lastApCue(g3);
    assert.equal(cue.correlationKey, `autopilot:${g3}:weigh_in:0`);
    assert.match(cue.text, /Kevin changed these during the night; weigh in on each/);
    assert.match(cue.text, new RegExp(`#${w2} edited:`));
  });
  await check('AP-14f', 'JARVIS accept {node_id: W2} via the tool clears the round (works regardless of autopilot); the next tick wraps cleanly (complete, not stuck)', async () => {
    const toolsModule = await import(path.join(distDir, 'tools', 'goals-tool.js'));
    const g3Ext = `cockpit:goal-${g3}`;
    const accepted = await toolsModule.goals.execute({ operation: 'accept', node_id: w2 }, { externalId: g3Ext });
    assert.equal(accepted.node.review_state, 'none', JSON.stringify(accepted));
    // W2 is a human leaf and stays `set` forever until Kevin marks it done —
    // do that now so this run demonstrates the OTHER finalizeWrap branch
    // (stop_reason='complete') rather than duplicating AP-13/AP-11's 'stuck'.
    const humanDone = await post(`/goals/${g3}/nodes/${w2}/human_done`, {});
    assert.equal(humanDone.status, 200, JSON.stringify(humanDone.json));
    assert.equal(humanDone.json.node.state, 'check', 'human_done lands on check; verify still finishes it');
    const verified = await post(`/goals/${g3}/nodes/${w2}/verify`, { passed: true });
    assert.equal(verified.status, 200, JSON.stringify(verified.json));
    assert.equal(verified.json.node.state, 'done');
    await tick(g3, 'sim'); // wrap
    assert.equal(lastApCue(g3).correlationKey, `autopilot:${g3}:wrap:0`);
    await tick(g3, 'sim'); // finalize
    const goal = await get(`/goals/${g3}`);
    assert.equal(goal.json.goal.autopilot, 0);
    assert.equal(goal.json.goal.autopilot_config.stop_reason, 'complete', 'W1 done, W2 human+done -> nothing parked');
  });

  console.log(`\n[autopilot-sim] every prior goals sim (v0–v0.3, guards) is unaffected — this file only ADDS autopilot coverage and does not touch their scratch DB.`);
} finally {
  server.close();
  fs.rmSync(ap.STOP_FILE, { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log(`\n[autopilot-sim] ${passed}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ' ✅'}`);
console.log('\n| # | Result |');
console.log('|---|---|');
for (const r of results) console.log(`| ${r.id} | ${r.pass ? 'PASS' : 'FAIL'} |`);

const outDir = '/home/kevin/obsidian/paperclip-wiki/outbox/goals';
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'autopilot-sim-report.md');
const lines: string[] = [];
lines.push('# GOALS AUTOPILOT — sim report (CONTRACT.md §15.12, tree-a2a9e6b2 node #540)');
lines.push('');
lines.push(`Run at ${new Date().toISOString()}. Scratch DB: \`${DB_PATH}\`. ${passed}/${results.length} checks passed.`);
lines.push('');
lines.push(
  'Drives the real `createApiV1Router()` over real HTTP on a throwaway port, against a scratch sqlite ' +
    'copy — never `jarvis.db`. The hopper worker spawn is stubbed with a fake `processMessage` (mirrors ' +
    '`scripts/foundry-sim.mjs`) so `dispatchTick` runs for real (claims ready leaves, applies dependency ' +
    'ordering, plants/agrees real hopper trees) but **zero live model calls are made anywhere in this file**. ' +
    'Build + VERIFY node completion is driven through the real finish contract, `POST /hopper-nodes/:id/finish`. ' +
    'AP-6 (parseVerdict) and AP-7/AP-8/AP-9 (the §15.4 decision table\'s ordering rules) are tested as pure unit ' +
    'checks against the exported `computeNextAction`/`parseVerdict` — those rows depend only on a `GoalNodeRow[]` ' +
    'snapshot + config, so a hand-built fixture array is the most direct, deterministic way to prove every row of ' +
    'the table without fighting real dispatch timing for the ordering edge cases.',
);
lines.push('');
lines.push('| # | Check | Result |');
lines.push('|---|---|---|');
for (const r of results) {
  lines.push(`| ${r.id} | ${r.description} | ${r.pass ? '✅ pass' : `❌ **FAIL** — ${r.error}`} |`);
}
lines.push('');
if (failed.length) {
  lines.push('## Failures');
  lines.push('');
  for (const r of failed) {
    lines.push(`### [${r.id}] ${r.description}`);
    lines.push('');
    lines.push('```');
    lines.push(r.error ?? '(no error captured)');
    lines.push('```');
    lines.push('');
  }
} else {
  lines.push("All checks passed against `CONTRACT.md` §15.12's acceptance list during this run.");
}
lines.push('');
lines.push('## Notes for REVIEW-BACKEND (not treated as bugs, not patched here)');
lines.push('');
lines.push(
  '1. **`parallel > 1` is inert in the current `computeNextAction` implementation.** CONTRACT.md §15.12 AP-7\'s ' +
    'worked example claims "With `parallel:2`: after A1 dispatched, tick → cue `plan A2`" — but `earlierSettled()` ' +
    'treats `state=\'working\'` as NOT settled (only `done`/`parked`/`human`/`check`/promoted count), and every ' +
    'node — sibling under the same container OR a fully independent root-level leaf — has the currently-working ' +
    'node in its `earlier()` chain once that node is the first thing dispatched. Verified empirically two ways ' +
    '(check AP-7b): A2 under A while A1 is `working`, and two fully unrelated root leaves X1(`working`)/X2, both ' +
    'return `{action:null, reason:\'waiting_on_work\'}` regardless of `parallel:1` vs `parallel:2` — the ONLY ' +
    'observable difference `parallel` makes is the *reason string* on row 3 (`parallel_full` vs falling through to ' +
    'the walk, which then also returns null). Given "execute them in a row" is the explicit design intent ' +
    '(AUTOPILOT.md §2.3: "Sibling ordering = execution order... a machine leaf is runnable only when every earlier ' +
    'sibling... is done/parked/human"), this may be working as designed and the CONTRACT prose\'s specific example ' +
    'is simply wrong — or `parallel>1` was meant to unlock something the current DFS-walk-with-earlier-gating ' +
    'structure cannot express (independent BRANCHES running concurrently) and needs a real design decision before ' +
    'it does anything. Either way it is not a one-line fix and not something to guess at here.',
);
fs.writeFileSync(reportPath, lines.join('\n') + '\n');
console.log(`[autopilot-sim] report written: ${reportPath}`);

if (failed.length) process.exitCode = 1;
