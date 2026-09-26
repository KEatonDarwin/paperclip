#!/usr/bin/env node
// NOTEPAD LEDGER-KEY CHECK — the regression guard for goal 6 node #106.
//
// The per-line state ledger holds exactly ONE row per origin thought, keyed by
// origin_line_id (docs/notepad/CARRY-FORWARD.md §2.3). Reads resolved through
// that key from node #886 onward; the WRITES did not. A state set on a carried
// line landed under the carried row's own id, where no reader ever looks:
// JARVIS could act on the same thought again the next day, and a thought marked
// done/dismissed on a carried line resurrected every morning forever.
//
// This check fails if either side of that pair regresses. No HTTP, no model
// calls.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-ledger-key-check.db node scripts/notepad-ledger-key-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

console.log(`[notepad-ledger-key-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getNotepadDay, putNotepadDay, getNotepadLineState, markLineActed, markLineDone, unscannedLines } =
  await import(path.join(distDir, 'notepad.js'));
const { openNotepadDay } = await import(path.join(distDir, 'notepad-rollover.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));

let failed = false;
function check(label, ok, detail) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed = true;
  }
}

const rowsForOrigin = sqliteDb.prepare(
  `SELECT s.line_id AS line_id, s.state AS state
     FROM notepad_line_state s
    WHERE s.line_id IN (SELECT id FROM notepad_lines WHERE id = ? OR origin_line_id = CAST(? AS TEXT))`
);

const DAY1 = '2026-09-20';
const DAY2 = '2026-09-21';
const DAY3 = '2026-09-22';

// day 1: two thoughts, typed fresh (day zero — no lineage).
putNotepadDay(DAY1, ['Call Mike about the invoice', 'Draft the Q3 deck'].join('\n'));
const [invoiceD1, deckD1] = getNotepadDay(DAY1).lines;

// day 2 opens: both carry forward, each with a NEW row id and origin_line_id
// pointing back at day 1.
const opened2 = openNotepadDay(DAY2, { now: '2026-09-21T09:00:00.000Z' });
const invoiceD2 = opened2.lines.find((l) => l.text === 'Call Mike about the invoice');
const deckD2 = opened2.lines.find((l) => l.text === 'Draft the Q3 deck');
check('setup: both thoughts carried to day2 with new ids', invoiceD2.id !== invoiceD1.id && deckD2.id !== deckD1.id);

// ── 1. a write on a CARRIED line is visible to the readers ─────────────────
markLineActed(invoiceD2.id, 'thread:cockpit:notepad-line-invoice');
const readBack = getNotepadLineState(invoiceD2.id);
check(
  'WRITE VISIBLE: acting on a carried line is readable through getNotepadLineState',
  readBack?.state === 'acted' && readBack?.action_ref === 'thread:cockpit:notepad-line-invoice',
  `got state=${readBack?.state ?? 'null'} action_ref=${readBack?.action_ref ?? 'null'}`
);

// ── 2. exactly ONE ledger row for the thought, under the origin id ─────────
{
  const rows = rowsForOrigin.all(invoiceD1.id, invoiceD1.id);
  check(
    'ONE ROW PER THOUGHT: the write landed on the origin id, not a second row',
    rows.length === 1 && rows[0].line_id === invoiceD1.id,
    `rows=${JSON.stringify(rows)} origin=${invoiceD1.id}`
  );
}

// ── 3. an acted thought is not re-offered to the scanner ───────────────────
{
  const ids = unscannedLines(DAY2).map((l) => l.line_id);
  check(
    'NO DOUBLE-ACT: an acted carried line whose text is unchanged is not re-offered',
    !ids.includes(invoiceD2.id),
    `unscanned=${JSON.stringify(ids)} carried=${invoiceD2.id}`
  );
}

// ── 4. closing a CARRIED line actually closes the thought ──────────────────
markLineDone(deckD2.id, 'test:deck-finished');
const opened3 = openNotepadDay(DAY3, { now: '2026-09-22T09:00:00.000Z' });
const day3Texts = opened3.lines.map((l) => l.text);
check(
  'STAYS CLOSED: a thought marked done on a carried line does not roll into day3',
  !day3Texts.includes('Draft the Q3 deck'),
  `day3=${JSON.stringify(day3Texts)}`
);
check(
  'STILL CARRIES: the open thought does roll into day3',
  day3Texts.includes('Call Mike about the invoice'),
  `day3=${JSON.stringify(day3Texts)}`
);

// ── 5. a day-zero line (no lineage) is untouched by the resolution ─────────
{
  putNotepadDay(DAY3, [...day3Texts, 'Brand new thought today'].join('\n'));
  const fresh = getNotepadDay(DAY3).lines.find((l) => l.text === 'Brand new thought today');
  markLineActed(fresh.id, 'thread:cockpit:notepad-line-fresh');
  const st = getNotepadLineState(fresh.id);
  check('DAY-ZERO UNCHANGED: a never-carried line still keys on its own id', st?.state === 'acted');
}

console.log(failed ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
