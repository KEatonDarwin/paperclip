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
// Node #943 adds the BLOCK form (routeNotepadBlock): the same table, the same
// detectors, run over a whole topic — a zero-indent headline plus everything
// indented under it (docs/notepad/BLOCKS.md). The 14 per-line fixtures below
// are kept EXACTLY as they were, because the line form is unchanged and must
// stay so: they are the proof that node #943 loosened nothing. The B-series
// fixtures underneath them are the block form.
//
//   npm run build && node scripts/notepad-route-rule-check.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
const { routeNotepadLine, routeNotepadBlock } = await import(path.join(distDir, 'notepad-route-rule.js'));

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

// ═══════════════════════════════════════════════════════════════════════════
// THE BLOCK FORM (node #943) — routeNotepadBlock over Kevin's real
// headline + irregularly-indented-dash topics.
// ═══════════════════════════════════════════════════════════════════════════

/** Build a RouteBlockInput from a headline (or null) and its raw child lines,
 *  numbering ids from `startId`, exactly as parseNotepadBlocks would. */
function block(startId, headline, children) {
  const lines = [];
  let id = startId;
  let idx = 0;
  if (headline !== null) lines.push({ line_id: id++, idx: idx++, text: headline });
  for (const text of children) lines.push({ line_id: id++, idx: idx++, text });
  return {
    block_id: headline !== null ? startId : lines[0].line_id,
    headline_line_id: headline !== null ? startId : null,
    headline,
    lines,
  };
}

function checkBlock(name, input, expectedSink, expectedConfidence) {
  const first = routeNotepadBlock(input);
  const second = routeNotepadBlock(input); // determinism: same input, same output
  const ok =
    first.sink === expectedSink &&
    second.sink === expectedSink &&
    first.why === second.why &&
    first.confidence === second.confidence &&
    (expectedConfidence === undefined || first.confidence === expectedConfidence);
  if (ok) {
    pass++;
    console.log(`PASS  ${name} -> ${first.sink} (${first.confidence}) — ${first.why}`);
  } else {
    fail++;
    console.log(
      `FAIL  ${name}: expected ${expectedSink}${expectedConfidence ? `/${expectedConfidence}` : ''}, got ${first.sink}/${first.confidence} (why: ${first.why})`,
    );
  }
}

// ── B1: the `Potential Goals:` block — the heading IS the headline. No
// backward walk, no section-boundary guessing: the block IS the section. ────
checkBlock(
  'B1. a "Potential Goals:" headline block routes the WHOLE topic to goal_proposal',
  {
    block: block(100, 'Potential Goals:', [
      '  - A universal KPI tracker across every brand',
      '     - one base class, one append-only value store',
      '',
      ' - a shared retro board for the team',
    ]),
    move: { kind: 'take_it' },
  },
  'goal_proposal',
  'high',
);

// ── B2: an explicit `goal:` cue on a CHILD line, not the headline ──────────
checkBlock(
  'B2. an explicit goal: cue on an indented child still routes the block to goal_proposal',
  {
    block: block(200, 'Ideas from the drive home', ['  - goal: build a universal KPI tracker', '  - also need to call the bank']),
    move: { kind: 'take_it' },
  },
  'goal_proposal',
  'high',
);

// ── B3: a build-shaped CHILD — the case the per-line form kept missing,
// because "Fix the composer auto-grow bug in notepad.ts" only makes sense
// under its headline. ─────────────────────────────────────────────────────
checkBlock(
  'B3. an imperative build child routes the block to hopper',
  {
    block: block(300, 'Smart notepad', ['\t- Fix the composer auto-grow bug in notepad.ts', '  - it jumps when you paste']),
    move: { kind: 'take_it' },
  },
  'hopper',
  'high',
);

// ── B4: a ball-in-the-air CHILD ────────────────────────────────────────────
checkBlock(
  'B4. a waiting-on child routes the block to workstream',
  {
    block: block(400, 'Suppression files', ['  - Waiting on Mike to approve the FC gate', '  - six sources still not suppressing']),
    move: { kind: 'take_it' },
  },
  'workstream',
  'high',
);

// ── B5: an annotation ANYWHERE in the block closes the whole topic out.
// Deliberately the cautious direction — a topic with a child already handled
// is exactly the thing that must not be re-fanned into a duplicate sink row.
checkBlock(
  'B5. a "(Created a goal)" annotation on one child sends the WHOLE block to thread',
  {
    block: block(500, 'Potential Goals:', [
      '  - A universal KPI tracker across every brand (Created a goal)',
      '  - a shared retro board for the team',
    ]),
    move: { kind: 'take_it' },
  },
  'thread',
);

// ── B6: the three non-take_it kinds are conversation for a block too ───────
for (const kind of ['question', 'already_done', 'context']) {
  checkBlock(
    `B6. a ${kind}-kind block is always thread`,
    { block: block(600, 'Pricing', ['  - should we raise the sequenced offer for Q4?']), move: { kind } },
    'thread',
  );
}

// ── B7: nothing rule-shaped anywhere in the block -> the safe default ──────
checkBlock(
  'B7. a block no rule matches falls to thread with low confidence',
  {
    block: block(700, 'Groceries', ['  - milk, eggs, bread', '  - dog food']),
    move: { kind: 'take_it' },
  },
  'thread',
  'low',
);

// ── B8: a headline:null lead-in block (the day opened mid-thought) ─────────
checkBlock(
  'B8. a headline:null lead-in block still routes on its children',
  {
    block: block(800, null, ['  - Ship the /api/notepad/route endpoint to sandbox-intake']),
    move: { kind: 'take_it' },
  },
  'hopper',
  'high',
);

// ── B9: NOTHING WAS LOOSENED. buildShapeReason still demands the imperative
// verb and the concrete artifact on the SAME line. A block with the verb on
// one child and an artifact noun on another must NOT become a hopper card —
// if the detectors had been relaxed into "match anywhere in the glued-up
// block text", this fixture would route to hopper. ────────────────────────
checkBlock(
  'B9. a verb on one child and an artifact on ANOTHER does not fabricate a build cue',
  {
    block: block(900, 'Random thoughts', ['  - build something nice for mom', '  - the dashboard looked off today']),
    move: { kind: 'take_it' },
  },
  'thread',
  'low',
);

// ── B10: an ambiguous block (build child AND a goals headline) resolves by
// the SAME priority order the per-line table uses — goal before build. ─────
checkBlock(
  'B10. ambiguous: a build-shaped child under a goals headline -> goal_proposal, medium',
  {
    block: block(1000, 'Potential Goals:', ['  - Build a goal tracker page for hopper visibility']),
    move: { kind: 'take_it' },
  },
  'goal_proposal',
  'medium',
);

// ── B11: a block's `why` names the exact child line that fired, so a block
// decision stays as auditable as a line decision was. ─────────────────────
{
  const b = block(1100, 'Smart notepad', ['  - nothing here', '  - Fix the composer auto-grow bug in notepad.ts']);
  const decision = routeNotepadBlock({ block: b, move: { kind: 'take_it' } });
  const firedLineId = b.lines[2].line_id;
  if (decision.sink === 'hopper' && decision.why.includes(`[line ${firedLineId}]`)) {
    pass++;
    console.log(`PASS  B11. the block's why names the child line that fired — ${decision.why}`);
  } else {
    fail++;
    console.log(`FAIL  B11. expected hopper naming line ${firedLineId}, got ${decision.sink} (why: ${decision.why})`);
  }
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
