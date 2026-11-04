#!/usr/bin/env node
// PARALLEL ENGINE END-TO-END SIM — docs/hopper/PARALLEL-CONTRACT.md
// (tree-383bb55b node #951)
//
//   npm run parallel:sim
//
// ONE hermetic scenario driving the REAL compiled hopper-engine.js
// (dispatchTick, finishHopperNode, resource leases), hopper-git.js (real, but
// strictly local, git), and night-shift.js (tickNightShift — the §7 never-idle
// sequence + §6 unpark) TOGETHER, against a scratch DB and a throwaway /tmp
// repo. Model calls are stubbed — spawnCalls RECORDS every dispatch instead of
// making a live call, and the final tally is asserted against the exact node
// count, so "the engine dispatched real workers, but zero of them touched a
// real model" is proven, not promised (§10's guarantee).
//
// Kevin's integration tree, plus the two things this contract added on top of
// it, all live at once:
//   - A (nothing) / D (nothing) / B, C (depend on A)         — §3-§4
//   - E, F share a resource lease name                        — §5
//   - a night-shift goal node parked on node_done(A)          — §6/§7
//
// Timeline asserted:
//   t0  A, D, and ONE of {E,F} claim together. The OTHER resource holder is a
//       clean SKIP (pending, zero attempts burned) — not a park. B, C wait on
//       the dep. The night item is still parked: A hasn't finished.
//   t1  A finishes (`done`). The night item unparks on A's STATUS ALONE — it
//       does not wait for the merge. B and C are STILL pending mid-integration:
//       a dependent needs the MERGE, never just the finish (§3.5's whole
//       point). A integrates.
//   t2  B and C claim now, cut from a head that contains A's work.
//   t3  D finishes. The resource loser claims the instant the winner's lease
//       releases. B, C, and the loser finish. Every merge serializes; nothing
//       conflicts; the integration branch ends up holding every file, intact.
//   t4  The night run reaches `complete` — the driver never reported `stuck`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const rawDb = process.env.JARVIS_DB_PATH;
if (!rawDb || !rawDb.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(rawDb);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

process.env.JARVIS_SIM = '1';
process.env.HOPPER_GOV_ENABLED = '0';
process.env.HOPPER_ENGINE_SLOTS = '8';
process.env.NIGHT_SHIFT_DRIVER = '0';
process.env.NIGHT_SHIFT_KICK_MS = '999999999';
process.env.NIGHT_SHIFT_STOP_FILE = path.join(path.dirname(DB_PATH), `parallel-engine-sim-${process.pid}.stop`);
process.env.GOALS_AUTOPILOT_DRIVER = '0';
process.env.GOALS_AUTOPILOT_KICK_MS = '999999999';
fs.rmSync(process.env.NIGHT_SHIFT_STOP_FILE, { force: true });
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const dist = path.join(repoRoot, 'dist');
const { sqliteDb } = await import(path.join(dist, 'conversation-db.js'));
const engine = await import(path.join(dist, 'hopper-engine.js'));
const goals = await import(path.join(dist, 'goals.js'));
const night = await import(path.join(dist, 'night-shift.js'));

night.__setNightShiftTestOverrides({ governor: () => ({ allow: true, reason: '', detail: '' }) });

// A REAL model call would be a policy violation. This records instead, and
// every section is free to assert the running total is zero.
let spawnCalls = 0;
const spawnedPrompts = [];
engine.startHopperEngine(async (prompt) => {
  spawnCalls += 1;
  spawnedPrompts.push(prompt);
  return '';
});

// ---------------------------------------------------------------------------
// Throwaway git repo (§10: "git is real but local").
// ---------------------------------------------------------------------------
const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-engine-sim-'));
const REPO = path.join(gitRoot, 'demo-repo');
fs.mkdirSync(REPO, { recursive: true });
const g = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).toString().trim();
g(REPO, ['init', '-q']);
g(REPO, ['config', 'user.email', 'parallel-engine-sim@example.com']);
g(REPO, ['config', 'user.name', 'parallel-engine-sim']);
g(REPO, ['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(REPO, 'shared.txt'), 'seed line\n');
g(REPO, ['add', '.']);
g(REPO, ['commit', '-q', '-m', 'seed']);

const branchList = () => g(REPO, ['branch', '--format=%(refname:short)']).split('\n').map((x) => x.trim()).filter(Boolean);
const fileOnBranch = (branch, file) => {
  try { return g(REPO, ['show', `refs/heads/${branch}:${file}`]); } catch { return null; }
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TREE = 'tree-pe-sim';
const BR = 'hopper/pe-sim';
// A gate that takes a beat, same technique as hopper-merge-check's MB-5: it
// makes "B and C could not have started while A was integrating" an OBSERVED
// fact rather than a timing accident.
sqliteDb
  .prepare(`INSERT INTO hopper_trees (id, topic, status, repo_path, integration_branch, build_gate_cmd) VALUES (?, ?, 'active', ?, ?, ?)`)
  .run(TREE, 'parallel-engine-sim', REPO, BR, 'sleep 1');

const mkNode = (title, deps = null, resources = null) => {
  const info = sqliteDb
    .prepare(`INSERT INTO hopper_nodes (tree_id, title, spec, status, depends_on, resources) VALUES (?, ?, ?, 'pending', ?, ?)`)
    .run(TREE, title, `do ${title}`, deps ? JSON.stringify(deps) : null, resources ? JSON.stringify(resources) : null);
  return engine.getHopperNode(Number(info.lastInsertRowid));
};
/** Claim a node the way dispatchTick does, without needing a whole tick. */
const claim = (nodeId) => {
  const node = engine.getHopperNode(nodeId);
  const tree = engine.getHopperTree(node.tree_id);
  const prep = engine.prepareIntegrationWorkspace(node, tree);
  sqliteDb.prepare(`UPDATE hopper_nodes SET status='running', worker_thread_ext=?, attempts=attempts+1 WHERE id=?`).run(`check-ext-${nodeId}`, nodeId);
  return prep;
};
/** What a worker does: commit in its OWN worktree, on its OWN branch. */
const workIn = (nodeId, files) => {
  const node = engine.getHopperNode(nodeId);
  for (const [file, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(node.worktree_path, file), body);
    g(node.worktree_path, ['add', file]);
  }
  g(node.worktree_path, ['commit', '-q', '-m', `n${nodeId} work`]);
};

const a = mkNode('A — the one B, C and the night item depend on');
const d = mkNode('D — depends on nothing');
const b = mkNode('B — depends on A');
const c = mkNode('C — depends on A');
sqliteDb.prepare(`UPDATE hopper_nodes SET depends_on = ? WHERE id IN (?, ?)`).run(JSON.stringify([a.id]), b.id, c.id);
const e = mkNode('E — holds the shared resource', null, ['demo-shared-lock']);
const f = mkNode('F — wants the same shared resource', null, ['demo-shared-lock']);

// A night-shift goal node, parked on node_done(A) — exactly Shift #6's shape
// (a parked head-of-chain item), except the condition now points at a REAL
// node in the SAME integration tree the hopper engine is driving.
const { goal } = goals.createGoal({ title: 'PE-SIM night stage', done_means: 'n/a' });
const stage = goals.createGoalNode(goal.id, { title: 'PE-SIM stage (waits on node A)', done_means: 'n/a', actor: 'jarvis' });
const stageChild = goals.createGoalNode(goal.id, { title: 'PE-SIM stage child', done_means: 'n/a', parent_id: stage.id, actor: 'jarvis' });
function setGoalNodeFields(nodeId, fields) {
  const cols = Object.keys(fields);
  sqliteDb.prepare(`UPDATE goal_nodes SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...cols.map((c) => fields[c]), nodeId);
}
setGoalNodeFields(stageChild.id, { state: 'done' });
setGoalNodeFields(stage.id, { state: 'check' });
goals.parkGoalNode(goal.id, stage.id, 'system', 'pe-sim: waiting on hopper node A', { kind: 'node_done', node_id: a.id });

const runId = (() => {
  const info = sqliteDb.prepare(`
    INSERT INTO night_runs (status, mode, config, goal_ids, started_at) VALUES ('running', 'until_stop', '{}', ?, datetime('now'))
  `).run(JSON.stringify([goal.id]));
  return Number(info.lastInsertRowid);
})();
const noStuckEventYet = () =>
  sqliteDb.prepare(`SELECT COUNT(*) c FROM night_events WHERE run_id = ? AND kind = 'hold' AND text LIKE 'stuck:%'`).get(runId).c === 0;

// ===========================================================================
console.log('\n[PES-1] t0 — A, D and ONE resource holder claim together; B, C wait on the dep; the other resource holder is a clean SKIP; the night item is still parked');
{
  await engine.dispatchTick('pe-sim t0');
  check('A claimed', engine.getHopperNode(a.id).status === 'running');
  check('D claimed in the SAME tick', engine.getHopperNode(d.id).status === 'running');
  check('B still pending (dep unmet)', engine.getHopperNode(b.id).status === 'pending');
  check('C still pending (dep unmet)', engine.getHopperNode(c.id).status === 'pending');

  const [E, F] = [engine.getHopperNode(e.id), engine.getHopperNode(f.id)];
  const running = [E, F].filter((n) => n.status === 'running');
  const pending = [E, F].filter((n) => n.status === 'pending');
  check('exactly one resource holder claimed', running.length === 1, JSON.stringify([E, F].map((n) => n.status)));
  check('the other is a clean SKIP: pending, zero attempts burned, no lease', pending.length === 1 && pending[0].attempts === 0, JSON.stringify(pending[0]));

  await night.tickNightShift('pe-sim t0');
  check('night: the stage is still parked — A has not finished yet', goals.getRawGoalNode(stage.id).state === 'parked');
  check('night: run is still running', night.getNightRun(runId).status === 'running');
  check('night: no stuck hold recorded', noStuckEventYet());
}

// ===========================================================================
console.log("\n[PES-2] t1 — A finishes: the night item unparks on A's STATUS ALONE (before the merge); B and C stay pending mid-integration; A integrates");
{
  workIn(a.id, { 'a.txt': 'A wrote this\n', 'shared.txt': 'A owns this line\n' });
  engine.finishHopperNode(a.id, 'done', { result: 'A done' });
  check("A is done but still integration_pending (the merge hasn't landed)",
    engine.getHopperNode(a.id).status === 'done' && engine.getHopperNode(a.id).integration_state === 'integration_pending');

  // Fired while A's 1s build gate is still in flight (nothing awaited since
  // finishHopperNode returned) — deterministically BEFORE the merge lands.
  let stageState = 'parked';
  for (let i = 0; i < 5 && stageState !== 'done'; i += 1) {
    await night.tickNightShift(`pe-sim t1-${i}`);
    stageState = goals.getRawGoalNode(stage.id).state;
  }
  check("night: the stage unparked and verified done on node_done(A) alone — it never waited for the merge", stageState === 'done', stageState);
  check('night: never reported stuck while settling the stage', noStuckEventYet());

  await engine.dispatchTick('pe-sim t1-mid-integration');
  check('B still pending mid-integration — a dependent needs the MERGE, not just the finish', engine.getHopperNode(b.id).status === 'pending');
  check('C still pending mid-integration', engine.getHopperNode(c.id).status === 'pending');

  await engine.integrationIdle(TREE);
  check('A integrated', engine.getHopperNode(a.id).integration_state === 'merged');
}

// ===========================================================================
console.log("\n[PES-3] t2 — B and C claim now that A has integrated, cut from a head that contains A's work");
{
  await engine.dispatchTick('pe-sim t2');
  const B = engine.getHopperNode(b.id);
  const C = engine.getHopperNode(c.id);
  check('B claimed', B.status === 'running', B.status);
  check('C claimed in the SAME tick', C.status === 'running', C.status);
  check("B's checkout contains A's file", fs.readFileSync(path.join(B.worktree_path, 'a.txt'), 'utf8') === 'A wrote this\n');
  check("C's checkout sees A's version of the shared file", fs.readFileSync(path.join(C.worktree_path, 'shared.txt'), 'utf8') === 'A owns this line\n');
}

// ===========================================================================
console.log('\n[PES-4] t3 — D finishes; the resource loser claims the instant the winner\'s lease releases; everyone finishes; zero conflicts; every file lands');
{
  const labelOf = (nodeId) => (nodeId === e.id ? 'e' : 'f');
  const [E, F] = [engine.getHopperNode(e.id), engine.getHopperNode(f.id)];
  const winner = E.status === 'running' ? E : F;
  const loser = E.status === 'running' ? F : E;

  workIn(d.id, { 'd.txt': 'D wrote this\n' });
  engine.finishHopperNode(d.id, 'done', { result: 'D done' });

  check('the loser is STILL pending while the winner holds the lease', engine.getHopperNode(loser.id).status === 'pending');
  workIn(winner.id, { [`${labelOf(winner.id)}.txt`]: `${labelOf(winner.id)} wrote this\n` });
  engine.finishHopperNode(winner.id, 'done', { result: `${labelOf(winner.id)} done` });

  await engine.dispatchTick('pe-sim resource handoff');
  check("the resource loser claims the moment the winner's lease releases — the resource pair SERIALIZES", engine.getHopperNode(loser.id).status === 'running');

  workIn(b.id, { 'b.txt': 'B wrote this\n' });
  workIn(c.id, { 'c.txt': 'C wrote this\n' });
  engine.finishHopperNode(b.id, 'done', { result: 'B done' });
  engine.finishHopperNode(c.id, 'done', { result: 'C done' });
  workIn(loser.id, { [`${labelOf(loser.id)}.txt`]: `${labelOf(loser.id)} wrote this\n` });
  engine.finishHopperNode(loser.id, 'done', { result: `${labelOf(loser.id)} done` });

  await engine.integrationIdle(TREE);

  const all = [a, d, b, c, e, f].map((n) => engine.getHopperNode(n.id));
  check('all six nodes are done', all.every((n) => n.status === 'done'), all.map((n) => n.status).join(','));
  check('all six INTEGRATED', all.every((n) => n.integration_state === 'merged'), all.map((n) => String(n.integration_state)).join(','));
  check('ZERO CONFLICTS: no repair/integrate node was ever created', engine.listTreeNodes(TREE).every((n) => n.integrates_node_id === null));
  check('the integration branch holds every file', ['a.txt', 'd.txt', 'b.txt', 'c.txt', 'e.txt', 'f.txt'].every((file) => fileOnBranch(BR, file) !== null));
  check("shared.txt is exactly A's line — nobody clobbered it", fileOnBranch(BR, 'shared.txt') === 'A owns this line');
  check('every node worktree was pruned', all.every((n) => !fs.existsSync(n.worktree_path)));
  check('every node branch survives (§8.2)', all.every((n) => branchList().includes(n.node_branch)));
  check('the tree finished', engine.getHopperTree(TREE).status === 'done');
  // Each of the 6 nodes was really dispatched (that IS the engine doing its
  // job) — but every dispatch hit the STUB above, never a live model call.
  check('exactly 6 workers were spawned — one per node, all stubbed, zero live model calls', spawnCalls === 6, `spawnCalls=${spawnCalls}`);
}

// ===========================================================================
console.log('\n[PES-5] the night run reaches `complete` — the driver never reported `stuck`, anywhere in this scenario');
{
  let runRow = night.getNightRun(runId);
  for (let i = 0; i < 5 && runRow.status === 'running'; i += 1) {
    await night.tickNightShift(`pe-sim finalize-${i}`);
    runRow = night.getNightRun(runId);
  }
  check('the night run reached `complete`', runRow.status === 'complete', JSON.stringify(runRow));
  check('...never `stuck`', runRow.stop_reason !== 'stuck', String(runRow.stop_reason));
  check('the driver NEVER recorded a stuck hold across the whole scenario', noStuckEventYet());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
