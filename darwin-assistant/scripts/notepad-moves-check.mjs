#!/usr/bin/env node
// NOTEPAD MOVES CHECK — exercises decideNotepadMoves (src/notepad-moves.ts),
// the speaking bar (goal 6 node #103 / #62 "JARVIS speaks only when it has
// something worth saying"). No HTTP. Every case drives the injection seam
// (opts.runOneShot), so this file spawns ZERO real claude processes —
// proven, not assumed, by the before/after pgrep snapshot at the end.
//
// Covers:
//   (A) zero candidates -> outcome 'no_candidates', no model call at all:
//       (A1) a genuinely empty day, (A2) a day whose only line is already
//       'seen' with an UNCHANGED hash (never surfaces at all).
//   (B) a well-formed response covering some-but-not-all candidates: the
//       named ones get their moves, the OMITTED one gets no entry at all
//       (silence by omission, not a "none" kind) — and a line that never
//       even surfaced (already seen, unchanged) never reaches the model:
//       proven by asserting on the CAPTURED PROMPT's judge-list.
//   (C) at most one move per line: a response listing the SAME line_id
//       twice with different kinds keeps only the first, drops the second.
//   (D) an unrecognized `kind` string is dropped (not coerced, not trusted).
//   (E) a blank/missing `reason` is dropped.
//   (F) a move for a line_id that was never a candidate (phantom) is
//       dropped and never appears in the output.
//   (G) a non-JSON garbage response: outcome 'model' (the call itself
//       succeeded), moves comes back EMPTY — garbage degrades to silence,
//       not a thrown error.
//   (H) a REJECTING stub (simulated CLI failure): outcome 'fallback',
//       moves forced empty.
//   (I) a HANGING stub past timeoutMs: outcome 'fallback', moves forced
//       empty, and it resolves promptly rather than hanging the suite.
//   (J) the REAL path (no opts.runOneShot) throws synchronously OUT of
//       decideNotepadMoves under this scratch DB, before any spawn.
//   (K) opts.review is honoured as an injection seam: a stale, pre-built
//       review context is used as-is rather than the function silently
//       re-querying the DB for a fresher one.
//   (L) ZERO CLAUDE PROCESSES spawned across the whole run.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-moves-check.db node scripts/notepad-moves-check.mjs

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

console.log(`[notepad-moves-check] DB: ${DB_PATH}`);

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
const { putNotepadDay, unscannedLines, markLineSeen } = await import(path.join(distDir, 'notepad.js'));
const { buildNotepadReviewContext } = await import(path.join(distDir, 'notepad-review.js'));
const { decideNotepadMoves } = await import(path.join(distDir, 'notepad-moves.js'));

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

// == (A1) a genuinely empty day -> zero candidates, zero model call ========
{
  const DAY = '2026-09-24';
  const callsBefore = stubCalls;
  const result = await decideNotepadMoves(DAY, { runOneShot: countedStub(async () => '{"moves":[]}') });
  check('(A1) empty day: candidate_count is 0', result.candidate_count === 0);
  check('(A1) empty day: outcome is no_candidates', result.outcome === 'no_candidates');
  check('(A1) empty day: moves is an empty array', Array.isArray(result.moves) && result.moves.length === 0);
  check('(A1) empty day: the model stub was never invoked', stubCalls === callsBefore);
}

// == (A2) one line already 'seen' with an unchanged hash -> unscannedLines
// filters it out entirely, so it never surfaces as a candidate either =======
{
  const DAY = '2026-09-25';
  const text = 'Buy stamps for the mailer campaign';
  putNotepadDay(DAY, text);
  markLineSeen(lineIdFor(DAY, text));

  const callsBefore = stubCalls;
  const result = await decideNotepadMoves(DAY, { runOneShot: countedStub(async () => '{"moves":[]}') });
  check('(A2) already-seen/unchanged line: candidate_count is 0', result.candidate_count === 0);
  check('(A2) already-seen/unchanged line: outcome is no_candidates', result.outcome === 'no_candidates');
  check('(A2) already-seen/unchanged line: the model stub was never invoked', stubCalls === callsBefore);
}

