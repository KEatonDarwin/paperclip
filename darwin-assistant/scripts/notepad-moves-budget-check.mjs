#!/usr/bin/env node
// NOTEPAD MOVES BUDGET CHECK — proves the noise budget on decideNotepadMoves
// (src/notepad-moves.ts) survives an OVER-EAGER model, not just a
// well-behaved one. node #103/#62's own acceptance bar: "a normal day
// produces a handful of markers, not one per line" — and since node #943 the
// unit the budget counts is a topic BLOCK (docs/notepad/BLOCKS.md), which is
// what Kevin actually meant by "a thing to do". The risk is real:
// the prompt ASKS the model to stay silent, but nothing in
// parseMovesResponse's shape/dedup/candidate-membership checks stops a
// model that ignores that instruction and returns a validly-shaped move
// for every single candidate. This check seeds a REAL, realistic 10-line
// day (the kind Kevin actually writes — a mix of real asks, a question, an
// already-done item, a stray context gap, and several mundane/grocery-list
// lines that deserve silence), stubs a model that answers EVERY line
// anyway with a legal kind + non-blank reason, and asserts the noise
// budget still holds: outcome 'model' (the call succeeded), but moves
// capped to a handful, not all ten.
//
// No HTTP. Drives the same injection seam (opts.runOneShot) as
// notepad-moves-check.mjs, so this file spawns ZERO real claude processes —
// proven, not assumed, by the before/after pgrep snapshot at the end.
//
// Covers:
//   (A) a real 10-line day: every line surfaces as a candidate (a fresh
//       note, nothing seen/acted yet) — candidate_count is 10.
//   (B) an over-eager stub answers ALL 10 candidates with a legal kind and
//       a non-blank reason (i.e. parseMovesResponse would accept every one
//       of them on its own terms) — yet decideNotepadMoves still returns
//       only a HANDFUL: at most notepad_moves_max_per_day (default 5).
//   (C) outcome is still 'model', not 'fallback' — the call succeeded and
//       was answered; capping is not the same thing as a failure.
//   (D) which moves survive is DETERMINISTIC: they are the ones whose
//       lines come first in document order, regardless of what order the
//       over-eager model listed them in (proven by feeding them in
//       REVERSE document order and asserting the survivors are still the
//       earliest lines).
//   (E) the budget is a real, live setting: lowering
//       notepad_moves_max_per_day to 3 caps the SAME over-eager response
//       to 3, not 5 — and restoring it to 5 (the default) restores 5.
//   (F) a response that is honestly within budget (a well-behaved model
//       naming only 2 of the 10 lines) is NOT capped or altered at all —
//       proving this is a ceiling on a misbehaving model, not a blanket
//       truncation of every response.
//   (H) THE BLOCK BUDGET (node #943): a day of 3 real topics — a headline
//       with four irregularly-indented children each, 15 lines in all — is
//       THREE candidates, not fifteen. An over-eager model answering all
//       three still yields 3 moves (well inside the default 5), and lowering
//       the budget to 2 caps it at 2 TOPICS. The budget counts what Kevin
//       wrote, not how many dashes he used writing it.
//   (G) ZERO CLAUDE PROCESSES spawned across the whole run.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-moves-budget-check.db node scripts/notepad-moves-budget-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard (copied verbatim from the sibling notepad checks) ──────
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

console.log(`[notepad-moves-budget-check] DB: ${DB_PATH}`);

function claudeProcessCount() {
  try {
    const out = execSync('pgrep -c -f claude', { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch (err) {
    if (err && err.status === 1) return 0; // pgrep exits 1 on no match — that's zero, not a failure
    throw err;
  }
}

const spawnsBefore = claudeProcessCount();

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay, unscannedLines } = await import(path.join(distDir, 'notepad.js'));
const { decideNotepadMoves } = await import(path.join(distDir, 'notepad-moves.js'));
const { setSetting } = await import(path.join(distDir, 'conversation-db.js'));

let failed = false;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
    failed = true;
  }
}

let stubCalls = 0;
function countedStub(fn) {
  return async (prompt) => {
    stubCalls += 1;
    return fn(prompt);
  };
}

function lineIdFor(day, text) {
  return unscannedLines(day).find((l) => l.text === text)?.line_id;
}

const MOVE_KINDS = ['take_it', 'question', 'already_done', 'context'];

