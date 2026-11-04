#!/usr/bin/env node
// NOTEPAD GATE CHECK — exercises the deterministic BLOCK-level prefilter
// (src/notepad-gate.ts: prefilterGateCandidates/classifyGateSkip/
// classifyCandidateOrigin/assertModelSpawnAllowed) against a scratch
// jarvis.db. No HTTP, and — this is the point of the whole module — NO
// MODEL CALLS anywhere in this run.
//
// Node #942 moved the gate from per-LINE to per-BLOCK judgement (Kevin's
// topic-block note format, docs/notepad/BLOCKS.md). Coverage:
//   (A) a block made ENTIRELY of junk member lines (blank, heading, thematic
//       break, bare bullet, bare URL, too-short) is disposed WHOLESALE; a
//       block with a mix of junk AND one real sentence goes to the model
//       whole, junk members included, because Kevin's rule is never judge a
//       line alone.
//   (not_a_candidate) classifyCandidateOrigin against a line id that is not
//       one of the day's current unscannedLines() candidates (per-line;
//       unscannedLines() itself is untouched by this node).
//   (B) a day where every line is already seen/acted/dismissed at an
//       UNCHANGED hash produces zero candidate blocks and zero disposed
//       blocks (unscannedLines() filters upstream, same as before).
//   (C) notepad_gate_min_chars is honoured and re-read on every call, at
//       block granularity.
//   (D) assertModelSpawnAllowed() throws under this scratch DB, naming the
//       offending path in the message.
//   (F)-(K) the MODEL half (runNotepadGate), block-keyed: well-formed
//       response, garbage response, an omitted block_id, a rejecting/hanging
//       stub, the real (unstubbed) path throwing before spawn, and a
//       phantom block_id in the response being ignored.
//   (L) a NULL-HEADLINE block (a day opened mid-thought, indented, before
//       any headline): block_id falls back to the first member line id, and
//       the model verdict comes back keyed on it.
//   (E) ZERO CLAUDE PROCESSES spawned across the whole run (before/after
//       pgrep snapshot).
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-gate-check.db node scripts/notepad-gate-check.mjs

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

console.log(`[notepad-gate-check] DB: ${DB_PATH}`);

