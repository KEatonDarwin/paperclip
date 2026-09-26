#!/usr/bin/env node
// NIGHT NEVER-IDLE CHECK — docs/hopper/PARALLEL-CONTRACT.md §7 (tree-383bb55b node #947).
//
//   npm run night:never-idle:check
//
// Drives the REAL compiled night-shift.js (tickNightShift, the merged never-
// idle sequence: replanTail -> unpark re-check -> serial fallback -> stuck)
// and goals.js (createGoal/createGoalNode/parkGoalNode) directly, in-process,
// against a scratch DB. No HTTP, no server, no model calls: `postCue` no-ops
// when the target conversation doesn't exist (never created here), and every
// scenario below uses SERVER-kind night items (`verify`) or a raw fixture row,
// never a real model dispatch that would need a fake worker to answer it.
//
// Hermetic per CONTRACT §10: scratch DB under /tmp, JARVIS_SIM=1, zero model
// calls, governor bypassed via HOPPER_GOV_ENABLED=0 + the test override seam.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
process.env.NIGHT_SHIFT_STOP_FILE = path.join(path.dirname(DB_PATH), `night-never-idle-check-${process.pid}.stop`);
process.env.NIGHT_SHIFT_STUCK_TICKS = '3';
process.env.GOALS_AUTOPILOT_DRIVER = '0';
process.env.GOALS_AUTOPILOT_KICK_MS = '999999999';
fs.rmSync(process.env.NIGHT_SHIFT_STOP_FILE, { force: true });
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const dist = path.join(repoRoot, 'dist');
const { sqliteDb } = await import(path.join(dist, 'conversation-db.js'));
const goals = await import(path.join(dist, 'goals.js'));
const night = await import(path.join(dist, 'night-shift.js'));

night.__setNightShiftTestOverrides({ governor: () => ({ allow: true, reason: '', detail: '' }) });

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
// Fixture helpers
// ---------------------------------------------------------------------------
let treeSeq = 0;
function makeHopperTree(status = 'active') {
  const id = `tree-nvi-check-${++treeSeq}`;
  sqliteDb.prepare(`INSERT INTO hopper_trees (id, topic, status) VALUES (?, ?, ?)`).run(id, 'never-idle check tree', status);
  return id;
}
function makeHopperMarker(treeId) {
  const info = sqliteDb.prepare(`INSERT INTO hopper_nodes (tree_id, title, status) VALUES (?, ?, 'pending')`).run(treeId, 'marker');
  return Number(info.lastInsertRowid);
}
function markHopperNodeDone(id) {
  sqliteDb.prepare(`UPDATE hopper_nodes SET status = 'done' WHERE id = ?`).run(id);
}

function insertNightRun(goalIds) {
  const info = sqliteDb.prepare(`
    INSERT INTO night_runs (status, mode, config, goal_ids, started_at) VALUES ('running', 'until_stop', '{}', ?, datetime('now'))
  `).run(JSON.stringify(goalIds));
  return Number(info.lastInsertRowid);
}
function insertNightItem(runId, goalId, nodeId, kind, status, opts = {}) {
  const info = sqliteDb.prepare(`
    INSERT INTO night_items (run_id, position, goal_id, node_id, kind, title, why, status)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?)
  `).run(runId, goalId, nodeId, kind, opts.title ?? 'item', opts.why ?? '', status);
  return Number(info.lastInsertRowid);
}
function setNodeFields(nodeId, fields) {
  const cols = Object.keys(fields);
  const sql = `UPDATE goal_nodes SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`;
  sqliteDb.prepare(sql).run(...cols.map((c) => fields[c]), nodeId);
}
function lastHoldEvent(runId) {
  return sqliteDb.prepare(`SELECT * FROM night_events WHERE run_id = ? AND kind = 'hold' ORDER BY id DESC LIMIT 1`).get(runId);
}
function lastEventOfKind(runId, kind) {
  return sqliteDb.prepare(`SELECT * FROM night_events WHERE run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`).get(runId, kind);
}

