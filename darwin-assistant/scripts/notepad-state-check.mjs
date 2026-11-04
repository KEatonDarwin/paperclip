#!/usr/bin/env node
// NOTEPAD LINE-STATE CHECK — exercises the per-line state ledger
// (src/notepad.ts: markLineSeen/markLineActed/markLineDismissed/
// unscannedLines/getNotepadLine/getNotepadLineState) against the decision
// table in docs/notepad/LINE-IDENTITY.md §4. No HTTP, no model calls.
//
// Covers, one case per decision-table cell (7 total):
//   unseen                              -> first_look
//   seen      + hash unchanged          -> skip (not returned)
//   seen      + hash changed            -> first_look
//   acted     + hash unchanged          -> skip (not returned)
//   acted     + hash changed            -> reconcile, carrying action_ref
//   dismissed + hash unchanged          -> skip (not returned)
//   dismissed + hash changed            -> first_look
//
// Plus the structural cases from the parent node's done_means:
//   - a typo fix on an acted line returns reconcile with the ORIGINAL
//     action_ref (not a bare first-look, not a new action)
//   - a meaning change on an acted line returns reconcile with the same
//     action_ref (the contract deliberately does not try to distinguish
//     cosmetic vs. meaningful changes at the hash layer)
//   - deleting a line removes its state row entirely (CASCADE)
//   - a moved line (same text, different index) keeps its state and does
//     NOT resurface
//   - two identical lines in the same note keep independent states
//   - the load-bearing invariant: mark-then-immediately-read reports the
//     line as NOT needing a look (proves the hash function used by the
//     markers and the reader are the same one)
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-state-check.db node scripts/notepad-state-check.mjs

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

