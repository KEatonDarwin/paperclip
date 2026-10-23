#!/usr/bin/env node
// NOTEPAD ROUTE CHECK (node #875, moved to BLOCKS by node #943) — the
// end-to-end proof for this tree: three topic shapes land in three real
// sinks, a fourth stays conversation-only, and dispatching every topic a
// SECOND time creates nothing new anywhere.
//
// Since node #943 the unit is a topic BLOCK (docs/notepad/BLOCKS.md) — a
// zero-indent headline plus everything Kevin indented under it — not a line.
// The day seeded below is written the way he actually writes: four headlines
// with irregularly-indented, dash-prefixed children, where the routing cue
// lives on a CHILD line and only makes sense under its headline.
//
// This is deliberately NOT another unit check (node #874's own
// notepad-dispatch-check.mjs already covers that in detail). This script
// seeds ONE realistic day with all four shapes together, dispatches the
// whole day once, snapshots every sink table, dispatches the whole day
// AGAIN, and asserts the snapshots are byte-for-byte the same counts.
//
// Covers, per the node's acceptance bar:
//   (1) goal-shaped block -> exactly ONE ghost goal proposal (never a set
//       node, never a root goal), action_ref goal:<goal_id>:<node_id>
//   (2) build-shaped block -> exactly ONE hopper candidate, action_ref
//       hopper:<id>
//   (3) ball-in-the-air block -> exactly ONE workstream with a turn and a
//       next_action, action_ref workstream:<id>
//   (4) a question-kind block -> thread:<ext>, and creates NO goal/hopper/
//       workstream row
//   (4b) THE LEDGER STAYS PER-LINE: every block's HEADLINE is 'acted' with
//       the action_ref and every other member is 'seen' — one topic, one
//       action, and not one orphaned child line left unscanned forever.
//   (5) EXACTLY ONCE: re-dispatching every block above creates no second row
//       anywhere — row counts in every sink table, before vs. after, delta 0
//   (6) every action_ref parses with parseActionRef and resolves to a row
//       that actually exists
//   (7) nothing was written to any DAR/Paperclip surface — grep the compiled
//       sink modules for any reference to one; there is no code path there
//       that could reach it
//   (8) zero net new claude processes spawned across the whole run
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-route-check-<ts>.db node scripts/notepad-route-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

// ── scratch DB guard (copied verbatim from the sibling notepad checks) ──────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

console.log(`[notepad-route-check] DB: ${DB_PATH}`);