// == (B) a well-formed response covering SOME candidates: named ones get
// moves, the omitted one gets none, and a never-surfaced line never even
// reaches the model (proven via the captured prompt's judge-list) =========
let idTakeIt, idSilent, idNeverSurfaced;
{
  const DAY = '2026-09-26';
  const takeItText = 'Email the vendor about the invoice today';
  const silentText = 'grocery list: milk, eggs, bread';
  const neverSurfacedText = 'This line is already handled and unchanged';
  putNotepadDay(DAY, [takeItText, silentText, neverSurfacedText].join('\n'));
  markLineSeen(lineIdFor(DAY, neverSurfacedText));

  idTakeIt = lineIdFor(DAY, takeItText);
  idSilent = lineIdFor(DAY, silentText);
  idNeverSurfaced = lineIdFor(DAY, neverSurfacedText);

  const review = buildNotepadReviewContext(DAY);
  check('(B) exactly 2 surfaced lines (the never-surfaced one is excluded)', review.lines.filter((l) => l.surfaced).length === 2);

  let capturedPrompt = null;
  const stub = countedStub(async (prompt) => {
    capturedPrompt = prompt;
    return JSON.stringify({
      moves: [{ line_id: idTakeIt, kind: 'take_it', reason: 'Reply to the vendor about the invoice' }],
      // idSilent is deliberately OMITTED — that omission IS the "no move" answer.
    });
  });

  const result = await decideNotepadMoves(DAY, { runOneShot: stub });
  check('(B) candidate_count is 2', result.candidate_count === 2);
  check('(B) outcome is model', result.outcome === 'model');
  check('(B) exactly one move came back', result.moves.length === 1);
  const move = result.moves[0];
  check(
    '(B) the named line gets kind take_it with a real reason',
    move?.line_id === idTakeIt && move?.kind === 'take_it' && typeof move?.reason === 'string' && move.reason.length > 0,
  );
  check('(B) the omitted candidate produces no entry at all (silence, not a "none" kind)', !result.moves.some((m) => m.line_id === idSilent));
  check('(B) captured prompt is non-empty (the stub was invoked)', typeof capturedPrompt === 'string' && capturedPrompt.length > 0);
  check(
    '(B) captured prompt lists BOTH surfaced candidates in the judge list',
    capturedPrompt.includes(`- line_id ${idTakeIt}`) && capturedPrompt.includes(`- line_id ${idSilent}`),
  );
  check(
    '(B) captured prompt does NOT list the never-surfaced line in the judge list',
    !capturedPrompt.includes(`- line_id ${idNeverSurfaced}`),
  );
  check('(B) captured prompt carries the whole rendered note (all three lines) for context', capturedPrompt.includes(review.rendered));
}

// == (C) at most one move per line: a duplicate line_id keeps only the
// FIRST valid entry, drops the rest =========================================
{
  const DAY = '2026-09-27';
  const text = 'Confirm the meeting time with Sarah';
  putNotepadDay(DAY, text);
  const id = lineIdFor(DAY, text);

  const stub = countedStub(async () =>
    JSON.stringify({
      moves: [
        { line_id: id, kind: 'take_it', reason: 'First verdict — reply to Sarah' },
        { line_id: id, kind: 'question', reason: 'Second, conflicting verdict — should be dropped' },
      ],
    }),
  );
  const result = await decideNotepadMoves(DAY, { runOneShot: stub });
  check('(C) exactly one move survives the duplicate', result.moves.length === 1);
  check('(C) the FIRST entry wins (kind take_it, not question)', result.moves[0]?.kind === 'take_it');
  check('(C) the surviving reason is the first entry\'s reason', result.moves[0]?.reason === 'First verdict — reply to Sarah');
}

