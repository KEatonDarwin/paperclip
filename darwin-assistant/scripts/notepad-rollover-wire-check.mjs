#!/usr/bin/env node
// NOTEPAD ROLLOVER WIRE CHECK — exercises openNotepadDay() in
// src/notepad-rollover.ts (the real day-open path, node #882), not the
// carryForwardInto() engine directly (see notepad-rollover-check.mjs for
// that). No HTTP, no model calls. Proves:
//
//   (a) day A gets 2 open lines, one of them marked 'acted' (a ledger
//       entry). Opening day B via openNotepadDay() (the REAL day-open
//       function, with an injected clock) carries both lines onto B.
//   (b) the lineage-aware ledger read (getLedgerStateForLine) on the
//       CARRIED line (a brand-new id on B) still finds day A's ledger
//       entry -- proving a carried line doesn't look "unseen" to the
//       ledger just because it has a new id.
//   (c) opening day B a second time does not duplicate lines, and the
//       fast path (rolled_over_at already stamped) is what's taken --
//       carriedCount/carriedFrom on the response stay stable.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-rollover-wire-check.db node scripts/notepad-rollover-wire-check.mjs

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

console.log(`[notepad-rollover-wire-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getNotepadDay, putNotepadDay, markLineSeen, markLineActed, unscannedLines } = await import(path.join(distDir, 'notepad.js'));
const { openNotepadDay, getLedgerStateForLine, resolveLedgerKey } = await import(path.join(distDir, 'notepad-rollover.js'));
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

// -- day A: 2 open lines, one with a ledger entry ------------------------------
// 'seen' (not 'acted') deliberately: per carryForwardInto's own OPEN/CLOSED
// split, 'acted'/'dismissed' lines are CLOSED and never carry -- only a
// still-open line ('seen' or no ledger row at all) can be both carried AND
// have a pre-existing ledger entry to test lineage resolution against.
putNotepadDay(DAY_A, ['Call Mike about the invoice', 'Draft the Q3 deck'].join('\n'));
const aLines = getNotepadDay(DAY_A).lines;
const seenLine = aLines.find((l) => l.text === 'Call Mike about the invoice');
markLineSeen(seenLine.id);

// -- (a) open day B via the REAL day-open path, injected clock -----------------
// `now`'s calendar date (Central time) must equal DAY_B itself: node #886
// gates carry-forward on the requested day being TODAY, and openNotepadDay
// treats an injected `now` as "today" too (see isOpeningToday in
// notepad-rollover.ts) so this stays deterministic without touching the real
// system clock.
const opened1 = openNotepadDay(DAY_B, { now: '2026-09-24T12:00:00.000Z' });
check('(a) both lines carried onto B', opened1.lines.length === 2);
check(
  '(a) B lines match A texts, in order',
  JSON.stringify(opened1.lines.map((l) => l.text)) === JSON.stringify(['Call Mike about the invoice', 'Draft the Q3 deck'])
);
check('(a) carriedFrom reports A', opened1.carriedFrom === DAY_A);
check('(a) carriedCount reports 2', opened1.carriedCount === 2);

const dayBRow1 = sqliteDb.prepare(`SELECT rolled_over_at FROM notepad_days WHERE day = ?`).get(DAY_B);
check('(a) rolled_over_at stamped on B by the wiring call', dayBRow1?.rolled_over_at === '2026-09-24T12:00:00.000Z');

// -- (b) lineage-aware ledger read on the carried line -------------------------
const carriedSeenLine = opened1.lines.find((l) => l.text === 'Call Mike about the invoice');
check('(b) carried line has a NEW id (not the same as day A\'s)', carriedSeenLine.id !== seenLine.id);
check('(b) resolveLedgerKey walks the carried line back to day A\'s line id', resolveLedgerKey(carriedSeenLine.id) === seenLine.id);

const ledgerViaCarried = getLedgerStateForLine(carriedSeenLine.id);
check('(b) lineage-aware ledger read finds a state row at all', !!ledgerViaCarried);
check('(b) lineage-aware ledger read finds day A\'s state (seen)', ledgerViaCarried?.state === 'seen');
check('(b) lineage-aware ledger read is keyed on day A\'s line id, not the carried line\'s', ledgerViaCarried?.line_id === seenLine.id);

// A naive (non-lineage) read on the carried line's own id must find nothing --
// this is exactly the bug the wiring fixes.
const naiveRow = sqliteDb.prepare(`SELECT * FROM notepad_line_state WHERE line_id = ?`).get(carriedSeenLine.id);
check('(b) no separate ledger row exists under the carried line\'s own id (no duplication)', naiveRow === undefined);

// -- (c) opening day B again must not duplicate, and takes the fast path ------
const beforeSecondOpenCalls = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM notepad_lines WHERE day = ?`).get(DAY_B).n;
const opened2 = openNotepadDay(DAY_B, { now: '2026-09-25T13:00:00.000Z' });
check('(c) B still has exactly 2 lines after a second open', opened2.lines.length === 2 && beforeSecondOpenCalls === 2);
check(
  '(c) B line ids unchanged across the second open',
  JSON.stringify(opened2.lines.map((l) => l.id)) === JSON.stringify(opened1.lines.map((l) => l.id))
);
check('(c) carriedFrom still reports A on the second open', opened2.carriedFrom === DAY_A);
check('(c) carriedCount still reports 2 on the second open', opened2.carriedCount === 2);