function claudeProcessCount() {
  try {
    const out = execSync("pgrep -c -f claude", { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch (err) {
    // pgrep exits 1 when nothing matches — that's zero, not a failure.
    if (err && err.status === 1) return 0;
    throw err;
  }
}

const spawnsBefore = claudeProcessCount();

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay, unscannedLines, markLineSeen, markLineActed, markLineDismissed } = await import(
  path.join(distDir, 'notepad.js')
);
const {
  prefilterGateCandidates,
  classifyGateSkip,
  classifyCandidateOrigin,
  assertModelSpawnAllowed,
  runNotepadGate,
} = await import(path.join(distDir, 'notepad-gate.js'));
const { setSetting } = await import(path.join(distDir, 'conversation-db.js'));

let failed = false;
let totalBlocksSeen = 0;
let totalCandidates = 0;
let totalDisposed = 0;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}
function findDisposedByHeadline(result, headline) {
  return result.disposed.find((d) => d.headline === headline);
}
function findCandidateByHeadline(result, headline) {
  return result.candidates.find((c) => c.headline === headline);
}

// == (A) an all-junk block is disposed WHOLESALE; a mixed block (junk +
// one real line) goes to the model whole ====================================
{
  const DAY = '2026-09-24';
  // Block 1: headline "Junk Topic" with every member line disposable.
  const junkHeadline = 'Junk Topic';
  const junkBlockLines = [junkHeadline, '  ', '  ##', '  ---', '  - ', '  https://example.com/some/path', '  hi'];
  // Block 2: headline "Mixed Topic" with junk members AND one real sentence.
  const mixedHeadline = 'Mixed Topic';
  const realSentence = '  Call Mike about the invoice tomorrow morning';
  const mixedBlockLines = [mixedHeadline, '  ', '  hi', realSentence];
  const lines = [...junkBlockLines, ...mixedBlockLines];
  putNotepadDay(DAY, lines.join('\n'));

  const result = prefilterGateCandidates(DAY);
  totalBlocksSeen += result.candidates.length + result.disposed.length;
  totalCandidates += result.candidates.length;
  totalDisposed += result.disposed.length;

  check('(A) exactly 2 blocks considered (2 headlines -> 2 blocks)', result.candidates.length + result.disposed.length === 2);

  const junkDisposed = findDisposedByHeadline(result, junkHeadline);
  check('(A) the all-junk block is disposed wholesale', junkDisposed !== undefined);
  check(
    '(A) the disposed block carries EVERY member line id, and a reason per member',
    junkDisposed !== undefined &&
      junkDisposed.member_line_ids.length === junkBlockLines.length &&
      junkDisposed.member_reasons.length === junkBlockLines.length &&
      junkDisposed.member_reasons.every((r) => typeof r === 'string'),
  );
  check('(A) the all-junk block is NOT a candidate', findCandidateByHeadline(result, junkHeadline) === undefined);

  const mixedCandidate = findCandidateByHeadline(result, mixedHeadline);
  check('(A) the mixed block (junk + one real line) goes to the model WHOLE', mixedCandidate !== undefined);
  check(
    '(A) the mixed block\'s rendered text includes every member, junk included',
    mixedCandidate !== undefined &&
      mixedCandidate.member_line_ids.length === mixedBlockLines.length &&
      mixedCandidate.text.includes(realSentence.trim()) &&
      mixedCandidate.text.includes('hi'),
  );
  check('(A) the mixed block is NOT disposed', findDisposedByHeadline(result, mixedHeadline) === undefined);
  check(
    '(A) block_id === headline_line_id for both blocks (both have a real headline)',
    mixedCandidate?.block_id === mixedCandidate?.headline_line_id &&
      junkDisposed?.block_id === junkDisposed?.headline_line_id,
  );
}

// == not_a_candidate: cover the per-line classifying predicate directly =====
// (unscannedLines() itself is untouched by the block move -- this predicate
// still operates per-line.)
{
  const DAY = '2026-09-24';
  check(
    '(not_a_candidate) a line id that is not one of the day\'s current candidates is classified not_a_candidate',
    classifyCandidateOrigin(DAY, 999999999) === 'not_a_candidate',
  );
  check(
    '(not_a_candidate) classifyGateSkip on real prose returns null (would pass)',
    classifyGateSkip('a perfectly normal sentence worth a look', 12) === null,
  );
}

// == (B) a day where every line is already seen/acted/dismissed at an
// UNCHANGED hash produces ZERO candidate blocks and ZERO disposed blocks --
// unscannedLines() filters upstream, exactly as it did before the block move.
{
  const DAY = '2026-09-25';
  const headline = 'Settled Topic';
  const child1 = '  This line will be marked seen and must stop appearing';
  const child2 = '  This line will be marked acted and must stop appearing';
  const child3 = '  This line will be marked dismissed and must stop appearing';
  putNotepadDay(DAY, [headline, child1, child2, child3].join('\n'));

  const before = prefilterGateCandidates(DAY);
  check('(B) before marking: one candidate block (the whole topic)', before.candidates.length === 1 && before.disposed.length === 0);
  totalBlocksSeen += 1;
  totalCandidates += before.candidates.length;

  const ids = unscannedLines(DAY);
  const headlineId = ids.find((l) => l.text === headline).line_id;
  const child1Id = ids.find((l) => l.text === child1).line_id;
  const child2Id = ids.find((l) => l.text === child2).line_id;
  const child3Id = ids.find((l) => l.text === child3).line_id;

  markLineSeen(headlineId);
  markLineSeen(child1Id);
  markLineActed(child2Id, 'cockpit:test-thread');
  markLineDismissed(child3Id, 'not needed');

  const after = prefilterGateCandidates(DAY);
  totalCandidates += after.candidates.length;
  totalDisposed += after.disposed.length;
  check(
    '(B) once every member line is settled at its current hash, the whole block drops out (0 candidates, 0 disposed)',
    after.candidates.length === 0 && after.disposed.length === 0,
  );
}

// == (C) notepad_gate_min_chars is honoured and re-read every call, at block
// granularity =================================================================
{
  const DAY = '2026-09-26';
  const headline = 'Short Topic';
  const midLine = '  word word word word'; // 19 normalized chars: > default 12, < 40
  putNotepadDay(DAY, [headline, midLine].join('\n'));

  const atDefault = prefilterGateCandidates(DAY);
  totalBlocksSeen += atDefault.candidates.length + atDefault.disposed.length;
  totalCandidates += atDefault.candidates.length;
  totalDisposed += atDefault.disposed.length;
  check(
    '(C) at default min_chars (12): the headline + 19-char child forms one candidate block',
    findCandidateByHeadline(atDefault, headline) !== undefined,
  );

  setSetting('notepad_gate_min_chars', '40');
  const atRaised = prefilterGateCandidates(DAY);
  totalCandidates += atRaised.candidates.length;
  totalDisposed += atRaised.disposed.length;
  check(
    '(C) raising min_chars to 40 (no restart, no caching): the headline itself is too short too now, so the WHOLE block is disposed',
    findDisposedByHeadline(atRaised, headline) !== undefined && findCandidateByHeadline(atRaised, headline) === undefined,
  );
  setSetting('notepad_gate_min_chars', '12');
}

// == (D) assertModelSpawnAllowed() throws under this scratch DB =============
{
  let threw = false;
  let message = '';
  try {
    assertModelSpawnAllowed();
  } catch (err) {
    threw = true;
    message = err.message;
  }
  check('(D) assertModelSpawnAllowed() throws in this scratch environment', threw);
  check('(D) the thrown message names the offending JARVIS_DB_PATH', message.includes(DB_PATH));
  check('(D) the thrown message identifies itself as [notepad-gate]', message.includes('[notepad-gate]'));
  console.log(`  guard message: ${message}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// runNotepadGate — the MODEL half of the gate (src/notepad-gate.ts), now
// block-keyed. Every case below drives the injection seam (opts.runOneShot)
// so NOTHING here ever spawns a real claude process -- that is proven, not
// assumed, by the before/after pgrep snapshot at the very end of this file
// covering the WHOLE run, cases F-K included.
// ═══════════════════════════════════════════════════════════════════════════

setSetting('notepad_gate_min_chars', '12');

let gateStubCalls = 0;
let gateFallbackTotal = 0;
let gateModelTotal = 0;

/** Wrap a stub so every invocation is counted toward the final summary. */
function countedStub(fn) {
  return async (prompt) => {
    gateStubCalls += 1;
    return fn(prompt);
  };
}

function tallyGateVerdicts(verdicts) {
  for (const v of verdicts) {
    if (v.reason === 'model') gateModelTotal += 1;
    else if (v.reason === 'fallback') gateFallbackTotal += 1;
  }
}

// == (F) well-formed stub response: correct verdicts, and the CAPTURED
// PROMPT proves the prefilter actually gated what reached the model -- both
// surviving blocks' headline+text are in it, the disposed all-junk block's
// text is NOT. ================================================================
{
  const DAY = '2026-09-27';
  const junkHeadline = 'All Junk';
  const junkLine = '  https://example.com/junk/should/never/reach/the/model';
  const topic1 = 'Email Vendor';
  const topic1Line = '  Email the vendor about the invoice today';
  const topic2 = 'Draft Report';
  const topic2Line = '  Draft the quarterly report before Friday';
  putNotepadDay(DAY, [junkHeadline, junkLine, topic1, topic1Line, topic2, topic2Line].join('\n'));

  const pre = prefilterGateCandidates(DAY);
  totalBlocksSeen += pre.candidates.length + pre.disposed.length;
  totalCandidates += pre.candidates.length;
  totalDisposed += pre.disposed.length;
  check('(F) the all-junk block is disposed, not passed as a candidate', findCandidateByHeadline(pre, junkHeadline) === undefined);
  const id1 = findCandidateByHeadline(pre, topic1)?.block_id;
  const id2 = findCandidateByHeadline(pre, topic2)?.block_id;
  check('(F) both real topic blocks survived the prefilter as candidates', Number.isInteger(id1) && Number.isInteger(id2));

  let capturedPrompt = null;
  const stub = countedStub(async (prompt) => {
    capturedPrompt = prompt;
    return JSON.stringify({
      verdicts: [
        { block_id: id1, complete_thought: true },
        { block_id: id2, complete_thought: false },
      ],
    });
  });

  const verdicts = await runNotepadGate(DAY, { runOneShot: stub });
  tallyGateVerdicts(verdicts);

  const v1 = verdicts.find((v) => v.block_id === id1);
  const v2 = verdicts.find((v) => v.block_id === id2);
  check('(F) topic1 block gets the model verdict true, reason model', v1?.complete_thought === true && v1?.reason === 'model');
  check('(F) topic2 block gets the model verdict false, reason model', v2?.complete_thought === false && v2?.reason === 'model');
  check('(F) the disposed all-junk block still reports via reason prefilter', verdicts.some((v) => v.reason === 'prefilter'));
  check('(F) captured prompt is non-null (the stub was actually invoked)', typeof capturedPrompt === 'string' && capturedPrompt.length > 0);
  check(
    '(F) captured prompt contains BOTH surviving blocks (headline text + block_id)',
    capturedPrompt.includes(topic1) && capturedPrompt.includes(topic2) && capturedPrompt.includes(String(id1)) && capturedPrompt.includes(String(id2)),
  );
  check(
    '(F) captured prompt does NOT contain the disposed all-junk block\'s headline -- the prefilter actually gated the spend',
    !capturedPrompt.includes(junkHeadline),
  );
  check(
    '(F) captured prompt renders each surviving block\'s member lines with their [line_id N] prefix',
    /\[line_id \d+\]/.test(capturedPrompt),
  );
}

// == (G) a stub returning non-JSON garbage: every candidate block degrades to
// complete_thought:false/reason:fallback, and the function RESOLVES rather
// than rejecting. ============================================================
{
  const DAY = '2026-09-28';
  const h1 = 'Buy Stamps';
  const l1 = '  Buy stamps for the mailer campaign';
  const h2 = 'Confirm Meeting';
  const l2 = '  Confirm the meeting time with Sarah';
  putNotepadDay(DAY, [h1, l1, h2, l2].join('\n'));
  const pre = prefilterGateCandidates(DAY);
  totalBlocksSeen += pre.candidates.length;
  totalCandidates += pre.candidates.length;

  let rejected = false;
  let verdicts = null;
  try {
    verdicts = await runNotepadGate(DAY, { runOneShot: countedStub(async () => 'not json at all') });
  } catch {
    rejected = true;
  }
  check('(G) runNotepadGate RESOLVES rather than rejecting on a garbage response', !rejected);
  check('(G) exactly 2 verdicts came back (one per real candidate block)', Array.isArray(verdicts) && verdicts.length === 2);
  check(
    '(G) both candidate blocks degrade to complete_thought:false, reason:fallback',
    Array.isArray(verdicts) && verdicts.every((v) => v.complete_thought === false && v.reason === 'fallback'),
  );
  if (Array.isArray(verdicts)) tallyGateVerdicts(verdicts);
}

// == (H) a well-formed JSON response that OMITS one candidate block's
// block_id: that block falls back to false/fallback while the OTHER keeps
// its real model answer -- proves the fallback is per-block, not all-or-
// nothing. =====================================================================
{
  const DAY = '2026-09-29';
  const h1 = 'Pack Boxes';
  const l1 = '  Pack the boxes before the movers arrive';
  const h2 = 'Call Bank';
  const l2 = '  Call the bank about the wire transfer';
  putNotepadDay(DAY, [h1, l1, h2, l2].join('\n'));
  const pre = prefilterGateCandidates(DAY);
  totalCandidates += pre.candidates.length;
  const id1 = findCandidateByHeadline(pre, h1)?.block_id;
  const id2 = findCandidateByHeadline(pre, h2)?.block_id;

  const stub = countedStub(async () => JSON.stringify({ verdicts: [{ block_id: id1, complete_thought: true }] })); // id2 omitted on purpose
  const verdicts = await runNotepadGate(DAY, { runOneShot: stub });
  tallyGateVerdicts(verdicts);

  const v1 = verdicts.find((v) => v.block_id === id1);
  const v2 = verdicts.find((v) => v.block_id === id2);
  check('(H) the block_id present in the response keeps its real model verdict', v1?.complete_thought === true && v1?.reason === 'model');
  check('(H) the OMITTED block_id falls back to false/fallback', v2?.complete_thought === false && v2?.reason === 'fallback');
}

// == (I) a stub that REJECTS (simulated CLI failure) and a stub that HANGS
// past timeoutMs: both degrade to the safe fallback answer rather than
// throwing, and the timeout case finishes promptly (small timeoutMs) rather
// than hanging this whole check run. =========================================
{
  const DAY = '2026-09-30';
  const h1 = 'Ship Part';
  const l1 = '  Ship the replacement part overnight';
  putNotepadDay(DAY, [h1, l1].join('\n'));
  const pre = prefilterGateCandidates(DAY);
  totalCandidates += pre.candidates.length;

  const rejectStub = countedStub(async () => {
    throw new Error('simulated CLI failure');
  });
  const verdictsReject = await runNotepadGate(DAY, { runOneShot: rejectStub });
  tallyGateVerdicts(verdictsReject);
  check(
    '(I) a REJECTING stub degrades to fallback rather than throwing out of runNotepadGate',
    verdictsReject.length === 1 && verdictsReject[0].complete_thought === false && verdictsReject[0].reason === 'fallback',
  );
}
{
  const DAY = '2026-10-01';
  const h1 = 'Renew Domain';
  const l1 = '  Renew the domain registration before it lapses';
  putNotepadDay(DAY, [h1, l1].join('\n'));
  const pre = prefilterGateCandidates(DAY);
  totalCandidates += pre.candidates.length;

  const hangStub = countedStub(() => new Promise(() => {})); // never resolves or rejects
  const startedAt = Date.now();
  const verdictsHang = await runNotepadGate(DAY, { runOneShot: hangStub, timeoutMs: 200 });
  const elapsedMs = Date.now() - startedAt;
  tallyGateVerdicts(verdictsHang);
  check(
    '(I) a HANGING stub past timeoutMs degrades to fallback rather than throwing',
    verdictsHang.length === 1 && verdictsHang[0].complete_thought === false && verdictsHang[0].reason === 'fallback',
  );
  check(`(I) the timeout finished promptly (${elapsedMs}ms, well under 2000ms) -- did not hang the suite`, elapsedMs < 2000);
}

// == (J) the REAL path (no opts.runOneShot at all) throws synchronously OUT
// of runNotepadGate under THIS scratch DB, BEFORE any spawn is attempted --
// proves the guard sits ahead of the try/catch rather than being caught and
// silently downgraded to an all-fallback verdict that would read as a
// passing sim. ================================================================
{
  const DAY = '2026-10-02';
  const h1 = 'Dentist';
  const l1 = '  Schedule the dentist appointment for next week';
  putNotepadDay(DAY, [h1, l1].join('\n'));
  const pre = prefilterGateCandidates(DAY);
  totalCandidates += pre.candidates.length;

  let threwReal = false;
  let msgReal = '';
  try {
    await runNotepadGate(DAY); // no stub -- takes the real defaultRunOneShot path
  } catch (err) {
    threwReal = true;
    msgReal = err instanceof Error ? err.message : String(err);
  }
  check('(J) the REAL path (no stub) throws before spawning, under this scratch DB', threwReal);
  check('(J) the thrown message is the notepad-gate spawn guard', msgReal.includes('[notepad-gate]'));
}

// == (K) a JSON response claiming a block_id that was NEVER sent to the
// model is ignored, not trusted -- the real candidate still gets its
// verdict, and the phantom id never appears anywhere in the output. =========
{
  const DAY = '2026-10-03';
  const h1 = 'Water Plants';
  const l1 = '  Water the office plants twice this week';
  putNotepadDay(DAY, [h1, l1].join('\n'));
  const pre = prefilterGateCandidates(DAY);
  totalCandidates += pre.candidates.length;
  const realId = findCandidateByHeadline(pre, h1)?.block_id;
  const phantomId = realId + 999999; // never sent as a candidate

  const stub = countedStub(async () =>
    JSON.stringify({
      verdicts: [
        { block_id: realId, complete_thought: true },
        { block_id: phantomId, complete_thought: true },
      ],
    }),
  );
  const verdicts = await runNotepadGate(DAY, { runOneShot: stub });
  tallyGateVerdicts(verdicts);

  const realVerdict = verdicts.find((v) => v.block_id === realId);
  check('(K) the real candidate block gets its model verdict', realVerdict?.complete_thought === true && realVerdict?.reason === 'model');
  check('(K) exactly one verdict came back (the phantom id was not added as a second one)', verdicts.length === 1);
  check('(K) the phantom block_id never appears anywhere in the verdicts', !verdicts.some((v) => v.block_id === phantomId));
}

// == (L) a NULL-HEADLINE block (Kevin opened the day mid-thought, indented,
// before typing any topic headline): block_id falls back to the FIRST member
// line's id, headline_line_id stays null, and the model verdict comes back
// keyed on that same id. This is the one identity branch the cases above
// never touch, and it is exactly how a real morning's first lines look. =====
{
  const DAY = '2026-10-04';
  const leadIn1 = '  - picking up the suppression thread from last night';
  const leadIn2 = '      - six sources still are not suppressing at all';
  const laterHeadline = 'Flight Deck';
  const laterChild = '  - the turn model needs a next_action per workstream';
  putNotepadDay(DAY, [leadIn1, leadIn2, laterHeadline, laterChild].join('\n'));

  const pre = prefilterGateCandidates(DAY);
  totalBlocksSeen += pre.candidates.length + pre.disposed.length;
  totalCandidates += pre.candidates.length;
  totalDisposed += pre.disposed.length;

  const nullBlock = pre.candidates.find((c) => c.headline === null);
  check('(L) the indented lead-in forms a candidate block with headline === null', nullBlock !== undefined && nullBlock.headline_line_id === null);
  const firstMemberId = unscannedLines(DAY).find((l) => l.text === leadIn1)?.line_id;
  check('(L) its block_id falls back to the FIRST member line id', nullBlock?.block_id === firstMemberId);
  check('(L) it holds BOTH lead-in lines and stops before the later headline', nullBlock?.member_line_ids.length === 2);
  check('(L) the later headline is its OWN separate candidate block', pre.candidates.some((c) => c.headline === laterHeadline));

  const stub = countedStub(async () => JSON.stringify({ verdicts: [{ block_id: nullBlock?.block_id, complete_thought: true }] }));
  const verdicts = await runNotepadGate(DAY, { runOneShot: stub });
  tallyGateVerdicts(verdicts);
  const vNull = verdicts.find((v) => v.block_id === nullBlock?.block_id);
  check('(L) the null-headline block gets a real model verdict keyed on that block_id', vNull?.complete_thought === true && vNull?.reason === 'model');
  check('(L) its verdict carries headline_line_id null and both member line ids', vNull?.headline_line_id === null && vNull?.member_line_ids.length === 2);
}

// == (E) zero claude processes spawned across the entire run =================
const spawnsAfter = claudeProcessCount();
console.log(`  claude processes before: ${spawnsBefore}  after: ${spawnsAfter}`);
check('(E) the claude process count did not increase across this run', spawnsAfter <= spawnsBefore);

console.log(
  `\nblocks: ${totalBlocksSeen}  candidates: ${totalCandidates}  disposed: ${totalDisposed}  ` +
    `model_calls: ${gateStubCalls} (stubbed)  fallbacks: ${gateFallbackTotal}  ` +
    `claude_spawns: ${Math.max(0, spawnsAfter - spawnsBefore)}  violations: ${failed ? 'yes' : 0}`,
);
console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