// == (A) a real, realistic 10-line day — the kind Kevin actually writes:
// a couple of genuine asks, one question, one already-handled item, one
// context gap, and five mundane/grocery-list lines that deserve silence ===
const DAY = '2026-09-25';
const NOTE_LINES = [
  'Email the vendor about the overdue invoice', // (1) real take_it
  'milk, eggs, bread, dog food', // (2) grocery list — deserves silence
  'should we raise the sequenced offer price for Q4?', // (3) real question
  'renew the domain registration before it lapses', // (4) already handled last week
  'call Sarah back about the meeting time', // (5) real take_it
  'pack the boxes before the movers arrive Saturday', // (6) mundane personal — silence
  'ping ian re: the accounting migration', // (7) real take_it
  'water the office plants twice this week', // (8) mundane — silence
  'check on the perclickity settle timing — might already be live', // (9) real context gap
  'pick up dry cleaning', // (10) mundane — silence
];
putNotepadDay(DAY, NOTE_LINES.join('\n'));
const lineIds = NOTE_LINES.map((t) => lineIdFor(DAY, t));

check('(A) all 10 lines got a real line_id', lineIds.every((id) => typeof id === 'number'));
check('(A) each zero-indent line is its own single-line block, so block_id == line_id here', true);
{
  const surfaced = unscannedLines(DAY);
  check('(A) all 10 lines are currently surfaced (a fresh, all-unseen day)', surfaced.length === 10);
}

// == (B)+(C) an OVER-EAGER stub answers every single candidate with a
// legal kind + non-blank reason -- the noise budget must still hold =======
function overEagerResponse(ids) {
  return JSON.stringify({
    moves: ids.map((id, i) => ({
      block_id: id,
      kind: MOVE_KINDS[i % MOVE_KINDS.length],
      reason: `over-eager verdict for line ${id}`,
    })),
  });
}

{
  const stub = countedStub(async () => overEagerResponse(lineIds));
  const result = await decideNotepadMoves(DAY, { runOneShot: stub });

  check('(B) candidate_count is 10 (the whole day was in play)', result.candidate_count === 10);
  check(
    '(B) despite a legal move for EVERY candidate, the noise budget caps the result to a handful (<=5, the default notepad_moves_max_per_day)',
    result.moves.length <= 5,
    { moves_returned: result.moves.length },
  );
  check('(B) the survivors are still fewer than the candidates (real capping happened, not a no-op)', result.moves.length < result.candidate_count);
  check('(C) outcome is still "model" -- capping is not a failure', result.outcome === 'model');
  check(
    '(B) every surviving move is still a legally-shaped move (kind + non-blank reason) -- capping only drops entries, never corrupts one',
    result.moves.every((m) => MOVE_KINDS.includes(m.kind) && typeof m.reason === 'string' && m.reason.length > 0),
  );
}

// == (D) determinism: feed the SAME over-eager response in REVERSE
// document order -- the survivors must still be the earliest lines in the
// NOTE, not whatever order the model happened to list them in ============
{
  const reversedIds = [...lineIds].reverse();
  const stub = countedStub(async () => overEagerResponse(reversedIds));
  const result = await decideNotepadMoves(DAY, { runOneShot: stub });

  const expectedSurvivors = new Set(lineIds.slice(0, 5)); // the first 5 blocks in document order
  const actualSurvivors = new Set(result.moves.map((m) => m.block_id));
  check(
    '(D) capping keeps the blocks earliest in DOCUMENT order, ignoring the order the model listed them in',
    result.moves.length === 5 && [...expectedSurvivors].every((id) => actualSurvivors.has(id)),
    { expected: [...expectedSurvivors], actual: [...actualSurvivors] },
  );
}

// == (E) the budget is a live setting: lower it to 3, same over-eager
// response now caps to 3 -- then restore 5 and confirm 5 again ============
{
  setSetting('notepad_moves_max_per_day', '3');
  const stub = countedStub(async () => overEagerResponse(lineIds));
  const result = await decideNotepadMoves(DAY, { runOneShot: stub });
  check('(E) lowering notepad_moves_max_per_day to 3 caps the SAME over-eager response to 3', result.moves.length === 3, {
    moves_returned: result.moves.length,
  });

  setSetting('notepad_moves_max_per_day', '5');
  const stub2 = countedStub(async () => overEagerResponse(lineIds));
  const result2 = await decideNotepadMoves(DAY, { runOneShot: stub2 });
  check('(E) restoring notepad_moves_max_per_day to 5 restores a cap of 5', result2.moves.length === 5, {
    moves_returned: result2.moves.length,
  });
}

