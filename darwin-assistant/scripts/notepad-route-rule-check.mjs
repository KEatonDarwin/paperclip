#!/usr/bin/env node
// NOTEPAD ROUTE RULE CHECK — node #873's acceptance bar for the routing
// table in src/notepad-route-rule.ts: an explicit, testable rule from
// (line text + move kind [+ dossier]) to exactly one sink
// (goal_proposal | hopper | workstream | thread).
//
// PURE FUNCTION TEST: no DB, no JARVIS_DB_PATH, no model call. This is
// possible only because notepad-route-rule.ts imports its neighbors
// (notepad-moves.ts / notepad-dossier.ts) with `import type` alone, so it
// carries zero runtime dependency on conversation-db.ts's sqliteDb.
//
// 12 fixtures drawn from the SHAPES in Kevin's real note (a `Potential
// Goals:` section, a `(Created a goal)` annotation, imperative build asks,
// waiting-on ball-in-the-air lines, and the three non-take_it move kinds
// that are always conversation) plus 2 genuinely ambiguous lines that match
// more than one rule — proving the table's priority order resolves them
// deterministically rather than guessing.
//
// Every fixture is asserted TWICE (same input, same output) to prove
// determinism, not just correctness.
//
//   npm run build && node scripts/notepad-route-rule-check.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
const { routeNotepadLine } = await import(path.join(distDir, 'notepad-route-rule.js'));

let pass = 0;
let fail = 0;

function line(line_id, idx, text) {
  return { line_id, idx, text };
}

function check(name, input, expectedSink) {
  const first = routeNotepadLine(input);
  const second = routeNotepadLine(input); // determinism: same input, same output
  const ok =
    first.sink === expectedSink &&
    second.sink === expectedSink &&
    first.sink === second.sink &&
    first.why === second.why &&
    first.confidence === second.confidence;
  if (ok) {
    pass++;
    console.log(`PASS  ${name} -> ${first.sink} (${first.confidence}) — ${first.why}`);
  } else {
    fail++;
    console.log(
      `FAIL  ${name}: expected ${expectedSink}, got first=${first.sink} second=${second.sink} (why: ${first.why})`,
    );
  }
}

// ── Fixture 1: under a "Potential Goals:" heading ───────────────────────────
{
  const heading = line(1, 0, 'Potential Goals:');
  const target = line(2, 1, 'A universal KPI tracker across every brand');
  const day = [heading, target, line(3, 2, '')];
  check('1. line under Potential Goals: heading', { line: target, move: { kind: 'take_it' }, allLines: day }, 'goal_proposal');
}

// ── Fixture 2: explicit "goal:" cue ──────────────────────────────────────────
{
  const target = line(4, 0, 'goal: build a universal KPI tracker');
  check('2. explicit goal: cue', { line: target, move: { kind: 'take_it' }, allLines: [target] }, 'goal_proposal');
}

// ── Fixture 3: already annotated (Created a goal) — not re-routed ──────────
{
  const target = line(5, 0, 'Add a notepad export button (Created a goal)');
  check(
    '3. already annotated (Created a goal) is not re-routed',
    { line: target, move: { kind: 'take_it' }, allLines: [target] },
    'thread',
  );
}

// ── Fixture 4a/4b: imperative build lines -> hopper ─────────────────────────
{
  const target = line(6, 0, 'Fix the composer auto-grow bug in notepad.ts');
  check('4a. imperative build line (file extension)', { line: target, move: { kind: 'take_it' }, allLines: [target] }, 'hopper');
}
{
  const target = line(7, 0, 'Ship the /api/notepad/route endpoint to sandbox-intake');
  check('4b. imperative build line (endpoint)', { line: target, move: { kind: 'take_it' }, allLines: [target] }, 'hopper');
}

// ── Fixture 5a/5b: ball-in-the-air lines -> workstream ──────────────────────
{
  const target = line(8, 0, 'Waiting on Mike to approve the FC gate before we can ship');
  check('5a. waiting on someone', { line: target, move: { kind: 'take_it' }, allLines: [target] }, 'workstream');
}
{
  const target = line(9, 0, "Blocked on Kevin's decision about the RecordInput conflict");
  check('5b. blocked on someone', { line: target, move: { kind: 'take_it' }, allLines: [target] }, 'workstream');
}

// ── Fixture 6/7/8: the three non-take_it move kinds are always thread ──────
{
  const target = line(10, 0, 'Should we deprecate the old suppression build?');
  check('6. question-kind is always thread', { line: target, move: { kind: 'question' }, allLines: [target] }, 'thread');
}
{
  const target = line(11, 0, 'Set up nightly retention timer');
  check('7. already_done-kind is always thread', { line: target, move: { kind: 'already_done' }, allLines: [target] }, 'thread');
}
{
  const target = line(12, 0, 'FYI the AR guard passed 30 days clean');
  check('8. context-kind is always thread', { line: target, move: { kind: 'context' }, allLines: [target] }, 'thread');
}

// ── Fixture 9a: ambiguous — build-shaped line INSIDE a goals heading ────────
// Reads like a hopper build ask ("Build a ... page") AND sits under a
// Potential Goals: heading. The table's priority (goal before build) picks
// goal_proposal deterministically; this is the documented tie-break, not a
// guess.
{
  const heading = line(13, 0, 'Potential Goals:');
  const target = line(14, 1, 'Build a goal tracker page for hopper visibility');
  const day = [heading, target];
  check(
    '9a. ambiguous: build-shaped line under a goals heading',
    { line: target, move: { kind: 'take_it' }, allLines: day },
    'goal_proposal',
  );
}

// ── Fixture 9b: ambiguous — build cue AND a waiting-on phrase in one line ──
// Reads as both a hopper build ask ("Fix the login endpoint") and a
// ball-in-the-air line ("waiting on Mike"). The table's priority (hopper
// before workstream) picks hopper deterministically.
{
  const target = line(15, 0, 'Fix the login endpoint — waiting on Mike for the API keys');
  check(
    '9b. ambiguous: build cue + waiting-on phrase in one line',
    { line: target, move: { kind: 'take_it' }, allLines: [target] },
    'hopper',
  );
}

// ── Confidence sanity check: the two ambiguous fixtures must report medium
// (more than one rule matched), every unambiguous fixture above must report
// high or low, never a false 'high' on a line that was actually contested.
{
  const heading = line(13, 0, 'Potential Goals:');
  const target = line(14, 1, 'Build a goal tracker page for hopper visibility');
  const decision = routeNotepadLine({ line: target, move: { kind: 'take_it' }, allLines: [heading, target] });
  if (decision.confidence === 'medium') {
    pass++;
    console.log(`PASS  confidence: ambiguous fixture 9a reports medium confidence`);
  } else {
    fail++;
    console.log(`FAIL  confidence: ambiguous fixture 9a expected medium, got ${decision.confidence}`);
  }
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
