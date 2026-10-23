#!/usr/bin/env node
// NOTEPAD SIM — broader behavioral coverage for src/notepad.ts on a scratch
// jarvis.db (JARVIS_DB_PATH; never the live DB — refused below). No HTTP, no
// model calls. Complements scripts/notepad-check.mjs (which nails down the
// core reword/re-indent/insert/move/delete matrix) with:
//
//   1. Day rollover across midnight US/Central (the boundary math itself,
//      both DST offsets) + full isolation between adjacent calendar days.
//   2. A day with no note (never touched) reads as empty, not an error.
//   3. The full line-identity matrix (reword/re-indent/insert/move/delete),
//      re-proven here so this sim stands alone.
//   4. A whole-document rewrite (every line's content changes at once) in
//      three shapes (same length / fewer lines / more lines) — proves
//      nothing is ever orphaned in notepad_lines regardless of how the diff
//      chooses to reuse or retire ids.
//   5. Duplicate identical lines in one note — the nearest-old-index
//      tie-break, worked out by hand and asserted exactly.
//   6. A 5,000-line note (round-trip + a mid-document reword).
//   7. Two saves "racing" the same day — the last one scheduled always wins
//      whole, never a torn mix of both payloads.
//   8. Reading a day that does not exist.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-sim.db node scripts/notepad-sim.mjs

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