// == (D) an unrecognized kind string is dropped ==============================
{
  const DAY = '2026-09-28';
  const text = 'Pack the boxes before the movers arrive';
  putNotepadDay(DAY, text);
  const id = lineIdFor(DAY, text);

  const stub = countedStub(async () => JSON.stringify({ moves: [{ line_id: id, kind: 'urgent_flag', reason: 'not a real kind' }] }));
  const result = await decideNotepadMoves(DAY, { runOneShot: stub });
  check('(D) an unrecognized kind produces zero moves', result.moves.length === 0);
  check('(D) outcome is still model (the call succeeded, the entry was just invalid)', result.outcome === 'model');
}

// == (E) a blank/missing reason is dropped ===================================
{
  const DAY = '2026-09-29';
  const blankText = 'Water the office plants twice this week';
  const missingText = 'Renew the domain registration before it lapses';
  putNotepadDay(DAY, [blankText, missingText].join('\n'));
  const idBlank = lineIdFor(DAY, blankText);
  const idMissing = lineIdFor(DAY, missingText);

  const stub = countedStub(async () =>
    JSON.stringify({
      moves: [
        { line_id: idBlank, kind: 'take_it', reason: '   ' },
        { line_id: idMissing, kind: 'take_it' }, // reason entirely absent
      ],
    }),
  );
  const result = await decideNotepadMoves(DAY, { runOneShot: stub });
  check('(E) a whitespace-only reason is dropped', !result.moves.some((m) => m.line_id === idBlank));
  check('(E) a missing reason is dropped', !result.moves.some((m) => m.line_id === idMissing));
  check('(E) zero moves survive', result.moves.length === 0);
}

// == (F) a move for a line_id that was never a candidate (phantom) is
// dropped, never trusted =====================================================
{
  const DAY = '2026-09-30';
  const text = 'Ship the replacement part overnight';
  putNotepadDay(DAY, text);
  const realId = lineIdFor(DAY, text);
  const phantomId = realId + 999999;

  const stub = countedStub(async () =>
    JSON.stringify({
      moves: [
        { line_id: realId, kind: 'take_it', reason: 'Arrange overnight shipping' },
        { line_id: phantomId, kind: 'take_it', reason: 'Should never appear' },
      ],
    }),
  );
  const result = await decideNotepadMoves(DAY, { runOneShot: stub });
  check('(F) the real candidate keeps its move', result.moves.some((m) => m.line_id === realId));
  check('(F) exactly one move came back (the phantom was not added as a second one)', result.moves.length === 1);
  check('(F) the phantom line_id never appears anywhere in the output', !result.moves.some((m) => m.line_id === phantomId));
}

// == (G) a non-JSON garbage response: outcome 'model' (the call succeeded),
// moves comes back empty — garbage degrades to silence, not a thrown error ==
{
  const DAY = '2026-10-01';
  const text = 'Draft the quarterly report before Friday';
  putNotepadDay(DAY, text);

  let threw = false;
  let result = null;
  try {
    result = await decideNotepadMoves(DAY, { runOneShot: countedStub(async () => 'not json at all, just prose') });
  } catch {
    threw = true;
  }
  check('(G) decideNotepadMoves RESOLVES rather than rejecting on a garbage response', !threw);
  check('(G) outcome is model (the call itself succeeded)', result?.outcome === 'model');
  check('(G) moves is empty', Array.isArray(result?.moves) && result.moves.length === 0);
}

// == (H) a REJECTING stub (simulated CLI failure): outcome fallback, moves
// forced empty ================================================================
{
  const DAY = '2026-10-02';
  const text = 'Call the bank about the wire transfer';
  putNotepadDay(DAY, text);

  const rejectStub = countedStub(async () => {
    throw new Error('simulated CLI failure');
  });
  const result = await decideNotepadMoves(DAY, { runOneShot: rejectStub });
  check('(H) a rejecting stub degrades to outcome fallback rather than throwing', result.outcome === 'fallback');
  check('(H) moves is forced empty', result.moves.length === 0);
  check('(H) candidate_count still reflects the real candidate set', result.candidate_count === 1);
}

