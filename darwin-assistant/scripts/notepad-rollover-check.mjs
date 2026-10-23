#!/usr/bin/env node
// NOTEPAD ROLLOVER CHECK — exercises carryForwardInto() in
// src/notepad-rollover.ts directly against a scratch jarvis.db. No HTTP, no
// model calls. Proves:
//
//   (a) day A with 3 open + 2 closed (1 acted, 1 dismissed) lines -> a
//       single carryForwardInto(db, 'B') call carries exactly the 3 open
//       lines, in order, each with origin_day='A' and
//       carried_from_line_id = the source line's id.
//   (b) calling it a SECOND time for the same targetDay carries nothing new
//       (idempotent) — line count on B stays 3, carried=0, skipped=3.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-rollover-check.db node scripts/notepad-rollover-check.mjs

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

console.log(`[notepad-rollover-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getNotepadDay, putNotepadDay, markLineActed, markLineDismissed, markLineDone } = await import(path.join(distDir, 'notepad.js'));
const { carryForwardInto } = await import(path.join(distDir, 'notepad-rollover.js'));
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

const DAY_A = '2026-09-23';
const DAY_B = '2026-09-24';

// -- set up day A: 4 open lines (incl. 1 acted -- acted lines carry forward
//    under the #886 contract, see fix (e) below) + 1 closed (dismissed) -------
putNotepadDay(DAY_A, ['Call Mike about the invoice', 'Draft the Q3 deck', 'ACTED ALREADY', 'DISMISSED ALREADY', 'Follow up with Ian'].join('\n'));
const aLines = getNotepadDay(DAY_A).lines;
const actedLine = aLines.find((l) => l.text === 'ACTED ALREADY');
const dismissedLine = aLines.find((l) => l.text === 'DISMISSED ALREADY');
markLineActed(actedLine.id, 'thread:test-123');
markLineDismissed(dismissedLine.id, 'not needed');

const openTexts = ['Call Mike about the invoice', 'Draft the Q3 deck', 'ACTED ALREADY', 'Follow up with Ian'];

// -- first carry-forward --------------------------------------------------------
const result1 = carryForwardInto(sqliteDb, DAY_B, { now: '2026-09-25T12:00:00.000Z' });
check('(a) sourceDay resolved to A', result1.sourceDay === DAY_A);
check('(a) carried 4 lines (open + acted; only dismissed excluded)', result1.carried === 4);
check('(a) skipped 0 lines', result1.skipped === 0);
check('(a) lineIds has 4 entries', result1.lineIds.length === 4);

const bLines1 = getNotepadDay(DAY_B).lines;
check('(a) B has exactly 4 lines', bLines1.length === 4);
check('(a) B lines match the 4 open+acted texts, in order', JSON.stringify(bLines1.map((l) => l.text)) === JSON.stringify(openTexts));

const rawB1 = sqliteDb
  .prepare(`SELECT id, text, origin_line_id, origin_day, carried_from_line_id, carried_at FROM notepad_lines WHERE day = ? ORDER BY idx ASC`)
  .all(DAY_B);
check('(a) every carried line has origin_day = A', rawB1.every((r) => r.origin_day === DAY_A));
check(
  '(a) every carried line has carried_from_line_id matching a source line id',
  rawB1.every((r) => aLines.some((a) => String(a.id) === r.carried_from_line_id))
);
check('(a) every carried line has origin_line_id = its carried_from_line_id (first carry)', rawB1.every((r) => r.origin_line_id === r.carried_from_line_id));
check('(a) every carried line has carried_at stamped from the injected clock', rawB1.every((r) => r.carried_at === '2026-09-25T12:00:00.000Z'));

const dayBRow = sqliteDb.prepare(`SELECT rolled_over_at FROM notepad_days WHERE day = ?`).get(DAY_B);
check('(a) notepad_days.rolled_over_at stamped', dayBRow?.rolled_over_at === '2026-09-25T12:00:00.000Z');

// -- second carry-forward (idempotency) -----------------------------------------
const result2 = carryForwardInto(sqliteDb, DAY_B, { now: '2026-09-25T13:00:00.000Z' });
check('(b) second call carries 0 new lines', result2.carried === 0);
check('(b) second call skips all 4', result2.skipped === 4);

const bLines2 = getNotepadDay(DAY_B).lines;
check('(b) B still has exactly 4 lines (no duplicates)', bLines2.length === 4);
check('(b) B line ids unchanged across the second call', JSON.stringify(bLines2.map((l) => l.id)) === JSON.stringify(bLines1.map((l) => l.id)));

const dayBRow2 = sqliteDb.prepare(`SELECT rolled_over_at FROM notepad_days WHERE day = ?`).get(DAY_B);
check('(b) rolled_over_at re-stamped on the second call', dayBRow2?.rolled_over_at === '2026-09-25T13:00:00.000Z');

// -- day with no prior day at all (nothing exists before it) --------------------
const result3 = carryForwardInto(sqliteDb, '2000-01-01', { now: '2026-09-25T14:00:00.000Z' });
check('(c) no source day found -> sourceDay null', result3.sourceDay === null);
check('(c) no source day found -> carried 0', result3.carried === 0);
check(
  '(c) lonely day still stamped rolled_over_at',
  sqliteDb.prepare(`SELECT rolled_over_at FROM notepad_days WHERE day = ?`).get('2000-01-01')?.rolled_over_at === '2026-09-25T14:00:00.000Z'
);

// -- skip-day chain: an empty day in between must not break the chain ----------
// B already has 4 lines carried from A above. D is two days after B, with C
// (in between) never touched at all (simulating a skipped/weekend day with
// no notepad_days row for it whatsoever). carryForwardInto(D) must still
// find B as the source (the most recent day WITH lines), not fail because
// C-1 has no rows.
const DAY_D = '2026-09-26';
const result4 = carryForwardInto(sqliteDb, DAY_D, { now: '2026-09-25T15:00:00.000Z' });
check('(d) skip-day chain: sourceDay resolves to the last day WITH lines (B), skipping the empty gap', result4.sourceDay === DAY_B);
check('(d) skip-day chain: carries the 4 lines forward from B', result4.carried === 4);

// -- fix #886(4): acted-vs-done contract -- acted lines carry, dismissed and
//    done lines do not. A separate day pair so it doesn't disturb the counts
//    asserted above. -------------------------------------------------------
const DAY_E = '2026-10-01';
const DAY_F = '2026-10-02';
putNotepadDay(DAY_E, ['Still open', 'ACTED — still on the list', 'DISMISSED — dropped', 'DONE — finished'].join('\n'));
const eLines = getNotepadDay(DAY_E).lines;
const actedLine2 = eLines.find((l) => l.text === 'ACTED — still on the list');
const dismissedLine2 = eLines.find((l) => l.text === 'DISMISSED — dropped');
const doneLine2 = eLines.find((l) => l.text === 'DONE — finished');
markLineActed(actedLine2.id, 'thread:test-456');
markLineDismissed(dismissedLine2.id, 'not needed');
markLineDone(doneLine2.id, 'finished for real');

const result5 = carryForwardInto(sqliteDb, DAY_F, { now: '2026-10-02T09:00:00.000Z' });
const fLines = getNotepadDay(DAY_F).lines;
check('(e) acted-vs-done: carries exactly the open + acted lines (2)', result5.carried === 2);
check('(e) acted-vs-done: F has exactly 2 lines', fLines.length === 2);
check(
  '(e) acted-vs-done: F carries "Still open" and the acted line, in order, and drops dismissed/done',
  JSON.stringify(fLines.map((l) => l.text)) === JSON.stringify(['Still open', 'ACTED — still on the list'])
);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
