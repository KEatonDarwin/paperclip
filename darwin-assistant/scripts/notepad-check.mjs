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
//   (g) COMBINED edits in one save (delete-above + reword-below, insert-above +
//       reword-below, two distant rewords) keep each line's OWN id — the hole
//       ordinal leftover-pairing had, found in the node #713 review.
//   (h) a note of thousands of identical lines stays off the O(n^2) path.
//
// Adversarial hardening pass (node #803), added on top of (a)-(h):
//   (1) duplicate identical lines: editing/deleting one occurrence leaves the
//       other occurrences' ids untouched.
//   (2) a contiguous block of lines moved across a note keeps every id.
//   (3) SPLIT — one line becomes two: the LEADING fragment (the one left
//       occupying the original line's position) keeps the id; the trailing
//       fragment is new.
//   (4) MERGE — two lines become one: the FIRST (topmost) line's id survives;
//       the second is deleted.
//   (5) reword AND re-indent the same line in the same save: same id.
//   (6) an autosave burst (many successive single-char-appended saves) holds
//       one id for the whole burst.
//   (7) whitespace-only lines (blank / spaces / tab, including two adjacent
//       blanks) get stable, distinct ids and round-trip byte-for-byte, even
//       across an edit that shifts their indices.
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

// -- (g) COMBINED edits in ONE save: the case ordinal pairing got wrong --------
// Regression for node #713 review. Before the fix, leftover old lines were
// paired with leftover new lines by ordinal position, so a save that both
// removed a line above and reworded a line below handed the reworded line the
// REMOVED line's id (and threw away its own). Same for "insert at the top +
// reword at the bottom": the brand-new line stole an existing id.
{
  const D = '2026-09-26';
  const first = putNotepadDay(D, ['a', 'b', 'c', 'd', 'e', 'f'].join('\n'));
  const idOf = Object.fromEntries(first.lines.map((l) => [l.text, l.id]));

  // delete 'b' AND reword 'e' in the same save
  const after = putNotepadDay(D, ['a', 'c', 'd', 'E-reworded', 'f'].join('\n'));
  const reworded = after.lines.find((l) => l.text === 'E-reworded');
  check("(g) delete-above + reword-below: reworded line keeps its OWN id", reworded.id === idOf.e);
  check("(g) delete-above + reword-below: the deleted line's id is gone", !after.lines.some((l) => l.id === idOf.b));
  check('(g) delete-above + reword-below: untouched lines keep their ids',
    after.lines.find((l) => l.text === 'a').id === idOf.a &&
    after.lines.find((l) => l.text === 'c').id === idOf.c &&
    after.lines.find((l) => l.text === 'd').id === idOf.d &&
    after.lines.find((l) => l.text === 'f').id === idOf.f);
}
{
  const D = '2026-09-27';
  const first = putNotepadDay(D, ['one', 'two', 'three', 'four'].join('\n'));
  const idOf = Object.fromEntries(first.lines.map((l) => [l.text, l.id]));
  const known = new Set(first.lines.map((l) => l.id));

  // insert a NEW first line AND reword the last line in the same save
  const after = putNotepadDay(D, ['NEW', 'one', 'two', 'three', 'FOUR!'].join('\n'));
  check('(g) insert-above + reword-below: reworded line keeps its own id',
    after.lines.find((l) => l.text === 'FOUR!').id === idOf.four);
  check('(g) insert-above + reword-below: the inserted line gets a NEW id, not a stolen one',
    !known.has(after.lines.find((l) => l.text === 'NEW').id));
  check('(g) insert-above + reword-below: middle lines keep their ids',
    after.lines.find((l) => l.text === 'one').id === idOf.one &&
    after.lines.find((l) => l.text === 'three').id === idOf.three);
}
{
  // Two far-apart rewords in one save must not swap ids with each other.
  const D = '2026-09-28';
  const lines = Array.from({ length: 40 }, (_, i) => `row ${i}`);
  const first = putNotepadDay(D, lines.join('\n'));
  const ids = first.lines.map((l) => l.id);
  lines[3] = 'row 3 reworded';
  lines[31] = 'row 31 reworded';
  const after = putNotepadDay(D, lines.join('\n'));
  check('(g) two distant rewords in one save keep their own ids',
    after.lines[3].id === ids[3] && after.lines[31].id === ids[31]);
  check('(g) two distant rewords leave every other id untouched',
    after.lines.every((l, i) => l.id === ids[i]));
}

