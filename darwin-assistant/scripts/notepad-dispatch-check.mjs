#!/usr/bin/env node
// NOTEPAD DISPATCH CHECK — node #874's src/notepad-dispatch.ts, exercised
// against a scratch DB the same way every other notepad check does
// (notepad-handoff-route-check.mjs is the closest sibling in shape).
//
// Covers, per the node's acceptance bar:
//   (1) one line of each of the four route shapes dispatches to the right
//       sink: goal_proposal, hopper, workstream, thread.
//   (2) each sink's row actually exists (goal_nodes ghost row, hopper_items
//       row, workstreams row, a real conversation for the thread).
//   (3) the line's action_ref matches the documented buildActionRef scheme,
//       and parseActionRef round-trips it back to the same target.
//   (4) a second dispatch of the SAME line returns created:false and adds
//       NO second row anywhere (idempotency, proven by row-count deltas, not
//       assumed).
//   (5) the goal-shaped line produced a GHOST proposal awaiting Kevin
//       (state:'ghost', authored_by:'jarvis'), never a set node.
//   (6) a goal-shaped line whose dossier names NO goal falls back to the
//       thread sink rather than inventing a goal to attach to.
//   (7) NODE #943 — THE BLOCK FORM (dispatchNotepadBlock): a real
//       headline+indented-children topic dispatches as ONE thing; the
//       HEADLINE line gets the 'acted' ledger row + the action_ref + the one
//       marker, every OTHER member is marked 'seen' (never acted, never its
//       own sink row); the sink row carries the whole topic (hopper
//       raw_message, goal-proposal notes); a thread handoff seeds the WHOLE
//       block; and re-dispatching the block is a no-op.
//   (8) ZERO claude processes spawned across the whole run.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-dispatch-check.db node scripts/notepad-dispatch-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

console.log(`[notepad-dispatch-check] DB: ${DB_PATH}`);

