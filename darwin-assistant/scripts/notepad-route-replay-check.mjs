#!/usr/bin/env node
// NOTEPAD ROUTE REPLAY CHECK — node #1066's acceptance bar: teach
// notepad-route-rule.ts's BLOCK detectors Kevin's actual handwriting, then
// prove it by replaying every real topic block from his two captured days
// (scripts/fixtures/notepad-real-days.json / notepad-real-blocks.json)
// through the REAL compiled dist/notepad-route-rule.js and asserting each
// lands on its labelled `expected_sink`.
//
// PURE FUNCTION TEST: no DB, no JARVIS_DB_PATH, no JARVIS_SIM, zero model
// calls — routeNotepadBlock is deterministic (import type only on its
// neighbors), that is the whole point of this layer.
//
// Every block is fed as move.kind: 'take_it'. Move-kind classification
// (question / already_done / context / take_it) is a SEPARATE, already-built
// and already-tested stage (notepad-moves.ts's decideNotepadMoves, one
// model call over the whole day) — this check is exclusively about what the
// deterministic table does with a block ONCE it is take_it-eligible, so a
// "Testing Tool??" or "Ran all last night" block is evaluated exactly the
// same as everything else and must earn its own way to `thread` through a
// detector, not by us handing it a different move.kind. dossier is passed
// null uniformly for the same reason: node #1065's dossier-goal path is its
// own already-tested pure function (notepad-dossier-check.mjs /
// notepad-marker-route-check.mjs) — this file isolates node #1066's actual
// job, the BLOCK_ROUTE_RULES shape detectors, from both neighbors.
//
// The BEFORE/AFTER confidence comparison below runs the SAME 29 blocks
// through the REAL pre-#1066 table (commit 84f1e7c5f, the last commit before
// this node's fix — transpiled in-process from git history, not hand
// reconstructed) to prove, with actual counts, that "every take_it block
// defaults to thread at low confidence" was true before this fix and is no
// longer true after it.
//
//   npm run build && node scripts/notepad-route-replay-check.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

// Only allow these clean envs — this check makes zero model calls, but
// mirrors the discipline every other notepad check script uses.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, 'fixtures');
const darwinAssistantDir = path.join(__dirname, '..');
const repoRoot = path.join(darwinAssistantDir, '..');

const { routeNotepadBlock } = await import(path.join(darwinAssistantDir, 'dist', 'notepad-route-rule.js'));

// ── BEFORE: the real pre-#1066 table, transpiled from git history ──────────
// notepad-route-rule.ts has ZERO runtime dependencies (only `import type` on
// its neighbors), so a bare per-file transpile — no project-wide tsc, no
// other source files needed — is enough to get a runnable legacy module.
const LEGACY_COMMIT = '84f1e7c5f'; // "route to the goal the dossier already found" — HEAD immediately before this node's fix
const legacySource = execFileSync(
  'git',
  ['show', `${LEGACY_COMMIT}:darwin-assistant/src/notepad-route-rule.ts`],
  { cwd: repoRoot, encoding: 'utf8' },
);
const { outputText } = ts.transpileModule(legacySource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
  },
  fileName: 'notepad-route-rule-legacy.ts',
});
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notepad-route-legacy-'));
const legacyPath = path.join(tmpDir, 'notepad-route-rule-legacy.cjs');
fs.writeFileSync(legacyPath, outputText);
const { routeNotepadBlock: legacyRouteNotepadBlock } = await import(pathToFileURL(legacyPath).href);
fs.rmSync(tmpDir, { recursive: true, force: true });

// ── fixtures ─────────────────────────────────────────────────────────────
const daysFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'notepad-real-days.json'), 'utf8'));
const blocksFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'notepad-real-blocks.json'), 'utf8'));

function buildBlockInput(dayLines, blockData) {
  const byId = new Map(dayLines.map((l) => [l.line_id, l]));
  const lines = blockData.member_line_ids.map((id) => {
    const l = byId.get(id);
    if (!l) throw new Error(`fixture inconsistency: line ${id} not found in day for block ${blockData.block_id}`);
    return { line_id: l.line_id, idx: l.sort_order, text: l.text };
  });
  return {
    block_id: blockData.block_id,
    headline_line_id: blockData.block_id,
    headline: blockData.headline,
    lines,
  };
}

