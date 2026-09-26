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
const { getNotepadDay, putNotepadDay, markLineSeen } = await import(path.join(distDir, 'notepad.js'));
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
const opened1 = openNotepadDay(DAY_B, { now: '2026-09-25T12:00:00.000Z' });
check('(a) both lines carried onto B', opened1.lines.length === 2);
check(
  '(a) B lines match A texts, in order',
  JSON.stringify(opened1.lines.map((l) => l.text)) === JSON.stringify(['Call Mike about the invoice', 'Draft the Q3 deck'])
);
check('(a) carriedFrom reports A', opened1.carriedFrom === DAY_A);
check('(a) carriedCount reports 2', opened1.carriedCount === 2);

const dayBRow1 = sqliteDb.prepare(`SELECT rolled_over_at FROM notepad_days WHERE day = ?`).get(DAY_B);
check('(a) rolled_over_at stamped on B by the wiring call', dayBRow1?.rolled_over_at === '2026-09-25T12:00:00.000Z');

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
  dayBRow2?.rolled_over_at === '2026-09-25T12:00:00.000Z'
);

// -- opening a virgin day with nothing before it still works -------------------
const opened3 = openNotepadDay('2000-01-01', { now: '2026-09-25T14:00:00.000Z' });
check('(d) virgin day with no prior day -> carriedCount 0', opened3.carriedCount === 0);
check('(d) virgin day with no prior day -> carriedFrom null', opened3.carriedFrom === null);
check('(d) virgin day with no prior day -> no lines', opened3.lines.length === 0);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
