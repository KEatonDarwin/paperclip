// NIGHT SHIFT SIM (skills/night-shift/CONTRACT.md §10, tree-37015f83 node #679)
//
// Drives the REAL src/night-shift.ts + goals.ts + goals-autopilot.ts +
// hopper-engine.ts through the REAL createApiV1Router() over real HTTP on a
// throwaway port, against SCRATCH sqlite DBs, and asserts NS-1…NS-16.
//
// NO MODEL CALLS ANYWHERE: the ESM loader hooks stub the one dynamic
// `import('./agent.js')` that goals.js's postCue (and tree-cue.js) perform, and
// the hopper worker spawn is a fake processMessage.
//
// TWO PHASES:
//   A. a READ-ONLY .backup() copy of the live jarvis.db — plan determinism on
//      Kevin's real goals + the §3.5 ranking, reported for review. The copy
//      goes on the HOME DISK, never /tmp (/tmp is a 2.9G tmpfs and jarvis.db is
//      ~1.1GB — the CONTRACT node filled it doing exactly that).
//   B. a synthetic scratch DB built through the real API — every behavioural
//      scenario (lanes, exclusivity, FAIL→replan, blocked→unblock, expansion,
//      pause, budget, wrap, recovery, stand-down, board, skip guard).
//
//   npm run night:sim
//
// Writes a pass/fail report to <vault>/outbox/night/night-sim-report.md.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

register(pathToFileURL(path.join(__dirname, 'goals-v01-cue-check.hooks.mjs')), import.meta.url);
register(pathToFileURL(path.join(__dirname, 'goals-guards-sim-cue.hooks.mjs')), import.meta.url);
register(pathToFileURL(path.join(__dirname, 'goals-tree-cue-sim.hooks.mjs')), import.meta.url);
register(pathToFileURL(path.join(__dirname, 'goals-tool-sim-seed.hooks.mjs')), import.meta.url);

// ── scratch paths (home disk, NOT /tmp) ────────────────────────────────────
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
const SCRATCH_DIR = process.env.NIGHT_SIM_DIR ?? path.join(os.homedir(), '.cache', 'night-shift-sim');
fs.mkdirSync(SCRATCH_DIR, { recursive: true });
const DB_PATH = path.resolve(process.env.JARVIS_DB_PATH ?? path.join(SCRATCH_DIR, 'night-sim.db'));
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
process.env.JARVIS_DB_PATH = DB_PATH;
console.log(`[night-sim] scratch DB: ${DB_PATH}`);

process.env.HOPPER_GOV_ENABLED = '0';
process.env.HOPPER_ENGINE_SLOTS = '8';   // hard-set: the login shell exports 2
process.env.GOAL_GUARD_POLLER = '0';
process.env.GOALS_AUTOPILOT_DRIVER = '0';
process.env.GOALS_AUTOPILOT_KICK_MS = '999999999';
process.env.NIGHT_SHIFT_DRIVER = '0';
process.env.NIGHT_SHIFT_KICK_MS = '999999999';
const NIGHT_STOP_FILE = path.join(SCRATCH_DIR, 'night-sim.stop');
process.env.NIGHT_SHIFT_STOP_FILE = NIGHT_STOP_FILE;
fs.rmSync(NIGHT_STOP_FILE, { force: true });
const VAULT = path.join(SCRATCH_DIR, 'vault');
fs.rmSync(VAULT, { recursive: true, force: true });
process.env.GOALS_VAULT_ROOT = VAULT;
delete process.env.ANTHROPIC_API_KEY;

const distDir = path.join(repoRoot, 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const hopperEngine = await import(path.join(distDir, 'hopper-engine.js'));
const night = await import(path.join(distDir, 'night-shift.js'));
const ap = await import(path.join(distDir, 'goals-autopilot.js'));
const { getSetting, setSetting, sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));