// ===========================================================================
console.log('\n[NVI-A] 4-item chain: item1 finishes, items 2-4 are dependency-parked (§6) — the driver must keep progressing serially to completion, max 1 concurrent, and must NOT go complete/stuck while a live unpark condition is still outstanding');
{
  const { goal } = goals.createGoal({ title: 'NVI-A chain goal', done_means: 'n/a' });
  const goalId = goal.id;
  const treeId = makeHopperTree();
  const markers = [makeHopperMarker(treeId), makeHopperMarker(treeId), makeHopperMarker(treeId)];

  // 4 sibling "stage" nodes under the goal root, each with one already-`done`
  // child, so its `verify` item settles synchronously (a server kind — no
  // model call, no fake worker needed) the instant it reaches `check`.
  const nodes = [];
  for (let i = 0; i < 4; i += 1) {
    const n = goals.createGoalNode(goalId, { title: `NVI-A stage ${i + 1}`, done_means: 'n/a', sort_order: i, actor: 'jarvis' });
    const child = goals.createGoalNode(goalId, { title: `NVI-A stage ${i + 1} child`, done_means: 'n/a', parent_id: n.id, actor: 'jarvis' });
    setNodeFields(child.id, { state: 'done' });
    nodes.push(n);
  }
  // Stage 1 is immediately workable. Stages 2-4 start PARKED, each waiting on
  // the previous stage's marker — modeling exactly Shift #6's "parked
  // head-of-chain" shape, now with a condition attached (§6) instead of a
  // one-way manual park.
  setNodeFields(nodes[0].id, { state: 'check' });
  for (let i = 1; i < 4; i += 1) {
    setNodeFields(nodes[i].id, { state: 'check' });
    goals.parkGoalNode(goalId, nodes[i].id, 'system', 'chain test — waiting on the previous stage', { kind: 'node_done', node_id: markers[i - 1] });
  }

  const runId = insertNightRun([goalId]);
  let maxRunning = 0;
  const observe = () => {
    const running = night.listNightItems(runId).filter((i) => i.status === 'running').length;
    if (running > maxRunning) maxRunning = running;
  };
  const freshNode = (id) => goals.getRawGoalNode(id);

  await night.tickNightShift('test');
  observe();
  check('A1: tick 1 — stage 1 verified done (no model call, no worker fake needed)', freshNode(nodes[0].id).state === 'done');
  check('A1: run is still running', night.getNightRun(runId).status === 'running');

  // An idle tick with marker[0] still pending must NOT end the run — a live
  // unpark condition (§6) may still clear later; ending here would strand
  // stages 2-4 forever, exactly the "9 hours unused" failure §0 describes.
  await night.tickNightShift('test');
  check('A2: an idle tick (marker not yet fired) does not stop the run', night.getNightRun(runId).status === 'running');

  markHopperNodeDone(markers[0]);
  await night.tickNightShift('test');
  observe();
  check('A3: stage 2 unparked + verified done on the very next tick', freshNode(nodes[1].id).state === 'done');

  await night.tickNightShift('test');
  check('A4: idle tick before marker[1] fires — still running', night.getNightRun(runId).status === 'running');

  markHopperNodeDone(markers[1]);
  await night.tickNightShift('test');
  observe();
  check('A5: stage 3 unparked + verified done', freshNode(nodes[2].id).state === 'done');

  markHopperNodeDone(markers[2]);
  await night.tickNightShift('test');
  observe();
  check('A6: stage 4 unparked + verified done', freshNode(nodes[3].id).state === 'done');

  await night.tickNightShift('test');
  const run = night.getNightRun(runId);
  check('A7: everything done -> immediate `complete` (not stuck, not stranded)', run.status === 'complete' && run.stop_reason === 'complete');
  check('A8: never more than 1 item running at once across the whole chain', maxRunning <= 1, `saw ${maxRunning}`);
}