function claudeProcessCount() {
  try {
    const out = execSync('pgrep -c -f claude', { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch (err) {
    // pgrep exits 1 when nothing matches — that's zero, not a failure.
    if (err && err.status === 1) return 0;
    throw err;
  }
}

const spawnsBefore = claudeProcessCount();

// No real Smarty Pants / model reachable from this scratch run — anything
// that tried to reach out would time out fast rather than hang.
process.env.JARVIS_SMARTY_PANTS_URL = 'http://127.0.0.1:1';
process.env.JARVIS_MCP_NATIVE_TIMEOUT_MS = '5000';

const distDir = path.join(repoRoot, 'dist');
const { putNotepadDay, getNotepadLineState } = await import(path.join(distDir, 'notepad.js'));
const { reconcileNotepadMarker } = await import(path.join(distDir, 'notepad-markers.js'));
const { getConversation } = await import(path.join(distDir, 'conversation-db.js'));
const { createGoal, createGoalNode, getGoalTree } = await import(path.join(distDir, 'goals.js'));
const { listHopperItems, getHopperItem } = await import(path.join(distDir, 'hopper.js'));
const { listWorkstreams, getWorkstream } = await import(path.join(distDir, 'workstreams.js'));
const { dispatchNotepadBlock, buildActionRef, parseActionRef } = await import(
  path.join(distDir, 'notepad-dispatch.js'),
);
const { parseNotepadBlocks, notepadBlockId } = await import(path.join(distDir, 'notepad-blocks.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

function lineIdByText(saved, text) {
  const line = saved.lines.find((l) => l.text === text);
  assert.ok(line, `fixture line '${text}' must exist`);
  return line.id;
}

const stubHandoffOpts = {
  dossierOpts: { runOneShot: async () => '{}' },
  postMessage: async () => '[stub] posted',
};

// -- fixture: a real "set" goal + node for the goal-shaped line to propose under
const testGoal = createGoal({ title: 'Route check test goal', done_means: 'the check passes', authored_by: 'kevin' });
const testNode = createGoalNode(testGoal.goal.id, {
  title: 'A real node the check can propose a child under',
  done_means: 'exists for the fixture',
  authored_by: 'kevin',
});
const dossierWithGoal = { confidence: 'strong', goal: { goal_id: testGoal.goal.id, node_id: testNode.id, title: testNode.title } };

// -- ONE seeded day, all four topic shapes together, written the way Kevin
// actually writes: a headline with irregularly-indented dashed children, and
// the routing cue sitting on a CHILD line that only means something under it.
const DAY = '2026-09-25';
const NOTE = [
  'Potential Goals:',                                      // goal block
  '  - a shared retro board for the team',
  '     - everyone drops cards during the week',
  '',
  '  - one place for the quarterly themes',
  'Cockpit composer',                                      // hopper block
  '  - fix the composer auto-grow bug in the cockpit endpoint',
  '   - it jumps when you paste',
  'Suppression files',                                     // workstream block
  '\t- waiting on Mike to finish the suppression file',
  '  - six sources still not suppressing',
  'Old export script',                                     // thread block (question kind)
  '  - should we sunset it?',
].join('\n');

const saved = putNotepadDay(DAY, NOTE);
const parsedBlocks = parseNotepadBlocks(saved.lines.map((l) => ({ id: l.id, idx: l.idx, text: l.text })));
check('the day parses into exactly 4 topic blocks', parsedBlocks.length === 4);

const lineById = new Map(saved.lines.map((l) => [l.id, l]));
function toRouteBlock(b) {
  return {
    block_id: notepadBlockId(b),
    headline_line_id: b.headline_line_id,
    headline: b.headline,
    lines: b.member_line_ids.map((id) => ({ line_id: id, idx: lineById.get(id).idx, text: lineById.get(id).text })),
  };
}
const [goalBlock, hopperBlock, workstreamBlock, questionBlock] = parsedBlocks.map(toRouteBlock);
check('block headlines are the four topics, in document order', [goalBlock, hopperBlock, workstreamBlock, questionBlock].map((b) => b.headline).join(' | ') === 'Potential Goals: | Cockpit composer | Suppression files | Old export script');

// take_it for the three machinery-eligible topics; the fourth carries a
// non-take_it move kind, which alone forces it to `thread` regardless of shape.
// The marker lives on the HEADLINE line — one marker per topic.
reconcileNotepadMarker(goalBlock.block_id, { kind: 'take_it', reason: 'route check fixture' });
reconcileNotepadMarker(hopperBlock.block_id, { kind: 'take_it', reason: 'route check fixture' });
reconcileNotepadMarker(workstreamBlock.block_id, { kind: 'take_it', reason: 'route check fixture' });
reconcileNotepadMarker(questionBlock.block_id, { kind: 'question', reason: 'route check fixture' });

const dispatchArgs = {
  goal: { block: goalBlock, move: { kind: 'take_it', reason: 'goal-shaped' }, dossier: dossierWithGoal, handoffOpts: stubHandoffOpts },
  hopper: { block: hopperBlock, move: { kind: 'take_it', reason: 'build-shaped' }, handoffOpts: stubHandoffOpts },
  workstream: { block: workstreamBlock, move: { kind: 'take_it', reason: 'ball-in-air' }, handoffOpts: stubHandoffOpts },
  question: { block: questionBlock, move: { kind: 'question', reason: 'genuinely a question' }, handoffOpts: stubHandoffOpts },
};
const blocksByKey = { goal: goalBlock, hopper: hopperBlock, workstream: workstreamBlock, question: questionBlock };

// -- snapshot every sink table before the first dispatch pass ---------------
function snapshot() {
  return {
    goalNodeCount: getGoalTree(testGoal.goal.id).nodes.length,
    hopperCount: listHopperItems('all', 500).length,
    workstreamCount: listWorkstreams(true).length,
  };
}

const before = snapshot();

// -- FIRST PASS: dispatch all four lines -------------------------------------
const results = {};
for (const key of ['goal', 'hopper', 'workstream', 'question']) {
  results[key] = await dispatchNotepadBlock(dispatchArgs[key]);
}

// -- (1) goal-shaped line -> exactly one ghost goal proposal -----------------
{
  const r = results.goal;
  check('goal-shaped block routed to goal_proposal', r.decision.sink === 'goal_proposal');
  check('goal-shaped block dispatched AS goal_proposal (no fallback)', r.sink === 'goal_proposal');
  check('goal dispatch created a new row', r.created === true);
  const parsed = parseActionRef(r.action_ref);
  check('action_ref matches goal:<goal_id>:<node_id>', parsed?.sink === 'goal_proposal' && parsed.goal_id === testGoal.goal.id);
  check('action_ref round-trips', buildActionRef(parsed) === r.action_ref);
  const tree = getGoalTree(testGoal.goal.id);
  check('exactly one new node appeared under the goal', tree.nodes.length === before.goalNodeCount + 1);
  const node = tree.nodes.find((n) => n.id === parsed.node_id);
  check('the proposed node exists (resolves)', !!node);
  check('the proposed node is a GHOST awaiting Kevin, not set', node?.state === 'ghost');
  check('the proposed node is NOT the root goal', node?.id !== testGoal.goal.id);
  check('the proposed node is authored_by jarvis', node?.authored_by === 'jarvis');
}

// -- (2) build-shaped line -> exactly one hopper candidate -------------------
{
  const r = results.hopper;
  check('build-shaped block routed to hopper (the cue lives on a child line)', r.decision.sink === 'hopper' && r.sink === 'hopper');
  check('hopper dispatch created a new row', r.created === true);
  const parsed = parseActionRef(r.action_ref);
  check('action_ref matches hopper:<id>', parsed?.sink === 'hopper');
  const item = getHopperItem(parsed.candidate_id);
  check('the hopper candidate exists (resolves)', !!item);
  check('the hopper candidate is pending (a candidate, not started work)', item?.status === 'pending');
  check('exactly one new hopper item appeared', listHopperItems('all', 500).length === before.hopperCount + 1);
}

// -- (3) ball-in-the-air line -> exactly one workstream ----------------------
{
  const r = results.workstream;
  check('ball-in-air block routed to workstream (the cue lives on a child line)', r.decision.sink === 'workstream' && r.sink === 'workstream');
  check('workstream dispatch created a new row', r.created === true);
  const parsed = parseActionRef(r.action_ref);
  check('action_ref matches workstream:<id>', parsed?.sink === 'workstream');
  const ws = getWorkstream(parsed.workstream_id);
  check('the workstream exists (resolves)', !!ws);
  check('the workstream carries a turn', ws?.turn === 'jarvis');
  check('the workstream carries a next_action', typeof ws?.next_action === 'string' && ws.next_action.length > 0);
  check('exactly one new workstream appeared', listWorkstreams(true).length === before.workstreamCount + 1);
}

// -- (4) question-kind line -> thread only, no machinery row -----------------
{
  const r = results.question;
  check('question-kind block routed to thread', r.decision.sink === 'thread' && r.sink === 'thread');
  check('thread dispatch created a new row', r.created === true);
  const parsed = parseActionRef(r.action_ref);
  check('action_ref matches thread:<ext>', parsed?.sink === 'thread');
  check('the conversation exists (resolves)', !!getConversation(parsed.thread_ext));

  const afterQuestion = snapshot();
  check('question block created NO goal node', afterQuestion.goalNodeCount === before.goalNodeCount + 1); // +1 is the goal line's own node, not this one
  check('question block created NO hopper item', afterQuestion.hopperCount === before.hopperCount + 1); // +1 is the hopper line's own item
  check('question block created NO workstream', afterQuestion.workstreamCount === before.workstreamCount + 1); // +1 is the workstream line's own row
}

const afterFirstPass = snapshot();

// -- (5) EXACTLY ONCE: re-dispatch every line, assert zero deltas everywhere -
// The thread re-dispatch is handed exploding stubs — if dispatch actually
// short-circuits on the ledger check (rather than merely returning the same
// answer by luck) it must never even reach these.
const explodingHandoffOpts = {
  dossierOpts: { runOneShot: async () => { throw new Error('must not be called twice'); } },
  postMessage: async () => { throw new Error('must not post twice'); },
};

const second = {};
for (const key of ['goal', 'hopper', 'workstream']) {
  second[key] = await dispatchNotepadBlock(dispatchArgs[key]);
}
second.question = await dispatchNotepadBlock({ ...dispatchArgs.question, handoffOpts: explodingHandoffOpts });

for (const key of ['goal', 'hopper', 'workstream', 'question']) {
  check(`second dispatch of ${key} block reports created:false`, second[key].created === false);
  check(`second dispatch of ${key} block returns the SAME action_ref`, second[key].action_ref === results[key].action_ref);
}

const afterSecondPass = snapshot();
check('zero delta: goal node count unchanged by the re-dispatch pass', afterSecondPass.goalNodeCount === afterFirstPass.goalNodeCount);
check('zero delta: hopper item count unchanged by the re-dispatch pass', afterSecondPass.hopperCount === afterFirstPass.hopperCount);
check('zero delta: workstream count unchanged by the re-dispatch pass', afterSecondPass.workstreamCount === afterFirstPass.workstreamCount);

// -- (6) every action_ref written to the ledger matches the dispatch result --
// -- (4b) THE LEDGER STAYS PER-LINE: headline 'acted' + action_ref, every
// other member 'seen'. This is the whole point of BLOCKS.md's binding
// decision — blocks judge, lines remember.
for (const key of ['goal', 'hopper', 'workstream', 'question']) {
  const block = blocksByKey[key];
  const ledger = getNotepadLineState(block.block_id);
  check(`${key} block's HEADLINE ledger action_ref matches the dispatch result`, ledger?.action_ref === results[key].action_ref);
  check(`${key} block's HEADLINE is 'acted'`, ledger?.state === 'acted');
  check(`${key} block's HEADLINE action_ref still parses after both passes`, parseActionRef(ledger?.action_ref ?? '') !== null);

  const childIds = block.lines.map((l) => l.line_id).filter((id) => id !== block.block_id);
  check(
    `${key} block's ${childIds.length} child line(s) are all 'seen', none acted, none carrying an action_ref`,
    childIds.length > 0 && childIds.every((id) => {
      const st = getNotepadLineState(id);
      return st?.state === 'seen' && st.action_ref === null;
    }),
  );
}

// -- (7) nothing was written to any DAR / Paperclip surface ------------------
// Static proof, not a guess: grep the compiled sink modules this check
// actually exercised for any reference to Paperclip/DAR. There is no client,
// no fetch, no import of one anywhere in this call graph.
{
  const sinkModules = ['notepad-dispatch.js', 'notepad-route-rule.js', 'hopper.js', 'goals.js', 'workstreams.js', 'notepad-handoff.js'];
  const hits = [];
  for (const mod of sinkModules) {
    const p = path.join(distDir, mod);
    const src = fs.readFileSync(p, 'utf8');
    if (/paperclip|\bDAR-\d|dar_issue|create_issue/i.test(src)) hits.push(mod);
  }
  check('no sink module references Paperclip/DAR in any form', hits.length === 0);
}

// -- (8) zero net new claude processes spawned across the whole run ---------
const spawnsAfter = claudeProcessCount();
check(`no net new claude processes spawned (before=${spawnsBefore}, after=${spawnsAfter})`, spawnsAfter <= spawnsBefore);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