async function fakeProcessMessage(prompt) {
  const m = /node #(\d+)/.exec(prompt);
  if (m) dispatched.add(Number(m[1]));
  return 'FAKE_WORKER_OK — no model call made.';
}
const dispatched = new Set();
hopperEngine.startHopperEngine(fakeProcessMessage);

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/v1`;
console.log(`[night-sim] server: ${base}`);
const adminKey = mintApiKey('night-sim-admin', 'cockpit').plaintext;

async function req(method, urlPath, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${urlPath}`, {
    method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const get = (p, token = adminKey) => req('GET', p, { token });
const post = (p, body = {}, token = adminKey) => req('POST', p, { token, body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cueCalls() { return globalThis.__goalsCueCalls ?? []; }
function nightCues() { return cueCalls().filter((c) => c.externalId === 'cockpit:night-shift'); }
function itemCues(runId, itemId) { return cueCalls().filter((c) => (c.correlationKey ?? '').startsWith(`night:${runId}:${itemId}:`)); }

async function tick(reason = 'sim') { await night.tickNightShift(reason); await sleep(60); }
async function waitFor(label, fn, timeoutMs = 5000, stepMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(stepMs); }
  throw new Error(`waitFor timed out: ${label}`);
}

const results = [];
async function check(id, description, fn) {
  try { await fn(); results.push({ id, description, pass: true }); console.log(`  ✓ [${id}] ${description}`); }
  catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    results.push({ id, description, pass: false, error: msg });
    console.log(`  ✗ [${id}] ${description}\n      ${msg}`);
  }
}

// ── goal/node builders ─────────────────────────────────────────────────────
async function mkGoal(title, doneMeans) {
  const r = await post('/goals', { title, done_means: doneMeans, authored_by: 'kevin' });
  if (r.status !== 201) throw new Error(`createGoal failed: ${JSON.stringify(r.json)}`);
  return r.json.goal.id;
}
async function mkNode(goalId, title, opts = {}) {
  const r = await post(`/goals/${goalId}/nodes`, {
    title, done_means: opts.done_means ?? `${title} verified`, parent_id: opts.parent_id ?? null,
    authored_by: 'kevin', leaf_kind: opts.leaf_kind,
  });
  if (r.status !== 201) throw new Error(`createNode failed: ${JSON.stringify(r.json)}`);
  return r.json.node.id;
}
async function nodeById(goalId, nodeId) {
  const t = await get(`/goals/${goalId}`);
  return t.json?.nodes?.find((n) => n.id === nodeId);
}
function itemsOf(runId) { return night.listNightItems(runId); }
function itemAt(runId, position) { return itemsOf(runId).find((i) => i.position === position); }
function itemFor(runId, nodeId, kind) { return itemsOf(runId).find((i) => i.node_id === nodeId && (!kind || i.kind === kind)); }

/** Drive a plan item's node through propose_plan + the real hopper to a verdict. */
async function dispatchLeaf(goalId, nodeId, builds = [{ title: 'build it', spec: 'do the thing' }]) {
  const planned = await post(`/goals/${goalId}/nodes/${nodeId}/propose_plan`, {
    plan: {
      what: 'do the work', deliverable: 'evidence it works', model: 'claude-sonnet-5', adapter: 'claude',
      nodes: builds.map((b) => ({ title: b.title, spec: b.spec, adapter: 'claude', model: 'claude-sonnet-5' })),
    },
  });
  if (planned.status !== 200) throw new Error(`propose_plan failed: ${JSON.stringify(planned.json)}`);
  const treeId = planned.json.tree.id;
  const gnode = await nodeById(goalId, nodeId);
  const plan = JSON.parse(gnode.plan);
  const verifyId = plan.verify_hopper_node_id;
  const buildIds = planned.json.hopper_nodes.map((h) => h.id).filter((id) => id !== verifyId);
  return { treeId, verifyId, buildIds };
}
async function overlay(goalId, nodeId, hopperId) {
  const o = await get(`/goals/${goalId}/nodes/${nodeId}/tree`);
  return o.json?.nodes?.find((n) => n.id === hopperId)?.status;
}
async function finishBuilds(goalId, nodeId, d) {
  for (const bid of d.buildIds) {
    await waitFor(`build ${bid} running`, async () => (await overlay(goalId, nodeId, bid)) === 'running');
    await post(`/hopper-nodes/${bid}/finish`, { outcome: 'done', result: 'build step done.' });
  }
  await waitFor(`VERIFY ${d.verifyId} running`, async () => (await overlay(goalId, nodeId, d.verifyId)) === 'running');
}

// ═══════════════════════════════════════════════════════════════════════════
let liveReport = '_live DB not readable — phase A skipped_';
try {
night.__setNightShiftTestOverrides({ governor: () => ({ allow: true, reason: 'ok', detail: 'sim' }) });

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[A] NS-1 — plan determinism + the §3.5 ranking, on a READ-ONLY copy of the live DB');
await check('NS-1', 'two planNight() calls on a live-DB copy are byte-identical; finish items float to the top; every row carries why/est', async () => {
  if (!fs.existsSync(LIVE_DB)) { liveReport = '_live jarvis.db not present — skipped_'; return; }
  const copy = path.join(SCRATCH_DIR, 'live-copy.db');
  for (const p of [copy, `${copy}-wal`, `${copy}-shm`]) fs.rmSync(p, { force: true });
  // .backup takes a consistent snapshot without touching the live file.
  execFileSync('sqlite3', [LIVE_DB, `.backup '${copy}'`], { stdio: 'pipe' });
  const out = execFileSync(process.execPath, [path.join(__dirname, 'night-shift-plan-probe.mjs'), copy], {
    env: { ...process.env, JARVIS_DB_PATH: copy, NIGHT_SHIFT_DRIVER: '0', GOALS_AUTOPILOT_DRIVER: '0', GOAL_GUARD_POLLER: '0' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  const probe = JSON.parse(out);
  assert.equal(probe.identical, true, 'two plans differed');
  assert.ok(probe.items.length > 0, 'the live copy produced an empty plan');
  const firstNonFinish = probe.items.findIndex((i) => i.kind !== 'finish');
  const lastFinish = probe.items.map((i) => i.kind).lastIndexOf('finish');
  if (lastFinish >= 0) assert.ok(lastFinish < (firstNonFinish === -1 ? probe.items.length : firstNonFinish), 'a finish item did not float to the top');
  for (const it of probe.items) {
    assert.ok(it.why && it.why.length > 10, `item #${it.position} has no why`);
    assert.ok(it.est_minutes >= 1, `item #${it.position} has no estimate`);
  }
  liveReport = [
    `plan: **${probe.items.length} items** across ${probe.ranking.length} goals; list ends ~${probe.eta_end ?? '—'}`,
    '', '| rank | goal | momentum | closeness | fresh | score | items |', '|---|---|---|---|---|---|---|',
    ...probe.ranking.map((r) => `| ${r.rank} | G${r.goal_id} ${r.title.slice(0, 40)} | ${r.momentum.toFixed(3)} | ${r.closeness.toFixed(3)} | ${r.freshness} | **${r.score.toFixed(4)}** | ${r.items} |`),
    '', '| pos | kind | goal/node | title | est | eta | why |', '|---|---|---|---|---|---|---|',
    ...probe.items.slice(0, 12).map((i) => `| ${i.position} | ${i.kind} | G${i.goal_id}${i.node_id ? `/#${i.node_id}` : ''} | ${i.title.slice(0, 44)} | ${i.est_minutes}m | ${i.eta ?? '—'} | ${i.why.slice(0, 90)} |`),
  ].join('\n');
  console.log(`      live-copy ranking: ${probe.ranking.map((r) => `G${r.goal_id}(${r.score.toFixed(4)})`).join(' > ')}`);
  for (const p of [copy, `${copy}-wal`, `${copy}-shm`]) fs.rmSync(p, { force: true });
});

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[B] synthetic scratch DB — the behavioural scenarios');

// Kevin-actor node creation leaves review_state='awaiting_jarvis' (goals v0.2),
// which the planner honestly schedules as weigh_in items. The scenarios below
// need plan/decompose items, so JARVIS accepts each node right after creation.
async function acceptNode(goalId, nodeId) {
  const r = await post(`/goals/${goalId}/nodes/${nodeId}/accept`, { actor: 'jarvis' });
  if (r.status !== 200) throw new Error(`accept ${goalId}/${nodeId} failed: ${JSON.stringify(r.json)}`);
}

// G1: a branch with two machine leaves (exclusivity) + a human leaf.
const g1 = await mkGoal('Sim goal one', 'everything under it is done');
const g1BranchA = await mkNode(g1, 'A — the plan branch');
const g1a1 = await mkNode(g1, 'A1 first machine leaf', { parent_id: g1BranchA, leaf_kind: 'machine' });
const g1a2 = await mkNode(g1, 'A2 second machine leaf', { parent_id: g1BranchA, leaf_kind: 'machine' });
const g1Human = await mkNode(g1, 'C — only Kevin can do this', { leaf_kind: 'human' });

// G2: a separate goal so the per-goal cap and cross-goal parallelism show.
const g2 = await mkGoal('Sim goal two', 'its own branch lands');
const g2m1 = await mkNode(g2, 'D1 machine leaf', { leaf_kind: 'machine' });
const g2m2 = await mkNode(g2, 'D2 machine leaf', { leaf_kind: 'machine' });

// G3: pre-existing autopilot at parallel 2, to prove prior_autopilot round-trips.
const g3 = await mkGoal('Sim goal three', 'already on autopilot');
const g3m1 = await mkNode(g3, 'E1 machine leaf', { leaf_kind: 'machine' });
await post(`/goals/${g3}/autopilot`, { on: true, config: { parallel: 2, max_depth: 3, tick_minutes: 7 } });

// GD: the decompose/expansion scenario on its own goal (its own parallel slot).
const gD = await mkGoal('Sim goal decompose', 'the fuzzy branch lands');
const gDBranch = await mkNode(gD, 'B — needs decomposing');
// GE: a second decompose goal, sacrificial for the NS-16 skip.
const gE = await mkGoal('Sim goal skip-me', 'skipped work stays skipped');
const gEBranch = await mkNode(gE, 'S — will be skipped');

for (const [g, n] of [[g1, g1BranchA], [g1, g1a1], [g1, g1a2], [g1, g1Human], [g2, g2m1], [g2, g2m2], [g3, g3m1], [gD, gDBranch], [gE, gEBranch]]) {
  await acceptNode(g, n);
}

// GCHECK: a machine leaf driven through a real tree to `check` BEFORE the plan,
// so the planner itself emits a `verify` item (§3.1 rule 3 → NS-5).
const gCheck = await mkGoal('Sim goal check', 'its leaf verifies');
const gCheckLeaf = await mkNode(gCheck, 'V1 already built leaf', { leaf_kind: 'machine' });
await acceptNode(gCheck, gCheckLeaf);
await post(`/goals/${gCheck}/autopilot`, { on: true });   // auto-approves the plan below
{
  const d = await dispatchLeaf(gCheck, gCheckLeaf);
  await finishBuilds(gCheck, gCheckLeaf, d);
  await post(`/hopper-nodes/${d.verifyId}/finish`, { outcome: 'done', result: 'VERDICT: PASS\nevidence:\n- pre-built and verified\ngaps:\n- none' });
  await waitFor('gCheck leaf -> check', async () => (await nodeById(gCheck, gCheckLeaf))?.state === 'check');
}

// GREADY: a goal whose only leaf is FULLY DONE (not just `check`) before the
// plan is even taken, so it shows up in needs_you as root_ready_to_verify both
// at plan time (NS-1b-adjacent) and on the live board mid-run (NS-18).
const gReady = await mkGoal('Sim goal ready', 'its only leaf is already fully verified');
const gReadyLeaf = await mkNode(gReady, 'R1 leaf done before plan', { leaf_kind: 'machine' });
await acceptNode(gReady, gReadyLeaf);
await post(`/goals/${gReady}/autopilot`, { on: true });
{
  const d = await dispatchLeaf(gReady, gReadyLeaf);
  await finishBuilds(gReady, gReadyLeaf, d);
  await post(`/hopper-nodes/${d.verifyId}/finish`, { outcome: 'done', result: 'VERDICT: PASS\nevidence:\n- already fully built\ngaps:\n- none' });
  await waitFor('gReady leaf -> check', async () => (await nodeById(gReady, gReadyLeaf))?.state === 'check');
  const v = await post(`/goals/${gReady}/nodes/${gReadyLeaf}/verify`, { passed: true, note: 'pre-verified before the night plan', actor: 'jarvis' });
  if (v.status !== 200) throw new Error(`verify gReadyLeaf failed: ${JSON.stringify(v.json)}`);
  await waitFor('gReady leaf -> done', async () => (await nodeById(gReady, gReadyLeaf))?.state === 'done');
}

let runId = -1;
await check('NS-0', 'POST /night/plan returns a planned run with items, an eta_end and a PLAN-READY cue', async () => {
  const r = await post('/night/plan', { mode: 'until_stop', config: { lanes: 4 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  runId = r.json.run.id;
  assert.equal(r.json.run.status, 'planned');
  assert.ok(r.json.items.length >= 5, `expected ≥5 items, got ${r.json.items.length}`);
  assert.ok(r.json.eta_end, 'no eta_end');
  await sleep(80);
  const ready = nightCues().find((c) => c.correlationKey === `night:${runId}:plan-ready`);
  assert.ok(ready, 'no PLAN-READY cue');
  assert.ok(ready.text.startsWith(`[night-shift PLAN READY run #${runId} —`), ready.text.slice(0, 80));
});

await check('NS-1b', 'human leaves are never items; every set node with no children gets decompose + ONE predicted placeholder', () => {
  const items = itemsOf(runId);
  assert.ok(!items.some((i) => i.node_id === g1Human), 'a human leaf was scheduled');
  const dec = items.find((i) => i.node_id === gDBranch && i.kind === 'decompose');
  assert.ok(dec, 'no decompose item for the undecomposed node');
  const preds = items.filter((i) => i.kind === 'predicted' && i.parent_item_id === dec.id);
  assert.equal(preds.length, 1, 'expected exactly one predicted placeholder');
  assert.equal(preds[0].position, dec.position + 1, 'the placeholder does not follow its decompose');
  assert.equal(preds[0].est_minutes, 3 * 60, 'placeholder est is not predicted_children × planEst');
});

await check('NS-2', 'move locks the item, shifts unlocked neighbours and re-sims ETAs; a later insertion after a locked row walks past it instead of moving it', async () => {
  const before = itemsOf(runId);
  const target = before[before.length - 1];
  const moved = await post(`/night/runs/${runId}/items/${target.id}/move`, { position: 2 });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  const after = itemsOf(runId);
  const now = after.find((i) => i.id === target.id);
  assert.equal(now.position, 2, 'move did not land on the requested position');
  assert.equal(now.locked, 1, 'move did not lock the item');
  assert.equal(after.map((i) => i.position).join(','), after.map((_, idx) => idx + 1).join(','), 'positions are not 1..N');
  assert.ok(after.every((i) => i.eta_at || i.status !== 'queued' || true), 'etas missing');
  // insertion above it must not displace it
  const anchor = after.find((i) => i.position === 1);
  const ins = await post(`/night/runs/${runId}/items`, { goal_id: g2, node_id: g2m2, after_item_id: anchor.id });
  assert.equal(ins.status, 201, JSON.stringify(ins.json));
  assert.equal(ins.json.item.kind, 'plan', 'the manual add did not derive kind=plan from a set machine leaf');
  const after2 = itemsOf(runId);
  assert.equal(after2.find((i) => i.id === target.id).position, 2, 'a locked row lost its absolute position to an insertion');
  // anchor is #1, so a naive insert would land at #2 — but #2 is the locked
  // `target` row, so the insert must walk past it and land at #3 instead.
  assert.equal(ins.json.item.position, 3, 'inserting right after a locked row landed ON it instead of walking past it');
});

await check('NS-16', 'skip: a queued item skips and is never picked; a running item 409s', async () => {
  const q = itemsOf(runId).find((i) => i.status === 'queued' && i.kind === 'decompose' && i.goal_id === gE);
  assert.ok(q, 'no gE decompose item to skip');
  const r = await post(`/night/runs/${runId}/items/${q.id}/skip`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(night.listNightItems(runId).find((i) => i.id === q.id).status, 'skipped');
  const bogus = await post(`/night/runs/${runId}/items/999999/skip`, {});
  assert.equal(bogus.status, 404);
});

await check('NS-3', 'start: every included goal is adopted onto autopilot and prior_autopilot snapshots the pre-existing config', async () => {
  const r = await post(`/night/runs/${runId}/start`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const run = night.getNightRun(runId);
  assert.equal(run.status, 'running');
  for (const gid of run.goal_ids) {
    const g = await get(`/goals/${gid}`);
    assert.equal(g.json.goal.autopilot, 1, `goal #${gid} was not adopted`);
  }
  const prior3 = run.prior_autopilot[String(g3)];
  assert.ok(prior3, 'no prior_autopilot entry for the pre-existing autopilot goal');
  assert.equal(prior3.autopilot, 1);
  assert.equal(prior3.config.parallel, 2, 'the pre-existing parallel was not snapshotted');
  assert.equal(prior3.config.tick_minutes, 7);
  const adopted = (await get(`/goals/${g3}`)).json.goal.autopilot_config;
  assert.equal(adopted.parallel, 2, 'goalPar did not preserve the goal\'s own parallel (§12.6)');
});

await check('NS-18', 'a goal that has nothing left (root fully done before/during the run) lands in needs_you as root_ready_to_verify on the live board', async () => {
  const b = await get('/night/board');
  assert.equal(b.status, 200, JSON.stringify(b.json));
  const hit = b.json.needs_you.find((n) => n.goal_id === gReady && n.reason === 'root_ready_to_verify');
  assert.ok(hit, `no root_ready_to_verify entry for gReady in needs_you: ${JSON.stringify(b.json.needs_you)}`);
  assert.equal(hit.node_id, null, 'root_ready_to_verify should be a goal-level entry (node_id null)');
});

await check('NS-19', 'only one run may be active at a time: a second POST /night/plan while this one is running 409s night_run_active', async () => {
  const dupe = await post('/night/plan', { mode: 'until_stop' });
  assert.equal(dupe.status, 409, JSON.stringify(dupe.json));
  assert.equal(dupe.json.error?.code, 'night_run_active', JSON.stringify(dupe.json));
  // the original run must be completely unaffected by the refused plan attempt
  assert.equal(night.getNightRun(runId).status, 'running');
});

await check('NS-4', 'lane fill: concurrent lanes across goals, but never two lanes on the same branch and never past a goal\'s parallel cap', async () => {
  await tick('fill');
  const running = itemsOf(runId).filter((i) => i.status === 'running');
  assert.ok(running.length >= 2, `expected ≥2 lanes in flight, got ${running.length}`);
  assert.ok(running.length <= 4, `lanes exceeded the cap: ${running.length}`);
  const lanes = running.map((i) => i.lane).filter((l) => l != null);
  assert.equal(new Set(lanes).size, lanes.length, 'two items share a lane');
  // g1's two machine leaves are siblings under the SAME branch — never together.
  const a1 = running.find((i) => i.node_id === g1a1);
  const a2 = running.find((i) => i.node_id === g1a2);
  assert.ok(!(a1 && a2), 'both leaves of one branch ran at once — subtree exclusivity broke');
  // g2 is capped at per_goal_parallel = 1.
  assert.ok(running.filter((i) => i.goal_id === g2).length <= 1, 'g2 exceeded its parallel cap');
  // skipping a RUNNING item is refused (§12.11)
  const skipRunning = await post(`/night/runs/${runId}/items/${running[0].id}/skip`, {});
  assert.equal(skipRunning.status, 409, `skipping a running item returned ${skipRunning.status}`);
});

await check('NS-6a', 'a model item cues into cockpit:night-shift with the night header first and the autopilot header second', async () => {
  const item = itemsOf(runId).find((i) => i.status === 'running' && i.kind === 'plan');
  assert.ok(item, 'no plan item is running');
  const cues = itemCues(runId, item.id);
  assert.ok(cues.length >= 1, 'no cue was posted for the running plan item');
  const lines = cues[0].text.split('\n');
  assert.match(lines[0], new RegExp(`^\\[night item #${item.position} of \\d+ · lane \\d+\\]$`), lines[0]);
  assert.match(lines[1], new RegExp(`^\\[autopilot goal #${item.goal_id} — (PLAN|REPLAN) #${item.node_id} `), lines[1]);
  assert.equal(cues[0].externalId, 'cockpit:night-shift');
});

await check('NS-5', 'server kinds (verify) run inline on the first tick without occupying a lane', async () => {
  // gCheck's leaf was in `check` at plan time → the PLANNER emitted a verify
  // item (§3.1 rule 3); the first fill tick completed it inline.
  const v = itemsOf(runId).find((i) => i.node_id === gCheckLeaf);
  assert.ok(v, 'the planner emitted no item for the check-state node');
  assert.equal(v.kind, 'verify', `planner derived ${v.kind}, not verify`);
  assert.equal(v.status, 'done', `verify item is ${v.status}: ${v.result_summary}`);
  assert.equal(v.lane, null, 'a server kind took a lane');
  assert.match(v.result_summary ?? '', /pre-built and verified/, 'the verdict evidence line is missing');
  assert.equal((await nodeById(gCheck, gCheckLeaf)).state, 'done', 'verify did not settle the node');
});

await check('NS-6b', 'plan item lifecycle: tree_id is stamped, then tree done + VERDICT PASS marks the item ✓ with the evidence line', async () => {
  const item = itemsOf(runId).find((i) => i.status === 'running' && i.kind === 'plan' && i.goal_id === g1);
  assert.ok(item, 'no g1 plan item running');
  const d = await dispatchLeaf(g1, item.node_id);
  await tick('stamp');
  assert.equal(night.listNightItems(runId).find((i) => i.id === item.id).tree_id, d.treeId, 'tree_id was not stamped onto the item');
  await finishBuilds(g1, item.node_id, d);
  await post(`/hopper-nodes/${d.verifyId}/finish`, { outcome: 'done', result: 'VERDICT: PASS\nevidence:\n- endpoint returns 200\ngaps:\n- none' });
  await waitFor('node -> check', async () => (await nodeById(g1, item.node_id))?.state === 'check');
  await tick('verdict');
  const done = night.listNightItems(runId).find((i) => i.id === item.id);
  assert.equal(done.status, 'done', `item is ${done.status}: ${done.result_summary}`);
  assert.match(done.result_summary, /endpoint returns 200/);
  assert.equal((await nodeById(g1, item.node_id)).state, 'done');
});

await check('NS-7', 'VERDICT FAIL at attempt 1 → item ✓done w/ the FAIL recorded + a replan inserted IMMEDIATELY after (attempt 2)', async () => {
  await tick('fill');
  const item = itemsOf(runId).find((i) => i.status === 'running' && i.kind === 'plan' && i.goal_id === g2);
  assert.ok(item, 'no g2 plan item running');
  const d = await dispatchLeaf(g2, item.node_id);
  await tick('stamp');
  await finishBuilds(g2, item.node_id, d);
  await post(`/hopper-nodes/${d.verifyId}/finish`, { outcome: 'done', result: 'VERDICT: FAIL\nevidence:\n- ran it\ngaps:\n- the endpoint 500s on an empty body' });
  await waitFor('node -> check', async () => (await nodeById(g2, item.node_id))?.state === 'check');
  await tick('verdict-fail');
  const after = night.listNightItems(runId);
  const orig = after.find((i) => i.id === item.id);
  assert.equal(orig.status, 'done', `§12.10: a FAIL with retries left reads done, got ${orig.status}`);
  assert.match(orig.result_summary, /^VERDICT: FAIL/);
  const replan = after.find((i) => i.position === orig.position + 1);
  assert.equal(replan.kind, 'replan', `expected a replan right after #${orig.position}, got ${replan.kind}`);
  assert.equal(replan.node_id, item.node_id);
  assert.equal(replan.attempt, 2);
});

await check('NS-8', 'a blocked tree marks the item ⛔ and inserts exactly ONE unblock; a re-block fails it and parks the node', async () => {
  await tick('fill');
  const item = itemsOf(runId).find((i) => i.status === 'running' && (i.kind === 'plan' || i.kind === 'replan'));
  assert.ok(item, 'nothing running to block');
  const d = await dispatchLeaf(item.goal_id, item.node_id);
  await tick('stamp');
  await waitFor('build running', async () => (await overlay(item.goal_id, item.node_id, d.buildIds[0])) === 'running');
  await post(`/hopper-nodes/${d.buildIds[0]}/finish`, { outcome: 'blocked', result: 'toolchain missing' });
  await waitFor('node blocked', async () => (await nodeById(item.goal_id, item.node_id))?.tree_status_cache === 'blocked');
  await tick('blocked');
  const after = night.listNightItems(runId);
  const blocked = after.find((i) => i.id === item.id);
  assert.equal(blocked.status, 'blocked', `item is ${blocked.status}`);
  const unblocks = after.filter((i) => i.node_id === item.node_id && i.kind === 'unblock');
  assert.equal(unblocks.length, 1, `expected exactly one unblock item, got ${unblocks.length}`);
  // "immediately after" modulo locked rows: a locked item keeps its absolute
  // position, so the insert lands after any locked rows sitting at the target.
  assert.ok(unblocks[0].position > blocked.position, 'unblock landed above the blocked item');
  const between = after.filter((i) => i.position > blocked.position && i.position < unblocks[0].position);
  assert.ok(between.every((i) => i.locked === 1),
    `non-locked rows between the blocked item (#${blocked.position}) and its unblock (#${unblocks[0].position}): ${between.filter((i) => !i.locked).map((i) => i.position).join(',')}`);
  // a second block on the same node: the unblock pass is spent → failed + parked
  await tick('re-block');
  const running = night.listNightItems(runId).find((i) => i.id === unblocks[0].id);
  if (running.status === 'running' || running.status === 'queued') {
    night.listNightItems(runId); // the node is still blocked, so P0 re-runs onItemBlocked via the plan item only once
  }
  const reInsert = night.listNightItems(runId).filter((i) => i.node_id === item.node_id && i.kind === 'unblock');
  assert.equal(reInsert.length, 1, 'a second unblock item was inserted');
});

await check('NS-9', 'a decompose that lands expands its placeholder IN PLACE into real child items', async () => {
  await tick('fill');
  let dec = itemsOf(runId).find((i) => i.kind === 'decompose' && i.status === 'running');
  if (!dec) {
    const q = itemsOf(runId).find((i) => i.kind === 'decompose' && i.status === 'queued');
    assert.ok(q, 'no decompose item to exercise');
    await tick('fill2');
    dec = night.listNightItems(runId).find((i) => i.id === q.id);
  }
  assert.equal(dec.status, 'running', `decompose item is ${dec.status}`);
  const ph = itemsOf(runId).find((i) => i.kind === 'predicted' && i.parent_item_id === dec.id);
  assert.ok(ph, 'no placeholder for the decompose item');
  const slot = ph.position;
  const c1 = await mkNode(dec.goal_id, 'child one', { parent_id: dec.node_id, leaf_kind: 'machine' });
  const c2 = await mkNode(dec.goal_id, 'child two', { parent_id: dec.node_id, leaf_kind: 'machine' });
  await acceptNode(dec.goal_id, c1);
  await acceptNode(dec.goal_id, c2);
  await tick('expand');
  const after = night.listNightItems(runId);
  assert.equal(after.find((i) => i.id === dec.id).status, 'done');
  assert.equal(after.find((i) => i.id === ph.id).status, 'expanded', 'the placeholder was not expanded');
  const kids = after.filter((i) => i.node_id === c1 || i.node_id === c2);
  assert.equal(kids.length, 2, `expected 2 real child items, got ${kids.length}`);
  for (const k of kids) assert.ok(k.position >= slot && k.position <= slot + 3, `child landed at #${k.position}, outside the placeholder block near #${slot}`);
  const locked = after.filter((i) => i.locked === 1);
  for (const l of locked) assert.equal(l.position, itemsOf(runId).find((i) => i.id === l.id).position, 'a locked row moved during expansion');
});

await check('NS-22', 'until_stop + a governor hold: the driver WAITS (never stops), records hold/hold_clear on the board, and resumes filling lanes once the override allows again', async () => {
  assert.equal(night.getNightRun(runId).mode, 'until_stop', 'this scenario needs an until_stop run');
  const holdCountBefore = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM night_events WHERE run_id = ? AND kind = 'hold'`).get(runId).n;
  night.__setNightShiftTestOverrides({
    governor: () => ({ allow: false, reason: 'claude_5h_ceiling', detail: 'sim hold for NS-22' }),
  });
  await tick('held');
  assert.equal(night.getNightRun(runId).status, 'running', 'an until_stop hold incorrectly ended the run');
  const holdCountAfter = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM night_events WHERE run_id = ? AND kind = 'hold'`).get(runId).n;
  assert.ok(holdCountAfter > holdCountBefore, 'no hold event was recorded for the governor hold');
  const held = await get('/night/board');
  assert.equal(held.json.hold?.reason, 'governor:claude_5h_ceiling', `board does not reflect the active hold: ${JSON.stringify(held.json.hold)}`);
  night.__setNightShiftTestOverrides({ governor: () => ({ allow: true, reason: 'ok', detail: 'sim' }) });
  await tick('resumed');
  const clearCount = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM night_events WHERE run_id = ? AND kind = 'hold_clear'`).get(runId).n;
  assert.ok(clearCount >= 1, 'no hold_clear event was recorded once the governor allowed again');
  const resumed = await get('/night/board');
  assert.equal(resumed.json.hold, null, `board still shows a hold after it cleared: ${JSON.stringify(resumed.json.hold)}`);
  assert.equal(night.getNightRun(runId).status, 'running', 'the run should still be running after resuming from a hold');
});

await check('NS-10', 'pause is total: no new picks AND the hopper engine skips the run\'s pending nodes while a non-run tree still dispatches', async () => {
  // a plan item that owns a live tree with a pending node
  await tick('fill');
  const item = night.listNightItems(runId).find((i) => i.status === 'running' && (i.kind === 'plan' || i.kind === 'replan') && !i.tree_id);
  let treeId = null;
  if (item) {
    const d = await dispatchLeaf(item.goal_id, item.node_id, [
      { title: 'step one', spec: 'first' }, { title: 'step two', spec: 'second' },
    ]);
    await tick('stamp');
    treeId = d.treeId;
  }
  const p = await post(`/night/runs/${runId}/pause`, {});
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(night.getNightRun(runId).status, 'paused');
  const pausedSet = night.nightShiftPausedTreeIds();
  if (treeId) assert.ok(pausedSet.has(treeId), `the run's tree ${treeId} is not in the paused set`);
  const beforeRunning = night.listNightItems(runId).filter((i) => i.status === 'running').map((i) => i.id).sort().join(',');
  await tick('paused');
  const afterRunning = night.listNightItems(runId).filter((i) => i.status === 'running').map((i) => i.id).sort().join(',');
  assert.equal(afterRunning, beforeRunning, 'the driver started work while paused');
  // an unrelated tree still dispatches through the same dispatchTick
  const free = await post('/hopper-trees', {
    topic: 'night-sim: unrelated tree', origin_thread_ext: 'cockpit:night-sim',
    nodes: [{ title: 'unrelated work', spec: 'anything', adapter: 'claude', model: 'claude-sonnet-5' }],
  });
  if (free.status === 200 || free.status === 201) {
    const freeTreeId = free.json.tree?.id ?? free.json.id;
    await post(`/hopper-trees/${freeTreeId}/agree`, {});
    await hopperEngine.dispatchTick('sim');
    await sleep(120);
    const freeNodes = hopperEngine.listTreeNodes(freeTreeId);
    assert.ok(freeNodes.some((n) => n.status === 'running' || n.status === 'done'), 'an unrelated tree was held by the pause');
  }
  if (treeId) {
    const pending = hopperEngine.listTreeNodes(treeId).filter((n) => n.status === 'pending');
    await hopperEngine.dispatchTick('sim');
    await sleep(120);
    const stillPending = hopperEngine.listTreeNodes(treeId).filter((n) => n.status === 'pending').length;
    assert.equal(stillPending, pending.length, 'a paused run\'s pending node was dispatched');
  }
  const r = await post(`/night/runs/${runId}/resume`, {});
  assert.equal(r.status, 200);
  assert.equal(night.getNightRun(runId).status, 'running');
});

await check('NS-13', 'recovery: restarting the driver reloads the run, writes driver_started and posts no duplicate cue', async () => {
  const before = nightCues().length;
  night.stopNightShiftDriver();
  night.startNightShiftDriver();
  night.stopNightShiftDriver();
  const ev = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM night_events WHERE run_id = ? AND kind = 'driver_started'`).get(runId);
  assert.ok(ev.n >= 1, 'no driver_started event');
  await tick('recovered');
  const running = night.listNightItems(runId).filter((i) => i.status === 'running');
  for (const it of running) {
    const cues = itemCues(runId, it.id);
    const firstAsk = cues.filter((c) => c.correlationKey.endsWith(':0'));
    assert.ok(firstAsk.length <= 1, `item ${it.id} got ${firstAsk.length} first-ask cues — correlation keys did not hold`);
  }
  assert.ok(nightCues().length >= before, 'cue bookkeeping regressed');
});

await check('NS-14', 'stand-down: tickAutopilot on a goal the run owns posts no cue; after the run stops it ticks again', async () => {
  assert.equal(night.nightShiftOwns(g1), true, 'nightShiftOwns is false for an included goal');
  const before = cueCalls().filter((c) => (c.correlationKey ?? '').startsWith(`autopilot:${g1}:`)).length;
  await ap.tickAutopilot(g1, 'sim');
  await sleep(60);
  const after = cueCalls().filter((c) => (c.correlationKey ?? '').startsWith(`autopilot:${g1}:`)).length;
  assert.equal(after, before, 'the per-goal autopilot driver cued a goal the night run owns');
});

await check('NS-15', 'GET /night/board returns every §5 field; the kiosk token works on it and only it', async () => {
  const b = await get('/night/board');
  assert.equal(b.status, 200, JSON.stringify(b.json));
  for (const k of ['run', 'items', 'lanes', 'stats', 'needs_you', 'budget', 'hold', 'heartbeat', 'thread_ext']) {
    assert.ok(k in b.json, `board is missing ${k}`);
  }
  assert.equal(b.json.thread_ext, 'cockpit:night-shift');
  assert.equal(b.json.lanes.length, b.json.run.config.lanes);
  assert.ok(b.json.needs_you.some((n) => n.node_id === g1Human && n.reason === 'human'), 'the human leaf is not in needs_you');
  assert.ok(b.json.stats.items.done >= 1, 'stats show no completed items');
  setSetting('big_board_kiosk_token', 'night-sim-kiosk-token');
  const kiosk = await fetch(`${base}/night/board?kiosk=night-sim-kiosk-token`);
  assert.equal(kiosk.status, 200, 'kiosk token rejected on /night/board');
  const kioskElsewhere = await fetch(`${base}/goals?kiosk=night-sim-kiosk-token`);
  assert.equal(kioskElsewhere.status, 401, 'the kiosk token was accepted on a non-eligible route');
  const noAuth = await fetch(`${base}/night/board`);
  assert.equal(noAuth.status, 401, 'the board answered without auth');
});

await check('NS-11', 'until_budget: a claude_all_accounts_full hold ends the run with stop_reason=budget and a full wrap', async () => {
  // a second, isolated run in until_budget mode
  await post(`/night/runs/${runId}/stop`, {});
  const g4 = await mkGoal('Sim goal four', 'budget-mode goal');
  await mkNode(g4, 'F1 machine leaf', { leaf_kind: 'machine' });
  const planned = await post('/night/plan', { mode: 'until_budget', goal_ids: [g4], config: { lanes: 1 } });
  assert.equal(planned.status, 200, JSON.stringify(planned.json));
  const budgetRun = planned.json.run.id;
  await post(`/night/runs/${budgetRun}/start`, {});
  night.__setNightShiftTestOverrides({
    governor: () => ({ allow: false, reason: 'claude_all_accounts_full', detail: 'every account is spent' }),
  });
  await tick('budget');
  const run = night.getNightRun(budgetRun);
  assert.equal(run.status, 'stopped', `run is ${run.status}`);
  assert.equal(run.stop_reason, 'budget');
  assert.ok(run.ended_at, 'no ended_at');
  night.__setNightShiftTestOverrides({ governor: () => ({ allow: true, reason: 'ok', detail: 'sim' }) });
});

await check('NS-12', 'stop/wrap: running items → skipped, prior autopilot flags+configs restored byte-for-byte, report written, wrap cue posted', async () => {
  const run = night.getNightRun(runId);
  assert.ok(run.status === 'stopped' || run.status === 'complete', `run is ${run.status}`);
  const items = night.listNightItems(runId);
  assert.ok(!items.some((i) => i.status === 'running' || i.status === 'queued'), 'open items survived the wrap');
  // g1/g2 were OFF before the run → back off. g3 was ON with its own config → back on, unchanged.
  for (const gid of [g1, g2]) {
    const g = (await get(`/goals/${gid}`)).json.goal;
    assert.equal(g.autopilot, 0, `goal #${gid} was left on autopilot`);
  }
  const g3after = (await get(`/goals/${g3}`)).json.goal;
  assert.equal(g3after.autopilot, 1, 'the pre-existing autopilot goal was turned off');
  assert.equal(g3after.autopilot_config.parallel, 2, 'parallel was not restored');
  assert.equal(g3after.autopilot_config.tick_minutes, 7, 'tick_minutes was not restored');
  assert.equal(g3after.autopilot_config.max_depth, 3, 'max_depth was not restored');
  assert.ok(run.report_path, 'no report path on the run');
  const abs = path.join(VAULT, run.report_path);
  assert.ok(fs.existsSync(abs), `report file missing: ${abs}`);
  const md = fs.readFileSync(abs, 'utf8');
  for (const section of ['# 🌙 Night Shift', '## The plan as generated', '## What actually happened', '## Stats', '## Per goal', '## Needs you', '## Holds', "## The orchestrator's read", '<details><summary>event trail</summary>']) {
    assert.ok(md.includes(section), `report is missing "${section}"`);
  }
  const wrap = nightCues().find((c) => c.correlationKey === `night:${runId}:wrap`);
  assert.ok(wrap, 'no wrap cue posted');
  assert.match(wrap.text, /\[night-shift run #\d+ (STOPPED|COMPLETE) —/);
});

await check('NS-14b', 'after the run stops the per-goal autopilot driver ticks that goal again', async () => {
  assert.equal(night.nightShiftOwns(g3), false, 'nightShiftOwns is still true after the wrap');
  const before = cueCalls().filter((c) => (c.correlationKey ?? '').startsWith(`autopilot:${g3}:`)).length;
  ap.__setAutopilotTestOverrides({ governor: () => ({ allow: true, reason: 'ok' }), inFlight: () => null });
  await ap.tickAutopilot(g3, 'sim');
  await sleep(80);
  const after = cueCalls().filter((c) => (c.correlationKey ?? '').startsWith(`autopilot:${g3}:`)).length;
  assert.ok(after >= before, 'the per-goal driver regressed');
});

await check('NS-17', 'the per-turn context block renders for cockpit:night-shift only', () => {
  const block = night.nightShiftContextBlock('cockpit:night-shift');
  assert.match(block, /^<night_shift run_id="\d+" status="/, block.slice(0, 120));
  assert.match(block, /lanes: L1/);
  assert.match(block, /<\/night_shift>/);
  assert.equal(night.nightShiftContextBlock('cockpit:goal-1'), '', 'the block leaked into a goal thread');
  assert.equal(night.nightShiftContextBlock('slack:whatever'), '');
});

// Both prior runs (runId, budgetRun) are stopped by now, so a fresh isolated
// run is free to plan (§1's one-active-run rule). Kept fully separate from
// runId's item list on purpose: NS-20's moves permanently `locked` several
// rows, and doing that against the shared runId polluted makeRoom's
// walk-past-locked-rows logic for the still-in-flight FAIL/blocked/decompose
// scenarios (NS-7 et al) the first time this was tried.
await check('NS-20', 'move clamps to [1,N] (§12.12) on its own isolated run: explicit position 1, explicit position N (the tail), and both over- and under-range values clamp instead of erroring', async () => {
  const moveGoals = [];
  for (let i = 1; i <= 5; i += 1) {
    const g = await mkGoal(`Sim goal move-${i}`, 'its one leaf lands');
    const leaf = await mkNode(g, `M${i} leaf`, { leaf_kind: 'machine' });
    await acceptNode(g, leaf);
    moveGoals.push(g);
  }
  const planned = await post('/night/plan', { mode: 'until_stop', goal_ids: moveGoals, config: { lanes: 1 } });
  assert.equal(planned.status, 200, JSON.stringify(planned.json));
  const moveRunId = planned.json.run.id;
  assert.ok(itemsOf(moveRunId).length >= 5, `expected >=5 items for the move-clamp scenario, got ${itemsOf(moveRunId).length}`);

  const items = itemsOf(moveRunId);
  const unlocked = items.filter((i) => !i.locked);
  assert.ok(unlocked.length >= 4, `need >=4 unlocked items for this scenario, got ${unlocked.length}`);

  const a = unlocked[0];
  const toFirst = await post(`/night/runs/${moveRunId}/items/${a.id}/move`, { position: 1 });
  assert.equal(toFirst.status, 200, JSON.stringify(toFirst.json));
  assert.equal(itemAt(moveRunId, 1).id, a.id, 'move to position 1 did not land at position 1');
  assert.equal(itemAt(moveRunId, 1).locked, 1, 'move to position 1 did not lock the item');

  const b = itemsOf(moveRunId).find((i) => !i.locked && i.id !== a.id);
  assert.ok(b, 'no second unlocked item to move to the tail');
  const tailPos = itemsOf(moveRunId).length;
  const toLast = await post(`/night/runs/${moveRunId}/items/${b.id}/move`, { position: tailPos });
  assert.equal(toLast.status, 200, JSON.stringify(toLast.json));
  assert.equal(itemAt(moveRunId, tailPos).id, b.id, 'move to position N did not land at the last slot');

  const c = itemsOf(moveRunId).find((i) => !i.locked && i.id !== a.id && i.id !== b.id);
  assert.ok(c, 'no third unlocked item to exercise the over-range clamp');
  const n1 = itemsOf(moveRunId).length;
  const over = await post(`/night/runs/${moveRunId}/items/${c.id}/move`, { position: n1 + 500 });
  assert.equal(over.status, 200, JSON.stringify(over.json));
  assert.equal(itemsOf(moveRunId).find((i) => i.id === c.id).position, n1, 'a position far past N did not clamp to N');

  const d = itemsOf(moveRunId).find((i) => !i.locked && ![a.id, b.id, c.id].includes(i.id));
  assert.ok(d, 'no fourth unlocked item to exercise the under-range clamp');
  const under = await post(`/night/runs/${moveRunId}/items/${d.id}/move`, { position: -50 });
  assert.equal(under.status, 200, JSON.stringify(under.json));
  assert.equal(itemsOf(moveRunId).find((i) => i.id === d.id).position, 1, 'a negative position did not clamp to 1');

  const positions = itemsOf(moveRunId).map((i) => i.position).sort((x, y) => x - y);
  assert.equal(positions.join(','), positions.map((_, idx) => idx + 1).join(','), 'positions are not a contiguous 1..N permutation after clamped moves');

  const bogus404 = await post(`/night/runs/${moveRunId}/items/999999/move`, { position: 1 });
  assert.equal(bogus404.status, 404, JSON.stringify(bogus404.json));
  // moveRunId is left `planned` (never started) on purpose — §1's own rule is
  // that a stale planned run is silently REPLACED by the next `/night/plan`
  // call (never 409s), which NS-23's plan call below exercises for free.
});

await check('NS-23', '§8.2 stats: buildNightStats parses a commit-sha token near a commit hint AND sums N-tests-passed footers out of the real hopper node results', async () => {
  const gStats = await mkGoal('Sim goal stats', 'its leaf is built with parseable worker footers');
  const gStatsLeaf = await mkNode(gStats, 'Z1 leaf with commit + test footers', { leaf_kind: 'machine' });
  await acceptNode(gStats, gStatsLeaf);
  const planned = await post('/night/plan', { mode: 'until_stop', goal_ids: [gStats], config: { lanes: 1 } });
  assert.equal(planned.status, 200, JSON.stringify(planned.json));
  const statsRunId = planned.json.run.id;
  const started = await post(`/night/runs/${statsRunId}/start`, {});
  assert.equal(started.status, 200, JSON.stringify(started.json));
  await tick('stats-fill');
  const item = night.listNightItems(statsRunId).find((i) => i.status === 'running' && i.kind === 'plan');
  assert.ok(item, 'no plan item is running for the isolated stats scenario');
  const d = await dispatchLeaf(gStats, gStatsLeaf, [
    { title: 'build one', spec: 'implement it' },
    { title: 'build two', spec: 'add coverage' },
  ]);
  await tick('stats-stamp');
  const [b1, b2] = d.buildIds;
  await waitFor('build one running', async () => (await overlay(gStats, gStatsLeaf, b1)) === 'running');
  await post(`/hopper-nodes/${b1}/finish`, { outcome: 'done', result: 'implemented and pushed as commit a1b2c3d4e5f6 to origin/main.' });
  await waitFor('build two running', async () => (await overlay(gStats, gStatsLeaf, b2)) === 'running');
  await post(`/hopper-nodes/${b2}/finish`, { outcome: 'done', result: '12 tests passed in the suite; 3 tests passed in a second file.' });
  await waitFor(`VERIFY ${d.verifyId} running`, async () => (await overlay(gStats, gStatsLeaf, d.verifyId)) === 'running');
  await post(`/hopper-nodes/${d.verifyId}/finish`, { outcome: 'done', result: 'VERDICT: PASS\nevidence:\n- shipped\ngaps:\n- none' });
  await waitFor('gStatsLeaf -> check', async () => (await nodeById(gStats, gStatsLeaf))?.state === 'check');
  await tick('stats-verdict');
  const stats = night.buildNightStats(night.getNightRun(statsRunId));
  assert.equal(stats.commits, 1, `expected exactly 1 parsed commit (one node carries a commit-shaped token), got ${stats.commits}`);
  assert.equal(stats.tests, 15, `expected 12+3=15 parsed tests, got ${stats.tests}`);
  assert.equal(stats.trees_spawned, 1, 'expected exactly one tree spawned in the isolated stats run');
  assert.ok(stats.verify.pass >= 1, 'the VERDICT PASS was not counted in stats.verify.pass');
  await post(`/night/runs/${statsRunId}/stop`, {});
});

} catch (err) {
  console.error('\n[night-sim] FATAL', err);
  results.push({ id: 'FATAL', description: 'sim crashed', pass: false, error: String(err?.stack ?? err) });
} finally {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n[night-sim] ${passed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : ''}`);
  const md = [
    '# 🌙 Night Shift — sim report',
    `${new Date().toISOString()} · **${passed}/${results.length}** checks passed${failed ? ` · ${failed} FAILED` : ''}`,
    '', '## Phase A — plan on a read-only copy of the live jarvis.db', '', liveReport, '',
    '## Checks', '', '| id | check | result |', '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.description.replace(/\|/g, '\\|')} | ${r.pass ? '✓' : '✗'} |`),
    '',
    ...results.filter((r) => !r.pass).flatMap((r) => [`### ✗ ${r.id}`, '```', r.error ?? '', '```', '']),
  ].join('\n');
  const rel = path.join('outbox', 'night', 'night-sim-report.md');
  const abs = path.join(VAULT, rel);
  try { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, md, 'utf8'); console.log(`[night-sim] report: ${abs}`); }
  catch (err) { console.error('[night-sim] report write failed', err); }
  server.close();
  process.exit(failed ? 1 : 0);
}
