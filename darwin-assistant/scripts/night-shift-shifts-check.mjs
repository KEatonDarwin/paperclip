// SHIFTS v1 CHECK (skills/night-shift/SHIFTS.md §3.1–§3.4, tree-f3c53854 #830)
//
// The REGRESSION suite for the two failures Shifts v1 exists to fix, plus the
// session surface. Drives the REAL src/night-shift.ts + goals.ts +
// goals-autopilot.ts + hopper-engine.ts through the REAL createApiV1Router()
// over HTTP on a throwaway port, against a SCRATCH sqlite DB.
//
// NO MODEL CALLS ANYWHERE: the ESM loader hooks stub the one dynamic
// `import('./agent.js')` that postCue / tree-cue perform, and the hopper worker
// spawn is a fake processMessage. The suite asserts `pgrep -c claude` is
// unchanged across the whole run.
//
//   npm run night:shifts-check
//
// The two required regressions (SHIFTS.md §3.3.4):
//   SH-R1  run #1's exact stuck state → the run CONTINUES, it does not stop.
//   SH-R2  goal 6's tree shape → #99, #100 and #62–#65 are planned (or arrive
//          on the first re-plan), and the run does not stop `complete` while
//          they are open.

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
const SCRATCH_DIR = process.env.SHIFTS_CHECK_DIR ?? path.join(os.homedir(), '.cache', 'shifts-check');
fs.mkdirSync(SCRATCH_DIR, { recursive: true });
const DB_PATH = path.resolve(process.env.JARVIS_DB_PATH ?? path.join(SCRATCH_DIR, 'shifts-check.db'));
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
process.env.JARVIS_DB_PATH = DB_PATH;

process.env.HOPPER_GOV_ENABLED = '0';
process.env.HOPPER_ENGINE_SLOTS = '8';
process.env.GOAL_GUARD_POLLER = '0';
process.env.GOALS_AUTOPILOT_DRIVER = '0';
process.env.GOALS_AUTOPILOT_KICK_MS = '999999999';
process.env.NIGHT_SHIFT_DRIVER = '0';
process.env.NIGHT_SHIFT_KICK_MS = '999999999';
const STOP_FILE = path.join(SCRATCH_DIR, 'shifts-check.stop');
process.env.NIGHT_SHIFT_STOP_FILE = STOP_FILE;
fs.rmSync(STOP_FILE, { force: true });
const VAULT = path.join(SCRATCH_DIR, 'vault');
fs.rmSync(VAULT, { recursive: true, force: true });
process.env.GOALS_VAULT_ROOT = VAULT;
delete process.env.ANTHROPIC_API_KEY;

// ── the no-spawn proof (SHIFTS.md §4) ──────────────────────────────────────
// A global `pgrep -c claude` is racy on this box: jarvis.service workers
// (including whichever one is RUNNING this suite) start and stop constantly,
// so the count moves for reasons that have nothing to do with the suite.
// What the rail actually forbids is THIS SUITE spawning a model call — and any
// process the suite spawns is a descendant of this node process. Count those.
function claudeProcs() {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
    const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/, 3));
    const kids = new Map();
    for (const [pid, ppid] of rows) {
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(pid);
    }
    const mine = new Set();
    const stack = [String(process.pid)];
    while (stack.length) {
      const p = stack.pop();
      for (const c of kids.get(p) ?? []) { if (!mine.has(c)) { mine.add(c); stack.push(c); } }
    }
    return rows.filter(([pid, , comm]) => mine.has(pid) && /claude/i.test(comm ?? '')).length;
  } catch { return 0; }
}
const CLAUDE_BEFORE = claudeProcs();
console.log(`[shifts-check] scratch DB: ${DB_PATH} · claude procs (suite descendants) before: ${CLAUDE_BEFORE}`);

