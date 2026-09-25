#!/usr/bin/env node
// NOTEPAD GATE CHECK — exercises the deterministic prefilter
// (src/notepad-gate.ts: prefilterGateCandidates/classifyGateSkip/
// classifyCandidateOrigin/assertModelSpawnAllowed) against a scratch
// jarvis.db. No HTTP, and — this is the point of the whole module — NO
// MODEL CALLS anywhere in this run.
//
// Covers:
//   (A) one line of EACH junk class (blank, heading, thematic break, bare
//       bullet, bare URL, too-short) plus two real sentences -> every junk
//       line disposed with the correct reason, both sentences pass, and
//       passed_count + disposed_count equals the lines considered.
//   (B) a line already marked seen/acted/dismissed with an UNCHANGED hash is
//       filtered out by unscannedLines() itself and therefore never reaches
//       the gate at all (absent from both candidates AND disposed).
//   (not_a_candidate) classifyCandidateOrigin against a line id that is not
//       one of the day's current unscannedLines() candidates.
//   (C) notepad_gate_min_chars is honoured and re-read on every call: a line
//       that passes at the default (12) is disposed too_short once the
//       setting is raised to 40 — no caching, no restart needed.
//   (D) assertModelSpawnAllowed() throws under this scratch DB, naming the
//       offending path in the message.
//   (E) ZERO CLAUDE PROCESSES spawned across the whole run (before/after
//       pgrep snapshot) — a green suite whose subject quietly spawns a
//       model is the exact failure class this project has already shipped
//       once (see src/sim-guard.ts's header comment).
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
let totalLines = 0;
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
function findDisposed(result, text) {
  return result.disposed.find((d) => d.text === text);
}

// == (A) one line of every junk class + two real sentences ===================
{
  const DAY = '2026-09-24';
  const blank = '';
  const heading = '##'; // a bare header marker with no title -- marker_only.
  // ("## Heading" WITH real title text is legitimate content, not junk --
  // that's the module's documented behavior, not a gap: only a header/
  // thematic-break/ordinal marker with NOTHING after it counts as junk.)
  const rule = '---';
  const bareBullet = '- ';
  const bareUrl = 'https://example.com/some/path';
  const tooShort = 'hello'; // 5 chars, under the default min of 12
  const sentence1 = 'Call Mike about the invoice tomorrow morning';
  const sentence2 = 'Review the PR before lunch and merge afterward';
  const lines = [blank, heading, rule, bareBullet, bareUrl, tooShort, sentence1, sentence2];
  putNotepadDay(DAY, lines.join('\n'));

  const result = prefilterGateCandidates(DAY);
  totalLines += lines.length;
  totalCandidates += result.candidates.length;
  totalDisposed += result.disposed.length;

  check('(A) blank line disposed with reason blank', findDisposed(result, blank)?.reason === 'blank');
  check('(A) bare "##" (no title) disposed with reason marker_only', findDisposed(result, heading)?.reason === 'marker_only');
  check('(A) "---" (thematic break) disposed with reason marker_only', findDisposed(result, rule)?.reason === 'marker_only');
  // A bare bullet with nothing after it normalizes (bullet-strip) to an empty
  // string, so the correct reason IS blank, not a distinct "bullet" reason —
  // this is the classifier's actual, correct behavior, not a shortcut.
  check('(A) bare "- " disposed with reason blank (bullet-strip leaves nothing)', findDisposed(result, bareBullet)?.reason === 'blank');
  check('(A) bare URL disposed with reason url_only', findDisposed(result, bareUrl)?.reason === 'url_only');
  check('(A) 5-char line disposed with reason too_short', findDisposed(result, tooShort)?.reason === 'too_short');
  check('(A) real sentence 1 passed through as a candidate', result.candidates.some((c) => c.text === sentence1));
  check('(A) real sentence 2 passed through as a candidate', result.candidates.some((c) => c.text === sentence2));
  check('(A) exactly 2 candidates, 6 disposed', result.candidates.length === 2 && result.disposed.length === 6);
  check(
    '(A) passed_count + disposed_count equals the lines considered',
    result.passed_count + result.disposed_count === lines.length &&
      result.passed_count === result.candidates.length &&
      result.disposed_count === result.disposed.length,
  );
}

