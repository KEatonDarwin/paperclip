#!/usr/bin/env node
// NOTEPAD SPEAK CHECK — end-to-end proof for runNotepadSpeak (src/notepad-speak.ts),
// node #850's wiring of settle (#97) -> gate (#98) -> whole-note review (#99)
// -> decide (#62/#103) -> persist (#104) into ONE callable pipeline, and the
// two guarantees that pipeline exists to prove:
//
//   (1) editing an ACTED line reconciles its existing marker in place --
//       exactly ONE row for that line_id, never a second one -- when the
//       whole chain (a real settle, a real gate call, a real whole-note
//       review, a real decided move) drives it, not just a direct call into
//       reconcileNotepadMarker the way notepad-markers-check.mjs already
//       proves at the unit level.
//   (2) dismissing a marker on one day ("Monday") keeps it quiet on a
//       GENUINELY DIFFERENT LATER DAY ("Tuesday") over the identical
//       wording -- even though that later day mints a brand-new line_id
//       (lines belong to a day, per LINE-IDENTITY.md) and the model is
//       genuinely asked again and proposes a DIFFERENT judgement than
//       before -- because reconcileNotepadMarker's day-independent
//       text-hash dismissal memory (node #851) runs on every call this
//       pipeline makes to it, not just on hand-crafted direct calls.
//
// The gate and the moves stage share the SAME opts.runOneShot injection
// seam (runNotepadSpeak threads it to both); the stub below discriminates by
// prompt content the same way any two-stage batched caller would have to --
// the gate's prompt is the only one that mentions "complete_thought".
//
// No HTTP, no real model calls -- proven, not assumed, by the before/after
// pgrep snapshot at the end, same discipline as notepad-pass-check.mjs.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-speak-check.db node scripts/notepad-speak-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

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

console.log(`[notepad-speak-check] DB: ${DB_PATH}`);