console.log(`[notepad-state-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const {
  putNotepadDay,
  markLineSeen,
  markLineActed,
  markLineDismissed,
  unscannedLines,
  getNotepadLine,
  getNotepadLineState,
  normalizeLineText,
  lineTextHash,
} = await import(path.join(distDir, 'notepad.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

// -- normalizeLineText / lineTextHash: worked examples from §2.3 -------------
{
  check('§2.3 #1 leading whitespace only: hash unchanged',
    lineTextHash('- Call Mike about the invoice') === lineTextHash('    - Call Mike about the invoice'));
  check('§2.3 #2 bullet marker style change: hash unchanged',
    lineTextHash('- Call Mike about the invoice') === lineTextHash('* Call Mike about the invoice'));
  check('§2.3 #3 case + internal spacing: hash unchanged',
    lineTextHash('Call Mike About The Invoice') === lineTextHash('call  mike about   the invoice'));
  check('§2.3 #4 subject word changed: hash CHANGES',
    lineTextHash('- Call Mike about the invoice') !== lineTextHash('- Call Mike about the contract'));
  check('§2.3 #5 meaning reversed: hash CHANGES',
    lineTextHash('- Call Mike about the invoice') !== lineTextHash('- Do NOT call Mike, Ian is handling it'));
  check('§2.3 #6 added content: hash CHANGES',
    lineTextHash('- Follow up with Ian') !== lineTextHash('- Follow up with Ian tomorrow'));
  check('normalizeLineText strips bullet + collapses + casefolds',
    normalizeLineText('   *   Call   MIKE  ') === 'call mike');
}

// ── helper: save a day and return a map of text -> line_id (first match) ────
function saveAndMap(day, lines) {
  const saved = putNotepadDay(day, lines.join('\n'));
  const byText = new Map();
  for (const l of saved.lines) {
    if (!byText.has(l.text)) byText.set(l.text, []);
    byText.get(l.text).push(l.id);
  }
  return { saved, byText };
}

function unscannedById(day) {
  const map = new Map();
  for (const u of unscannedLines(day)) map.set(u.line_id, u);
  return map;
}

// -- decision table: 7 cells --------------------------------------------------
const DAY = '2026-09-25';
{
  const { saved } = saveAndMap(DAY, ['unseen line', 'seen line', 'acted line', 'dismissed line']);
  const [unseenId, seenId, actedId, dismissedId] = saved.lines.map((l) => l.id);

  markLineSeen(seenId);
  markLineActed(actedId, 'cockpit:test-thread-1');
  markLineDismissed(dismissedId, 'not relevant');

  let u = unscannedById(DAY);

  // unseen -> first_look
  check('unseen line surfaces as first_look', u.get(unseenId)?.kind === 'first_look');
  check('unseen line has no action_ref', u.get(unseenId)?.action_ref === null);

  // seen + unchanged -> skip
  check('seen + unchanged: skipped (not in unscannedLines)', !u.has(seenId));

  // acted + unchanged -> skip
  check('acted + unchanged: skipped (not in unscannedLines)', !u.has(actedId));

  // dismissed + unchanged -> skip
  check('dismissed + unchanged: skipped (not in unscannedLines)', !u.has(dismissedId));

  // -- the load-bearing invariant: mark-then-immediately-read reports NOT
  //    needing a look. If normalization drifted between the marker and the
  //    reader, seen/acted/dismissed would all incorrectly appear above.
  check('load-bearing invariant: mark-then-read round trip is stable (0 of 3 marked lines resurface)',
    !u.has(seenId) && !u.has(actedId) && !u.has(dismissedId));

  // Now change all four lines' text (reword) and re-save.
  const after = putNotepadDay(DAY, [
    'unseen line', // untouched
    'seen line REWORDED',
    'acted line REWORDED',
    'dismissed line REWORDED',
  ].join('\n'));
  // ids must be preserved by the line-identity diff (positional reword).
  check('reword: seen line kept its id', after.lines.find((l) => l.text === 'seen line REWORDED')?.id === seenId);
  check('reword: acted line kept its id', after.lines.find((l) => l.text === 'acted line REWORDED')?.id === actedId);
  check('reword: dismissed line kept its id', after.lines.find((l) => l.text === 'dismissed line REWORDED')?.id === dismissedId);

  u = unscannedById(DAY);

  // seen + changed -> first_look
  check('seen + changed: surfaces as first_look', u.get(seenId)?.kind === 'first_look');
  check('seen + changed: no action_ref', u.get(seenId)?.action_ref === null);

  // acted + changed -> reconcile, carrying action_ref
  check('acted + changed: surfaces as reconcile', u.get(actedId)?.kind === 'reconcile');
  check('acted + changed: carries the ORIGINAL action_ref', u.get(actedId)?.action_ref === 'cockpit:test-thread-1');

  // dismissed + changed -> first_look
  check('dismissed + changed: surfaces as first_look', u.get(dismissedId)?.kind === 'first_look');
  check('dismissed + changed: no action_ref', u.get(dismissedId)?.action_ref === null);
}

// -- structural: typo fix vs. meaning change on an acted line ----------------
{
  const DAY2 = '2026-09-26';
  const saved = putNotepadDay(DAY2, ['- Call Mike about the invoice'].join('\n'));
  const lineId = saved.lines[0].id;
  markLineActed(lineId, 'goal:6:node:91');

  // Typo fix (cosmetic-ish, but still a real text change per §2.3 example 4
  // territory — the contract does not try to distinguish this from a real
  // meaning change at the hash layer, both must reconcile identically).
  putNotepadDay(DAY2, ['- Cal Mike about the invoice'].join('\n')); // typo: "Cal"
  let u = unscannedById(DAY2);
  check('typo fix on acted line: reconcile (not a new bare first-look)', u.get(lineId)?.kind === 'reconcile');
  check('typo fix on acted line: action_ref is the ORIGINAL, not a new one', u.get(lineId)?.action_ref === 'goal:6:node:91');

  // Resolve the reconciliation (re-mark acted, same action_ref, updates the
  // SAME row rather than inserting a second one).
  markLineActed(lineId, 'goal:6:node:91');
  check('re-marking acted updates the same row (still not surfaced)', !unscannedById(DAY2).has(lineId));

  // Meaning change.
  putNotepadDay(DAY2, ['- Do NOT call Mike, Ian is handling it'].join('\n'));
  u = unscannedById(DAY2);
  check('meaning change on acted line: reconcile', u.get(lineId)?.kind === 'reconcile');
  check('meaning change on acted line: carries the same action_ref', u.get(lineId)?.action_ref === 'goal:6:node:91');
}

// -- deleting a line removes its state row ------------------------------------
{
  const DAY3 = '2026-09-27';
  const saved = putNotepadDay(DAY3, ['keep me', 'delete me'].join('\n'));
  const deleteId = saved.lines.find((l) => l.text === 'delete me').id;
  markLineActed(deleteId, 'thread:1');
  check('state row exists before delete', getNotepadLineState(deleteId) !== undefined);

  putNotepadDay(DAY3, ['keep me'].join('\n')); // "delete me" line is gone
  check('line itself is gone', getNotepadLine(deleteId) === undefined);
  check('state row is gone too (ON DELETE CASCADE)', getNotepadLineState(deleteId) === undefined);
  check('deleted line does not appear in unscannedLines', !unscannedById(DAY3).has(deleteId));
}

// -- moved line (same text, different index) keeps state, does not resurface -
{
  const DAY4 = '2026-09-28';
  const saved = putNotepadDay(DAY4, ['alpha', 'bravo', 'charlie', 'delta'].join('\n'));
  const bravoId = saved.lines.find((l) => l.text === 'bravo').id;
  markLineSeen(bravoId);
  check('bravo not surfaced right after marking seen', !unscannedById(DAY4).has(bravoId));

  // Move "bravo" to the end — text unchanged, index changes.
  const after = putNotepadDay(DAY4, ['alpha', 'charlie', 'delta', 'bravo'].join('\n'));
  const movedBravo = after.lines.find((l) => l.text === 'bravo');
  check('moved line kept its id', movedBravo.id === bravoId);
  check('moved line (same text) does NOT resurface after moving', !unscannedById(DAY4).has(bravoId));
}

// -- two identical lines in the same note keep independent states ------------
{
  const DAY5 = '2026-09-29';
  const saved = putNotepadDay(DAY5, ['dup line', 'other', 'dup line'].join('\n'));
  const dupIds = saved.lines.filter((l) => l.text === 'dup line').map((l) => l.id);
  check('two distinct ids for the two identical lines', dupIds.length === 2 && dupIds[0] !== dupIds[1]);

  markLineActed(dupIds[0], 'thread:only-the-first');
  const u = unscannedById(DAY5);
  check('first duplicate (marked acted, unchanged): skipped', !u.has(dupIds[0]));
  check('second duplicate (never marked): still surfaces as first_look', u.get(dupIds[1])?.kind === 'first_look');
}

// -- unknown line id: markers throw rather than silently no-op ----------------
{
  let threw = false;
  try {
    markLineSeen(999999999);
  } catch {
    threw = true;
  }
  check('marking a nonexistent line id throws (no silent no-op)', threw);
}

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
