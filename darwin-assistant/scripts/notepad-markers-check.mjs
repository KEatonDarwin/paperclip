#!/usr/bin/env node
// NOTEPAD MARKER STORE CHECK — exercises src/notepad-markers.ts
// (reconcileNotepadMarker / dismissNotepadMarker / setNotepadMarkerActionRef
// / getNotepadMarker / listNotepadMarkers / activeNotepadMarkers) against
// goal 6 node #104's done_means: "Markers persist against line_id with
// their move kind, reason and action_ref; editing an acted line reconciles
// its existing marker instead of creating a second one; dismissing a
// marker is remembered across days; and a check proves an already-acted
// line never produces a duplicate marker through an edit-and-settle
// cycle." No HTTP, no model calls.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-markers-check.db node scripts/notepad-markers-check.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard ─────────────────────────────────────────────────────────
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

console.log(`[notepad-markers-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay, lineTextHash } = await import(path.join(distDir, 'notepad.js'));
const {
  reconcileNotepadMarker,
  dismissNotepadMarker,
  setNotepadMarkerActionRef,
  getNotepadMarker,
  listNotepadMarkers,
  activeNotepadMarkers,
} = await import(path.join(distDir, 'notepad-markers.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

/** Raw row count for a line_id -- the strongest possible proof that
 *  "reconcile in place" never inserts a second row: not "the read returns
 *  the latest values" (which a duplicate-with-a-later-id could also
 *  satisfy if the read happened to pick the right one) but "there is
 *  structurally exactly one row in the table for this line_id." */
function markerRowCount(lineId) {
  return sqliteDb.prepare('SELECT COUNT(*) AS n FROM notepad_markers WHERE line_id = ?').get(lineId).n;
}

function lineIdByText(saved, text) {
  const line = saved.lines.find((l) => l.text === text);
  assert.ok(line, `fixture line '${text}' must exist`);
  return line.id;
}

// -- first reconcile: creates the one row -------------------------------------
const DAY1 = '2026-09-25';
{
  const saved = putNotepadDay(DAY1, ['- Call Mike about the invoice', 'other line'].join('\n'));
  const lineId = lineIdByText(saved, '- Call Mike about the invoice');

  check('no marker before the first reconcile', getNotepadMarker(lineId) === undefined);

  const m1 = reconcileNotepadMarker(lineId, { kind: 'take_it', reason: 'a concrete task JARVIS can do' });
  check('reconcile returns the created marker', m1.line_id === lineId);
  check('kind persisted', m1.kind === 'take_it');
  check('reason persisted', m1.reason === 'a concrete task JARVIS can do');
  check('action_ref defaults to null when omitted', m1.action_ref === null);
  check('hash matches the current normalized line text', m1.hash === lineTextHash('- Call Mike about the invoice'));
  check('a fresh marker is not dismissed', m1.dismissed === false);
  check('exactly one row exists for this line_id', markerRowCount(lineId) === 1);
}

// -- reconcile again, SAME text: updates the same row, never a duplicate -----
{
  const saved = putNotepadDay(DAY1, ['- Call Mike about the invoice', 'other line'].join('\n'));
  const lineId = lineIdByText(saved, '- Call Mike about the invoice');

  const before = getNotepadMarker(lineId);
  const m2 = reconcileNotepadMarker(lineId, { kind: 'context', reason: 'he already replied about this in email' });
  check('reconcile on unchanged text updates kind', m2.kind === 'context');
  check('reconcile on unchanged text updates reason', m2.reason === 'he already replied about this in email');
  check('same line_id (same row identity)', m2.line_id === before.line_id);
  check('still exactly one row for this line_id (no duplicate insert)', markerRowCount(lineId) === 1);
}

// -- editing the line's text ("edit an acted line") reconciles in place ------
{
  const before = putNotepadDay(DAY1, ['- Call Mike about the invoice', 'other line'].join('\n'));
  const lineId = lineIdByText(before, '- Call Mike about the invoice');
  reconcileNotepadMarker(lineId, { kind: 'take_it', reason: 'original task', action_ref: 'cockpit:test-thread-1' });

  // Reword -- id-stable per LINE-IDENTITY.md, new normalized hash.
  const after = putNotepadDay(DAY1, ['- Call Mike about the contract', 'other line'].join('\n'));
  const rewordedId = lineIdByText(after, '- Call Mike about the contract');
  check('reword kept the same line id', rewordedId === lineId);

  const reconciled = reconcileNotepadMarker(lineId, {
    kind: 'take_it',
    reason: 'still a task, now about the contract',
    action_ref: 'cockpit:test-thread-1',
  });
  check('reconcile after edit updates the hash to the new text', reconciled.hash === lineTextHash('- Call Mike about the contract'));
  check('reconcile after edit keeps the action_ref', reconciled.action_ref === 'cockpit:test-thread-1');
  check('reconcile after edit updates the reason', reconciled.reason === 'still a task, now about the contract');
  check('exactly one row for this line_id after the edit-and-reconcile cycle', markerRowCount(lineId) === 1);
}

// -- dismiss: stamps dismissed_hash from the marker's OWN hash ---------------
const DAY2 = '2026-09-26';
let dismissLineId;
{
  const saved = putNotepadDay(DAY2, ['grab milk on the way home'].join('\n'));
  dismissLineId = lineIdByText(saved, 'grab milk on the way home');
  const created = reconcileNotepadMarker(dismissLineId, { kind: 'take_it', reason: 'errand JARVIS could remind about' });

  const dismissed = dismissNotepadMarker(dismissLineId);
  check('dismiss sets dismissed true', dismissed.dismissed === true);
  check('dismiss stamps dismissed_hash from the marker hash', dismissed.dismissed_hash === created.hash);
  check('dismiss stamps dismissed_at', typeof dismissed.dismissed_at === 'string' && dismissed.dismissed_at.length > 0);
  check('dismiss does not touch kind/reason', dismissed.kind === 'take_it' && dismissed.reason === created.reason);
}

// -- dismissed + SAME text reconciled again: no-op, never fires twice -------
{
  // Same day, same text, no edit at all -- exactly what a later
  // settle-and-reread pass re-examining the whole note would do.
  const noop = reconcileNotepadMarker(dismissLineId, { kind: 'take_it', reason: 'errand JARVIS could remind about (again)' });
  check('reconcile on dismissed+unchanged text is a no-op: stays dismissed', noop.dismissed === true);
  check('reconcile on dismissed+unchanged text does not overwrite the reason', noop.reason === 'errand JARVIS could remind about');
  check('reconcile on dismissed+unchanged text keeps the original dismissed_hash', noop.dismissed_hash !== null);
  check('the no-op did not create a second row', markerRowCount(dismissLineId) === 1);
  check('a dismissed marker is excluded from activeNotepadMarkers', !activeNotepadMarkers(DAY2).some((m) => m.line_id === dismissLineId));
  check('a dismissed marker still shows up in listNotepadMarkers', listNotepadMarkers(DAY2).some((m) => m.line_id === dismissLineId));
}

// -- "remembered across days": put the SAME text back after an edit away ----
{
  // Edit the line away from the dismissed text (a genuinely different
  // judgment is allowed to fire)...
  const edited = putNotepadDay(DAY2, ['grab milk and eggs on the way home'].join('\n'));
  const editedId = lineIdByText(edited, 'grab milk and eggs on the way home');
  check('edit-away kept the same line id', editedId === dismissLineId);

  const revived = reconcileNotepadMarker(dismissLineId, { kind: 'take_it', reason: 'errand, now with eggs too' });
  check('a genuinely different text revives an active (non-dismissed) marker', revived.dismissed === false);
  check('revived marker hash matches the NEW text', revived.hash === lineTextHash('grab milk and eggs on the way home'));

  // ...then edit it BACK to exactly the text that was dismissed. This is
  // the literal "dismiss on Monday, stay quiet [later]" case: the same
  // wording that was already ruled out must not resurrect a marker just
  // because time (or another edit) passed in between.
  const reverted = putNotepadDay(DAY2, ['grab milk on the way home'].join('\n'));
  const revertedId = lineIdByText(reverted, 'grab milk on the way home');
  check('revert kept the same line id', revertedId === dismissLineId);

  const afterRevert = reconcileNotepadMarker(dismissLineId, { kind: 'take_it', reason: 'errand JARVIS could remind about' });
  check('reverting to the exact dismissed text stays dismissed (never fires twice)', afterRevert.dismissed === true);
  check('exactly one row for this line_id through revive-then-revert', markerRowCount(dismissLineId) === 1);
}

// -- setNotepadMarkerActionRef: attach without disturbing the rest ----------
const DAY3 = '2026-09-27';
{
  const saved = putNotepadDay(DAY3, ['fix the composer auto-grow bug'].join('\n'));
  const lineId = lineIdByText(saved, 'fix the composer auto-grow bug');
  const created = reconcileNotepadMarker(lineId, { kind: 'take_it', reason: 'a real bug JARVIS could take' });
  check('action_ref starts null', created.action_ref === null);

  const linked = setNotepadMarkerActionRef(lineId, 'cockpit:hopper-node-900');
  check('setNotepadMarkerActionRef attaches the ref', linked.action_ref === 'cockpit:hopper-node-900');
  check('setNotepadMarkerActionRef leaves kind untouched', linked.kind === 'take_it');
  check('setNotepadMarkerActionRef leaves reason untouched', linked.reason === created.reason);
  check('setNotepadMarkerActionRef leaves hash untouched', linked.hash === created.hash);
}

// -- deleting a line cascades its marker away --------------------------------
{
  const saved = putNotepadDay(DAY3, ['fix the composer auto-grow bug', 'delete me'].join('\n'));
  const deleteId = lineIdByText(saved, 'delete me');
  reconcileNotepadMarker(deleteId, { kind: 'question', reason: 'needs a decision' });
  check('marker exists before delete', getNotepadMarker(deleteId) !== undefined);

  putNotepadDay(DAY3, ['fix the composer auto-grow bug'].join('\n')); // "delete me" is gone
  check('marker is gone too (ON DELETE CASCADE)', getNotepadMarker(deleteId) === undefined);
  check('deleted line does not appear in listNotepadMarkers', !listNotepadMarkers(DAY3).some((m) => m.line_id === deleteId));
}

// -- two identical lines keep independent markers ----------------------------
const DAY4 = '2026-09-28';
{
  const saved = putNotepadDay(DAY4, ['dup line', 'other', 'dup line'].join('\n'));
  const dupIds = saved.lines.filter((l) => l.text === 'dup line').map((l) => l.id);
  check('two distinct ids for the two identical lines', dupIds.length === 2 && dupIds[0] !== dupIds[1]);

  reconcileNotepadMarker(dupIds[0], { kind: 'take_it', reason: 'first one only' });
  check('first duplicate has a marker', getNotepadMarker(dupIds[0]) !== undefined);
  check('second duplicate has no marker of its own', getNotepadMarker(dupIds[1]) === undefined);
}

// -- validation: bad input throws rather than silently no-opping ------------
{
  const saved = putNotepadDay('2026-09-29', ['a line'].join('\n'));
  const lineId = saved.lines[0].id;

  let threw = false;
  try {
    reconcileNotepadMarker(999999999, { kind: 'take_it', reason: 'x' });
  } catch {
    threw = true;
  }
  check('reconcile on a nonexistent line id throws', threw);

  threw = false;
  try {
    reconcileNotepadMarker(lineId, { kind: 'not_a_real_kind', reason: 'x' });
  } catch {
    threw = true;
  }
  check('reconcile with an invalid kind throws', threw);

  threw = false;
  try {
    reconcileNotepadMarker(lineId, { kind: 'take_it', reason: '   ' });
  } catch {
    threw = true;
  }
  check('reconcile with a blank reason throws', threw);

  threw = false;
  try {
    dismissNotepadMarker(lineId); // no marker created on this line yet
  } catch {
    threw = true;
  }
  check('dismissing a line with no marker throws', threw);

  threw = false;
  try {
    setNotepadMarkerActionRef(lineId, 'ref'); // still no marker
  } catch {
    threw = true;
  }
  check('setNotepadMarkerActionRef on a line with no marker throws', threw);
}

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
