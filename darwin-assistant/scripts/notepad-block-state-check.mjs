#!/usr/bin/env node
// NOTEPAD BLOCK STATE CHECK — exercises src/notepad-block-state.ts
// (notepadBlockStates) against node #187's done_means: every topic block's
// HEADLINE must carry a deterministic gutter state so silence is visible.
// No HTTP, no model call — a pure derivation over the existing per-line
// ledger (notepad.ts) and marker store (notepad-markers.ts), neither of
// which this node changes.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-block-state-check.db node scripts/notepad-block-state-check.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log(`[notepad-block-state-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay, getNotepadDay, markLineSeen, markLineActed, getNotepadLineState } = await import(
  path.join(distDir, 'notepad.js')
);
const { reconcileNotepadMarker, dismissNotepadMarker } = await import(path.join(distDir, 'notepad-markers.js'));
const { carryForwardInto } = await import(path.join(distDir, 'notepad-rollover.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));
const { notepadBlockStates } = await import(path.join(distDir, 'notepad-block-state.js'));
const { runNotepadSpeak } = await import(path.join(distDir, 'notepad-speak.js'));

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

function stateFor(day, headlineText) {
  const saved = getNotepadDay(day);
  const headlineId = lineIdByText(saved, headlineText);
  const rows = notepadBlockStates(day);
  return rows.find((r) => r.headline_line_id === headlineId);
}

// -- empty day -> blocks: [] -------------------------------------------------
{
  const rows = notepadBlockStates('2026-01-01');
  check('an empty/never-touched day returns zero block rows', Array.isArray(rows) && rows.length === 0);
}

// -- 1. UNSEEN: brand-new block, no ledger row on any line -------------------
const D1 = '2026-09-01';
{
  putNotepadDay(D1, ['Topic one', '  - child one'].join('\n'));
  const r = stateFor(D1, 'Topic one');
  check('unseen: a never-examined block reports unseen', r?.state === 'unseen');
}

// -- 2. SEEN: every line examined, no marker, no edits -----------------------
const D2 = '2026-09-02';
{
  const saved = putNotepadDay(D2, ['Topic two', '  - child two'].join('\n'));
  markLineSeen(lineIdByText(saved, 'Topic two'));
  markLineSeen(lineIdByText(saved, '  - child two'));
  const r = stateFor(D2, 'Topic two');
  check('seen: every line examined and judged not-actionable reports seen', r?.state === 'seen');
}

// -- 3. MOVE: active marker with no action_ref yet ---------------------------
const D3 = '2026-09-03';
{
  const saved = putNotepadDay(D3, ['Topic three', '  - child three'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic three');
  reconcileNotepadMarker(headlineId, { kind: 'question', reason: 'needs a decision from Kevin' });
  const r = stateFor(D3, 'Topic three');
  check('move: an open marker with no action_ref reports move', r?.state === 'move');
}

// -- 4a. ACTED via marker carrying an action_ref -----------------------------
const D4A = '2026-09-04';
{
  const saved = putNotepadDay(D4A, ['Topic four a', '  - child four a'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic four a');
  reconcileNotepadMarker(headlineId, { kind: 'take_it', reason: 'a real task', action_ref: 'cockpit:thread-2' });
  const r = stateFor(D4A, 'Topic four a');
  check('acted (via marker): a marker carrying action_ref reports acted', r?.state === 'acted');
  check('acted (via marker): reason names the ref', r?.state_reason.includes('cockpit:thread-2'));
}

// -- 4b. ACTED via ledger only (no marker at all) ----------------------------
const D4B = '2026-09-05';
{
  const saved = putNotepadDay(D4B, ['Topic four b', '  - child four b'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic four b');
  markLineActed(headlineId, 'cockpit:thread-3');
  const r = stateFor(D4B, 'Topic four b');
  check('acted (via ledger, no marker): reports acted', r?.state === 'acted');
  check('acted (via ledger, no marker): reason names the ref', r?.state_reason.includes('cockpit:thread-3'));
}

// -- 5. CHANGED: a member was edited after being examined --------------------
const D5 = '2026-09-06';
{
  const saved = putNotepadDay(D5, ['Topic five', '  - child five'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic five');
  const childId = lineIdByText(saved, '  - child five');
  markLineSeen(headlineId);
  markLineSeen(childId);
  const before = stateFor(D5, 'Topic five');
  check('changed: fully-seen block reports seen before the edit', before?.state === 'seen');

  putNotepadDay(D5, ['Topic five', '  - child five, now with more detail'].join('\n'));
  const after = stateFor(D5, 'Topic five');
  check('changed: editing a member after it was seen reports changed', after?.state === 'changed');
  check('changed: reason names the edited line', after?.state_reason.includes(String(childId)));
}

// -- PRECEDENCE: a marker (move) AND an edited member -> move, not changed --
const D6 = '2026-09-07';
{
  const saved = putNotepadDay(D6, ['Topic six', '  - child six'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic six');
  const childId = lineIdByText(saved, '  - child six');
  markLineSeen(childId);
  reconcileNotepadMarker(headlineId, { kind: 'question', reason: 'ambiguous, needs Kevin' });

  putNotepadDay(D6, ['Topic six', '  - child six, edited after the marker'].join('\n'));
  const r = stateFor(D6, 'Topic six');
  check('precedence: an open marker outranks an edited member -> move, not changed', r?.state === 'move');
}

// -- DISMISSED marker -> never reports move ----------------------------------
const D7 = '2026-09-08';
{
  const saved = putNotepadDay(D7, ['Topic seven', '  - child seven'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic seven');
  const childId = lineIdByText(saved, '  - child seven');
  reconcileNotepadMarker(headlineId, { kind: 'question', reason: 'will be dismissed' });
  dismissNotepadMarker(headlineId);
  markLineSeen(childId); // both lines now carry a ledger row
  const r = stateFor(D7, 'Topic seven');
  check('dismissed marker: never reports move', r?.state !== 'move');
  check('dismissed marker: never reports acted', r?.state !== 'acted');
  check('dismissed marker: a dismissed-but-examined headline + seen child reports seen', r?.state === 'seen');
}

// -- CARRIED LINE: origin acted, carried forward -> acted, not unseen -------
const DAY_CA = '2026-09-10';
const DAY_CB = '2026-09-11';
{
  const saved = putNotepadDay(DAY_CA, ['Topic carry', '  - child carry'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic carry');
  markLineActed(headlineId, 'cockpit:thread-9');

  carryForwardInto(sqliteDb, DAY_CB, { now: '2026-09-11T08:00:00.000Z' });
  const carriedSaved = getNotepadDay(DAY_CB);
  const carriedHeadlineId = lineIdByText(carriedSaved, 'Topic carry');
  check('carried line: gets a brand-new line id', carriedHeadlineId !== headlineId);

  const rows = notepadBlockStates(DAY_CB);
  const r = rows.find((row) => row.headline_line_id === carriedHeadlineId);
  check('carried line: origin acted resolves through lineage to acted, not unseen', r?.state === 'acted');
}

// -- THE NODE'S HEADLINE CLAIM: every block examined, zero markers ----------
// -> every block reports seen, none report unseen.
const D8 = '2026-09-12';
{
  const NOTE = ['Topic A', '  - child a1', '  - child a2', 'Topic B', '  - child b1'].join('\n');
  const saved = putNotepadDay(D8, NOTE);
  for (const line of saved.lines) markLineSeen(line.id);

  const rows = notepadBlockStates(D8);
  check('headline claim: exactly 2 blocks', rows.length === 2);
  check('headline claim: every block reports seen', rows.every((r) => r.state === 'seen'));
  check('headline claim: no block reports unseen', !rows.some((r) => r.state === 'unseen'));
}

// -- headline: null lead-in block does not crash and resolves via notepadBlockId --
const D9 = '2026-09-13';
{
  const NOTE = ['  stray indented line before any headline', 'Topic nine'].join('\n');
  putNotepadDay(D9, NOTE);
  const rows = notepadBlockStates(D9);
  check('headline:null block: still returns a row for the lead-in block', rows.length === 2);
  check('headline:null block: lead-in block reports unseen (never examined)', rows[0]?.state === 'unseen');
}

// ═══════════════════════════════════════════════════════════════════════════
// NODE #1054 — THE REAL CHAIN, not a hand-seeded ledger. Every case above
// proves notepadBlockStates() reads a hand-built ledger correctly; none of
// them prove the autonomous pipeline (runNotepadSpeak) ever WRITES to that
// ledger for a block it judged silent -- which is exactly the gap #1054
// exists to close (verifier #1053: a real day judged 14 blocks and produced
// zero 'seen' rows). Same deterministic tick scheme as notepad-speak-check.mjs.
// ═══════════════════════════════════════════════════════════════════════════
const EPOCH_MS = Date.parse('2026-01-01T00:00:00Z');
function tickDate(n) {
  return new Date(EPOCH_MS + n * 1000); // one tick = one second
}
function sqliteDatetimeString(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
const setUpdatedAtStmt = sqliteDb.prepare(`UPDATE notepad_days SET updated_at = ? WHERE day = ?`);
function saveAtTick(day, text, tick) {
  const saved = putNotepadDay(day, text);
  setUpdatedAtStmt.run(sqliteDatetimeString(tickDate(tick)), day);
  return saved;
}

// One stub serving both stages runNotepadSpeak drives through the same
// opts.runOneShot seam, discriminated by prompt content exactly like
// notepad-speak-check.mjs's combinedStub -- the gate prompt is the only one
// that mentions "complete_thought". `moveFor(block_id)` returns {kind,
// reason} for a block this call should propose a real move for, or
// undefined for silence.
function speakStub(moveFor) {
  return async (prompt) => {
    if (prompt.includes('complete_thought')) {
      const blockIds = [...new Set([...prompt.matchAll(/block_id (\d+)/g)].map((m) => Number(m[1])))];
      return JSON.stringify({ verdicts: blockIds.map((block_id) => ({ block_id, complete_thought: true })) });
    }
    const blockIds = [...new Set([...prompt.matchAll(/^- block (\d+):/gm)].map((m) => Number(m[1])))];
    const moves = [];
    for (const block_id of blockIds) {
      const m = moveFor(block_id);
      if (m) moves.push({ block_id, kind: m.kind, reason: m.reason });
    }
    return JSON.stringify({ moves });
  };
}

// -- (A) THE REAL CHAIN: 3 candidate blocks in one settle pass -- ONE gets a
//    real move, TWO are judged and come back silent, and a FOURTH block --
//    added to the note only AFTER this pass already ran, so the gate never
//    laid eyes on it at all -- must be completely untouched. -----------------
const DAY_SPEAK = '2026-09-20';
{
  const NOTE = ['Topic Alpha', '  - alpha detail one', 'Topic Bravo', '  - bravo detail one', 'Topic Charlie', '  - charlie detail one'].join('\n');
  const saved = saveAtTick(DAY_SPEAK, NOTE, 1);
  const alphaId = lineIdByText(saved, 'Topic Alpha');
  const bravoId = lineIdByText(saved, 'Topic Bravo');
  const bravoChildId = lineIdByText(saved, '  - bravo detail one');
  const charlieId = lineIdByText(saved, 'Topic Charlie');
  const charlieChildId = lineIdByText(saved, '  - charlie detail one');

  const stub = speakStub((id) => (id === alphaId ? { kind: 'take_it', reason: 'JARVIS can take Alpha' } : undefined));
  const result = await runNotepadSpeak(DAY_SPEAK, { now: tickDate(1 + 20 + 1), runOneShot: stub });

  check('(1054a) the pass settled and decided moves', result.pass.settle !== null && result.moves !== null);
  check('(1054a) outcome is model (a real batched call, not a fallback)', result.moves?.outcome === 'model');
  check(
    '(1054a) GAP 1: candidate_block_ids names all 3 blocks the model was actually shown',
    [alphaId, bravoId, charlieId].every((id) => result.moves?.candidate_block_ids.includes(id)) && result.moves?.candidate_block_ids.length === 3,
  );
  check('(1054a) exactly one real move was decided, for Alpha', result.moves?.moves.length === 1 && result.moves?.moves[0].block_id === alphaId);

  // Add the 4th block ONLY NOW -- it did not exist when the pass above ran,
  // so it was never a gate/moves candidate at all. Its headline never went
  // through the pipeline; it must read exactly as untouched.
  saveAtTick(DAY_SPEAK, NOTE + '\nTopic Delta\n  - delta detail one', 2);
  const deltaSaved = getNotepadDay(DAY_SPEAK);
  const deltaId = lineIdByText(deltaSaved, 'Topic Delta');

  const alpha = stateFor(DAY_SPEAK, 'Topic Alpha');
  const bravo = stateFor(DAY_SPEAK, 'Topic Bravo');
  const charlie = stateFor(DAY_SPEAK, 'Topic Charlie');
  const delta = stateFor(DAY_SPEAK, 'Topic Delta');

  check('(1054a) THE FIX: the block with a real move reports move', alpha?.state === 'move');
  check('(1054a) THE FIX: a judged-but-silent block reports seen, not unseen', bravo?.state === 'seen');
  check('(1054a) THE FIX: the OTHER judged-but-silent block also reports seen', charlie?.state === 'seen');
  // notepadBlockStates only reports the HEADLINE's derived gutter state;
  // confirm the CHILD lines were individually written to the ledger too
  // (not just the headline) by reading their raw ledger rows directly --
  // marking only the headline would still pass every check above.
  check("(1054a) bravo's own CHILD line was individually marked seen in the ledger", getNotepadLineState(bravoChildId)?.state === 'seen');
  check("(1054a) charlie's own CHILD line was individually marked seen in the ledger", getNotepadLineState(charlieChildId)?.state === 'seen');
  check(
    "(1054a) THE GUARANTEE: a block the pass never saw at all (added after the fact) still reports unseen -- marking silence never spills onto the whole day",
    delta?.state === 'unseen',
  );
}

// -- (B) A FALLBACK OUTCOME WRITES NOTHING: the moves call itself fails, so
//    every candidate block must come back exactly as it went in (unseen) --
//    stamping seen there would launder a broken pass into "nothing to say".
const DAY_FALLBACK = '2026-09-21';
{
  const NOTE = ['Topic Echo', '  - echo detail one', 'Topic Foxtrot', '  - foxtrot detail one'].join('\n');
  const saved = saveAtTick(DAY_FALLBACK, NOTE, 3000);
  const echoId = lineIdByText(saved, 'Topic Echo');

  const stub = async (prompt) => {
    if (prompt.includes('complete_thought')) {
      const blockIds = [...new Set([...prompt.matchAll(/block_id (\d+)/g)].map((m) => Number(m[1])))];
      return JSON.stringify({ verdicts: blockIds.map((block_id) => ({ block_id, complete_thought: true })) });
    }
    throw new Error('simulated moves-model failure');
  };

  const result = await runNotepadSpeak(DAY_FALLBACK, { now: tickDate(3000 + 20 + 1), runOneShot: stub });

  check('(1054b) the moves call was attempted and failed', result.moves?.outcome === 'fallback');
  check('(1054b) it still names which blocks it had tried to judge', result.moves?.candidate_block_ids.length === 2);
  check('(1054b) THE GUARANTEE: a fallback writes nothing -- both blocks still report unseen', stateFor(DAY_FALLBACK, 'Topic Echo')?.state === 'unseen' && stateFor(DAY_FALLBACK, 'Topic Foxtrot')?.state === 'unseen');
  check('(1054b) THE GUARANTEE: no ledger row was written for the headline at all', getNotepadLineState(echoId) === undefined);
  check('(1054b) no marker was created either', notepadBlockStates(DAY_FALLBACK).every((r) => r.state === 'unseen'));
}

// -- (C) A TERMINAL STATE IS NEVER DOWNGRADED BY A SILENT PASS. The seen-loop
//    from (A) skipped lines carrying an action_ref, but `dismissed` and `done`
//    are ALSO finished states -- and notepad-rollover.ts leaves exactly those
//    behind when it carries the day forward. Stamping `seen` over a dismissal
//    puts a topic Kevin explicitly closed back on tomorrow's note, and on
//    every tomorrow after that, because the silent pass re-runs daily. This is
//    the regression verifier #1056 caught; these are its assertions. ---------
const DAY_TERMINAL = '2026-09-22';
{
  const NOTE = ['Topic Golf', '  - golf detail one', 'Topic Hotel', '  - hotel detail one'].join('\n');
  const saved = saveAtTick(DAY_TERMINAL, NOTE, 6000);
  const golfId = lineIdByText(saved, 'Topic Golf');
  const hotelId = lineIdByText(saved, 'Topic Hotel');

  // Kevin sees a move on Golf and dismisses it; Hotel he marks done outright.
  reconcileNotepadMarker(golfId, { kind: 'take_it', reason: 'JARVIS can take Golf' });
  dismissNotepadMarker(golfId);
  check('(1054c) precondition: the dismissed headline reads dismissed', getNotepadLineState(golfId)?.state === 'dismissed');

  // A later silent pass over the same day — the ordinary case after any dismissal.
  const silent = async (prompt) => {
    if (prompt.includes('complete_thought')) {
      const blockIds = [...new Set([...prompt.matchAll(/block_id (\d+)/g)].map((m) => Number(m[1])))];
      return JSON.stringify({ verdicts: blockIds.map((block_id) => ({ block_id, complete_thought: true })) });
    }
    return JSON.stringify({ moves: [] });
  };
  const result = await runNotepadSpeak(DAY_TERMINAL, { now: tickDate(6000 + 20 + 1), runOneShot: silent });

  check('(1054c) the silent pass really ran over this block', (result.moves?.candidate_block_ids ?? []).includes(golfId));
  check('(1054c) THE FIX: a DISMISSED headline is still dismissed after a silent pass', getNotepadLineState(golfId)?.state === 'dismissed');
  check('(1054c) the block it never closed did get marked seen (the loop still works)', stateFor(DAY_TERMINAL, 'Topic Hotel')?.state === 'seen');

  // The consequence the verifier proved end-to-end: rollover must still leave it behind.
  const carried = carryForwardInto(sqliteDb, '2026-09-23', { now: tickDate(9000) });
  const tomorrow = getNotepadDay('2026-09-23');
  const carriedTexts = tomorrow.lines.map((l) => l.text);
  check('(1054c) THE CONSEQUENCE: a dismissed topic is NOT carried into the new day', !carriedTexts.includes('Topic Golf'));
  check('(1054c) the still-open topic IS carried', carriedTexts.includes('Topic Hotel'));
  void hotelId; void carried;
}

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
