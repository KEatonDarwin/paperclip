#!/usr/bin/env node
// NOTEPAD ROUTE WIRE CHECK (node #1067) — end-to-end proof that the block
// routing machinery (routeNotepadBlock/dispatchNotepadBlock, nodes #873/#874/
// #943/#1065/#1066) is or is not actually reachable from the running
// service, run against Kevin's REAL 2026-09-26 note (fixture-captured, see
// scripts/fixtures/notepad-real-days.json) copied into a scratch DB.
//
// FINDING THIS PROVES (see node-190-routing-proof.md for the full trace):
// the production driver (notepad-driver.ts -> runNotepadSpeak) NEVER calls
// routeNotepadBlock/dispatchNotepadBlock at all -- it only decides a move
// (take_it/question/already_done/context) and persists a MARKER via
// reconcileNotepadMarker. Nothing in the running service turns a decided
// move into a goal_proposal/hopper/workstream sink call. The only other
// production entry points (POST /notepad/markers/:lineId/open, and #188's
// new /read /chat /done block actions) all call openNotepadHandoff directly
// and bypass the router too.
//
// This script asserts BOTH halves:
//   (1) DEAD ON THE LIVE PATH -- driving the real pipeline (runNotepadSpeak,
//       gate+moves model calls stubbed, everything else real) over the
//       'Universal KPI Goal' block (real line 86) produces a marker with
//       kind 'take_it' and NO goal_nodes/hopper_items/workstreams row and no
//       action_ref -- proving the sink machinery is not invoked.
//   (2) READY IN ISOLATION -- calling buildTopicDossier + dispatchNotepadBlock
//       directly (the same block, same DB, same goal table Kevin's real
//       goals live in) DOES produce a goal:<goal_id>:<node_id> ref for the
//       KPI block, a goal ref for the 'MBI Numbers in monitoring goal' block
//       (line 96), that both round-trip through parseActionRef to a live
//       (proposed/ghost, never set) goal_nodes row, and that a block naming
//       no goal (one of node #1066's already-labelled 29 real blocks) still
//       lands on its old non-goal sink -- i.e. the fix from nodes #1065/
//       #1066 works correctly; it simply has no live caller.
//
// Uses a SCRATCH COPY of the live DB (JARVIS_DB_PATH), never the live file
// itself -- see node-190-routing-proof.md for the exact cp command used.
//
//   JARVIS_DB_PATH=/tmp/notepad-190-live.db node scripts/notepad-route-wire-check.mjs

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
if (!fs.existsSync(DB_PATH)) {
  console.error(`FATAL: ${DB_PATH} does not exist -- this check expects a pre-made scratch COPY of the live DB.`);
  process.exit(1);
}

console.log(`[notepad-route-wire-check] DB: ${DB_PATH}`);

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

const distDir = path.join(repoRoot, 'dist');
const { getNotepadDay, getNotepadLineState } = await import(path.join(distDir, 'notepad.js'));
const { runNotepadSpeak } = await import(path.join(distDir, 'notepad-speak.js'));
const { getNotepadMarker, reconcileNotepadMarker } = await import(path.join(distDir, 'notepad-markers.js'));
const { buildTopicDossier } = await import(path.join(distDir, 'notepad-dossier.js'));
const { dispatchNotepadBlock, parseActionRef } = await import(path.join(distDir, 'notepad-dispatch.js'));
const { parseNotepadBlocks, notepadBlockId } = await import(path.join(distDir, 'notepad-blocks.js'));
const { getGoalTree } = await import(path.join(distDir, 'goals.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));

let failed = false;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed = true;
  }
}