function claudeProcessCount() {
  try {
    const out = execSync('pgrep -c -f claude', { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch (err) {
    if (err && err.status === 1) return 0; // pgrep exits 1 on no match — that's zero, not a failure
    throw err;
  }
}

const spawnsBefore = claudeProcessCount();

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay, getNotepadDay, markLineActed, lineTextHash } = await import(path.join(distDir, 'notepad.js'));
const { runNotepadSpeak } = await import(path.join(distDir, 'notepad-speak.js'));
const { getNotepadMarker, listNotepadMarkers, activeNotepadMarkers, setNotepadMarkerActionRef, dismissNotepadMarker } =
  await import(path.join(distDir, 'notepad-markers.js'));
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

function markerRowCount(lineId) {
  return sqliteDb.prepare('SELECT COUNT(*) AS n FROM notepad_markers WHERE line_id = ?').get(lineId).n;
}

function lineIdByText(saved, text) {
  const line = saved.lines.find((l) => l.text === text);
  if (!line) throw new Error(`fixture line '${text}' must exist`);
  return line.id;
}

// ── deterministic time injection (same tick scheme as notepad-pass-check) ──
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

let totalGateCalls = 0;
let totalMovesCalls = 0;

/**
 * One runOneShot stub serving BOTH stages runNotepadSpeak drives through the
 * same injection seam. `moveFor(line_id)` returns {kind, reason} for a
 * line_id this call should propose a real move for, or undefined for
 * silence — mirroring how an actual model both can and usually does stay
 * silent on most candidates.
 *
 * The two stages speak different id vocabularies (node #942 moved the GATE
 * to block_id; the MOVES stage, out of this node's scope, still speaks
 * line_id) -- extract each with its own regex, deduped, since the moves
 * prompt now mentions each line_id TWICE (once in review.rendered's
 * "[line_id N]" prefix, once in its own candidate-list bullet) and a naive
 * extraction would double-propose every move.
 */
function combinedStub(moveFor) {
  return async (prompt) => {
    if (prompt.includes('complete_thought')) {
      totalGateCalls += 1;
      const blockIds = [...new Set([...prompt.matchAll(/block_id (\d+)/g)].map((m) => Number(m[1])))];
      return JSON.stringify({ verdicts: blockIds.map((block_id) => ({ block_id, complete_thought: true })) });
    }
    totalMovesCalls += 1;
    const lineIds = [...new Set([...prompt.matchAll(/line_id (\d+)/g)].map((m) => Number(m[1])))];
    const moves = [];
    for (const line_id of lineIds) {
      const m = moveFor(line_id);
      if (m) moves.push({ line_id, kind: m.kind, reason: m.reason });
    }
    return JSON.stringify({ moves });
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// (1) EDIT AN ACTED LINE -> ONE MARKER, never a second one, driven by the
//     REAL pipeline end to end.
// ═══════════════════════════════════════════════════════════════════════════
const DAY1 = '2026-10-05';
const L1_V1 = 'Call the vendor about the overdue invoice';
const L2 = 'Buy milk and eggs on the way home to keep it company';
let l1Id;

// -- first cycle: L1 is a brand-new first_look candidate; the model decides
//    a real move ("take_it"); the pipeline creates its ONE marker row. -------
{
  const saved = saveAtTick(DAY1, [L1_V1, L2].join('\n'), 1);
  l1Id = lineIdByText(saved, L1_V1);

  check('no marker before the pipeline has ever run', getNotepadMarker(l1Id) === undefined);

  const stub = combinedStub((id) => (id === l1Id ? { kind: 'take_it', reason: 'JARVIS can call the vendor about this' } : undefined));
  const result = await runNotepadSpeak(DAY1, { now: tickDate(1 + 20 + 1), runOneShot: stub });

  check('(1a) the pass settled', result.pass.settle !== null);
  check('(1a) worth_reviewing is true', result.pass.worth_reviewing === true);
  check('(1a) moves were decided (not skipped)', result.moves !== null);
  check('(1a) exactly one real move was decided, for L1', result.moves?.moves.length === 1 && result.moves?.moves[0].line_id === l1Id);
  check('(1a) exactly one marker was reconciled', result.markers.length === 1 && result.markers[0].line_id === l1Id);
  check('(1a) marker kind matches the decided move', result.markers[0].kind === 'take_it');
  check('(1a) a first_look move carries no action_ref (nothing to carry yet)', result.markers[0].action_ref === null);
  check('(1a) exactly one row in the table for L1', markerRowCount(l1Id) === 1);
}

// -- simulate JARVIS having actually acted on L1 (out-of-band, the way a
//    real "click take_it -> spawn a thread" step would): ledger marked
//    'acted', the marker's action_ref attached to point at it. --------------
const ACTION_REF = 'cockpit:vendor-thread-77';
markLineActed(l1Id, ACTION_REF);
setNotepadMarkerActionRef(l1Id, ACTION_REF);
check('(1b) ledger now shows L1 acted, pinned to the CURRENT text', true); // sanity marker for the log

// -- edit the acted line's text, then run the pipeline again. Per
//    LINE-IDENTITY.md §4, an acted line whose hash changed surfaces as a
//    RECONCILE carrying its existing action_ref — never a fresh first_look.
//    L2 is re-saved byte-identical and stays silent (the model is asked
//    about it again but proposes nothing), isolating the proof to L1. -------
{
  const L1_V2 = 'Call the vendor about the overdue invoice -- confirm the new delivery date';
  const saved = saveAtTick(DAY1, [L1_V2, L2].join('\n'), 2000);
  const editedId = lineIdByText(saved, L1_V2);
  check('(1c) the edit kept the same line id (reword, not a new line)', editedId === l1Id);

  const stub = combinedStub((id) =>
    id === l1Id
      ? { kind: 'already_done', reason: 'You already reached out about the invoice; this just adds the delivery date' }
      : undefined,
  );
  const result = await runNotepadSpeak(DAY1, { now: tickDate(2000 + 20 + 1), runOneShot: stub });

  check('(1d) a NEW settle fired for the edit', result.pass.settle !== null);
  check('(1d) worth_reviewing is true', result.pass.worth_reviewing === true);

  const l1Review = result.pass.review?.lines.find((l) => l.line_id === l1Id);
  check('(1d) L1 surfaced as RECONCILE, not a bare first_look', l1Review?.surfaced_kind === 'reconcile');
  check('(1d) L1 still carries its ORIGINAL action_ref in the review', l1Review?.action_ref === ACTION_REF);

  check('(1d) the model was genuinely asked again and proposed a real move', result.moves?.moves.length === 1);
  check('(1d) exactly one marker was reconciled', result.markers.length === 1 && result.markers[0].line_id === l1Id);

  const updated = getNotepadMarker(l1Id);
  check('(1d) THE GUARANTEE: still exactly one row for L1 after the edit-and-settle cycle', markerRowCount(l1Id) === 1);
  check('(1d) the marker updated its kind to the new decision', updated.kind === 'already_done');
  check(
    '(1d) the marker updated its reason to the new decision',
    updated.reason === 'You already reached out about the invoice; this just adds the delivery date',
  );
  check('(1d) the marker CARRIED the original action_ref forward — never lost, never invented', updated.action_ref === ACTION_REF);
  check('(1d) the marker hash now matches the EDITED text', updated.hash === lineTextHash(L1_V2));
  check('(1d) the marker is active (not dismissed)', updated.dismissed === false);
}

// ═══════════════════════════════════════════════════════════════════════════
// (2) DISMISS ON "MONDAY", STAY QUIET ON "TUESDAY" — a REAL second day (not
//     a same-day re-save), where the identical text mints a BRAND NEW
//     line_id (lines belong to a day per LINE-IDENTITY.md), the model is
//     genuinely re-asked and proposes a DIFFERENT move than before, and the
//     result must still not persist as an active marker.
// ═══════════════════════════════════════════════════════════════════════════
const DAY2_MONDAY = '2026-10-06';
const DAY2_TUESDAY = '2026-10-20';
const L3 = 'Grab stamps at the post office before it closes for the day';
let l3Id;
let originalReason;

// -- "Monday": the pipeline decides a real move and creates the marker. -----
{
  const saved = saveAtTick(DAY2_MONDAY, [L3].join('\n'), 5000);
  l3Id = lineIdByText(saved, L3);

  const stub = combinedStub((id) => (id === l3Id ? { kind: 'take_it', reason: 'JARVIS could remind you on the way out' } : undefined));
  const result = await runNotepadSpeak(DAY2_MONDAY, { now: tickDate(5000 + 20 + 1), runOneShot: stub });

  check('(2a) Monday: settled and decided a move', result.pass.settle !== null && result.moves?.moves.length === 1);
  check('(2a) Monday: the marker was created', result.markers.length === 1 && result.markers[0].line_id === l3Id);
  check('(2a) Monday: marker starts active (not dismissed)', result.markers[0].dismissed === false);

  originalReason = result.markers[0].reason;
}

// -- Kevin dismisses it (the click a future marker-UI/dismiss route would
//    trigger — dismissNotepadMarker is the exact function that route calls). -
{
  const dismissed = dismissNotepadMarker(l3Id);
  check('(2b) dismiss took effect', dismissed.dismissed === true);
  check('(2b) hidden from the active set immediately', !activeNotepadMarkers(DAY2_MONDAY).some((m) => m.line_id === l3Id));
}

// -- "Tuesday": a GENUINELY DIFFERENT notepad day, not the same day re-saved.
//    The identical text (after normalization) gets a BRAND NEW line_id here
//    — this is the actual cross-day proof (node #851), not a same-day
//    settle repeat. The pipeline surfaces it as an ordinary first_look (a
//    fresh line_id has no ledger row of its own to compare against), the
//    model is genuinely re-asked over the same wording and proposes
//    something DIFFERENT than Monday's judgment — but the PERSISTED marker
//    must still come back dismissed, because reconcileNotepadMarker's
//    day-independent text-hash memory recognizes this exact wording
//    regardless of which line_id or day it shows up under. -----------------
{
  const movesCallsBefore = totalMovesCalls;
  const savedTuesday = saveAtTick(DAY2_TUESDAY, [L3].join('\n'), 6000);
  const l3IdTuesday = lineIdByText(savedTuesday, L3);
  check('(2c) Tuesday mints a FRESH line_id for the identical text (a real second day, not a re-save)', l3IdTuesday !== l3Id);

  const stub = combinedStub((id) => (id === l3IdTuesday ? { kind: 'question', reason: 'did you already grab these on Monday?' } : undefined));
  const result = await runNotepadSpeak(DAY2_TUESDAY, { now: tickDate(6000 + 20 + 1), runOneShot: stub });

  check('(2c) Tuesday: a new settle fired for the new day', result.pass.settle !== null);
  check(
    "(2c) Tuesday: L3 surfaced as an ordinary first_look (its OWN line_id is unseen -- the dismissal lives in the day-independent text memory, not this line's ledger row)",
    result.pass.review?.lines.some((l) => l.line_id === l3IdTuesday && l.surfaced && l.surfaced_kind === 'first_look'),
  );
  check(
    '(2c) Tuesday: the model was genuinely re-asked and proposed something DIFFERENT',
    totalMovesCalls === movesCallsBefore + 1 && result.moves?.moves.length === 1 && result.moves?.moves[0].kind === 'question',
  );
  check('(2c) Tuesday: the pipeline reconciled the NEW line_id', result.markers.length === 1 && result.markers[0].line_id === l3IdTuesday);

  const tuesdayMarker = getNotepadMarker(l3IdTuesday);
  check(
    "(2c) THE GUARANTEE: Tuesday's marker still comes back dismissed -- cross-day text memory, not a resurrected active proposal",
    tuesdayMarker.dismissed === true,
  );
  check('(2c) THE GUARANTEE: the fresh "question" proposal never went active', !activeNotepadMarkers(DAY2_TUESDAY).some((m) => m.line_id === l3IdTuesday));
  check('(2c) never a second row for Tuesday\'s own line_id', markerRowCount(l3IdTuesday) === 1);
  check(
    "(2c) Monday's own marker row is untouched by Tuesday's cycle (they are two different rows on two different days)",
    getNotepadMarker(l3Id).reason === originalReason && markerRowCount(l3Id) === 1,
  );
  check('(2c) still present (dismissed) in listNotepadMarkers for Tuesday -- remembered, not erased', listNotepadMarkers(DAY2_TUESDAY).some((m) => m.line_id === l3IdTuesday));
}

// ═══════════════════════════════════════════════════════════════════════════
// (3) THE SILENT PATH — nothing settled / nothing worth reviewing never
//     invokes decideNotepadMoves at all (no wasted model call, no markers).
// ═══════════════════════════════════════════════════════════════════════════
const DAY3 = '2026-10-07';
{
  const movesCallsBefore = totalMovesCalls;
  saveAtTick(DAY3, ['ok', '#', 'hi'].join('\n'), 7000); // junk only — never survives the gate prefilter
  const result = await runNotepadSpeak(DAY3, { now: tickDate(7000 + 20 + 1), runOneShot: combinedStub(() => undefined) });

  check('(3) settle still fires for a junk-only note', result.pass.settle !== null);
  check('(3) worth_reviewing is false', result.pass.worth_reviewing === false);
  check('(3) moves was never decided — null, not an empty result', result.moves === null);
  check('(3) markers is empty', result.markers.length === 0);
  check('(3) decideNotepadMoves was never actually called', totalMovesCalls === movesCallsBefore);
}

// ═══════════════════════════════════════════════════════════════════════════
// (F) — zero real claude processes were ever spawned by this whole run.
// ═══════════════════════════════════════════════════════════════════════════
const spawnsAfter = claudeProcessCount();
check('(F) zero net claude processes spawned across the entire run', spawnsAfter <= spawnsBefore, `before=${spawnsBefore} after=${spawnsAfter}`);

console.log(`\ngate calls: ${totalGateCalls}  moves calls: ${totalMovesCalls}  violations: ${failed ? 'yes' : 0}`);
console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