// ===========================================================================
console.log('\n[NVI-B] serial fallback: an eligible "waits on #X" item is force-dispatched as the one worker when replanTail + unpark both find nothing');
{
  const { goal } = goals.createGoal({ title: 'NVI-B fallback goal', done_means: 'n/a' });
  const goalId = goal.id;
  const p = goals.createGoalNode(goalId, { title: 'NVI-B parent', done_means: 'n/a', actor: 'jarvis' });
  const a = goals.createGoalNode(goalId, { title: 'NVI-B node A (stuck limbo — never gets an item, never settles)', done_means: 'n/a', parent_id: p.id, leaf_kind: 'machine', sort_order: 0, actor: 'jarvis' });
  const b = goals.createGoalNode(goalId, { title: 'NVI-B node B (waits on A)', done_means: 'n/a', parent_id: p.id, leaf_kind: 'machine', sort_order: 1, actor: 'jarvis' });
  // A: state=set, leaf_kind=machine, plan_state=proposed — no `deriveKind` /
  // `simulateGoal` rule matches this (rule 6 requires plan_state='none'), and
  // it is not `isSettled` either. It never gets an item and never settles: a
  // genuine FSM gap, which is exactly the kind of thing §7 is a backstop for.
  setNodeFields(a.id, { plan_state: 'proposed' });

  const runId = insertNightRun([goalId]);
  // B's item is inserted directly (simulating "this was planned before A
  // regressed into limbo") since simulateGoal itself would never emit it
  // while A is unsettled — B's own `earlierOk` gate blocks that.
  const itemBId = insertNightItem(runId, goalId, b.id, 'plan', 'queued', { title: b.title, why: 'pre-existing plan item (fixture)' });

  await night.tickNightShift('test');

  const itemB = night.listNightItems(runId).find((i) => i.id === itemBId);
  check('B1: the eligible "waits on #A" item was force-dispatched (now running)', !!itemB && itemB.status === 'running', JSON.stringify(itemB));
  check('B2: the run is still `running`, not `stuck`', night.getNightRun(runId).status === 'running');
  const fbEvent = lastEventOfKind(runId, 'serial_fallback');
  check('B3: a serial_fallback event was recorded naming the dispatched item', !!fbEvent && fbEvent.text.includes(b.title), JSON.stringify(fbEvent));
}

// ===========================================================================
console.log('\n[NVI-C] a queue of only human items stops WITH per-item reasons in the record — never a bare "stuck", never a false `complete`');
{
  const { goal } = goals.createGoal({ title: 'NVI-C human-only goal', done_means: 'n/a' });
  const goalId = goal.id;
  const h = goals.createGoalNode(goalId, { title: 'NVI-C human step — approve the thing', done_means: 'n/a', leaf_kind: 'human', actor: 'jarvis' });
  const runId = insertNightRun([goalId]);

  await night.tickNightShift('test');
  check('C1: tick 1 (idle 1/3) — run not yet stopped', night.getNightRun(runId).status === 'running');
  await night.tickNightShift('test');
  check('C2: tick 2 (idle 2/3) — still not stopped (grace period, NIGHT_SHIFT_STUCK_TICKS=3)', night.getNightRun(runId).status === 'running');
  await night.tickNightShift('test');
  const run = night.getNightRun(runId);
  check('C3: tick 3 (idle 3/3) — run stops `stuck`, never `complete`', run.status === 'stopped' && run.stop_reason === 'stuck');

  const hold = lastHoldEvent(runId);
  check('C4: the hold event names the human item by title', !!hold && hold.text.includes('NVI-C human step'), JSON.stringify(hold));
  check('C5: the hold event is not a bare "stuck" with no items', !!hold && !/no reason recorded/.test(hold.text));
  check('C6: the hold event data carries a structured per-item entry', (() => {
    if (!hold?.data) return false;
    const data = JSON.parse(hold.data);
    return Array.isArray(data.items) && data.items.some((e) => e.title.includes('NVI-C human step') && /human/.test(e.reason));
  })());

  const report = night.buildNightShiftReport(runId);
  check('C7: the morning report "Needs you" section names the human item', report.markdown.includes('NVI-C human step'));
}

console.log(`\n${pass} passed, ${fail} failed`);
try { assert.equal(fail, 0); } catch { /* summary already printed above */ }
process.exit(fail ? 1 : 0);