// -- (h) cost caps: a note of thousands of identical lines stays cheap --------
{
  const D = '2026-09-29';
  const same = Array.from({ length: 3000 }, () => '---');
  putNotepadDay(D, same.join('\n'));
  const t0 = Date.now();
  const after = putNotepadDay(D, same.concat(['---']).join('\n'));
  const ms = Date.now() - t0;
  check('(h) 3000 identical lines + append round-trips correctly', after.lines.length === 3001 && after.text === same.concat(['---']).join('\n'));
  check(`(h) that save stayed off the O(n^2) path (${ms}ms < 250ms)`, ms < 250);
}

// -- (1a) DUPLICATE IDENTICAL LINES: edit one occurrence, others keep ids -----
{
  const D = '2026-10-01';
  const first = putNotepadDay(D, ['start', '- follow up', 'middle', '- follow up', '- follow up', 'end'].join('\n'));
  const dupIdsBefore = first.lines.filter((l) => l.text === '- follow up').map((l) => l.id);
  const otherIdsBefore = first.lines.filter((l) => l.text !== '- follow up').map((l) => l.id);
  check('(1a) initial save: 3 distinct duplicate ids', new Set(dupIdsBefore).size === 3);

  const after = putNotepadDay(D, ['start', '- follow up', 'middle', '- follow up', '- follow up EDITED', 'end'].join('\n'));
  const stillDup = after.lines.filter((l) => l.text === '- follow up');
  check('(1a) editing one duplicate: exactly 2 unedited duplicates remain', stillDup.length === 2);
  check('(1a) editing one duplicate: the other duplicates kept ORIGINAL ids', stillDup.every((l) => dupIdsBefore.includes(l.id)));
  const editedLine = after.lines.find((l) => l.text === '- follow up EDITED');
  check(
    '(1a) the edited line is the one that changed (kept one of the original 3 ids, not a fresh insert)',
    !!editedLine && dupIdsBefore.includes(editedLine.id)
  );
  check(
    '(1a) non-duplicate lines untouched',
    after.lines.filter((l) => !l.text.startsWith('- follow up')).every((l) => otherIdsBefore.includes(l.id))
  );
}

// -- (1b) DUPLICATE IDENTICAL LINES: delete one of three, two survive --------
{
  const D = '2026-10-02';
  const first = putNotepadDay(D, ['start', '- follow up', 'middle', '- follow up', '- follow up', 'end'].join('\n'));
  const dupIdsBefore = first.lines.filter((l) => l.text === '- follow up').map((l) => l.id);
  check('(1b) initial save: 3 distinct duplicate ids', new Set(dupIdsBefore).size === 3);

  const after = putNotepadDay(D, ['start', '- follow up', 'middle', '- follow up', 'end'].join('\n'));
  const dupIdsAfter = after.lines.filter((l) => l.text === '- follow up').map((l) => l.id);
  check('(1b) delete one duplicate out of three: exactly 2 survivors', dupIdsAfter.length === 2);
  check('(1b) delete one duplicate out of three: no id collision among survivors', new Set(dupIdsAfter).size === 2);
  check(
    '(1b) delete one duplicate out of three: survivors are drawn from the original 3 ids',
    dupIdsAfter.every((id) => dupIdsBefore.includes(id))
  );
  check('(1b) delete one duplicate out of three: total line count is 5', after.lines.length === 5);
}

// -- (2) BLOCK REORDER: move a 3-line block from top to bottom of a 10-line note
{
  const D = '2026-10-03';
  const lines = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'];
  const first = putNotepadDay(D, lines.join('\n'));
  const idOf = Object.fromEntries(first.lines.map((l) => [l.text, l.id]));
  check('(2) initial save: 10 distinct ids', new Set(Object.values(idOf)).size === 10);

  const reordered = ['L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L0', 'L1', 'L2'];
  const after = putNotepadDay(D, reordered.join('\n'));
  check(
    '(2) block reorder: every one of the 10 lines kept its original id',
    reordered.every((text, i) => after.lines[i].id === idOf[text])
  );
  check('(2) block reorder: exact text order preserved', after.text === reordered.join('\n'));
  check('(2) block reorder: still 10 lines total (nothing deleted+reinserted)', after.lines.length === 10);
}

