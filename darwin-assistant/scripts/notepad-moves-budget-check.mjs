#!/usr/bin/env node
// NOTEPAD MOVES BUDGET CHECK — proves the noise budget on decideNotepadMoves
// (src/notepad-moves.ts) survives an OVER-EAGER model, not just a
// well-behaved one. node #103/#62's own acceptance bar: "a normal day
// produces a handful of markers, not one per line" — and the risk is real:
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
{
  const surfaced = unscannedLines(DAY);
  check('(A) all 10 lines are currently surfaced (a fresh, all-unseen day)', surfaced.length === 10);
}

// == (B)+(C) an OVER-EAGER stub answers every single candidate with a
// legal kind + non-blank reason -- the noise budget must still hold =======
function overEagerResponse(ids) {
  return JSON.stringify({
    moves: ids.map((id, i) => ({
      line_id: id,
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

  const expectedSurvivors = new Set(lineIds.slice(0, 5)); // the first 5 lines in document order
  const actualSurvivors = new Set(result.moves.map((m) => m.line_id));
  check(
    '(D) capping keeps the lines earliest in DOCUMENT order, ignoring the order the model listed them in',
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
        { line_id: takeItId, kind: 'take_it', reason: 'Reply to the vendor about the invoice' },
        { line_id: questionId, kind: 'question', reason: 'This needs a pricing decision from Kevin' },
      ],
    }),
  );
  const result = await decideNotepadMoves(DAY, { runOneShot: stub });
  check('(F) a well-behaved 2-of-10 response is NOT capped or altered', result.moves.length === 2);
  check(
    '(F) both of the honest moves survive exactly as given',
    result.moves.some((m) => m.line_id === takeItId && m.kind === 'take_it') &&
      result.moves.some((m) => m.line_id === questionId && m.kind === 'question'),
  );
}

// == (G) zero claude processes spawned across the entire run =================
const spawnsAfter = claudeProcessCount();
console.log(`  claude processes before: ${spawnsBefore}  after: ${spawnsAfter}`);
check('(G) the claude process count did not increase across this run', spawnsAfter <= spawnsBefore);

console.log(`\nmodel stub calls: ${stubCalls}`);
console.log(failed ? 'FAILED' : 'ALL PASS');
process.exit(failed ? 1 : 0);