// == (I) a HANGING stub past timeoutMs: outcome fallback, resolves promptly ==
{
  const DAY = '2026-10-03';
  const text = 'Schedule the dentist appointment for next week';
  putNotepadDay(DAY, text);

  const hangStub = countedStub(() => new Promise(() => {})); // never resolves or rejects
  const startedAt = Date.now();
  const result = await decideNotepadMoves(DAY, { runOneShot: hangStub, timeoutMs: 200 });
  const elapsedMs = Date.now() - startedAt;
  check('(I) a hanging stub past timeoutMs degrades to outcome fallback', result.outcome === 'fallback');
  check('(I) moves is forced empty', result.moves.length === 0);
  check(`(I) the timeout finished promptly (${elapsedMs}ms, well under 2000ms) — did not hang the suite`, elapsedMs < 2000);
}

// == (J) the REAL path (no opts.runOneShot at all) throws synchronously OUT
// of decideNotepadMoves under THIS scratch DB, before any spawn is
// attempted -- proves the guard sits ahead of the try/catch ================
{
  const DAY = '2026-10-04';
  const text = 'Follow up with Ian about the sequenced offer';
  putNotepadDay(DAY, text);

  let threwReal = false;
  let msgReal = '';
  try {
    await decideNotepadMoves(DAY); // no stub -- takes the real defaultRunOneShot path
  } catch (err) {
    threwReal = true;
    msgReal = err instanceof Error ? err.message : String(err);
  }
  check('(J) the REAL path (no stub) throws before spawning, under this scratch DB', threwReal);
  check('(J) the thrown message is the notepad spawn guard', msgReal.includes('refused to spawn a model'));
}

// == (K) opts.review is honoured as an injection seam: a STALE, pre-built
// review context is used as-is rather than the function silently
// re-querying the DB for a fresher one ======================================
{
  const DAY = '2026-10-05';
  const text = 'Renegotiate the vendor contract before renewal';
  putNotepadDay(DAY, text);
  const id = lineIdFor(DAY, text);

  // Build the review context while the line is still surfaced...
  const staleReview = buildNotepadReviewContext(DAY);
  check('(K) precondition: the stale review context has 1 surfaced candidate', staleReview.lines.filter((l) => l.surfaced).length === 1);

  // ...then mark it seen (unchanged text), which would make a FRESH rebuild
  // report zero surfaced candidates.
  markLineSeen(id);
  const freshReview = buildNotepadReviewContext(DAY);
  check('(K) precondition: a FRESH rebuild now reports 0 surfaced candidates', freshReview.lines.filter((l) => l.surfaced).length === 0);

  const stub = countedStub(async () => JSON.stringify({ moves: [{ line_id: id, kind: 'take_it', reason: 'Send the renewal terms' }] }));
  const result = await decideNotepadMoves(DAY, { review: staleReview, runOneShot: stub });
  check('(K) decideNotepadMoves used the INJECTED stale review, not a fresh rebuild', result.candidate_count === 1 && result.outcome === 'model');
  check('(K) the stale candidate still gets judged and its move returned', result.moves.some((m) => m.line_id === id));
}

// == (L) zero claude processes spawned across the entire run =================
const spawnsAfter = claudeProcessCount();
console.log(`  claude processes before: ${spawnsBefore}  after: ${spawnsAfter}`);
check('(L) the claude process count did not increase across this run', spawnsAfter <= spawnsBefore);

console.log(`\nmodel stub calls: ${stubCalls}`);
console.log(failed ? 'FAILED' : 'ALL PASS');
process.exit(failed ? 1 : 0);
