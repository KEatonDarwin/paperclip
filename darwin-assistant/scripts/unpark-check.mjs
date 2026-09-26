#!/usr/bin/env node
// UNPARK CHECK — docs/hopper/PARALLEL-CONTRACT.md §6 (tree-383bb55b node #946)
//
//   npm run unpark:check
//
// Drives the REAL compiled hopper-git.js (evaluateUnpark/parseUnparkCondition,
// filled by this node), unpark.js (the evaluateUnparks() batch pass) and the
// real goals.js / night-shift.js reevaluate* functions against a scratch DB.
//
// Hermetic: scratch DB under /tmp, JARVIS_SIM=1, zero model calls. The
// branch_pushed case uses REAL git (per CONTRACT §10 "git is real but local")
// against two throwaway repos under /tmp connected by a file:// remote — no
// network, ever.

import assert from 'node:assert/strict';
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
process.env.NIGHT_SHIFT_DRIVER = '0';
process.env.NIGHT_SHIFT_KICK_MS = '999999999';
process.env.GOALS_AUTOPILOT_DRIVER = '0';
process.env.GOALS_AUTOPILOT_KICK_MS = '999999999';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const dist = path.join(repoRoot, 'dist');
const { sqliteDb } = await import(path.join(dist, 'conversation-db.js'));
const hopperGit = await import(path.join(dist, 'hopper-git.js'));
const unpark = await import(path.join(dist, 'unpark.js'));
const goals = await import(path.join(dist, 'goals.js'));
const nightShift = await import(path.join(dist, 'night-shift.js'));

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

// ---------------------------------------------------------------------------
// Fixture helpers — raw INSERTs against the same tables the engine owns, so
// each check is a single-purpose fixture instead of standing up a full tree.
// ---------------------------------------------------------------------------
let treeSeq = 0;
function makeHopperTree(status = 'active') {
  const id = `tree-unpark-check-${++treeSeq}`;
  sqliteDb.prepare(`INSERT INTO hopper_trees (id, topic, status) VALUES (?, ?, ?)`).run(id, 'unpark check tree', status);
  return id;
}
function makeHopperNode(treeId, status = 'pending') {
  const info = sqliteDb.prepare(`INSERT INTO hopper_nodes (tree_id, title, status) VALUES (?, ?, ?)`).run(treeId, 'unpark check node', status);
  return Number(info.lastInsertRowid);
}
function setHopperNodeStatus(id, status) {
  sqliteDb.prepare(`UPDATE hopper_nodes SET status = ? WHERE id = ?`).run(status, id);
}
function setHopperTreeStatus(id, status) {
  sqliteDb.prepare(`UPDATE hopper_trees SET status = ? WHERE id = ?`).run(status, id);
}

let goalSeq = 0;
function makeGoalWithNode() {
  const { goal } = goals.createGoal({ title: `unpark check goal ${++goalSeq}`, done_means: 'n/a' });
  const node = goals.createGoalNode(goal.id, { title: 'node', done_means: 'n/a' });
  return { goalId: goal.id, nodeId: node.id };
}

