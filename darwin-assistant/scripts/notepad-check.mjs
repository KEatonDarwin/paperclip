#!/usr/bin/env node
// NOTEPAD CHECK — exercises the line-identity-preserving diff in
// src/notepad.ts (getNotepadDay/putNotepadDay) directly against a scratch
// jarvis.db. No HTTP, no model calls. Proves:
//
//   (a) reword one line -> every OTHER line keeps its id; the reworded line
//       itself is updated in place (same id, new text) rather than
//       delete+insert.
//   (b) re-indent a line (leading whitespace only) -> same id.
//   (c) insert a line in the middle -> every pre-existing id unchanged.
//   (d) move a line to the end -> same id.
//   (e) delete a line -> only that id disappears; everything else unchanged.
//   (f) a 5,000-line note saves and round-trips byte-for-byte.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-check.db node scripts/notepad-check.mjs

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

console.log(`[notepad-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getNotepadDay, putNotepadDay, listNotepadDays, isValidNotepadDate, todayNotepadDate } =
  await import(path.join(distDir, 'notepad.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

function idsByLine(day) {
  return getNotepadDay(day).lines.map((l) => ({ id: l.id, text: l.text }));
}

const DAY = '2026-09-24';

// -- date validation ----------------------------------------------------------
check('isValidNotepadDate accepts a real date', isValidNotepadDate('2026-09-24') === true);
check('isValidNotepadDate rejects a malformed date', isValidNotepadDate('2026-9-24') === false);
check('isValidNotepadDate rejects an impossible date', isValidNotepadDate('2026-13-40') === false);
check('todayNotepadDate returns YYYY-MM-DD shape', /^\d{4}-\d{2}-\d{2}$/.test(todayNotepadDate()));

// -- absent day returns empty note, not a 404-shaped error --------------------
{
  const empty = getNotepadDay('2099-01-01');
  check('absent day: text is empty string', empty.text === '');
  check('absent day: lines is an empty array', Array.isArray(empty.lines) && empty.lines.length === 0);
  check('absent day: not in the days list', !listNotepadDays().some((d) => d.day === '2099-01-01'));
}

// -- (a) save 5 lines, reword line 3 -> lines 1,2,4,5 keep ids ----------------
let saved = putNotepadDay(DAY, ['a', 'b', 'c', 'd', 'e'].join('\n'));
check('initial save: 5 lines created', saved.lines.length === 5);
check('initial save: round-trips text', saved.text === 'a\nb\nc\nd\ne');
const ids0 = saved.lines.map((l) => l.id);
check('initial save: 5 distinct ids', new Set(ids0).size === 5);

let after = putNotepadDay(DAY, ['a', 'b', 'c2', 'd', 'e'].join('\n'));
check('(a) line 1 keeps id', after.lines[0].id === ids0[0]);
check('(a) line 2 keeps id', after.lines[1].id === ids0[1]);
check('(a) line 4 keeps id', after.lines[3].id === ids0[3]);
check('(a) line 5 keeps id', after.lines[4].id === ids0[4]);
check('(a) reworded line updated in place (same id, new text)', after.lines[2].id === ids0[2] && after.lines[2].text === 'c2');
check('(a) no stray extra/missing rows', after.lines.length === 5);
const idsA = after.lines.map((l) => l.id);

// -- (b) re-indent line 2 (leading whitespace only) -> same id ----------------
after = putNotepadDay(DAY, ['a', '  b', 'c2', 'd', 'e'].join('\n'));
check('(b) re-indented line keeps id', after.lines[1].id === idsA[1]);
check('(b) re-indented line stores the raw (indented) text', after.lines[1].text === '  b');
check('(b) every other line keeps its id', [0, 2, 3, 4].every((i) => after.lines[i].id === idsA[i]));
const idsB = after.lines.map((l) => l.id);

// -- (c) insert a line in the middle -> every pre-existing id unchanged ------
after = putNotepadDay(DAY, ['a', '  b', 'NEW', 'c2', 'd', 'e'].join('\n'));
check('(c) 6 lines now', after.lines.length === 6);
const byText = Object.fromEntries(after.lines.map((l) => [l.text, l.id]));
check('(c) "a" kept its id', byText['a'] === idsB[0]);
check('(c) "  b" kept its id', byText['  b'] === idsB[1]);
check('(c) "c2" kept its id', byText['c2'] === idsB[2]);
check('(c) "d" kept its id', byText['d'] === idsB[3]);
check('(c) "e" kept its id', byText['e'] === idsB[4]);
check('(c) "NEW" got a brand-new id', !idsB.includes(byText['NEW']));
const idsC = { a: byText['a'], b: byText['  b'], new: byText['NEW'], c2: byText['c2'], d: byText['d'], e: byText['e'] };

// -- (d) move a line to the end -> same id ------------------------------------
after = putNotepadDay(DAY, ['a', 'NEW', 'c2', 'd', 'e', '  b'].join('\n'));
check('(d) moved line keeps its id', after.lines.find((l) => l.text === '  b')?.id === idsC.b);
check('(d) untouched lines keep their ids', after.lines.find((l) => l.text === 'a')?.id === idsC.a
  && after.lines.find((l) => l.text === 'NEW')?.id === idsC.new
  && after.lines.find((l) => l.text === 'c2')?.id === idsC.c2
  && after.lines.find((l) => l.text === 'd')?.id === idsC.d
  && after.lines.find((l) => l.text === 'e')?.id === idsC.e);
check('(d) new order is exactly as written', after.text === 'a\nNEW\nc2\nd\ne\n  b');

// -- (e) delete a line -> only that id disappears -----------------------------
after = putNotepadDay(DAY, ['a', 'NEW', 'd', 'e', '  b'].join('\n'));
check('(e) 5 lines remain', after.lines.length === 5);
check('(e) "c2" id is gone', !after.lines.some((l) => l.id === idsC.c2));
check('(e) every other id survived', [idsC.a, idsC.new, idsC.d, idsC.e, idsC.b].every((id) => after.lines.some((l) => l.id === id)));

// -- empty string clears the note (not a single empty-string line) ----------
after = putNotepadDay(DAY, '');
check('empty save: zero lines (not one blank line)', after.lines.length === 0);
check('empty save: text is empty string', after.text === '');
check('empty save: day still appears in the pager (touched, not deleted)', listNotepadDays().some((d) => d.day === DAY && d.line_count === 0));

// -- (f) a 5,000-line note saves and round-trips ------------------------------
{
  const BIG_DAY = '2026-09-25';
  const bigLines = Array.from({ length: 5000 }, (_, i) => `line ${i} — some content ${i % 7}`);
  const bigText = bigLines.join('\n');
  const savedBig = putNotepadDay(BIG_DAY, bigText);
  check('(f) 5000 lines saved', savedBig.lines.length === 5000);
  check('(f) round-trips byte-for-byte via GET', getNotepadDay(BIG_DAY).text === bigText);
  check('(f) 5000 distinct ids', new Set(savedBig.lines.map((l) => l.id)).size === 5000);
  check('(f) idx is sequential 0..4999', savedBig.lines.every((l, i) => l.idx === i));

  // Reword the middle line of the big note and confirm neighbors are untouched.
  const bigIdsBefore = savedBig.lines.map((l) => l.id);
  bigLines[2500] = 'REWORDED MIDDLE LINE';
  const savedBig2 = putNotepadDay(BIG_DAY, bigLines.join('\n'));
  check('(f) reword in a 5000-line note keeps neighbor ids', savedBig2.lines[2499].id === bigIdsBefore[2499] && savedBig2.lines[2501].id === bigIdsBefore[2501]);
  check('(f) reword in a 5000-line note keeps the reworded line\'s own id', savedBig2.lines[2500].id === bigIdsBefore[2500] && savedBig2.lines[2500].text === 'REWORDED MIDDLE LINE');
}

// -- days pager ----------------------------------------------------------------
{
  const days = listNotepadDays();
  check('days pager lists both touched days', days.some((d) => d.day === DAY) && days.some((d) => d.day === '2026-09-25'));
  const bigDay = days.find((d) => d.day === '2026-09-25');
  check('days pager reports the right line_count', bigDay?.line_count === 5000);
}

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