function claudeProcessCount() {
  try {
    const out = execSync('pgrep -c -f claude', { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch (err) {
    if (err && err.status === 1) return 0;
    throw err;
  }
}

const spawnsBefore = claudeProcessCount();

process.env.JARVIS_SMARTY_PANTS_URL = 'http://127.0.0.1:1';
process.env.JARVIS_MCP_NATIVE_TIMEOUT_MS = '5000';

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay, getNotepadLineState } = await import(path.join(distDir, 'notepad.js'));
const { reconcileNotepadMarker, getNotepadMarker } = await import(path.join(distDir, 'notepad-markers.js'));
const { getConversation } = await import(path.join(distDir, 'conversation-db.js'));
const { createGoal, createGoalNode, getGoalTree } = await import(path.join(distDir, 'goals.js'));
const { listHopperItems, getHopperItem } = await import(path.join(distDir, 'hopper.js'));
const { listWorkstreams, getWorkstream } = await import(path.join(distDir, 'workstreams.js'));
const { dispatchNotepadLine, dispatchNotepadBlock, buildActionRef, parseActionRef } = await import(
  path.join(distDir, 'notepad-dispatch.js')
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

function toRouteLine(line) {
  return { line_id: line.id, idx: line.idx, text: line.text };
}

const stubHandoffOpts = {
  dossierOpts: { runOneShot: async () => '{}' },
  postMessage: async () => '[stub] posted',
};

// -- parseActionRef/buildActionRef round-trip, in isolation ------------------
{
  const cases = [
    { sink: 'goal_proposal', goal_id: 6, node_id: 42 },
    { sink: 'hopper', candidate_id: 7 },
    { sink: 'workstream', workstream_id: 3 },
    { sink: 'thread', thread_ext: 'cockpit:notepad-line-99' },
  ];
  for (const c of cases) {
    const ref = buildActionRef(c);
    const parsed = parseActionRef(ref);
    check(`buildActionRef/parseActionRef round-trips ${c.sink}`, JSON.stringify(parsed) === JSON.stringify(c));
  }
  check('parseActionRef returns null for an unrecognized shape', parseActionRef('bogus:1') === null);
}

// -- fixture setup: a real "set" goal with a real "set" node to propose under
const testGoal = createGoal({ title: 'Dispatch check test goal', done_means: 'the check passes', authored_by: 'kevin' });
const testNode = createGoalNode(testGoal.goal.id, {
  title: 'A real node the check can propose a child under',
  done_means: 'exists for the fixture',
  authored_by: 'kevin',
});
const dossierWithGoal = { confidence: 'strong', goal: { goal_id: testGoal.goal.id, node_id: testNode.id, title: testNode.title } };

const DAY = '2026-09-25';
const saved = putNotepadDay(
  DAY,
  [
    'goal: build a dog-walking app for the neighborhood',
    'build a new export script for the hub2 revenue dashboard',
    'waiting on Mike to finish the suppression file',
    'thinking about what to get for lunch',
    'goal: a genuinely novel idea with no home anywhere',
  ].join('\n'),
);

const goalLine = lineIdByText(saved, 'goal: build a dog-walking app for the neighborhood');
const hopperLine = lineIdByText(saved, 'build a new export script for the hub2 revenue dashboard');
const workstreamLine = lineIdByText(saved, 'waiting on Mike to finish the suppression file');
const threadLine = lineIdByText(saved, 'thinking about what to get for lunch');
const noHomeGoalLine = lineIdByText(saved, 'goal: a genuinely novel idea with no home anywhere');

for (const id of [goalLine, hopperLine, workstreamLine, threadLine, noHomeGoalLine]) {
  reconcileNotepadMarker(id, { kind: 'take_it', reason: 'dispatch check fixture' });
}

// -- (1)+(2)+(3)+(5) goal_proposal sink ---------------------------------------
{
  const before = getGoalTree(testGoal.goal.id).nodes.length;
  const line = saved.lines.find((l) => l.id === goalLine);
  const result = await dispatchNotepadLine({
    line: toRouteLine(line),
    move: { kind: 'take_it', reason: 'a real goal-shaped idea' },
    dossier: dossierWithGoal,
    handoffOpts: stubHandoffOpts,
  });

  check('goal-shaped line routed to goal_proposal', result.decision.sink === 'goal_proposal');
  check('goal-shaped line dispatched AS goal_proposal (no fallback)', result.sink === 'goal_proposal');
  check('goal_proposal dispatch reports created:true', result.created === true);

  const parsed = parseActionRef(result.action_ref);
  check('action_ref matches the goal:<goal_id>:<node_id> scheme', parsed?.sink === 'goal_proposal' && parsed.goal_id === testGoal.goal.id);
  check('action_ref round-trips via parseActionRef', buildActionRef(parsed) === result.action_ref);

  const tree = getGoalTree(testGoal.goal.id);
  check('exactly one new node appeared under the goal', tree.nodes.length === before + 1);
  const node = tree.nodes.find((n) => n.id === parsed.node_id);
  check('the proposed node exists', !!node);
  check('the proposed node is a GHOST, not set (Kevin has not ✓d it)', node?.state === 'ghost');
  check('the proposed node is authored_by jarvis', node?.authored_by === 'jarvis');
  check('the proposed node title is the line text verbatim', node?.title === line.text);
  check('the proposed node carries a one-line done_means', typeof node?.done_means === 'string' && node.done_means.length > 0);
  check('the proposed node is parented under the dossier-named node', node?.parent_id === testNode.id);

  const ledger = getNotepadLineState(goalLine);
  check("the line's ledger action_ref matches the dispatch result", ledger?.action_ref === result.action_ref);
  check("the line's ledger state is 'acted'", ledger?.state === 'acted');

  const marker = getNotepadMarker(goalLine);
  check("the marker's action_ref also matches (goal/hopper/workstream sinks stamp it)", marker?.action_ref === result.action_ref);

  // -- (4) idempotency: second dispatch is a no-op --------------------------
  const beforeSecond = getGoalTree(testGoal.goal.id).nodes.length;
  const second = await dispatchNotepadLine({
    line: toRouteLine(line),
    move: { kind: 'take_it', reason: 'a real goal-shaped idea' },
    dossier: dossierWithGoal,
    handoffOpts: stubHandoffOpts,
  });
  check('second dispatch reports created:false', second.created === false);
  check('second dispatch returns the SAME action_ref', second.action_ref === result.action_ref);
  check('second dispatch created NO second node', getGoalTree(testGoal.goal.id).nodes.length === beforeSecond);
}

// -- (1)+(2)+(3) hopper sink ---------------------------------------------------
{
  const beforeCount = listHopperItems('all', 500).length;
  const line = saved.lines.find((l) => l.id === hopperLine);
  const result = await dispatchNotepadLine({
    line: toRouteLine(line),
    move: { kind: 'take_it', reason: 'a concrete build ask' },
    handoffOpts: stubHandoffOpts,
  });

  check('build-shaped line routed to hopper', result.decision.sink === 'hopper' && result.sink === 'hopper');
  check('hopper dispatch reports created:true', result.created === true);

  const parsed = parseActionRef(result.action_ref);
  check('action_ref matches the hopper:<candidate_id> scheme', parsed?.sink === 'hopper');
  const item = getHopperItem(parsed.candidate_id);
  check('the hopper candidate row exists', !!item);
  check('the hopper candidate is pending (a candidate, not started work)', item?.status === 'pending');
  check('the hopper candidate title is the line text', item?.title === line.text);
  check('exactly one new hopper item appeared', listHopperItems('all', 500).length === beforeCount + 1);

  const ledger = getNotepadLineState(hopperLine);
  check("the line's ledger action_ref matches", ledger?.action_ref === result.action_ref);

  // idempotency
  const beforeSecond = listHopperItems('all', 500).length;
  const second = await dispatchNotepadLine({
    line: toRouteLine(line),
    move: { kind: 'take_it', reason: 'a concrete build ask' },
    handoffOpts: stubHandoffOpts,
  });
  check('second hopper dispatch reports created:false', second.created === false);
  check('second hopper dispatch created NO second candidate', listHopperItems('all', 500).length === beforeSecond);
}

// -- (1)+(2)+(3) workstream sink -----------------------------------------------
{
  const beforeCount = listWorkstreams(true).length;
  const line = saved.lines.find((l) => l.id === workstreamLine);
  const result = await dispatchNotepadLine({
    line: toRouteLine(line),
    move: { kind: 'take_it', reason: 'a ball in the air' },
    handoffOpts: stubHandoffOpts,
  });

  check('ball-in-air line routed to workstream', result.decision.sink === 'workstream' && result.sink === 'workstream');
  check('workstream dispatch reports created:true', result.created === true);

  const parsed = parseActionRef(result.action_ref);
  check('action_ref matches the workstream:<workstream_id> scheme', parsed?.sink === 'workstream');
  const ws = getWorkstream(parsed.workstream_id);
  check('the workstream row exists', !!ws);
  check('the workstream carries a turn', ws?.turn === 'jarvis');
  check('the workstream carries a next_action', typeof ws?.next_action === 'string' && ws.next_action.length > 0);
  check('exactly one new workstream appeared', listWorkstreams(true).length === beforeCount + 1);

  // idempotency
  const beforeSecond = listWorkstreams(true).length;
  const second = await dispatchNotepadLine({
    line: toRouteLine(line),
    move: { kind: 'take_it', reason: 'a ball in the air' },
    handoffOpts: stubHandoffOpts,
  });
  check('second workstream dispatch reports created:false', second.created === false);
  check('second workstream dispatch created NO second workstream', listWorkstreams(true).length === beforeSecond);
}

// -- (1)+(2)+(3) thread sink ----------------------------------------------------
{
  const line = saved.lines.find((l) => l.id === threadLine);
  const result = await dispatchNotepadLine({
    line: toRouteLine(line),
    move: { kind: 'take_it', reason: 'nothing rule-shaped here' },
    handoffOpts: stubHandoffOpts,
  });

  check('unshaped line routed to thread', result.decision.sink === 'thread' && result.sink === 'thread');
  check('thread dispatch reports created:true', result.created === true);

  const parsed = parseActionRef(result.action_ref);
  check('action_ref matches the thread:<thread_ext> scheme', parsed?.sink === 'thread');
  check('the conversation actually exists', !!getConversation(parsed.thread_ext));

  const ledger = getNotepadLineState(threadLine);
  check("the line's ledger action_ref is the CANONICAL thread:<ext> form (re-stamped over #869's bare form)", ledger?.action_ref === result.action_ref);

  // idempotency — second dispatch must not call the (throwing) real spawn
  // seam again, proving it truly short-circuits on the ledger check.
  const explosiveOpts = { dossierOpts: { runOneShot: async () => { throw new Error('must not be called twice'); } }, postMessage: async () => { throw new Error('must not post twice'); } };
  const second = await dispatchNotepadLine({
    line: toRouteLine(line),
    move: { kind: 'take_it', reason: 'nothing rule-shaped here' },
    handoffOpts: explosiveOpts,
  });
  check('second thread dispatch reports created:false', second.created === false);
  check('second thread dispatch returns the SAME action_ref', second.action_ref === result.action_ref);
}

// -- (6) goal-shaped line with NO dossier goal falls back to thread -----------
{
  const line = saved.lines.find((l) => l.id === noHomeGoalLine);
  const result = await dispatchNotepadLine({
    line: toRouteLine(line),
    move: { kind: 'take_it', reason: 'a goal idea with nothing to attach to' },
    dossier: null,
    handoffOpts: stubHandoffOpts,
  });

  check('the router still calls this goal_proposal', result.decision.sink === 'goal_proposal');
  check('with no dossier.goal, dispatch actually lands on thread (never invents a goal)', result.sink === 'thread');
  const parsed = parseActionRef(result.action_ref);
  check('the fallback action_ref is a real thread ref', parsed?.sink === 'thread' && !!getConversation(parsed.thread_ext));
}

// ═══════════════════════════════════════════════════════════════════════════
// (7) THE BLOCK FORM — node #943. Kevin's real format: a zero-indent headline
// with irregularly-indented, dash-prefixed children underneath it. The whole
// topic dispatches as ONE thing.
// ═══════════════════════════════════════════════════════════════════════════
const BLOCK_DAY = '2026-09-26';
{
  const NOTE = [
    'Universal KPI Goal',
    '  - build a universal KPI tracker page for every brand',
    '     - one base class, one append-only value store',
    '',
    '  - needs a row cap before we schedule it',
    'Suppression files',
    '  - Waiting on Mike to finish the per-brand MD5 build',
    '   - six sources still not suppressing',
    'Lunch',
    '  - probably tacos',
  ].join('\n');
  const savedBlocks = putNotepadDay(BLOCK_DAY, NOTE);
  const blocks = parseNotepadBlocks(savedBlocks.lines.map((l) => ({ id: l.id, idx: l.idx, text: l.text })));
  check('(7) the day parses into exactly 3 topic blocks', blocks.length === 3);

  const byId = new Map(savedBlocks.lines.map((l) => [l.id, l]));
  const toRouteBlock = (b) => ({
    block_id: notepadBlockId(b),
    headline_line_id: b.headline_line_id,
    headline: b.headline,
    lines: b.member_line_ids.map((id) => ({ line_id: id, idx: byId.get(id).idx, text: byId.get(id).text })),
  });
  const [kpiBlock, suppressionBlock, lunchBlock] = blocks.map(toRouteBlock);

  // -- hopper sink: the build cue lives on a CHILD line ---------------------
  {
    const beforeCount = listHopperItems('all', 500).length;
    for (const id of kpiBlock.lines.map((l) => l.line_id)) {
      check(`(7) precondition: line ${id} has no ledger row yet`, getNotepadLineState(id) === undefined);
    }
    reconcileNotepadMarker(kpiBlock.block_id, { kind: 'take_it', reason: 'block dispatch fixture' });

    const result = await dispatchNotepadBlock({
      block: kpiBlock,
      move: { kind: 'take_it', reason: 'a concrete build ask, written under its topic' },
      handoffOpts: stubHandoffOpts,
    });

    check('(7) the block routed to hopper off a CHILD line\'s build cue', result.decision.sink === 'hopper' && result.sink === 'hopper');
    check('(7) exactly one hopper candidate appeared for the whole topic', listHopperItems('all', 500).length === beforeCount + 1);

    const parsed = parseActionRef(result.action_ref);
    const item = getHopperItem(parsed.candidate_id);
    check('(7) the hopper card is titled with the block HEADLINE, not a dash', item?.title === 'Universal KPI Goal');
    check('(7) the hopper card carries the WHOLE block verbatim as raw_message', item?.raw_message.includes('row cap') && item.raw_message.includes('append-only value store'));
    check('(7) the hopper card is provenanced to the block', item?.source_ref === `notepad-block-${kpiBlock.block_id}`);

    // THE LEDGER: headline acted, every other member seen -------------------
    check('(7) the result names the headline as the acted line', result.acted_line_id === kpiBlock.headline_line_id);
    const headState = getNotepadLineState(kpiBlock.block_id);
    check("(7) THE LEDGER: the HEADLINE line is 'acted' and carries the action_ref", headState?.state === 'acted' && headState.action_ref === result.action_ref);
    const childIds = kpiBlock.lines.map((l) => l.line_id).filter((id) => id !== kpiBlock.block_id);
    check(
      "(7) THE LEDGER: every OTHER member line is 'seen' — never acted, never carrying an action_ref of its own",
      childIds.every((id) => {
        const st = getNotepadLineState(id);
        return st?.state === 'seen' && st.action_ref === null;
      }),
    );
    check('(7) the result reports exactly those lines as newly seen', result.seen_line_ids.slice().sort().join() === childIds.slice().sort().join());

    // THE MARKER: one, on the headline -------------------------------------
    check('(7) THE MARKER: the headline carries the block\'s one marker, stamped with the action_ref', getNotepadMarker(kpiBlock.block_id)?.action_ref === result.action_ref);
    check('(7) THE MARKER: not one child line has a marker of its own', childIds.every((id) => getNotepadMarker(id) === undefined));

    // IDEMPOTENCE ----------------------------------------------------------
    const beforeSecond = listHopperItems('all', 500).length;
    const second = await dispatchNotepadBlock({
      block: kpiBlock,
      move: { kind: 'take_it', reason: 'a concrete build ask, written under its topic' },
      handoffOpts: stubHandoffOpts,
    });
    check('(7) re-dispatching the block reports created:false', second.created === false);
    check('(7) re-dispatching the block returns the SAME action_ref', second.action_ref === result.action_ref);
    check('(7) re-dispatching the block created NO second candidate', listHopperItems('all', 500).length === beforeSecond);
  }

  // -- workstream sink off a child's ball-in-the-air phrase ------------------
  {
    const beforeCount = listWorkstreams(true).length;
    const result = await dispatchNotepadBlock({
      block: suppressionBlock,
      move: { kind: 'take_it', reason: 'a ball in the air under its own topic' },
      handoffOpts: stubHandoffOpts,
    });
    check('(7) a waiting-on CHILD routes the whole block to workstream', result.sink === 'workstream');
    const ws = getWorkstream(parseActionRef(result.action_ref).workstream_id);
    check('(7) the workstream row exists and is live', !!ws && ws.turn === 'jarvis' && typeof ws.next_action === 'string' && ws.next_action.length > 0);
    // jotWorkstream is find-or-CREATE: this block's headline overlaps the
    // earlier per-line fixture ("waiting on Mike to finish the suppression
    // file"), so attaching to that existing row is the correct outcome. What
    // must hold either way is that the whole topic produced AT MOST one row.
    const wsDelta = listWorkstreams(true).length - beforeCount;
    check('(7) the whole topic produced at most ONE workstream row (attached or created)', wsDelta === (result.detail?.matched ? 0 : 1), { wsDelta, matched: result.detail?.matched });
    check(
      "(7) the workstream block's children are 'seen', its headline 'acted'",
      getNotepadLineState(suppressionBlock.block_id)?.state === 'acted' &&
        suppressionBlock.lines
          .map((l) => l.line_id)
          .filter((id) => id !== suppressionBlock.block_id)
          .every((id) => getNotepadLineState(id)?.state === 'seen'),
    );
  }

  // -- thread sink: the handoff is seeded with the WHOLE block ---------------
  {
    // The handoff contract (node #869) is that a marker already exists on the
    // line being opened — for a block, that is its headline, which is exactly
    // where runNotepadSpeak persists it.
    reconcileNotepadMarker(lunchBlock.block_id, { kind: 'take_it', reason: 'block thread fixture' });
    let seededPrompt = null;
    const result = await dispatchNotepadBlock({
      block: lunchBlock,
      move: { kind: 'take_it', reason: 'nothing rule-shaped here' },
      handoffOpts: {
        dossierOpts: { runOneShot: async () => '{}' },
        postMessage: async (text) => {
          seededPrompt = text;
          return '[stub] posted';
        },
      },
    });
    check('(7) an unshaped block falls to the thread sink', result.sink === 'thread');
    const parsed = parseActionRef(result.action_ref);
    check('(7) the thread conversation exists', !!getConversation(parsed.thread_ext));
    check('(7) the thread is keyed on the block\'s headline line', parsed.thread_ext === `cockpit:notepad-line-${lunchBlock.block_id}`);
    check('(7) THE HANDOFF: the seed prompt carries the block HEADLINE', seededPrompt?.includes('Lunch'));
    check(
      '(7) THE HANDOFF: the seed prompt carries every CHILD line verbatim, with its line_id',
      lunchBlock.lines.every((l) => seededPrompt?.includes(`[line_id ${l.line_id}] ${l.text}`)),
    );
    check(
      "(7) the thread block's child is 'seen' and its headline 'acted'",
      getNotepadLineState(lunchBlock.block_id)?.state === 'acted' &&
        lunchBlock.lines
          .map((l) => l.line_id)
          .filter((id) => id !== lunchBlock.block_id)
          .every((id) => getNotepadLineState(id)?.state === 'seen'),
    );
  }
}

// -- zero claude processes spawned across the whole run -----------------------
const spawnsAfter = claudeProcessCount();
check(`no net new claude processes spawned (before=${spawnsBefore}, after=${spawnsAfter})`, spawnsAfter <= spawnsBefore);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