const distDir = path.join(repoRoot, 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const hopperEngine = await import(path.join(distDir, 'hopper-engine.js'));
const night = await import(path.join(distDir, 'night-shift.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));
const tools = await import(path.join(distDir, 'tools', 'index.js'));

async function fakeProcessMessage() { return 'FAKE_WORKER_OK — no model call made.'; }
hopperEngine.startHopperEngine(fakeProcessMessage);
night.__setNightShiftTestOverrides({ governor: () => ({ allow: true, reason: 'ok', detail: 'shifts-check' }) });

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const adminKey = mintApiKey('shifts-check-admin', 'cockpit').plaintext;

async function req(method, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminKey}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const get = (p) => req('GET', p);
const post = (p, b = {}) => req('POST', p, b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = async (why = 'check') => { await night.tickNightShift(why); await sleep(40); };
function cueCalls() { return globalThis.__goalsCueCalls ?? []; }

const results = [];
async function check(id, description, fn) {
  try { await fn(); results.push({ id, description, pass: true }); console.log(`  ✓ [${id}] ${description}`); }
  catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    results.push({ id, description, pass: false, error: msg });
    console.log(`  ✗ [${id}] ${description}\n      ${msg}`);
  }
}

// ── goal builders ──────────────────────────────────────────────────────────
async function mkGoal(title) {
  const r = await post('/goals', { title, done_means: `${title} is done`, authored_by: 'kevin' });
  if (r.status !== 201) throw new Error(`createGoal failed: ${JSON.stringify(r.json)}`);
  return r.json.goal.id;
}
async function mkNode(goalId, title, opts = {}) {
  const r = await post(`/goals/${goalId}/nodes`, {
    title, done_means: `${title} verified`, parent_id: opts.parent_id ?? null,
    authored_by: 'kevin', leaf_kind: opts.leaf_kind,
  });
  if (r.status !== 201) throw new Error(`createNode failed: ${JSON.stringify(r.json)}`);
  const id = r.json.node.id;
  const a = await post(`/goals/${goalId}/nodes/${id}/accept`, { actor: 'jarvis' });
  if (a.status !== 200 && a.status !== 409) throw new Error(`accept failed: ${JSON.stringify(a.json)}`);
  return id;
}
/** Force a node straight to `done` in the DB — the suite is about SCHEDULING,
 *  not about re-proving the goals verify path (goals:sim owns that). */
function forceDone(nodeId) {
  sqliteDb.prepare(`UPDATE goal_nodes SET state = 'done' WHERE id = ?`).run(nodeId);
}
function nodeState(nodeId) {
  return sqliteDb.prepare(`SELECT state FROM goal_nodes WHERE id = ?`).get(nodeId)?.state;
}
function itemsOf(runId) { return night.listNightItems(runId); }
function itemFor(runId, nodeId) { return itemsOf(runId).filter((i) => i.node_id === nodeId); }

// ═══════════════════════════════════════════════════════════════════════════
try {

// ── SH-R2 — GOAL 6's TREE SHAPE ────────────────────────────────────────────
//
// Mirrors the live goal 6 on 2026-09-25, which planned FOUR items while six
// nodes of machine work sat open:
//   root: 59(done) 60(done, children done) 61(set) 62 63 64 65 (set, no kids)
//   61  : 97(done) 98(set) 99(machine set) 100(machine set)
//   98  : 101(machine set) 102(machine set)
// The parent-settle bug meant 98 never settled → 99/100 dropped; 61 never
// settled → 62–65 dropped. Four items, then `complete`.
const g6 = await mkGoal('G6 — the notepad');
const n59 = await mkNode(g6, 'N59 the notepad itself', { leaf_kind: 'machine' });
const n60 = await mkNode(g6, 'N60 line identity');
const n90 = await mkNode(g6, 'N90 break the algorithm', { parent_id: n60, leaf_kind: 'machine' });
const n61 = await mkNode(g6, 'N61 the settle-and-reread pass');
const n62 = await mkNode(g6, 'N62 JARVIS speaks only when it has something');
const n63 = await mkNode(g6, 'N63 the handoff prompt');
const n64 = await mkNode(g6, 'N64 notes feed the machinery');
const n65 = await mkNode(g6, 'N65 yesterday rolls forward');
const n97 = await mkNode(g6, 'N97 detect settle server-side', { parent_id: n61, leaf_kind: 'machine' });
const n98 = await mkNode(g6, 'N98 the cheap gate', { parent_id: n61 });
const n99 = await mkNode(g6, 'N99 re-read the whole note', { parent_id: n61, leaf_kind: 'machine' });
const n100 = await mkNode(g6, 'N100 wire settle -> gate -> re-read', { parent_id: n61, leaf_kind: 'machine' });
const n101 = await mkNode(g6, 'N101 the deterministic prefilter', { parent_id: n98, leaf_kind: 'machine' });
const n102 = await mkNode(g6, 'N102 the haiku one-shot', { parent_id: n98, leaf_kind: 'machine' });
for (const id of [n59, n60, n90, n97]) forceDone(id);

let r2Run = -1;
await check('SH-R2', "goal 6's shape: a decomposed parent no longer swallows its later siblings — #99, #100 and #62–#65 are all planned", async () => {
  const r = await post('/night/plan', { mode: 'until_stop', goal_ids: [g6], config: { lanes: 3 }, label: 'goal 6 push', brief: 'focus goal 6, Claude A' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r2Run = r.json.run.id;
  const items = itemsOf(r2Run);
  const scheduled = new Set(items.map((i) => i.node_id).filter((x) => x != null));
  // The live bug produced exactly 4 items and none of these.
  for (const [id, name] of [[n101, '#101'], [n102, '#102'], [n99, '#99'], [n100, '#100'], [n62, '#62'], [n63, '#63'], [n64, '#64'], [n65, '#65']]) {
    assert.ok(scheduled.has(id), `${name} was dropped from the plan — the parent-settle bug is back (plan had ${items.length} items: ${[...scheduled].join(',')})`);
  }
  // …and the lane sim can actually schedule them all, so nothing lands ETA-less.
  for (const it of items) {
    assert.ok(it.eta_at, `item #${it.position} (${it.kind} node ${it.node_id}) has no eta_at — the lane sim could not schedule it`);
  }
  assert.ok(items.length >= 8, `expected ≥8 items, got ${items.length}`);
});

await check('SH-R2b', 'the run does not stop `complete` while #62–#65 are still open work', async () => {
  const s = await post(`/night/runs/${r2Run}/start`);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  for (let i = 0; i < 6; i += 1) await tick('r2');
  const run = night.getNightRun(r2Run);
  assert.equal(run.status, 'running', `run ended early as ${run.status}/${run.stop_reason}`);
  const open = itemsOf(r2Run).filter((i) => i.status === 'queued' || i.status === 'running');
  assert.ok(open.length > 0, 'the whole list drained with #62–#65 untouched');
  for (const id of [n62, n63, n64, n65]) {
    assert.ok(itemFor(r2Run, id).length > 0, `#${id} never made it onto the list`);
  }
  await post(`/night/runs/${r2Run}/stop`);
});

// ── SH-R1 — RUN #1's STUCK STATE ───────────────────────────────────────────
//
// Run #1 stopped `stuck` at 02:14 CT on 2026-09-25 after 20 idle ticks with
// `#9 waits on #22`: node #22 had been DECOMPOSED (children #73–#77 all
// settled) but was itself still `set`, so `runnable()` blocked its later
// sibling #23 forever. A predicted placeholder orphaned by the same
// transition sat `queued` and counted as open work, so the run could neither
// progress nor complete.
const g7 = await mkGoal('G7 — the parity goal');
const p22 = await mkNode(g7, 'P22 prove tool parity');
const c73 = await mkNode(g7, 'C73 pin down the endpoints', { parent_id: p22, leaf_kind: 'machine' });
const c77 = await mkNode(g7, 'C77 fix every gap', { parent_id: p22, leaf_kind: 'machine' });
const s23 = await mkNode(g7, 'S23 add bearer-token auth');
const s24 = await mkNode(g7, 'S24 cut over all users');
forceDone(c73);
forceDone(c77);

let r1Run = -1;
await check('SH-R1', "run #1's stuck state: a fully-settled decomposed parent no longer blocks its later siblings", async () => {
  const r = await post('/night/plan', { mode: 'until_stop', goal_ids: [g7], config: { lanes: 2 }, label: 'parity' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r1Run = r.json.run.id;
  const scheduled = itemsOf(r1Run).map((i) => i.node_id);
  assert.ok(scheduled.includes(s23), '#23 (the later sibling of the decomposed parent) was dropped');
  assert.ok(scheduled.includes(s24), '#24 was dropped');
  await post(`/night/runs/${r1Run}/start`);
  await tick('r1');
  const started = itemsOf(r1Run).filter((i) => i.status === 'running');
  assert.ok(started.some((i) => i.node_id === s23), `#23 never became runnable — items: ${itemsOf(r1Run).map((i) => `${i.node_id}:${i.status}`).join(' ')}`);
});

await check('SH-R1b', 'an ORPHANED predicted placeholder is pruned in the same tick, never waited on (parent_already_expanded)', async () => {
  const items = itemsOf(r1Run);
  const decompose = items.find((i) => i.kind === 'decompose' && i.node_id === s24);
  assert.ok(decompose, 'expected a decompose item for #24');
  const ph = items.find((i) => i.kind === 'predicted' && i.parent_item_id === decompose.id);
  assert.ok(ph, 'expected a predicted placeholder under the decompose item');
  // Orphan it exactly the way the live run did: the decompose item reaches a
  // terminal state without ever running expandPredicted.
  sqliteDb.prepare(`UPDATE night_items SET status = 'failed', finished_at = datetime('now') WHERE id = ?`).run(decompose.id);
  await tick('r1-orphan');
  const after = night.listNightItems(r1Run).find((i) => i.id === ph.id);
  assert.equal(after.status, 'skipped', `the orphaned placeholder is still ${after.status} — it will be "waited on" forever`);
  assert.match(after.result_summary ?? '', /parent_already_expanded/);
});

await check('SH-R1c', 'STUCK MUST MEAN STUCK: idle ticks only count once a re-plan has also come up empty', async () => {
  // Settle everything the list was carrying, then add work that arrived AFTER
  // the plan was frozen — the exact shape that used to burn 20 idle ticks and
  // stop `stuck`/`complete` with real work open on the goal.
  forceDone(s23);
  forceDone(s24);
  const open = night.listNightItems(r1Run).filter((i) => i.status === 'queued' || i.status === 'running');
  for (const it of open) {
    sqliteDb.prepare(`UPDATE night_items SET status = 'skipped', finished_at = datetime('now') WHERE id = ?`).run(it.id);
  }
  const fresh = await mkNode(g7, 'S25 brand new machine work', { leaf_kind: 'machine' });
  await tick('r1-replan');
  const run = night.getNightRun(r1Run);
  assert.equal(run.status, 'running', `the run stopped ${run.stop_reason} instead of re-planning`);
  const replans = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM night_events WHERE run_id = ? AND kind = 'replanned_tail'`).get(r1Run).n;
  assert.ok(replans >= 1, 'no replanned_tail event was recorded');
  assert.ok(night.listNightItems(r1Run).some((i) => i.node_id === fresh), '#25 never arrived on the re-planned tail');
});

await check('SH-R1d', 'a run with genuinely nothing left DOES stop `complete` (the re-plan does not make a run immortal)', async () => {
  // Everything on g7 settled → the simulate pass yields nothing → complete.
  const all = sqliteDb.prepare(`SELECT id FROM goal_nodes WHERE goal_id = ? AND state NOT IN ('done','discarded')`).all(g7);
  for (const row of all) forceDone(row.id);
  for (const it of night.listNightItems(r1Run)) {
    if (it.status === 'queued' || it.status === 'running') {
      sqliteDb.prepare(`UPDATE night_items SET status = 'done', finished_at = datetime('now') WHERE id = ?`).run(it.id);
    }
  }
  await tick('r1-complete');
  const run = night.getNightRun(r1Run);
  assert.equal(run.status, 'complete', `expected complete, got ${run.status}/${run.stop_reason}`);
  assert.equal(run.stop_reason, 'complete');
});

// ── §3.1 — the per-shift orchestrator thread ───────────────────────────────
await check('SH-1', '§3.1 every run gets its own cockpit:shift-<id> thread at PLAN time, seeded, with the cues routed to it', async () => {
  const run = night.getNightRun(r2Run);
  assert.equal(run.thread_ext, `cockpit:shift-${r2Run}`, 'the run did not record its own thread');
  const conv = sqliteDb.prepare(`SELECT id, title FROM conversations WHERE external_id = ?`).get(`cockpit:shift-${r2Run}`);
  assert.ok(conv, 'the shift thread was never created');
  assert.match(conv.title ?? '', new RegExp(`Shift #${r2Run}`), `thread title is "${conv.title}"`);
  const seed = cueCalls().find((c) => c.externalId === `cockpit:shift-${r2Run}` && c.correlationKey === `shift:${r2Run}:seed`);
  assert.ok(seed, 'the shift thread was never seeded');
  assert.match(seed.text, /focus goal 6, Claude A/, "Kevin's brief is not in the seed");
  assert.match(seed.text, /goal 6 push/, 'the label is not in the seed');
  // Not one cue for this run went to the lobby.
  const lobby = cueCalls().filter((c) => c.externalId === 'cockpit:night-shift' && (c.correlationKey ?? '').includes(`:${r2Run}:`));
  assert.equal(lobby.length, 0, `${lobby.length} cue(s) for run #${r2Run} leaked into the lobby`);
});

await check('SH-2', "§3.1 a finished session's thread still answers about ITS OWN run, and refuses to be mutated", async () => {
  const block = night.nightShiftContextBlock(`cockpit:shift-${r1Run}`);
  assert.match(block, new RegExp(`^<night_shift run_id="${r1Run}" `), block.slice(0, 160));
  assert.match(block, /This shift ENDED/);
  // …even though a DIFFERENT, NEWER run exists.
  const newer = await post('/night/plan', { goal_ids: [g6], label: 'a newer session' });
  assert.equal(newer.status, 200, JSON.stringify(newer.json));
  assert.notEqual(newer.json.run.id, r1Run);
  const still = night.nightShiftContextBlock(`cockpit:shift-${r1Run}`);
  assert.match(still, new RegExp(`^<night_shift run_id="${r1Run}" `),
    'the old session\'s thread started answering about the newer run');
  await post(`/night/runs/${newer.json.run.id}/stop`);
  // Read-only ops are fine; mutations are refused with a clear code.
  const err = await post(`/night/runs/${r1Run}/items/999999/skip`);
  assert.equal(err.status, 409, JSON.stringify(err.json));
  assert.equal(err.json.error.code, 'night_run_ended', JSON.stringify(err.json));
  assert.match(err.json.error.message, /record/);
});

await check('SH-3', '§3.2 the brief is injected VERBATIM into the run thread context block every turn', async () => {
  const block = night.nightShiftContextBlock(`cockpit:shift-${r2Run}`);
  assert.match(block, /Kevin's brief for this shift: /);
  assert.match(block, /focus goal 6, Claude A/);
  assert.match(block, new RegExp(`label="goal 6 push"`));
});

await check('SH-4', '§3.2 dials_at_start is populated at Start and is null before it', async () => {
  const planned = await post('/night/plan', { mode: 'until_stop', goal_ids: [g6], label: 'dial probe' });
  assert.equal(planned.status, 200, JSON.stringify(planned.json));
  const id = planned.json.run.id;
  assert.equal(night.getNightRun(id).dials_at_start, null, 'dials were snapshotted before Start');
  await post(`/night/runs/${id}/start`);
  const dials = night.getNightRun(id).dials_at_start;
  assert.ok(dials && typeof dials === 'object', 'dials_at_start was not populated at Start');
  assert.ok(typeof dials.at === 'string' && dials.at.length > 10, 'the snapshot has no timestamp');
  for (const k of ['preset', 'hopper_slots', 'max_per_goal', 'claude_mode', 'accounts', 'stop_loss']) {
    assert.ok(k in dials, `the snapshot is missing "${k}"`);
  }
  assert.ok(Array.isArray(dials.accounts), 'accounts is not an array');
  await post(`/night/runs/${id}/stop`);
});

await check('SH-5', '§3.2 plan warns when per_goal_parallel is above the throttle per-goal cap', async () => {
  const { setSetting } = await import(path.join(distDir, 'conversation-db.js'));
  setSetting('throttle_max_per_goal', '1');
  const r = await post('/night/plan', { goal_ids: [g6], config: { per_goal_parallel: 3 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(Array.isArray(r.json.warnings), 'the plan response has no warnings array');
  assert.ok(r.json.warnings.some((w) => /per-goal cap of 1/.test(w)), `expected a per-goal cap warning, got ${JSON.stringify(r.json.warnings)}`);
  setSetting('throttle_max_per_goal', '0');
  const clean = await post('/night/plan', { goal_ids: [g6], config: { per_goal_parallel: 3 } });
  assert.equal(clean.json.warnings.length, 0, `expected no warnings with the cap off, got ${JSON.stringify(clean.json.warnings)}`);
  await post(`/night/runs/${clean.json.run.id}/stop`).catch(() => {});
  sqliteDb.prepare(`UPDATE night_runs SET status = 'stopped', ended_at = datetime('now'), stop_reason = 'kevin' WHERE status IN ('planned','running','paused')`).run();
});

// ── §3.4 — the sessions surface ────────────────────────────────────────────
await check('SH-6', '§3.4 GET /night/runs lists every session newest-first with durations, item counts and per-goal minutes', async () => {
  const r = await get('/night/runs?limit=50');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const runs = r.json.runs;
  assert.ok(runs.length >= 3, `expected ≥3 sessions, got ${runs.length}`);
  for (let i = 1; i < runs.length; i += 1) assert.ok(runs[i - 1].id > runs[i].id, 'the list is not newest-first');
  const r2 = runs.find((x) => x.id === r2Run);
  assert.ok(r2, 'the goal-6 session is missing from the list');
  for (const k of ['label', 'brief', 'status', 'mode', 'goal_ids', 'lanes', 'per_goal_parallel',
                   'planned_at', 'started_at', 'ended_at', 'duration_min', 'stop_reason',
                   'thread_ext', 'report_path', 'items', 'goals']) {
    assert.ok(k in r2, `the session row is missing "${k}"`);
  }
  assert.equal(r2.label, 'goal 6 push');
  assert.equal(r2.brief, 'focus goal 6, Claude A');
  assert.equal(r2.thread_ext, `cockpit:shift-${r2Run}`);
  assert.ok(typeof r2.duration_min === 'number' && r2.duration_min >= 0, 'duration_min is not a number');
  assert.ok(r2.items.total > 0, 'the session reports no items');
  assert.ok(r2.goals.some((g) => g.goal_id === g6), 'goal 6 is missing from the per-goal breakdown');
  assert.ok(r2.goals.every((g) => 'title' in g && 'minutes' in g && 'items_done' in g), 'a per-goal row is malformed');
  // status filter
  const stopped = await get('/night/runs?status=stopped');
  assert.equal(stopped.status, 200);
  assert.ok(stopped.json.runs.every((x) => x.status === 'stopped'), 'the status filter leaked other statuses');
  const bad = await get('/night/runs?status=nonsense');
  assert.equal(bad.status, 400, JSON.stringify(bad.json));
});

await check('SH-7', '§3.4 GET /night/runs/:id carries a summary with per-goal AND per-node minutes', async () => {
  const r = await get(`/night/runs/${r2Run}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  for (const k of ['run', 'items', 'eta_end', 'events', 'summary', 'thread_ext']) {
    assert.ok(k in r.json, `the detail read is missing "${k}"`);
  }
  const sum = r.json.summary;
  assert.equal(sum.run_id, r2Run);
  for (const k of ['duration_min', 'goals', 'nodes', 'trees_planted', 'nodes_verified_done', 'nodes_parked', 'items_failed']) {
    assert.ok(k in sum, `the summary is missing "${k}"`);
  }
  assert.ok(sum.goals.some((g) => g.goal_id === g6), 'goal 6 is missing from the summary');
  assert.ok(sum.nodes.length > 0, 'the summary has no per-node rows');
  assert.ok(sum.nodes.every((n) => typeof n.minutes === 'number' && Array.isArray(n.kinds)), 'a per-node row is malformed');
  assert.ok(Array.isArray(r.json.events) && r.json.events.length > 0, 'the event log is empty');
});

await check('SH-8', '§3.4 the night_shift tool: plan takes config+brief+label; `runs` lists; `run` details; a shift chat defaults to ITS OWN run', async () => {
  const tool = tools.ALL_TOOLS.find((t) => t.name === 'night_shift');
  assert.ok(tool, 'the night_shift tool is not registered');
  const ops = tool.parameters.properties.operation.enum;
  for (const op of ['runs', 'run']) assert.ok(ops.includes(op), `the tool does not expose "${op}"`);
  for (const p of ['brief', 'label', 'config', 'limit', 'status']) {
    assert.ok(p in tool.parameters.properties, `the tool schema is missing "${p}"`);
  }
  const planned = await tool.execute({
    operation: 'plan', goal_ids: [g6], brief: 'tool brief verbatim', label: 'tool session',
    config: { lanes: 2, per_goal_parallel: 1 },
  });
  assert.ok(planned.run, JSON.stringify(planned));
  assert.equal(planned.run.brief, 'tool brief verbatim');
  assert.equal(planned.run.label, 'tool session');
  assert.equal(planned.run.config.lanes, 2, 'config.lanes did not reach the planner');
  assert.equal(planned.thread_ext, `cockpit:shift-${planned.run.id}`);
  assert.ok(Array.isArray(planned.warnings), 'plan did not return warnings');

  const listed = await tool.execute({ operation: 'runs', limit: 5 });
  assert.ok(Array.isArray(listed.runs) && listed.runs.length > 0, JSON.stringify(listed).slice(0, 200));

  // §3.1 — called from an OLD shift's chat, every op is about THAT run.
  const own = await tool.execute({ operation: 'run' }, { externalId: `cockpit:shift-${r1Run}` });
  assert.equal(own.run.id, r1Run, 'the old shift chat answered about a different run');
  const st = await tool.execute({ operation: 'status' }, { externalId: `cockpit:shift-${r1Run}` });
  assert.equal(st.run.id, r1Run, '`status` in an old shift chat answered about the live run');
  // …and it refuses to mutate that finished run.
  const refused = await tool.execute({ operation: 'skip', item_id: 999999 }, { externalId: `cockpit:shift-${r1Run}` });
  assert.equal(refused.error, 'night_run_ended', JSON.stringify(refused));

  const digest = await tool.execute({ operation: 'status' });
  for (const k of ['brief', 'label', 'dials_at_start', 'thread_ext']) {
    assert.ok(k in digest, `the status digest is missing "${k}"`);
  }
  await post(`/night/runs/${planned.run.id}/stop`).catch(() => {});
});

// ═══════════════════════════════════════════════════════════════════════════
// ADVERSARIAL REVIEW regressions (node #833) — one per defect the review fixed.
// Each is mutation-tested: reverting its fix makes exactly this check fail.
// ═══════════════════════════════════════════════════════════════════════════

await check('SH-RV1', 'REVIEW: the `shift:<run>:seed` cue is an AUTOMATED turn — the shift seed cannot spawn opus outside the concurrency ceiling', async () => {
  const admission = await import(pathToFileURL(path.join(repoRoot, 'dist/turn-admission.js')).href);
  // The key planNight actually mints (night-shift.ts seedRunThreadIfNew).
  assert.equal(admission.isAutomatedTurn(`cockpit:shift-${r2Run}`, `shift:${r2Run}:seed`), true,
    'the shift-thread SEED cue is not gated by turn-admission — it would spawn claude outside max_concurrent_auto_turns');
  // The keys that were already gated must stay gated (no regression).
  assert.equal(admission.isAutomatedTurn(`cockpit:shift-${r2Run}`, `night:${r2Run}:wrap`), true);
  assert.equal(admission.isAutomatedTurn(`cockpit:shift-${r2Run}`, `night:${r2Run}:plan-ready`), true);
  // …and Kevin's own turn in that same thread must still go straight through.
  assert.equal(admission.isAutomatedTurn(`cockpit:shift-${r2Run}`, undefined), false,
    "Kevin's own turn in a shift thread must never be gated");
});

await check('SH-RV2', 'REVIEW: per-goal minutes ROUND, they do not CAST-truncate — the Sessions list and the session summary report the SAME number', async () => {
  // julianday() is a float: (jd(end) - jd(start)) * 1440 for a clean 13-minute
  // window comes out 12.99999…, so CAST(… AS INTEGER) truncated it to 12 while
  // nightRunSummary() computed 13 in JS with Math.round. The Sessions table and
  // the session drawer therefore disagreed about the one number Kevin asked for
  // ("how long did you work on X"), and a 1-minute item vanished entirely.
  const items = night.listNightItems(r2Run);
  assert.ok(items.length, 'no items to probe');
  // Isolate the arithmetic: exactly ONE item carries a window.
  sqliteDb.prepare(`UPDATE night_items SET started_at = NULL, finished_at = NULL WHERE run_id = ?`).run(r2Run);
  const probe = items[0];
  sqliteDb.prepare(
    `UPDATE night_items SET started_at = '2026-09-25T04:00:00.000Z', finished_at = '2026-09-25T04:13:00.000Z' WHERE id = ?`,
  ).run(probe.id);
  const listed = (await get('/night/runs?limit=50')).json.runs.find((x) => x.id === r2Run);
  const summed = (await get(`/night/runs/${r2Run}`)).json.summary;
  const gl = listed.goals.find((g) => g.goal_id === probe.goal_id);
  const gs = summed.goals.find((g) => g.goal_id === probe.goal_id);
  assert.ok(gl && gs, 'the probed goal is missing from one of the two surfaces');
  assert.equal(gl.minutes, 13,
    `a 13-minute item reads ${gl.minutes}m on the Sessions list (truncation, not rounding)`);
  assert.equal(gl.minutes, gs.minutes,
    `Sessions list says ${gl.minutes}m but the session summary says ${gs.minutes}m for goal ${probe.goal_id}`);
});

await check('SH-RV3', 'REVIEW: a spent re-plan ceiling stops the shift `stuck`, never `complete` — a drained list is not a finished goal', async () => {
  const { setSetting } = await import(path.join(distDir, 'conversation-db.js'));
  const gx = await mkGoal('GX — ceiling probe');
  const nx = await mkNode(gx, 'X1 open machine work', { leaf_kind: 'machine' });
  const r = await post('/night/plan', { mode: 'until_stop', goal_ids: [gx], config: { lanes: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const runId = r.json.run.id;
  assert.equal((await post(`/night/runs/${runId}/start`)).status, 200);
  // Burn the ceiling (settings-KV night_max_replans) with synthetic history…
  setSetting('night_max_replans', '2');
  for (let i = 0; i < 3; i += 1) {
    sqliteDb.prepare(`INSERT INTO night_events (run_id, actor, kind, text) VALUES (?, 'system', 'replanned_tail', 'probe')`).run(runId);
  }
  assert.equal(night.replanCeilingReached(runId), true, 'the ceiling probe did not take');
  // …drain the list while #X1 is still genuinely open machine work.
  for (const it of night.listNightItems(runId)) {
    sqliteDb.prepare(`UPDATE night_items SET status = 'done', finished_at = datetime('now') WHERE id = ?`).run(it.id);
  }
  assert.notEqual(nodeState(nx), 'done', 'the probe node settled — the test no longer proves anything');
  await tick('ceiling');
  const run = night.getNightRun(runId);
  assert.notEqual(run.stop_reason, 'complete',
    'the shift reported `complete` with open machine work because it had merely run out of re-plans');
  assert.equal(run.stop_reason, 'stuck', `expected stuck, got ${run.status}/${run.stop_reason}`);
  const ev = sqliteDb.prepare(
    `SELECT text FROM night_events WHERE run_id = ? AND kind = 'hold' ORDER BY id DESC LIMIT 1`,
  ).get(runId);
  assert.match(ev?.text ?? '', /re-plan ceiling/, 'the stop did not say WHY it stopped');
  setSetting('night_max_replans', '50');
});

await check('SH-RV4', 'REVIEW: re-planning before Start archives + renames the superseded shift thread — no live-looking orphan orchestrator', async () => {
  const gy = await mkGoal('GY — replan orphan probe');
  await mkNode(gy, 'Y1 machine leaf', { leaf_kind: 'machine' });
  const p1 = await post('/night/plan', { mode: 'until_stop', goal_ids: [gy], config: { lanes: 1 } });
  assert.equal(p1.status, 200, JSON.stringify(p1.json));
  const runA = p1.json.run.id;
  const extA = `cockpit:shift-${runA}`;
  const convA = sqliteDb.prepare(`SELECT id, title, status FROM conversations WHERE external_id = ?`).get(extA);
  assert.ok(convA, 'the first plan did not create its shift thread');
  // Re-plan before Start — the normal "tweak the sheet, hit Plan again" loop.
  const p2 = await post('/night/plan', { mode: 'until_stop', goal_ids: [gy], config: { lanes: 1 } });
  assert.equal(p2.status, 200, JSON.stringify(p2.json));
  const runB = p2.json.run.id;
  assert.notEqual(runB, runA, 'the re-plan did not replace the planned run');
  assert.ok(!night.getNightRun(runA), 'the replaced run row survived');
  const convA2 = sqliteDb.prepare(`SELECT title, status FROM conversations WHERE external_id = ?`).get(extA);
  assert.equal(convA2?.status, 'archived',
    `the superseded shift thread is still "${convA2?.status}" — a live-looking orchestrator for a run that no longer exists`);
  assert.match(convA2?.title ?? '', /superseded/, `the superseded thread still reads "${convA2?.title}"`);
  const convB = sqliteDb.prepare(`SELECT status FROM conversations WHERE external_id = ?`).get(`cockpit:shift-${runB}`);
  assert.ok(convB && convB.status !== 'archived', "the NEW run's thread must exist and be live");
});

await check('SH-9', 'NO MODEL CALLS: not one claude process was spawned by this suite', () => {
  const after = claudeProcs();
  assert.ok(after <= CLAUDE_BEFORE, `claude processes went from ${CLAUDE_BEFORE} to ${after} — the suite spawned a real model call`);
});

} catch (err) {
  console.error('\n[shifts-check] FATAL', err);
  results.push({ id: 'FATAL', description: 'suite crashed', pass: false, error: String(err?.stack ?? err) });
} finally {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n[shifts-check] ${passed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : ''}`);
  console.log(`[shifts-check] claude procs: ${CLAUDE_BEFORE} before / ${claudeProcs()} after`);
  server.close();
  process.exit(failed ? 1 : 0);
}
