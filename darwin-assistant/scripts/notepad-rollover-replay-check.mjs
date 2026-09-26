#!/usr/bin/env node
// NOTEPAD ROLLOVER REPLAY CHECK — replays THREE CONSECUTIVE DAYS through the
// REAL day-open path (openNotepadDay() in src/notepad-rollover.ts, node
// #882), not carryForwardInto() directly (see notepad-rollover-check.mjs for
// the single-hop engine check, and notepad-rollover-wire-check.mjs for the
// two-day wiring check). No HTTP, no model calls. Proves, across day1 ->
// day2 -> day3:
//
//   - day2 opens and carries all 5 of day1's lines, in original order.
//   - on day2, 2 lines get closed (1 done, 1 dismissed -- node #886: 'acted'
//     alone does NOT close a line) and 2 new lines are added; day3 opens and
//     carries exactly 3 + 2 = 5 lines, the 2 closed ones are gone, and the 3
//     survivors still carry origin_day = day1 (a TWO-HOP lineage walk, not
//     one).
//   - NO DUPLICATES: origin_line_id is unique per day, on every day.
//   - NO OPEN LINE LOST: the set of open thought-identities on day N-1 is
//     EXACTLY the set present on day N (a set comparison, not just a count).
//   - IDEMPOTENCE: opening day3 a 2nd and 3rd time is byte-identical (same
//     ids, same order) to the first open.
//   - GAP DAY: a day opened four days after the last day with content still
//     finds it as the source (the chain follows the last day that exists,
//     not calendar-yesterday).
//   - EDGE: an empty previous day, and a previous day where everything is
//     closed, both carry nothing and do not throw.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-rollover-replay-check.db node scripts/notepad-rollover-replay-check.mjs

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