// -- (3) SPLIT: one line becomes two — leading fragment keeps the id ---------
{
  const D = '2026-10-04';
  const first = putNotepadDay(D, ['a', 'Hello world', 'b'].join('\n'));
  const idOf = Object.fromEntries(first.lines.map((l) => [l.text, l.id]));

  const after = putNotepadDay(D, ['a', 'Hello', 'world', 'b'].join('\n'));
  check('(3) split: 4 lines now', after.lines.length === 4);
  const helloLine = after.lines.find((l) => l.text === 'Hello');
  const worldLine = after.lines.find((l) => l.text === 'world');
  // DECISION (see the comment on applyLineDiff in src/notepad.ts): the
  // LEADING fragment — the one left occupying the original line's position —
  // keeps the original id; the trailing fragment is a genuinely new line.
  check("(3) split: the LEADING fragment (\"Hello\") keeps the original line's id", helloLine?.id === idOf['Hello world']);
  check('(3) split: the trailing fragment ("world") gets a brand-new id', worldLine && worldLine.id !== idOf['Hello world']);
  check(
    '(3) split: surrounding lines untouched',
    after.lines.find((l) => l.text === 'a').id === idOf.a && after.lines.find((l) => l.text === 'b').id === idOf.b
  );
}

// -- (4) MERGE: two lines become one — first line's id survives -------------
{
  const D = '2026-10-05';
  const first = putNotepadDay(D, ['a', 'Hello', 'world', 'b'].join('\n'));
  const idOf = Object.fromEntries(first.lines.map((l) => [l.text, l.id]));

  const after = putNotepadDay(D, ['a', 'Hello world', 'b'].join('\n'));
  check('(4) merge: 3 lines now', after.lines.length === 3);
  const merged = after.lines.find((l) => l.text === 'Hello world');
  // DECISION (see the comment on applyLineDiff in src/notepad.ts): the FIRST
  // (topmost) of the two merged lines keeps its id; the second is deleted.
  check("(4) merge: exactly one id survives, and it is the FIRST line's id", merged?.id === idOf.Hello);
  check("(4) merge: the second line's id is gone", !after.lines.some((l) => l.id === idOf.world));
  check(
    '(4) merge: surrounding lines untouched',
    after.lines.find((l) => l.text === 'a').id === idOf.a && after.lines.find((l) => l.text === 'b').id === idOf.b
  );
}

// -- (5) REWORD + RE-INDENT the same line in the same save -------------------
{
  const D = '2026-10-06';
  const first = putNotepadDay(D, ['a', 'original text', 'c'].join('\n'));
  const idOf = Object.fromEntries(first.lines.map((l) => [l.text, l.id]));

  const after = putNotepadDay(D, ['a', '    reworded text', 'c'].join('\n'));
  const line = after.lines.find((l) => l.text === '    reworded text');
  check('(5) reword+re-indent in one save: same id', !!line && line.id === idOf['original text']);
  check('(5) reword+re-indent in one save: raw indented text stored exactly', line?.text === '    reworded text');
  check(
    '(5) reword+re-indent in one save: surrounding lines untouched',
    after.lines.find((l) => l.text === 'a').id === idOf.a && after.lines.find((l) => l.text === 'c').id === idOf.c
  );
}