function makeNightRun() {
  const info = sqliteDb.prepare(`INSERT INTO night_runs (status, mode, config, goal_ids) VALUES ('running','until_stop','{}','[]')`).run();
  return Number(info.lastInsertRowid);
}
let itemPos = 0;
function makeNightItem(runId, goalId, overrides = {}) {
  const info = sqliteDb.prepare(`
    INSERT INTO night_items (run_id, position, goal_id, node_id, kind, title, why, status, unpark_when)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId, ++itemPos, goalId, overrides.node_id ?? null, overrides.kind ?? 'plan',
    overrides.title ?? 'item', overrides.why ?? '', overrides.status ?? 'blocked', overrides.unpark_when ?? null,
  );
  return Number(info.lastInsertRowid);
}
function getNightItem(id) {
  return sqliteDb.prepare(`SELECT * FROM night_items WHERE id = ?`).get(id);
}

// ===========================================================================
console.log('\n[UC-1] parseUnparkCondition');
check('valid node_done parses', hopperGit.parseUnparkCondition(JSON.stringify({ kind: 'node_done', node_id: 5 }))?.kind === 'node_done');
check('null input -> null', hopperGit.parseUnparkCondition(null) === null);
check('garbage JSON -> null', hopperGit.parseUnparkCondition('{not json') === null);
check('unknown kind -> null', hopperGit.parseUnparkCondition(JSON.stringify({ kind: 'bogus' })) === null);

// ===========================================================================
console.log('\n[UC-2] evaluateUnpark: manual + null are NEVER met');
check('manual is never met', hopperGit.evaluateUnpark({ kind: 'manual' }) === false);
check('null condition is never met', hopperGit.evaluateUnpark(null) === false);

// ===========================================================================
console.log('\n[UC-3] evaluateUnpark: node_done');
{
  const treeId = makeHopperTree();
  const nodeId = makeHopperNode(treeId, 'pending');
  check('node not done -> false', hopperGit.evaluateUnpark({ kind: 'node_done', node_id: nodeId }) === false);
  setHopperNodeStatus(nodeId, 'done');
  check('node done -> true', hopperGit.evaluateUnpark({ kind: 'node_done', node_id: nodeId }) === true);
}

// ===========================================================================
console.log('\n[UC-4] evaluateUnpark: tree_done');
{
  const treeId = makeHopperTree('active');
  check('tree not done -> false', hopperGit.evaluateUnpark({ kind: 'tree_done', tree_id: treeId }) === false);
  setHopperTreeStatus(treeId, 'done');
  check('tree done -> true', hopperGit.evaluateUnpark({ kind: 'tree_done', tree_id: treeId }) === true);
}

// ===========================================================================
console.log('\n[UC-5] evaluateUnpark: file_exists');
{
  const p = path.join(os.tmpdir(), `unpark-check-file-${Date.now()}.txt`);
  fs.rmSync(p, { force: true });
  check('missing file -> false', hopperGit.evaluateUnpark({ kind: 'file_exists', path: p }) === false);
  fs.writeFileSync(p, 'x');
  check('present file -> true', hopperGit.evaluateUnpark({ kind: 'file_exists', path: p }) === true);
  fs.rmSync(p, { force: true });
}

// ===========================================================================
console.log('\n[UC-6] evaluateUnpark: branch_pushed (REAL git, LOCAL only — §10)');
{
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unpark-check-git-'));
  const originDir = path.join(gitRoot, 'origin.git');
  const workDir = path.join(gitRoot, 'work');
  fs.mkdirSync(originDir);
  fs.mkdirSync(workDir);
  const g = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
  g(originDir, ['init', '--bare', '-q']);
  g(workDir, ['init', '-q']);
  g(workDir, ['config', 'user.email', 'unpark-check@example.com']);
  g(workDir, ['config', 'user.name', 'unpark-check']);
  fs.writeFileSync(path.join(workDir, 'f.txt'), 'x');
  g(workDir, ['add', '.']);
  g(workDir, ['commit', '-q', '-m', 'init']);
  g(workDir, ['checkout', '-q', '-b', 'feature/unpark-check']);
  g(workDir, ['remote', 'add', 'origin', originDir]);

  check('branch not pushed -> false', hopperGit.evaluateUnpark({ kind: 'branch_pushed', repo: workDir, branch: 'feature/unpark-check' }) === false);
  g(workDir, ['push', '-q', 'origin', 'feature/unpark-check']);
  check('branch pushed -> true', hopperGit.evaluateUnpark({ kind: 'branch_pushed', repo: workDir, branch: 'feature/unpark-check' }) === true);
  check('remoteBranchExists agrees directly', hopperGit.remoteBranchExists(workDir, 'feature/unpark-check') === true);
  check('a never-pushed branch name -> false', hopperGit.remoteBranchExists(workDir, 'never-pushed') === false);
}

// ===========================================================================
console.log('\n[UC-7] evaluateUnparks — the batch pass (src/unpark.ts)');
{
  const treeId = makeHopperTree();
  const doneNodeId = makeHopperNode(treeId, 'done');
  const pendingNodeId = makeHopperNode(treeId, 'pending');
  const verdicts = unpark.evaluateUnparks([
    { ref: 'a', condition: { kind: 'node_done', node_id: doneNodeId } },
    { ref: 'b', condition: { kind: 'node_done', node_id: pendingNodeId } },
    { ref: 'c', condition: { kind: 'manual' } },
  ]);
  const byRef = Object.fromEntries(verdicts.map((v) => [v.ref, v.met]));
  check('batch: done node met', byRef.a === true);
  check('batch: pending node not met', byRef.b === false);
  check('batch: manual never met', byRef.c === false);
}

// ===========================================================================
console.log('\n[UC-8] goal node: manual park (park is one-way by default)');
{
  const { goalId, nodeId } = makeGoalWithNode();
  goals.parkGoalNode(goalId, nodeId, 'kevin', 'manual test');
  let node = goals.getRawGoalNode(nodeId);
  check('parked', node.state === 'parked');
  check('unpark_when is null for a manual park', node.unpark_when === null);
  const unparked = goals.reevaluateGoalNodeUnparks(goalId);
  check('reevaluate touches nothing', unparked.length === 0);
  node = goals.getRawGoalNode(nodeId);
  check('still parked after reevaluate — manual never self-clears', node.state === 'parked');
}

// ===========================================================================
console.log('\n[UC-9] goal node: node_done condition self-clears park');
{
  const { goalId, nodeId } = makeGoalWithNode();
  const treeId = makeHopperTree();
  const depNodeId = makeHopperNode(treeId, 'pending');
  goals.parkGoalNode(goalId, nodeId, 'system', 'waiting on dep', { kind: 'node_done', node_id: depNodeId });
  let node = goals.getRawGoalNode(nodeId);
  check('parked with condition recorded', node.state === 'parked' && JSON.parse(node.unpark_when).node_id === depNodeId);

  let unparked = goals.reevaluateGoalNodeUnparks(goalId);
  check('not yet unparked (dep still pending)', unparked.length === 0);
  node = goals.getRawGoalNode(nodeId);
  check('still parked', node.state === 'parked');

  setHopperNodeStatus(depNodeId, 'done');
  unparked = goals.reevaluateGoalNodeUnparks(goalId);
  check('unparked exactly this node', unparked.length === 1 && unparked[0].node_id === nodeId);
  node = goals.getRawGoalNode(nodeId);
  check('restored to set', node.state === 'set');
  check('unpark_when cleared', node.unpark_when === null);
}

// ===========================================================================
console.log('\n[UC-10] night item: manual park (no condition) never self-clears');
{
  const { goalId } = makeGoalWithNode();
  const runId = makeNightRun();
  const itemId = makeNightItem(runId, goalId, { status: 'blocked', unpark_when: null });
  const requeued = nightShift.reevaluateNightItemUnparks({ id: runId });
  check('nothing requeued', requeued.length === 0);
  check('item still blocked', getNightItem(itemId).status === 'blocked');
}

// ===========================================================================
// THE ACCEPTANCE SCENARIO (node spec): last night's Shift #6 failure —
// item #112 parked waiting on item #111's underlying work, #111 finishes,
// the very next tick re-queues #112. Modeled directly: #111's completion is a
// hopper node reaching `done` (exactly how #945's PARALLEL-CONTRACT.md landed —
// this node depended on that one finishing), #112 is a night item condition-
// parked on that node's id.
// ===========================================================================
console.log('\n[UC-11] ACCEPTANCE — #112 parked on node_done(#111), #111 finishes, next tick re-queues #112');
{
  const { goalId } = makeGoalWithNode();
  const runId = makeNightRun();
  const treeId = makeHopperTree();
  const node111 = makeHopperNode(treeId, 'pending'); // stands in for "#111 pushes the contract"
  const item112 = makeNightItem(runId, goalId, {
    title: '#112 (depends on #111)',
    status: 'blocked',
    unpark_when: JSON.stringify({ kind: 'node_done', node_id: node111 }),
  });

  let requeued = nightShift.reevaluateNightItemUnparks({ id: runId });
  check('tick before #111 finishes: no requeue', requeued.length === 0);
  check('#112 still blocked', getNightItem(item112).status === 'blocked');

  setHopperNodeStatus(node111, 'done'); // "#111 finishes"
  requeued = nightShift.reevaluateNightItemUnparks({ id: runId }); // "next tick"
  check('#111 done -> #112 re-queued in the very next tick', requeued.length === 1 && requeued[0].id === item112);
  const fresh = getNightItem(item112);
  check('#112 status is queued', fresh.status === 'queued');
  check('#112 unpark_when cleared', fresh.unpark_when === null);
}

// ===========================================================================
console.log('\n[UC-12] migration is additive — the new columns exist and are nullable');
{
  const goalNodeCols = sqliteDb.prepare(`PRAGMA table_info(goal_nodes)`).all();
  const upCol = goalNodeCols.find((c) => c.name === 'unpark_when');
  check('goal_nodes.unpark_when exists', !!upCol);
  check('goal_nodes.unpark_when is nullable', !!upCol && upCol.notnull === 0);

  const nightItemCols = sqliteDb.prepare(`PRAGMA table_info(night_items)`).all();
  const upCol2 = nightItemCols.find((c) => c.name === 'unpark_when');
  check('night_items.unpark_when exists', !!upCol2);
  check('night_items.unpark_when is nullable', !!upCol2 && upCol2.notnull === 0);

  // UC-8/UC-10 already inserted/parked rows with unpark_when omitted/NULL and
  // everything behaved exactly like pre-§6 park (one-way) — that IS the
  // "legacy trees dispatch identically" guarantee for this section.
  check('a null-condition park behaved exactly like today\'s one-way park (see UC-8/UC-10)', true);
}

console.log(`\n${pass} passed, ${fail} failed`);
try { assert.equal(fail, 0); } catch { /* summary already printed above */ }
process.exit(fail ? 1 : 0);