// == not_a_candidate: cover the classifying predicate directly ===============
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

// == (B) a line already marked seen/acted/dismissed with an UNCHANGED hash ===
// is filtered out by unscannedLines() itself -- never becomes a candidate,
// and never even shows up in `disposed` (it's not a "considered" line at all
// once the ledger says it was already looked at with this exact text).
{
  const DAY = '2026-09-25';
  const seenLine = 'This line will be marked seen and must stop appearing';
  const actedLine = 'This line will be marked acted and must stop appearing';
  const dismissedLine = 'This line will be marked dismissed and must stop appearing';
  const untouched = 'This line is never marked and should keep appearing';
  putNotepadDay(DAY, [seenLine, actedLine, dismissedLine, untouched].join('\n'));

  const before = prefilterGateCandidates(DAY);
  check('(B) before marking: all 4 lines are candidates', before.candidates.length === 4 && before.disposed.length === 0);
  totalLines += 4;
  totalCandidates += before.candidates.length;

  const seenId = unscannedLines(DAY).find((l) => l.text === seenLine).line_id;
  const actedId = unscannedLines(DAY).find((l) => l.text === actedLine).line_id;
  const dismissedId = unscannedLines(DAY).find((l) => l.text === dismissedLine).line_id;

  markLineSeen(seenId);
  markLineActed(actedId, 'cockpit:test-thread');
  markLineDismissed(dismissedId, 'not needed');

  const after = prefilterGateCandidates(DAY);
  totalCandidates += after.candidates.length;
  totalDisposed += after.disposed.length;

  check('(B) seen line is gone from candidates', !after.candidates.some((c) => c.text === seenLine));
  check('(B) seen line is gone from disposed too (never reached the gate)', !after.disposed.some((d) => d.text === seenLine));
  check('(B) acted line is gone from candidates', !after.candidates.some((c) => c.text === actedLine));
  check('(B) acted line is gone from disposed too', !after.disposed.some((d) => d.text === actedLine));
  check('(B) dismissed line is gone from candidates', !after.candidates.some((c) => c.text === dismissedLine));
  check('(B) dismissed line is gone from disposed too', !after.disposed.some((d) => d.text === dismissedLine));
  check('(B) the untouched line still appears as a candidate', after.candidates.some((c) => c.text === untouched));
  check('(B) exactly 1 candidate and 0 disposed remain (the other 3 were filtered upstream)', after.candidates.length === 1 && after.disposed.length === 0);
}