const dayBRow2 = sqliteDb.prepare(`SELECT rolled_over_at FROM notepad_days WHERE day = ?`).get(DAY_B);
check(
  '(c) fast path taken -- rolled_over_at NOT re-stamped by the second open (still the first call\'s clock value)',
  dayBRow2?.rolled_over_at === '2026-09-24T12:00:00.000Z'
);

// -- opening a virgin day with nothing before it still works -------------------
const opened3 = openNotepadDay('2000-01-01', { now: '2000-01-01T14:00:00.000Z' });
check('(d) virgin day with no prior day -> carriedCount 0', opened3.carriedCount === 0);
check('(d) virgin day with no prior day -> carriedFrom null', opened3.carriedFrom === null);
check('(d) virgin day with no prior day -> no lines', opened3.lines.length === 0);

// -- fix #886(1): a day request that is NOT today is a pure read --------------
// Opening DAY_A ('2026-09-23') again, now, with `now` set to a date that
// does NOT match DAY_A, must not touch it at all: no new carry-forward, no
// rolled_over_at stamp. DAY_A currently has no rolled_over_at (it was never
// opened via openNotepadDay -- only written via putNotepadDay above).
const dayARowBefore = sqliteDb.prepare(`SELECT rolled_over_at FROM notepad_days WHERE day = ?`).get(DAY_A);
check('(e) date-gate precondition: A has no rolled_over_at yet', dayARowBefore?.rolled_over_at == null);
const openedNonToday = openNotepadDay(DAY_A, { now: '2026-09-25T12:00:00.000Z' }); // today != DAY_A
check('(e) non-today open of A returns A\'s own lines untouched', openedNonToday.lines.length === aLines.length);
check('(e) non-today open of A does not report anything carried', openedNonToday.carriedCount === 0 && openedNonToday.carriedFrom === null);
const dayARowAfter = sqliteDb.prepare(`SELECT rolled_over_at FROM notepad_days WHERE day = ?`).get(DAY_A);
check('(e) non-today open of A still has no rolled_over_at stamp (pure read)', dayARowAfter?.rolled_over_at == null);

// -- fix #886(3): the REAL scan path (unscannedLines) resolves lineage too ----
// A carried line whose origin was already marked 'acted' (and whose text is
// unchanged) must not surface as new/unseen material -- that's the whole
// point of carrying lineage forward at all.
const DAY_G = '2026-09-27';
const DAY_H = '2026-09-28';
putNotepadDay(DAY_G, 'Call the vendor about pricing');
const actedLineG = getNotepadDay(DAY_G).lines[0];
markLineActed(actedLineG.id, 'thread:test-789');
const openedH = openNotepadDay(DAY_H, { now: '2026-09-28T12:00:00.000Z' });
check('(f) acted line carried from G to H', openedH.lines.length === 1 && openedH.lines[0].text === 'Call the vendor about pricing');
const carriedActedLine = openedH.lines[0];
check('(f) carried line has a NEW id (not G\'s)', carriedActedLine.id !== actedLineG.id);
const unscannedH = unscannedLines(DAY_H);
check(
  '(f) unscannedLines(H) -- the real scan path -- does NOT report the carried acted line as unseen/new',
  !unscannedH.some((u) => u.line_id === carriedActedLine.id)
);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