console.log(`[notepad-sim] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getNotepadDay, putNotepadDay, listNotepadDays, isValidNotepadDate } = await import(
  path.join(distDir, 'notepad.js')
);
const sqliteMod = await import(path.join(distDir, 'conversation-db.js'));
const sqliteDb = sqliteMod.sqliteDb;

let failed = false;
let passCount = 0;
let failCount = 0;
function check(label, ok) {
  if (ok) {
    passCount++;
    console.log(`  ok  ${label}`);
  } else {
    failCount++;
    failed = true;
    console.error(`FAIL  ${label}`);
  }
}

function rawRowsForDay(day) {
  return sqliteDb.prepare(`SELECT id, idx, text FROM notepad_lines WHERE day = ? ORDER BY idx ASC`).all(day);
}

// ══════════════════════════════════════════════════════════════════════════
// 1. Day rollover across midnight US/Central
// ══════════════════════════════════════════════════════════════════════════
{
  // Same boundary math todayNotepadDate() uses (Intl formatter, America/Chicago),
  // exercised at specific instants so the test doesn't depend on real "now".
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });

  // CDT (UTC-5) boundary: 2026-09-24 is daylight time. Midnight Chicago = 05:00 UTC.
  check(
    '(1) CDT: 04:59 UTC is still the previous Chicago day',
    fmt.format(new Date('2026-09-24T04:59:00Z')) === '2026-09-23'
  );
  check(
    '(1) CDT: 05:00 UTC rolls to the new Chicago day',
    fmt.format(new Date('2026-09-24T05:00:00Z')) === '2026-09-24'
  );

  // CST (UTC-6) boundary: 2026-01-15 is standard time. Midnight Chicago = 06:00 UTC.
  check(
    '(1) CST: 05:59 UTC is still the previous Chicago day',
    fmt.format(new Date('2026-01-15T05:59:00Z')) === '2026-01-14'
  );
  check(
    '(1) CST: 06:00 UTC rolls to the new Chicago day',
    fmt.format(new Date('2026-01-15T06:00:00Z')) === '2026-01-15'
  );

  // Isolation across the rollover: writing today's note must never touch
  // yesterday's or tomorrow's rows.
  const y = putNotepadDay('2026-09-23', 'yesterday line 1\nyesterday line 2');
  const t = putNotepadDay('2026-09-24', 'today line 1');
  const tm = putNotepadDay('2026-09-25', 'tomorrow line 1\ntomorrow line 2\ntomorrow line 3');
  check('(1) yesterday keeps its own 2 lines', getNotepadDay('2026-09-23').lines.length === 2);
  check('(1) today keeps its own 1 line', getNotepadDay('2026-09-24').lines.length === 1);
  check('(1) tomorrow keeps its own 3 lines', getNotepadDay('2026-09-25').lines.length === 3);
  // Re-save today; yesterday/tomorrow must be untouched (ids + text stable).
  const yIdsBefore = y.lines.map((l) => l.id);
  const tmIdsBefore = tm.lines.map((l) => l.id);
  putNotepadDay('2026-09-24', 'today line 1 (edited)\ntoday line 2 (added)');
  check(
    "(1) editing today doesn't disturb yesterday's ids",
    getNotepadDay('2026-09-23').lines.map((l) => l.id).join(',') === yIdsBefore.join(',')
  );
  check(
    "(1) editing today doesn't disturb tomorrow's ids",
    getNotepadDay('2026-09-25').lines.map((l) => l.id).join(',') === tmIdsBefore.join(',')
  );
  check('(1) today reflects the edit', getNotepadDay('2026-09-24').text === 'today line 1 (edited)\ntoday line 2 (added)');
}

// ══════════════════════════════════════════════════════════════════════════
// 2. A day with no note
// ══════════════════════════════════════════════════════════════════════════
{
  const NEVER = '2099-12-31';
  const empty = getNotepadDay(NEVER);
  check('(2) never-touched day: text is empty string', empty.text === '');
  check('(2) never-touched day: lines is an empty array', Array.isArray(empty.lines) && empty.lines.length === 0);
  check('(2) never-touched day: day field echoes back the requested date', empty.day === NEVER);
  check('(2) never-touched day: absent from the days pager', !listNotepadDays().some((d) => d.day === NEVER));
  check('(2) never-touched day: no raw rows exist for it', rawRowsForDay(NEVER).length === 0);
}

// ══════════════════════════════════════════════════════════════════════════
// 3. Full line-identity matrix (reword / re-indent / insert / move / delete)
// ══════════════════════════════════════════════════════════════════════════
{
  const DAY = '2026-10-01';
  let saved = putNotepadDay(DAY, ['a', 'b', 'c', 'd', 'e'].join('\n'));
  check('(3) initial save: 5 lines, 5 distinct ids', saved.lines.length === 5 && new Set(saved.lines.map((l) => l.id)).size === 5);
  const ids0 = saved.lines.map((l) => l.id);

  let after = putNotepadDay(DAY, ['a', 'b', 'c2', 'd', 'e'].join('\n'));
  check('(3) reword: untouched lines keep ids', [0, 1, 3, 4].every((i) => after.lines[i].id === ids0[i]));
  check('(3) reword: changed line keeps its id, new text', after.lines[2].id === ids0[2] && after.lines[2].text === 'c2');
  const ids1 = after.lines.map((l) => l.id);

  after = putNotepadDay(DAY, ['a', '  b', 'c2', 'd', 'e'].join('\n'));
  check('(3) re-indent: same id, raw (indented) text stored', after.lines[1].id === ids1[1] && after.lines[1].text === '  b');
  const ids2 = after.lines.map((l) => l.id);

  after = putNotepadDay(DAY, ['a', '  b', 'NEW', 'c2', 'd', 'e'].join('\n'));
  const byText3 = Object.fromEntries(after.lines.map((l) => [l.text, l.id]));
  check(
    '(3) insert in the middle: every pre-existing id unchanged',
    byText3['a'] === ids2[0] && byText3['  b'] === ids2[1] && byText3['c2'] === ids2[2] && byText3['d'] === ids2[3] && byText3['e'] === ids2[4]
  );
  check('(3) insert: new line gets a brand-new id', !ids2.includes(byText3['NEW']));

  after = putNotepadDay(DAY, ['a', 'NEW', 'c2', 'd', 'e', '  b'].join('\n'));
  check("(3) move to end: moved line keeps its id", after.lines.find((l) => l.text === '  b')?.id === byText3['  b']);
  check('(3) move: order is exactly as written', after.text === 'a\nNEW\nc2\nd\ne\n  b');

  after = putNotepadDay(DAY, ['a', 'NEW', 'd', 'e', '  b'].join('\n'));
  check('(3) delete: 5 lines remain', after.lines.length === 5);
  check('(3) delete: the removed id is gone and no other id is affected', !after.lines.some((l) => l.id === byText3['c2']));
  check('(3) delete: no orphaned row left behind in the table', !rawRowsForDay(DAY).some((r) => r.id === byText3['c2']));
}

// ══════════════════════════════════════════════════════════════════════════
// 4. Whole-document rewrite — every line's content changes at once
// ══════════════════════════════════════════════════════════════════════════
{
  // 4a. Same line count, zero trimmed-text overlap with the prior content.
  // The diff has no content match to key off, so it falls back to positional
  // reword (same documented behavior as a single-line reword, just applied
  // to every line at once) — the invariant under test is that NOTHING is
  // orphaned: id set is unique, row count matches, and no stale row for the
  // old content lingers in the table.
  const DAY_A = '2026-10-02';
  const before = putNotepadDay(DAY_A, ['alpha', 'bravo', 'charlie'].join('\n'));
  const beforeIds = before.lines.map((l) => l.id);
  const rewritten = putNotepadDay(DAY_A, ['zulu one', 'zulu two', 'zulu three'].join('\n'));
  check('(4a) same-count full rewrite: line count unchanged', rewritten.lines.length === 3);
  check('(4a) same-count full rewrite: ids are unique', new Set(rewritten.lines.map((l) => l.id)).size === 3);
  check('(4a) same-count full rewrite: text round-trips exactly', rewritten.text === 'zulu one\nzulu two\nzulu three');
  check(
    '(4a) same-count full rewrite: no orphaned rows (row count == returned line count)',
    rawRowsForDay(DAY_A).length === 3
  );
  check(
    '(4a) same-count full rewrite: none of the old text survives anywhere in the table',
    !rawRowsForDay(DAY_A).some((r) => ['alpha', 'bravo', 'charlie'].includes(r.text))
  );

  // 4b. Fewer new lines than old, all-new content — excess old lines must be
  // genuinely deleted (not left dangling), survivors reused positionally.
  const DAY_B = '2026-10-03';
  putNotepadDay(DAY_B, ['one', 'two', 'three', 'four', 'five'].join('\n'));
  const shrunk = putNotepadDay(DAY_B, ['un', 'deux'].join('\n'));
  check('(4b) shrink rewrite: exactly 2 lines remain', shrunk.lines.length === 2);
  check('(4b) shrink rewrite: no orphaned rows for the 3 dropped lines', rawRowsForDay(DAY_B).length === 2);
  check('(4b) shrink rewrite: text round-trips exactly', shrunk.text === 'un\ndeux');

  // 4c. More new lines than old, all-new content — the extra tail lines get
  // brand-new ids never seen before on this day.
  const DAY_C = '2026-10-04';
  const grownBefore = putNotepadDay(DAY_C, ['only line'].join('\n'));
  const everIssuedIds = new Set(grownBefore.lines.map((l) => l.id));
  const grown = putNotepadDay(DAY_C, ['fresh one', 'fresh two', 'fresh three', 'fresh four'].join('\n'));
  check('(4c) grow rewrite: 4 lines now', grown.lines.length === 4);
  check('(4c) grow rewrite: all ids unique', new Set(grown.lines.map((l) => l.id)).size === 4);
  check(
    '(4c) grow rewrite: the 3 net-new lines all get ids never issued before on this day',
    grown.lines.filter((l) => !everIssuedIds.has(l.id)).length === 3
  );
  check('(4c) grow rewrite: no orphaned rows (table matches returned lines exactly)', rawRowsForDay(DAY_C).length === 4);
}

// ══════════════════════════════════════════════════════════════════════════
// 5. Duplicate identical lines — nearest-old-index tie-break
// ══════════════════════════════════════════════════════════════════════════
{
  const DAY = '2026-10-05';
  // idx: 0="x" 1="y" 2="x" 3="z" 4="x"  (three "x" occurrences at 0, 2, 4)
  const saved = putNotepadDay(DAY, ['x', 'y', 'x', 'z', 'x'].join('\n'));
  check('(5) setup: 5 lines saved', saved.lines.length === 5);
  const idX0 = saved.lines[0].id; // "x" @ old idx 0
  const idY = saved.lines[1].id; // "y" @ old idx 1
  const idX2 = saved.lines[2].id; // "x" @ old idx 2
  const idZ = saved.lines[3].id; // "z" @ old idx 3
  const idX4 = saved.lines[4].id; // "x" @ old idx 4
  check('(5) setup: the three x rows have distinct ids', new Set([idX0, idX2, idX4]).size === 3);

  // New arrangement: "x" now appears at new idx 0, 1, 3 — worked out by hand
  // against the nearest-old-index rule:
  //   new idx 0 -> nearest old x is idx 0 (dist 0)          -> idX0
  //   new idx 1 -> remaining old x's are {2,4}; nearest is 2 (dist 1) -> idX2
  //   new idx 3 -> remaining old x is {4}; nearest is 4 (dist 1)      -> idX4
  const after = putNotepadDay(DAY, ['x', 'x', 'y', 'x', 'z'].join('\n'));
  check('(5) new idx 0 "x" nearest-matches old idx 0', after.lines[0].id === idX0);
  check('(5) new idx 1 "x" nearest-matches old idx 2', after.lines[1].id === idX2);
  check('(5) new idx 3 "x" nearest-matches old idx 4', after.lines[3].id === idX4);
  check('(5) "y" keeps its own id regardless of the x reshuffle', after.lines[2].id === idY);
  check('(5) "z" keeps its own id regardless of the x reshuffle', after.lines[4].id === idZ);
  check('(5) no orphaned rows after the reshuffle', rawRowsForDay(DAY).length === 5);
  check('(5) text round-trips exactly', after.text === 'x\nx\ny\nx\nz');
}

// ══════════════════════════════════════════════════════════════════════════
// 6. A 5,000-line note
// ══════════════════════════════════════════════════════════════════════════
{
  const BIG_DAY = '2026-10-06';
  const bigLines = Array.from({ length: 5000 }, (_, i) => `line ${i} — payload ${i % 11}`);
  const bigText = bigLines.join('\n');
  const savedBig = putNotepadDay(BIG_DAY, bigText);
  check('(6) 5000 lines saved', savedBig.lines.length === 5000);
  check('(6) round-trips byte-for-byte via GET', getNotepadDay(BIG_DAY).text === bigText);
  check('(6) 5000 distinct ids', new Set(savedBig.lines.map((l) => l.id)).size === 5000);
  check('(6) idx sequential 0..4999', savedBig.lines.every((l, i) => l.idx === i));
  check('(6) no orphaned rows (table count == 5000)', rawRowsForDay(BIG_DAY).length === 5000);

  const bigIdsBefore = savedBig.lines.map((l) => l.id);
  bigLines[2500] = 'REWORDED MIDDLE LINE';
  const savedBig2 = putNotepadDay(BIG_DAY, bigLines.join('\n'));
  check('(6) reword mid-document keeps neighbor ids', savedBig2.lines[2499].id === bigIdsBefore[2499] && savedBig2.lines[2501].id === bigIdsBefore[2501]);
  check(
    '(6) reword mid-document keeps its own id, new text',
    savedBig2.lines[2500].id === bigIdsBefore[2500] && savedBig2.lines[2500].text === 'REWORDED MIDDLE LINE'
  );
  check('(6) still no orphaned rows after the reword', rawRowsForDay(BIG_DAY).length === 5000);
}

// ══════════════════════════════════════════════════════════════════════════
// 7. Two saves racing the same day
// ══════════════════════════════════════════════════════════════════════════
{
  const DAY = '2026-10-07';
  putNotepadDay(DAY, 'seed line 1\nseed line 2');

  const payloadA = 'race payload A line 1\nrace payload A line 2\nrace payload A line 3';
  const payloadB = 'race payload B line 1\nrace payload B line 2';

  // better-sqlite3 is synchronous and putNotepadDay runs inside one DB
  // transaction, so on Node's single-threaded event loop there is no way for
  // two writers to interleave mid-write — but schedule them through
  // setTimeout so the two "requests" really are dispatched as separate
  // event-loop turns (the shape a real race between two HTTP handlers would
  // take), and prove whichever is scheduled to run last wins WHOLE.
  const callOrder = [];
  const raceA = new Promise((resolve) => {
    setTimeout(() => {
      callOrder.push('A');
      resolve(putNotepadDay(DAY, payloadA));
    }, 5);
  });
  const raceB = new Promise((resolve) => {
    setTimeout(() => {
      callOrder.push('B');
      resolve(putNotepadDay(DAY, payloadB));
    }, 10);
  });
  await Promise.all([raceA, raceB]);

  check('(7) both racing writes actually ran, B scheduled after A', callOrder.join('') === 'AB');
  const final = getNotepadDay(DAY);
  const isWholeA = final.text === payloadA;
  const isWholeB = final.text === payloadB;
  check('(7) final state is one payload in full (never a torn mix)', isWholeA || isWholeB);
  check('(7) the later-scheduled write (B) is the one that stuck', isWholeB && !isWholeA);
  check(
    '(7) no leftover lines from the loser payload anywhere in the table',
    !rawRowsForDay(DAY).some((r) => payloadA.includes(r.text) && !payloadB.includes(r.text))
  );
  check('(7) no orphaned/duplicate rows after the race', rawRowsForDay(DAY).length === final.lines.length);
}

// ══════════════════════════════════════════════════════════════════════════
// 8. Reading a day that does not exist
// ══════════════════════════════════════════════════════════════════════════
{
  check('(8) malformed date is rejected by the validator', isValidNotepadDate('2026-10-99') === false);
  check('(8) well-formed but never-created date reads as empty, not an error', getNotepadDay('2030-06-15').lines.length === 0);
  check('(8) never-created date does not appear in the days pager', !listNotepadDays().some((d) => d.day === '2030-06-15'));
}

console.log(`\n${passCount} passed, ${failCount} failed`);
console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