// == (C) notepad_gate_min_chars is honoured and re-read every call ==========
{
  const DAY = '2026-09-26';
  const midLine = 'word word word word'; // 19 normalized chars: > default 12, < 40
  putNotepadDay(DAY, midLine);
  totalLines += 1;

  const atDefault = prefilterGateCandidates(DAY);
  totalCandidates += atDefault.candidates.length;
  totalDisposed += atDefault.disposed.length;
  check('(C) at default min_chars (12): the 19-char line passes', atDefault.candidates.some((c) => c.text === midLine));

  setSetting('notepad_gate_min_chars', '40');
  const atRaised = prefilterGateCandidates(DAY);
  totalCandidates += atRaised.candidates.length;
  totalDisposed += atRaised.disposed.length;
  check(
    '(C) raising min_chars to 40 (no restart, no caching): the SAME 19-char line is now disposed too_short',
    findDisposed(atRaised, midLine)?.reason === 'too_short',
  );
  check('(C) it is no longer a candidate at the raised threshold', !atRaised.candidates.some((c) => c.text === midLine));
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
// runNotepadGate — the MODEL half of the gate (src/notepad-gate.ts). Every
// case below drives the injection seam (opts.runOneShot) so NOTHING here
// ever spawns a real claude process -- that is proven, not assumed, by the
// before/after pgrep snapshot at the very end of this file covering the
// WHOLE run, cases F-K included.
// ═══════════════════════════════════════════════════════════════════════════

// Case (C) above left notepad_gate_min_chars persisted at 40 (this whole
// file shares one DB/settings-KV across every section, by design -- same as
// the pre-existing A-E cases). Reset it back to the module's own default
// before any of the sentences below are written, so a case here isn't
// silently at the mercy of an earlier section's setting mutation.
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
// PROMPT proves the prefilter actually gated what reached the model --
// every surviving candidate's text+line_id is in it, the disposed junk
// line's text is NOT. Without asserting on the captured prompt itself, the
// prefilter could be silently bypassed (candidates built from the full
// unfiltered line list) and this check would still look green. ==========
{
  const DAY = '2026-09-27';
  const junk = 'https://example.com/junk/should/never/reach/the/model';
  const sentence1 = 'Email the vendor about the invoice today';
  const sentence2 = 'Draft the quarterly report before Friday';
  putNotepadDay(DAY, [junk, sentence1, sentence2].join('\n'));

  const pre = prefilterGateCandidates(DAY);
  totalLines += 3;
  totalCandidates += pre.candidates.length;
  totalDisposed += pre.disposed.length;
  check('(F) the junk URL is disposed by the prefilter, not passed as a candidate', !pre.candidates.some((c) => c.text === junk));
  const id1 = pre.candidates.find((c) => c.text === sentence1)?.line_id;
  const id2 = pre.candidates.find((c) => c.text === sentence2)?.line_id;
  check('(F) both real sentences survived the prefilter as candidates', Number.isInteger(id1) && Number.isInteger(id2));

  let capturedPrompt = null;
  const stub = countedStub(async (prompt) => {
    capturedPrompt = prompt;
    return JSON.stringify({
      verdicts: [
        { line_id: id1, complete_thought: true },
        { line_id: id2, complete_thought: false },
      ],
    });
  });

  const verdicts = await runNotepadGate(DAY, { runOneShot: stub });
  tallyGateVerdicts(verdicts);

  const v1 = verdicts.find((v) => v.line_id === id1);
  const v2 = verdicts.find((v) => v.line_id === id2);
  check('(F) sentence1 gets the model verdict true, reason model', v1?.complete_thought === true && v1?.reason === 'model');
  check('(F) sentence2 gets the model verdict false, reason model', v2?.complete_thought === false && v2?.reason === 'model');
  check('(F) the disposed junk line still reports via reason prefilter', verdicts.some((v) => v.reason === 'prefilter'));
  check('(F) captured prompt is non-null (the stub was actually invoked)', typeof capturedPrompt === 'string' && capturedPrompt.length > 0);
  check(
    '(F) captured prompt contains BOTH surviving candidates (text + line_id)',
    capturedPrompt.includes(sentence1) && capturedPrompt.includes(sentence2) && capturedPrompt.includes(String(id1)) && capturedPrompt.includes(String(id2)),
  );
  check(
    '(F) captured prompt does NOT contain the disposed junk text -- the prefilter actually gated the spend',
    !capturedPrompt.includes(junk),
  );
}

// == (G) a stub returning non-JSON garbage: every candidate degrades to
// complete_thought:false/reason:fallback, and the function RESOLVES rather
// than rejecting -- a malformed model response must never blow up the
// caller. ====================================================================
{
  const DAY = '2026-09-28';
  const s1 = 'Buy stamps for the mailer campaign';
  const s2 = 'Confirm the meeting time with Sarah';
  putNotepadDay(DAY, [s1, s2].join('\n'));
  totalLines += 2;
  const pre = prefilterGateCandidates(DAY);
  totalCandidates += pre.candidates.length;

  let rejected = false;
  let verdicts = null;
  try {
    verdicts = await runNotepadGate(DAY, { runOneShot: countedStub(async () => 'not json at all') });
  } catch {
    rejected = true;
  }
  check('(G) runNotepadGate RESOLVES rather than rejecting on a garbage response', !rejected);
  check('(G) exactly 2 verdicts came back (one per real candidate)', Array.isArray(verdicts) && verdicts.length === 2);
  check(
    '(G) both candidates degrade to complete_thought:false, reason:fallback',
    Array.isArray(verdicts) && verdicts.every((v) => v.complete_thought === false && v.reason === 'fallback'),
  );
  if (Array.isArray(verdicts)) tallyGateVerdicts(verdicts);
}

// == (H) a well-formed JSON response that OMITS one candidate's line_id:
// that one line falls back to false/fallback while the OTHER keeps its
// real model answer -- proves the fallback is per-line, not all-or-
// nothing. =====================================================================
{
  const DAY = '2026-09-29';
  const s1 = 'Pack the boxes before the movers arrive';
  const s2 = 'Call the bank about the wire transfer';
  putNotepadDay(DAY, [s1, s2].join('\n'));
  totalLines += 2;
  const pre = prefilterGateCandidates(DAY);
  totalCandidates += pre.candidates.length;
  const id1 = pre.candidates.find((c) => c.text === s1)?.line_id;
  const id2 = pre.candidates.find((c) => c.text === s2)?.line_id;

  const stub = countedStub(async () => JSON.stringify({ verdicts: [{ line_id: id1, complete_thought: true }] })); // id2 omitted on purpose
  const verdicts = await runNotepadGate(DAY, { runOneShot: stub });
  tallyGateVerdicts(verdicts);

  const v1 = verdicts.find((v) => v.line_id === id1);
  const v2 = verdicts.find((v) => v.line_id === id2);
  check('(H) the line_id present in the response keeps its real model verdict', v1?.complete_thought === true && v1?.reason === 'model');
  check('(H) the OMITTED line_id falls back to false/fallback', v2?.complete_thought === false && v2?.reason === 'fallback');
}

// == (I) a stub that REJECTS (simulated CLI failure) and a stub that HANGS
// past timeoutMs: both degrade to the safe fallback answer rather than
// throwing, and the timeout case finishes promptly (small timeoutMs) rather
// than hanging this whole check run. =========================================
{
  const DAY = '2026-09-30';
  const s1 = 'Ship the replacement part overnight';
  putNotepadDay(DAY, s1);
  totalLines += 1;
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
  const s1 = 'Renew the domain registration before it lapses';
  putNotepadDay(DAY, s1);
  totalLines += 1;
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
  const s1 = 'Schedule the dentist appointment for next week';
  putNotepadDay(DAY, s1);
  totalLines += 1;
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

// == (K) a JSON response claiming a line_id that was NEVER sent to the
// model is ignored, not trusted -- the real candidate still gets its
// verdict, and the phantom id never appears anywhere in the output. =========
{
  const DAY = '2026-10-03';
  const s1 = 'Water the office plants twice this week';
  putNotepadDay(DAY, s1);
  totalLines += 1;
  const pre = prefilterGateCandidates(DAY);
  totalCandidates += pre.candidates.length;
  const realId = pre.candidates.find((c) => c.text === s1)?.line_id;
  const phantomId = realId + 999999; // never sent as a candidate

  const stub = countedStub(async () =>
    JSON.stringify({
      verdicts: [
        { line_id: realId, complete_thought: true },
        { line_id: phantomId, complete_thought: true },
      ],
    }),
  );
  const verdicts = await runNotepadGate(DAY, { runOneShot: stub });
  tallyGateVerdicts(verdicts);

  const realVerdict = verdicts.find((v) => v.line_id === realId);
  check('(K) the real candidate gets its model verdict', realVerdict?.complete_thought === true && realVerdict?.reason === 'model');
  check('(K) exactly one verdict came back (the phantom id was not added as a second one)', verdicts.length === 1);
  check('(K) the phantom line_id never appears anywhere in the verdicts', !verdicts.some((v) => v.line_id === phantomId));
}

// == (E) zero claude processes spawned across the entire run =================
const spawnsAfter = claudeProcessCount();
console.log(`  claude processes before: ${spawnsBefore}  after: ${spawnsAfter}`);
check('(E) the claude process count did not increase across this run', spawnsAfter <= spawnsBefore);

console.log(
  `\nlines: ${totalLines}  candidates: ${totalCandidates}  disposed: ${totalDisposed}  ` +
    `model_calls: ${gateStubCalls} (stubbed)  fallbacks: ${gateFallbackTotal}  ` +
    `claude_spawns: ${Math.max(0, spawnsAfter - spawnsBefore)}  violations: ${failed ? 'yes' : 0}`,
);
console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
