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
const { prefilterGateCandidates, classifyGateSkip, classifyCandidateOrigin, assertModelSpawnAllowed } = await import(
  path.join(distDir, 'notepad-gate.js')
);
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

// == (E) zero claude processes spawned across the entire run =================
const spawnsAfter = claudeProcessCount();
console.log(`  claude processes before: ${spawnsBefore}  after: ${spawnsAfter}`);
check('(E) the claude process count did not increase across this run', spawnsAfter <= spawnsBefore);

console.log(
  `\nlines: ${totalLines}  candidates: ${totalCandidates}  disposed: ${totalDisposed}  ` +
    `claude_spawns: ${Math.max(0, spawnsAfter - spawnsBefore)}  violations: ${failed ? 'yes' : 0}`,
);
console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