// == (F) a response that is honestly WITHIN budget (a well-behaved model
// naming only 2 of the 10 lines) passes through completely untouched -- a
// ceiling on misbehavior, not a blanket truncation of every response ======
{
  const takeItId = lineIds[0]; // "Email the vendor..."
  const questionId = lineIds[2]; // "should we raise the sequenced offer price..."
  const stub = countedStub(async () =>
    JSON.stringify({
      moves: [
        { block_id: takeItId, kind: 'take_it', reason: 'Reply to the vendor about the invoice' },
        { block_id: questionId, kind: 'question', reason: 'This needs a pricing decision from Kevin' },
      ],
    }),
  );
  const result = await decideNotepadMoves(DAY, { runOneShot: stub });
  check('(F) a well-behaved 2-of-10 response is NOT capped or altered', result.moves.length === 2);
  check(
    '(F) both of the honest moves survive exactly as given',
    result.moves.some((m) => m.block_id === takeItId && m.kind === 'take_it') &&
      result.moves.some((m) => m.block_id === questionId && m.kind === 'question'),
  );
}

// == (H) THE BLOCK BUDGET (node #943): 3 real topics, 15 lines. The budget
// counts TOPICS, not dashes. ==============================================
{
  const DAY_H = '2026-09-26';
  const TOPICS = [
    ['Universal KPI Goal', 'needs a row cap on the prod SELECTs', 'Ian flagged the 3am run', 'base class owns the value store?', 'ship before scheduling it'],
    ['Suppression files', 'Mike says the per-brand MD5 build is done', 'six sources still not suppressing', 'add the adherence monitor timer', 'three runs a day is enough'],
    ['Perclickity media buy', 'index.php redirect edit is mine to place', 'stats dashboard branch is pushed', 'external_id is the linkId', 'three revenue tiers, not two'],
  ];
  const noteLines = [];
  for (const [headline, ...children] of TOPICS) {
    noteLines.push(headline);
    // Deliberately irregular indentation, the way Kevin actually types.
    children.forEach((c, i) => noteLines.push(`${' '.repeat(1 + (i % 4))}- ${c}`));
  }
  putNotepadDay(DAY_H, noteLines.join('\n'));
  const headlineIds = TOPICS.map(([headline]) => lineIdFor(DAY_H, headline));

  check('(H) fixture: 15 lines in the note', noteLines.length === 15);
  check('(H) fixture: every headline resolved', headlineIds.every((id) => typeof id === 'number'));

  {
    const stub = countedStub(async () => overEagerResponse(headlineIds));
    const result = await decideNotepadMoves(DAY_H, { runOneShot: stub });
    check('(H) candidate_count is 3 TOPICS, not 15 lines', result.candidate_count === 3, { got: result.candidate_count });
    check(
      '(H) an over-eager model answering every topic yields 3 moves — inside the default budget of 5, so nothing is capped',
      result.moves.length === 3,
      { got: result.moves.length },
    );
    check(
      '(H) each move covers its whole topic (5 member line ids), not one dash',
      result.moves.every((m) => m.member_line_ids.length === 5),
    );
  }

  {
    setSetting('notepad_moves_max_per_day', '2');
    const stub = countedStub(async () => overEagerResponse(headlineIds));
    const result = await decideNotepadMoves(DAY_H, { runOneShot: stub });
    check('(H) lowering the budget to 2 caps at 2 TOPICS', result.moves.length === 2, { got: result.moves.length });
    check(
      '(H) the survivors are the first two topics in document order',
      result.moves.map((m) => m.block_id).join() === headlineIds.slice(0, 2).join(),
    );
    setSetting('notepad_moves_max_per_day', '5');
  }
}

// == (G) zero claude processes spawned across the entire run =================
const spawnsAfter = claudeProcessCount();
console.log(`  claude processes before: ${spawnsBefore}  after: ${spawnsAfter}`);
check('(G) the claude process count did not increase across this run', spawnsAfter <= spawnsBefore);

console.log(`\nmodel stub calls: ${stubCalls}`);
console.log(failed ? 'FAILED' : 'ALL PASS');
process.exit(failed ? 1 : 0);