// -- (6) AUTOSAVE BURST: ~14 successive single-char-appended saves ----------
{
  const D = '2026-10-07';
  const first = putNotepadDay(D, ['before', 'typing', 'after'].join('\n'));
  const idOf = Object.fromEntries(first.lines.map((l) => [l.text, l.id]));
  const typingId = idOf.typing;
  const beforeId = idOf.before;
  const afterId = idOf.after;

  let text = 'typing';
  let burstOk = true;
  for (let i = 0; i < 14; i++) {
    text += String.fromCharCode(97 + (i % 26));
    const saved = putNotepadDay(D, ['before', text, 'after'].join('\n'));
    const typingLine = saved.lines.find((l) => l.idx === 1);
    if (!typingLine || typingLine.id !== typingId) burstOk = false;
    if (saved.lines.find((l) => l.text === 'before')?.id !== beforeId) burstOk = false;
    if (saved.lines.find((l) => l.text === 'after')?.id !== afterId) burstOk = false;
  }
  check('(6) autosave burst: one line held ONE id across 14 successive one-char saves', burstOk);
  const finalNote = getNotepadDay(D);
  check('(6) autosave burst: final text round-trips exactly', finalNote.text === ['before', text, 'after'].join('\n'));
}

// -- (7) WHITESPACE-ONLY LINES: blank / spaces / tab, incl. two adjacent blanks
{
  const D = '2026-10-08';
  const initial = ['keep1', '', '', '   ', '\t', 'keep2'];
  const first = putNotepadDay(D, initial.join('\n'));
  check('(7) initial save: 6 lines including whitespace-only ones', first.lines.length === 6);
  check('(7) initial save round-trips byte-for-byte (blank vs spaces vs tab distinct)', first.text === initial.join('\n'));
  const idsBefore = first.lines.map((l) => l.id);
  check('(7) 6 distinct ids to start', new Set(idsBefore).size === 6);
  const whitespaceIdsBefore = first.lines.filter((l) => l.text.trim() === '').map((l) => l.id);
  check(
    '(7) 4 distinct whitespace-only ids (2 blank + spaces + tab), none collapsed together',
    new Set(whitespaceIdsBefore).size === 4
  );

  // Unrelated edit elsewhere in the note; whitespace lines/positions untouched.
  const edited = ['keep1-edited', '', '', '   ', '\t', 'keep2'];
  const after = putNotepadDay(D, edited.join('\n'));
  check('(7) unrelated edit: text round-trips byte-for-byte', after.text === edited.join('\n'));
  check('(7) unrelated edit: still 6 lines (no whitespace line collapsed or duplicated)', after.lines.length === 6);
  const whitespaceIdsAfter = after.lines.filter((l) => l.text.trim() === '').map((l) => l.id);
  check('(7) unrelated edit: still 4 distinct whitespace-only ids', new Set(whitespaceIdsAfter).size === 4);
  check(
    '(7) unrelated edit: whitespace-only ids are the SAME set as before (stable across an unrelated edit)',
    whitespaceIdsAfter.length === whitespaceIdsBefore.length && whitespaceIdsAfter.every((id) => whitespaceIdsBefore.includes(id))
  );
  check(
    '(7) unrelated edit: reworded line kept its own id',
    after.lines.find((l) => l.text === 'keep1-edited')?.id === first.lines.find((l) => l.text === 'keep1').id
  );
  check(
    '(7) unrelated edit: keep2 untouched',
    after.lines.find((l) => l.text === 'keep2')?.id === first.lines.find((l) => l.text === 'keep2').id
  );

  // A further edit that SHIFTS the whitespace block's indices (insert above it).
  const shifted = ['keep1-edited', 'INSERTED', '', '', '   ', '\t', 'keep2'];
  const after2 = putNotepadDay(D, shifted.join('\n'));
  check('(7) index-shifting edit: text round-trips byte-for-byte', after2.text === shifted.join('\n'));
  check('(7) index-shifting edit: 7 lines now', after2.lines.length === 7);
  const whitespaceIdsAfter2 = after2.lines.filter((l) => l.text.trim() === '').map((l) => l.id);
  check(
    '(7) index-shifting edit: still exactly 4 distinct whitespace-only ids, no collapse/loss',
    new Set(whitespaceIdsAfter2).size === 4 && whitespaceIdsAfter2.length === 4
  );
  check(
    '(7) index-shifting edit: the 4 whitespace ids are the SAME set as before (survived the shift)',
    whitespaceIdsAfter2.every((id) => whitespaceIdsBefore.includes(id))
  );
  const insertedLine = after2.lines.find((l) => l.text === 'INSERTED');
  check('(7) index-shifting edit: the inserted line got a brand-new id', !!insertedLine && !idsBefore.includes(insertedLine.id));
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