const TAKE_IT = {
  kind: 'take_it',
  reason:
    'replay check: every real block is evaluated as take_it-eligible here — move-kind classification is notepad-moves.ts, a separate, already-tested stage',
};

let mismatches = 0;
const rows = [];
let lowBefore = 0;
let lowAfter = 0;
const confDeltaBefore = { high: 0, medium: 0, low: 0 };
const confDeltaAfter = { high: 0, medium: 0, low: 0 };

for (const day of daysFixture.days) {
  const blockDay = blocksFixture.days.find((d) => d.day === day.day);
  if (!blockDay) {
    console.error(`FATAL: no blocks fixture for day ${day.day}`);
    process.exit(1);
  }
  for (const blockData of blockDay.blocks) {
    const input = buildBlockInput(day.lines, blockData);
    const before = legacyRouteNotepadBlock({ block: input, move: TAKE_IT, dossier: null });
    const after = routeNotepadBlock({ block: input, move: TAKE_IT, dossier: null });

    confDeltaBefore[before.confidence] = (confDeltaBefore[before.confidence] ?? 0) + 1;
    confDeltaAfter[after.confidence] = (confDeltaAfter[after.confidence] ?? 0) + 1;
    if (before.confidence === 'low') lowBefore++;
    if (after.confidence === 'low') lowAfter++;

    if (blockData.expected_sink == null) {
      console.error(`FATAL: block ${blockData.block_id} (${blockData.headline}) has no expected_sink labelled — fill it in first`);
      process.exit(1);
    }

    const ok = after.sink === blockData.expected_sink;
    if (!ok) mismatches++;
    rows.push({
      ok,
      day: day.day,
      block_id: blockData.block_id,
      headline: blockData.headline,
      expected: blockData.expected_sink,
      actual: after.sink,
      confidence: after.confidence,
      before_confidence: before.confidence,
      why: after.why,
    });
  }
}

// ── per-block table ──────────────────────────────────────────────────────
console.log(
  'STATUS | DAY         | BLOCK | HEADLINE                                  | EXPECTED      | ACTUAL        | CONF   | WHY',
);
console.log('-'.repeat(160));
for (const r of rows) {
  const status = r.ok ? 'OK  ' : 'FAIL';
  console.log(
    `${status}   | ${r.day} | ${String(r.block_id).padEnd(5)} | ${r.headline.padEnd(41)} | ${r.expected.padEnd(13)} | ${r.actual.padEnd(13)} | ${r.confidence.padEnd(6)} | ${r.why}`,
  );
}

console.log('');
console.log(`${rows.length - mismatches}/${rows.length} blocks landed on their labelled expected_sink (${mismatches} mismatched)`);
console.log('');
console.log(`confidence distribution BEFORE (pre-#1066, commit ${LEGACY_COMMIT}): high=${confDeltaBefore.high ?? 0} medium=${confDeltaBefore.medium ?? 0} low=${confDeltaBefore.low ?? 0}`);
console.log(`confidence distribution AFTER  (this fix):                          high=${confDeltaAfter.high ?? 0} medium=${confDeltaAfter.medium ?? 0} low=${confDeltaAfter.low ?? 0}`);
console.log('');
console.log(`low-confidence decisions BEFORE: ${lowBefore}/${rows.length}`);
console.log(`low-confidence decisions AFTER:  ${lowAfter}/${rows.length}`);

let fail = mismatches > 0;

if (lowBefore !== rows.length) {
  console.error(
    `FAIL: expected EVERY real block to fall to thread at low confidence under the pre-#1066 table (the exact bug this node fixes) — got ${lowBefore}/${rows.length}`,
  );
  fail = true;
}
if (!(lowAfter < lowBefore)) {
  console.error(`FAIL: expected fewer low-confidence decisions after the fix — before=${lowBefore} after=${lowAfter}`);
  fail = true;
}

console.log('');
if (fail) {
  console.error('FAIL: notepad route replay check failed — see above');
  process.exit(1);
}
console.log('PASS: every real block landed on its labelled sink, and the low-confidence-by-default bug is measurably fixed');