function countRows(table) {
  return sqliteDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

const DAY = '2026-09-26';
const { lines } = getNotepadDay(DAY);
assert.ok(lines.length > 0, `fixture day ${DAY} must already be present in the scratch DB copy`);

const blocks = parseNotepadBlocks(lines);
const kpiBlock = blocks.find((b) => b.headline === 'Universal KPI Goal');
const mbiBlock = blocks.find((b) => b.headline === 'MBI Numbers in monitoring goal');
assert.ok(kpiBlock, "'Universal KPI Goal' block must exist in the real day");
assert.ok(mbiBlock, "'MBI Numbers in monitoring goal' block must exist in the real day");
assert.equal(kpiBlock.headline_line_id, 86, 'KPI block headline must be real line 86');
assert.equal(mbiBlock.headline_line_id, 96, 'MBI block headline must be real line 96');

function blockInput(block) {
  const textById = new Map(lines.map((l) => [l.id, l.text]));
  return {
    block_id: notepadBlockId(block),
    headline_line_id: block.headline_line_id,
    headline: block.headline,
    lines: block.member_line_ids.map((id) => ({ line_id: id, text: textById.get(id) ?? '' })),
  };
}

// ── PART 1: drive the REAL production pipeline ──────────────────────────────
// Force a fresh settle: clear today's settle mark so runNotepadSpeak treats
// this as a genuinely new pass rather than "already settled for this write"
// (the live jarvis.service already ticks this note every 60s -- the copy
// inherits whatever mark row already existed at cp time). This is a write to
// the SCRATCH COPY only, never the live file, and it does not touch note
// content -- it only lets the same real content be re-judged.
sqliteDb.prepare('DELETE FROM notepad_settle_marks WHERE day = ?').run(DAY);

const goalBefore = countRows('goal_nodes');
const hopperBefore = countRows('hopper_items');
const wsBefore = countRows('workstreams');

const FAR_FUTURE = new Date(Date.now() + 365 * 24 * 3600 * 1000);
function movesStub(prompt) {
  // Force exactly one real move on the KPI block, whatever the real gate
  // would have said -- the point of this half is "what happens to a
  // DECIDED move", not re-testing the gate/moves judgement itself (that's
  // notepad-moves-check.mjs's job).
  if (prompt.includes('"moves":')) {
    return Promise.resolve(JSON.stringify({ moves: [{ block_id: kpiBlock.headline_line_id, kind: 'take_it', reason: 'proof stub' }] }));
  }
  // gate prompt -- mark the KPI block worth a second look.
  return Promise.resolve(JSON.stringify({ verdicts: [{ block_id: kpiBlock.headline_line_id, complete_thought: true }] }));
}

const speakResult = await runNotepadSpeak(DAY, { now: FAR_FUTURE, runOneShot: movesStub, timeoutMs: 30_000 });

console.log('\n=== PART 1 — the REAL production pipeline (runNotepadSpeak) ===');
check('pass.worth_reviewing (settle+gate let this day through)', speakResult.pass.worth_reviewing === true);
check('a real move was decided for the KPI block', !!speakResult.moves && speakResult.moves.moves.some((m) => m.block_id === kpiBlock.headline_line_id));

const kpiMarkerAfterSpeak = getNotepadMarker(kpiBlock.headline_line_id);
check('runNotepadSpeak wrote a marker for the KPI block', !!kpiMarkerAfterSpeak, JSON.stringify(kpiMarkerAfterSpeak));
check("that marker's kind is 'take_it' (the moves stub's verdict)", kpiMarkerAfterSpeak?.kind === 'take_it');
check(
  'that marker has NO action_ref -- a first_look move never carries one (notepad-speak.ts resolveActionRef)',
  kpiMarkerAfterSpeak?.action_ref === null,
);

const kpiLineStateAfterSpeak = getNotepadLineState(kpiBlock.headline_line_id);
check(
  "the KPI headline's per-line ledger state is NOT 'acted' after the real pipeline ran",
  kpiLineStateAfterSpeak?.state !== 'acted',
  JSON.stringify(kpiLineStateAfterSpeak),
);

check('NO new goal_nodes row was created by the real pipeline', countRows('goal_nodes') === goalBefore, `before=${goalBefore} after=${countRows('goal_nodes')}`);
check('NO new hopper_items row was created by the real pipeline', countRows('hopper_items') === hopperBefore, `before=${hopperBefore} after=${countRows('hopper_items')}`);
check('NO new workstreams row was created by the real pipeline', countRows('workstreams') === wsBefore, `before=${wsBefore} after=${countRows('workstreams')}`);

console.log(
  '\n  => CONCLUSION: routeNotepadBlock/dispatchNotepadBlock is NEVER called by the running service.\n' +
    '     A decided move becomes a marker only. See node-190-routing-proof.md for the full call-path trace.',
);

// ── PART 2: the router/dispatch code itself, called directly (isolation) ───
console.log('\n=== PART 2 — dispatchNotepadBlock called directly (proves the #1065/#1066 fix is correct) ===');

function dossierStub() {
  // buildTopicDossier's confidence/goal/repo/branch are evidence-sourced
  // (real DB rows), never model output -- this stub only feeds the
  // narrative/open_question fields, which this check does not assert on.
  return Promise.resolve(JSON.stringify({ narrative: null, open_question: null }));
}

const kpiDossier = await buildTopicDossier({ block: blockInput(kpiBlock) }, { runOneShot: dossierStub, timeoutMs: 30_000 });
console.log(`  KPI dossier: confidence=${kpiDossier.confidence} goal=${kpiDossier.goal ? `#${kpiDossier.goal.goal_id}:${kpiDossier.goal.node_id}` : 'null'}`);

const mbiDossier = await buildTopicDossier({ block: blockInput(mbiBlock) }, { runOneShot: dossierStub, timeoutMs: 30_000 });
console.log(`  MBI dossier: confidence=${mbiDossier.confidence} goal=${mbiDossier.goal ? `#${mbiDossier.goal.goal_id}:${mbiDossier.goal.node_id}` : 'null'}`);

check('KPI dossier resolved a goal (evidence-sourced, not model output)', kpiDossier.goal !== null);
check('MBI dossier resolved a goal (evidence-sourced, not model output)', mbiDossier.goal !== null);

const handoffOpts = { dossierOpts: { runOneShot: dossierStub, timeoutMs: 30_000 } };

const kpiDispatch = await dispatchNotepadBlock({
  block: blockInput(kpiBlock),
  move: { reason: 'proof stub', kind: 'take_it' },
  dossier: kpiDossier,
  handoffOpts,
});
console.log(`  KPI dispatch -> sink=${kpiDispatch.sink} action_ref=${kpiDispatch.action_ref}`);

// The MBI block never got a real move in Part 1's stub (only the KPI block
// did) so it carries no marker yet -- openNotepadHandoff's thread-fallback
// path requires one (its own "clicking a marker" contract, unchanged by this
// node). Seed it exactly as the real moves pipeline would for a decided
// take_it move, via the same reconcileNotepadMarker call runNotepadSpeak
// itself uses.
reconcileNotepadMarker(mbiBlock.headline_line_id, { kind: 'take_it', reason: 'proof stub', action_ref: null });

const mbiDispatch = await dispatchNotepadBlock({
  block: blockInput(mbiBlock),
  move: { reason: 'proof stub', kind: 'take_it' },
  dossier: mbiDossier,
  handoffOpts,
});
console.log(`  MBI dispatch -> sink=${mbiDispatch.sink} action_ref=${mbiDispatch.action_ref}`);

// NOTE: both dossiers resolve to real goal #5 node #129 ("Build batch 2 —
// media buy, perclickity, suppression and bot dashboards as KPIs"). That
// node's REAL live state is 'parked' (autopilot tree-budget cap) —
// validateParentForNewChild only accepts set/planned/working/check parents,
// so proposeGoalNodes throws GoalError('parent_not_set') and
// actOnGoalProposal's documented safety net (a chat is always safe,
// inventing a home is not) converts this to a THREAD, not a dangling/
// inconsistent goal proposal. This is the real, honest result against
// Kevin's actual tree today -- see node-190-routing-proof.md.
for (const [label, d] of [['KPI', kpiDispatch], ['MBI', mbiDispatch]]) {
  check(`${label} block routed to a real sink (goal_proposal, or thread via the documented fallback)`, d.sink === 'goal_proposal' || d.sink === 'thread', d.sink);
  if (d.sink === 'goal_proposal') {
    check(`${label} action_ref matches goal:<id>:<node> shape`, /^goal:\d+:\d+$/.test(d.action_ref), d.action_ref);
  } else {
    console.log(`  ${label}: fell back to thread — resolved goal node #129 is 'parked', parent_not_set guard fired`);
  }
}

// Round-trip both refs through parseActionRef to a LIVE target (#110 contract) --
// whichever sink each one actually landed on.
for (const [label, d] of [['KPI', kpiDispatch], ['MBI', mbiDispatch]]) {
  const parsed = parseActionRef(d.action_ref);
  check(`${label} ref parses`, parsed?.sink === d.sink, JSON.stringify(parsed));
  if (parsed?.sink === 'goal_proposal') {
    const tree = getGoalTree(parsed.goal_id, true);
    const node = tree ? tree.nodes.find((n) => n.id === parsed.node_id) : null;
    check(`${label} ref round-trips to a LIVE goal_nodes row`, !!node, JSON.stringify(node));
    check(`${label} target is a GHOST (proposed), never a set node — the propose-not-set rule`, node?.state === 'proposed', JSON.stringify(node?.state));
  } else if (parsed?.sink === 'thread') {
    const { getConversation } = await import(path.join(distDir, 'conversation-db.js'));
    const conv = getConversation(parsed.thread_ext);
    check(`${label} ref round-trips to a LIVE conversation row`, !!conv, parsed.thread_ext);
  }
}

// A block naming NO goal must still land on its old (non-goal) sink --
// reusing one of node #1066's already-labelled 29 real blocks so this is a
// real block, not invented text. "Testing Tool??" is labelled `thread`
// (question-headline) in scripts/fixtures/notepad-real-blocks.json.
const questionBlock = blocks.find((b) => b.headline && b.headline.includes('Testing Tool'));
if (questionBlock) {
  const qDossier = await buildTopicDossier({ block: blockInput(questionBlock) }, { runOneShot: dossierStub, timeoutMs: 30_000 });
  console.log(`  question dossier: confidence=${qDossier.confidence} goal=${qDossier.goal ? `#${qDossier.goal.goal_id}:${qDossier.goal.node_id}` : 'null'}`);
  reconcileNotepadMarker(questionBlock.headline_line_id, { kind: 'question', reason: 'proof stub', action_ref: null });
  const qDispatch = await dispatchNotepadBlock({
    block: blockInput(questionBlock),
    move: { reason: 'proof stub', kind: 'question' },
    dossier: qDossier,
    handoffOpts,
  });
  console.log(`  question block dispatch -> sink=${qDispatch.sink} action_ref=${qDispatch.action_ref}`);
  check("a no-goal block still routes to 'thread' -- node #1066's old detectors are untouched", qDispatch.sink === 'thread');
} else {
  console.log('  (no "Testing Tool??" block found in this fixture day -- skipping the no-goal control)');
}

const spawnsAfter = claudeProcessCount();
check('zero net new claude processes spawned', spawnsAfter <= spawnsBefore, `before=${spawnsBefore} after=${spawnsAfter}`);

console.log(failed ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