console.log(`[notepad-rollover-replay-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getNotepadDay, putNotepadDay, markLineDismissed, markLineDone } = await import(path.join(distDir, 'notepad.js'));
const { openNotepadDay } = await import(path.join(distDir, 'notepad-rollover.js'));
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

function setDiffDetail(expected, actual) {
  const missing = [...expected].filter((x) => !actual.has(x));
  const extra = [...actual].filter((x) => !expected.has(x));
  return `expected=[${[...expected].join(',')}] actual=[${[...actual].join(',')}] missing=[${missing.join(',')}] extra=[${extra.join(',')}]`;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

const rawLinesStmt = sqliteDb.prepare(
  `SELECT id, text, origin_line_id, origin_day, carried_from_line_id, carried_at
   FROM notepad_lines WHERE day = ? ORDER BY idx ASC, id ASC`
);

function rawLines(day) {
  return rawLinesStmt.all(day);
}

const stateStmt = sqliteDb.prepare(`SELECT state FROM notepad_line_state WHERE line_id = ?`);
function stateOf(lineId) {
  return stateStmt.get(lineId)?.state ?? null;
}

/**
 * The "open thought identity" of a line: its origin_line_id if it has one
 * (a carried line), else its own id (a line that has never been carried —
 * exactly the fallback carryForwardInto itself uses when it later carries
 * this line forward). Only lines that are still open (no state row, 'seen',
 * or 'acted' — node #886: acting on a line does not mean it's done) count —
 * 'dismissed'/'done' lines are closed.
 */
function openIdentitySet(day) {
  const out = new Set();
  for (const l of rawLines(day)) {
    const st = stateOf(l.id);
    if (st === 'dismissed' || st === 'done') continue;
    out.add(l.origin_line_id ?? String(l.id));
  }
  return out;
}

function noDuplicateOriginIds(day) {
  const seen = new Map();
  const dupes = [];
  for (const l of rawLines(day)) {
    if (l.origin_line_id == null) continue;
    if (seen.has(l.origin_line_id)) dupes.push(l.origin_line_id);
    seen.set(l.origin_line_id, (seen.get(l.origin_line_id) ?? 0) + 1);
  }
  return { ok: dupes.length === 0, dupes };
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN CHAIN: day1 -> day2 -> day3
// ══════════════════════════════════════════════════════════════════════════

const DAY1 = '2026-09-20';
const DAY2 = '2026-09-21';
const DAY3 = '2026-09-22';

const DAY1_TEXTS = [
  'Call Mike about the invoice',
  'Draft the Q3 deck',
  'Follow up with Ian',
  'Review the budget doc',
  'Ping legal about the contract',
];

// -- day 1: write 5 lines, never opened via openNotepadDay (it's day zero —
//    written directly through the day, same as the real notepad all day) --
putNotepadDay(DAY1, DAY1_TEXTS.join('\n'));
const day1Lines = getNotepadDay(DAY1).lines;
check('day1: 5 lines written', day1Lines.length === 5);

const day1OpenSet = openIdentitySet(DAY1);
check('day1: all 5 lines are open (none acted/dismissed yet)', day1OpenSet.size === 5);

// -- day 2 opens: carries all 5 of day1's lines, in original order ----------
// `now`'s calendar date must equal the day being opened (node #886 gates
// carry-forward on the requested day being "today"; an injected `now`
// stands in for today deterministically -- see isOpeningToday in
// notepad-rollover.ts).
const opened2a = openNotepadDay(DAY2, { now: '2026-09-21T09:00:00.000Z' });
check('day2 open: 5 lines carried', opened2a.lines.length === 5);
check(
  'day2 open: lines match day1 texts, in original order',
  JSON.stringify(opened2a.lines.map((l) => l.text)) === JSON.stringify(DAY1_TEXTS),
  JSON.stringify(opened2a.lines.map((l) => l.text))
);
check('day2 open: carriedFrom reports day1', opened2a.carriedFrom === DAY1);
check('day2 open: carriedCount reports 5', opened2a.carriedCount === 5);

const day2RawAfterFirstOpen = rawLines(DAY2);
check(
  'day2 open: every carried line has origin_day = day1',
  day2RawAfterFirstOpen.every((r) => r.origin_day === DAY1)
);
check(
  'day2 open: every carried line has origin_line_id pointing at a day1 line id',
  day2RawAfterFirstOpen.every((r) => day1Lines.some((d1) => String(d1.id) === r.origin_line_id))
);

// NO OPEN LINE LOST (day1 -> day2): the set of open identities on day1 must
// be EXACTLY the set present on day2, right after the carry (before any
// further edits on day2).
{
  const day2OpenSet = openIdentitySet(DAY2);
  check(
    'NO OPEN LINE LOST (day1 -> day2): open identity set matches exactly',
    setsEqual(day1OpenSet, day2OpenSet),
    setDiffDetail(day1OpenSet, day2OpenSet)
  );
}

// NO DUPLICATES: origin_line_id unique per day, checked after each day's
// state settles (also re-checked at the end for all three days).
{
  const dupCheck = noDuplicateOriginIds(DAY2);
  check('NO DUPLICATES (day2, after first open): origin_line_id unique', dupCheck.ok, `dupes=${dupCheck.dupes.join(',')}`);
}

// -- on day2: close 2 of the carried lines, add 2 new ones -------------------
// Closed (node #886) means 'dismissed' or 'done' -- 'acted' alone would NOT
// close a line (it still carries forward), so both lines here use a truly
// closed state to keep this chain's "2 finished lines are gone" property.
const q3DeckLine = opened2a.lines.find((l) => l.text === 'Draft the Q3 deck');
const legalLine = opened2a.lines.find((l) => l.text === 'Ping legal about the contract');
markLineDone(q3DeckLine.id, 'test:done:q3-deck-drafted');
markLineDismissed(legalLine.id, 'legal already looped in elsewhere');

const NEW_DAY2_TEXTS = ['Email the vendor', 'Check on the server migration'];
const day2FullText = [...opened2a.lines.map((l) => l.text), ...NEW_DAY2_TEXTS].join('\n');
putNotepadDay(DAY2, day2FullText);
const day2LinesAfterEdit = getNotepadDay(DAY2).lines;
check('day2 edit: now has 7 lines (5 carried + 2 new)', day2LinesAfterEdit.length === 7);
check(
  'day2 edit: the 5 originally-carried lines kept their ids (unchanged text)',
  opened2a.lines.every((l) => day2LinesAfterEdit.some((d) => d.id === l.id && d.text === l.text))
);

const day2SurvivorTexts = ['Call Mike about the invoice', 'Follow up with Ian', 'Review the budget doc'];
const day2OpenIdentitySetBeforeDay3 = openIdentitySet(DAY2);
check(
  'day2 pre-day3: exactly 5 open identities (3 survivors + 2 new)',
  day2OpenIdentitySetBeforeDay3.size === 5,
  `size=${day2OpenIdentitySetBeforeDay3.size}`
);

// -- day 3 opens: carries exactly 3 + 2 = 5 lines -----------------------------
const opened3a = openNotepadDay(DAY3, { now: '2026-09-22T09:00:00.000Z' });
check('day3 open: exactly 3 + 2 = 5 lines', opened3a.lines.length === 5, `got ${opened3a.lines.length}`);
check('day3 open: carriedFrom reports day2', opened3a.carriedFrom === DAY2);
check('day3 open: carriedCount reports 5', opened3a.carriedCount === 5);

const day3Texts = opened3a.lines.map((l) => l.text);
check(
  'day3 open: the 2 finished lines are NOT present',
  !day3Texts.includes('Draft the Q3 deck') && !day3Texts.includes('Ping legal about the contract'),
  day3Texts.join(' | ')
);
check(
  'day3 open: the 3 survivors and 2 new day2 lines are all present',
  [...day2SurvivorTexts, ...NEW_DAY2_TEXTS].every((t) => day3Texts.includes(t)),
  day3Texts.join(' | ')
);

const day3RawAfterFirstOpen = rawLines(DAY3);
const survivorRowsOnDay3 = day3RawAfterFirstOpen.filter((r) => day2SurvivorTexts.includes(r.text));
check('day3 open: found all 3 survivor rows', survivorRowsOnDay3.length === 3);
check(
  'TWO-HOP LINEAGE: the 3 survivors still carry origin_day = day1 (not day2)',
  survivorRowsOnDay3.every((r) => r.origin_day === DAY1),
  survivorRowsOnDay3.map((r) => `${r.text}:origin_day=${r.origin_day}`).join(', ')
);
check(
  'TWO-HOP LINEAGE: the 3 survivors\' origin_line_id still points at their day1 incarnation, not their day2 one',
  survivorRowsOnDay3.every((r) => day1Lines.some((d1) => String(d1.id) === r.origin_line_id)),
  survivorRowsOnDay3.map((r) => `${r.text}:origin_line_id=${r.origin_line_id}`).join(', ')
);
check(
  'day3 open: the 2 brand-new day2 lines carry origin_day = day2 (one hop only, correctly)',
  day3RawAfterFirstOpen.filter((r) => NEW_DAY2_TEXTS.includes(r.text)).every((r) => r.origin_day === DAY2)
);

// NO OPEN LINE LOST (day2 -> day3)
{
  const day3OpenSet = openIdentitySet(DAY3);
  check(
    'NO OPEN LINE LOST (day2 -> day3): open identity set matches exactly',
    setsEqual(day2OpenIdentitySetBeforeDay3, day3OpenSet),
    setDiffDetail(day2OpenIdentitySetBeforeDay3, day3OpenSet)
  );
}

// NO DUPLICATES: re-check all three days now that the chain has settled.
for (const day of [DAY1, DAY2, DAY3]) {
  const dupCheck = noDuplicateOriginIds(day);
  check(`NO DUPLICATES (${day}, final): origin_line_id unique`, dupCheck.ok, `dupes=${dupCheck.dupes.join(',')}`);
}

// -- IDEMPOTENCE: open day3 a 2nd and 3rd time --------------------------------
const opened3b = openNotepadDay(DAY3, { now: '2026-09-24T10:00:00.000Z' });
const opened3c = openNotepadDay(DAY3, { now: '2026-09-24T11:00:00.000Z' });

for (const [label, opened] of [['2nd open', opened3b], ['3rd open', opened3c]]) {
  check(`IDEMPOTENCE: day3 ${label} has the same line count`, opened.lines.length === opened3a.lines.length);
  check(
    `IDEMPOTENCE: day3 ${label} has byte-identical ids, in the same order`,
    JSON.stringify(opened.lines.map((l) => l.id)) === JSON.stringify(opened3a.lines.map((l) => l.id)),
    `first=${JSON.stringify(opened3a.lines.map((l) => l.id))} ${label}=${JSON.stringify(opened.lines.map((l) => l.id))}`
  );
  check(
    `IDEMPOTENCE: day3 ${label} has byte-identical texts, in the same order`,
    JSON.stringify(opened.lines.map((l) => l.text)) === JSON.stringify(opened3a.lines.map((l) => l.text))
  );
  check(`IDEMPOTENCE: day3 ${label} still reports carriedFrom = day2`, opened.carriedFrom === DAY2);
  check(`IDEMPOTENCE: day3 ${label} still reports carriedCount = 5`, opened.carriedCount === 5);
}

const day3RowFinal = sqliteDb.prepare(`SELECT rolled_over_at FROM notepad_days WHERE day = ?`).get(DAY3);
check(
  'IDEMPOTENCE: rolled_over_at NOT re-stamped by the 2nd/3rd open (fast path taken)',
  day3RowFinal?.rolled_over_at === '2026-09-22T09:00:00.000Z',
  `got ${day3RowFinal?.rolled_over_at}`
);

// ══════════════════════════════════════════════════════════════════════════
// GAP DAY: source resolves across days with NOTHING in between
// ══════════════════════════════════════════════════════════════════════════
{
  const GAP_DAY1 = '2026-10-01';
  const GAP_TARGET = '2026-10-05'; // 4 days later; 10-02/10-03/10-04 never touched at all
  putNotepadDay(GAP_DAY1, 'A thought that sits alone for four days');
  const openedGap = openNotepadDay(GAP_TARGET, { now: '2026-10-05T08:00:00.000Z' });
  check('GAP DAY: carriedFrom resolves across the empty gap to the last day WITH lines', openedGap.carriedFrom === GAP_DAY1, `got ${openedGap.carriedFrom}`);
  check('GAP DAY: carriedCount is 1', openedGap.carriedCount === 1);
  check('GAP DAY: the line itself carried across', openedGap.lines.length === 1 && openedGap.lines[0].text === 'A thought that sits alone for four days');
}

// ══════════════════════════════════════════════════════════════════════════
// EDGE CASES: empty previous day / fully-closed previous day
// ══════════════════════════════════════════════════════════════════════════
{
  // Dates deliberately far before every other day used in this script (all
  // 2026+) so there is truly NOTHING with lines anywhere before EMPTY_DAY —
  // otherwise the source-day search would correctly walk past the empty day
  // and find some other, earlier day's content (as it should), which would
  // make this assert the wrong thing.
  const EMPTY_DAY = '1990-01-01';
  const EMPTY_TARGET = '1990-01-02';
  putNotepadDay(EMPTY_DAY, ''); // a day row that exists but has zero lines
  let threw = false;
  let openedEmpty;
  try {
    openedEmpty = openNotepadDay(EMPTY_TARGET, { now: '1990-01-02T08:00:00.000Z' });
  } catch {
    threw = true;
  }
  check('EDGE (empty previous day): does not throw', !threw);
  check('EDGE (empty previous day): carries nothing', !threw && openedEmpty.lines.length === 0 && openedEmpty.carriedCount === 0);
  check('EDGE (empty previous day): carriedFrom is null', !threw && openedEmpty.carriedFrom === null);
}

{
  // Under the #886 acted-vs-done contract, 'acted' is OPEN (it carries) --
  // only 'dismissed' and 'done' are CLOSED. So "everything closed on the
  // previous day" must use those two states, not acted+dismissed.
  const ALLDONE_DAY = '2026-10-15';
  const ALLDONE_TARGET = '2026-10-16';
  putNotepadDay(ALLDONE_DAY, ['Task A', 'Task B'].join('\n'));
  const allDoneLines = getNotepadDay(ALLDONE_DAY).lines;
  markLineDismissed(allDoneLines[0].id, 'no longer needed');
  markLineDone(allDoneLines[1].id, 'finished for real');

  let threw = false;
  let openedAllDone;
  try {
    openedAllDone = openNotepadDay(ALLDONE_TARGET, { now: '2026-10-16T08:00:00.000Z' });
  } catch {
    threw = true;
  }
  check('EDGE (everything closed on previous day): does not throw', !threw);
  check(
    'EDGE (everything closed on previous day): produces an empty new day',
    !threw && openedAllDone.lines.length === 0 && openedAllDone.carriedCount === 0
  );
  check('EDGE (everything closed on previous day): carriedFrom is null (nothing actually carried)', !threw && openedAllDone.carriedFrom === null);
}

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
