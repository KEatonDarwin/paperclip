#!/usr/bin/env node
// NOTEPAD REVIEW CHECK — exercises buildNotepadReviewContext (src/notepad-review.ts),
// the settle-and-reread pass's whole-note view over the line-state ledger
// (docs/notepad/LINE-IDENTITY.md §3/§4). No HTTP, no model calls, no claude spawns.
//
// Builds a five-state fixture (one line per case) plus a sixth line that is
// created then deleted before the context is built, and asserts:
//   (A) exactly the five surviving lines appear
//   (B) document order is preserved, both in `lines` and in `rendered`
//   (C) each line's `state` is exactly right (unseen resolves from a MISSING row)
//   (D) the acted line's action_ref appears verbatim in `lines` AND `rendered`
//   (E) the reconcile line renders distinctly from a first_look line, and still
//       carries its ORIGINAL action_ref verbatim
//   (F) the acted line's rendering is distinguishable from the unseen line's
//   (G) the deleted line appears nowhere in `lines` or `rendered`
//   (H) purity: two calls produce byte-identical `rendered`, and calling the
//       function does not itself change any line's ledger state
//   (I) zero claude spawns across the whole run
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-review-check.db node scripts/notepad-review-check.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
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

console.log(`[notepad-review-check] DB: ${DB_PATH}`);

function countClaudeProcs() {
  try {
    return parseInt(execSync("pgrep -c -f 'claude' || true", { encoding: 'utf8' }).trim() || '0', 10);
  } catch {
    return 0;
  }
}

const claudeBefore = countClaudeProcs();

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay, markLineSeen, markLineActed, markLineDismissed } = await import(
  path.join(distDir, 'notepad.js')
);
const { buildNotepadReviewContext } = await import(path.join(distDir, 'notepad-review.js'));

let failed = false;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
    failed = true;
  }
}

const DAY = '2026-09-25';
const ACTED_REF = 'cockpit:goal-6-node-99-probe';
const RECONCILE_REF = 'cockpit:goal-6-node-99-reconcile-probe';

// ── build the six-line fixture, in document order ────────────────────────────
const initial = putNotepadDay(
  DAY,
  [
    'unseen line — never looked at',
    'seen line — judged not actionable',
    'acted line — a real action was taken',
    'dismissed line — explicitly ruled out',
    'reconcile line — acted, then edited',
    'sixth line — will be deleted before review',
  ].join('\n')
);
assert.equal(initial.lines.length, 6, 'fixture must start with six lines');

const [unseenId, seenId, actedId, dismissedId, reconcileId, deleteId] = initial.lines.map((l) => l.id);

markLineSeen(seenId);
markLineActed(actedId, ACTED_REF);
markLineDismissed(dismissedId, 'not relevant to this probe');
markLineActed(reconcileId, RECONCILE_REF);

// Now: edit the reconcile line's text (hash changes -> surfaces as reconcile,
// carrying the ORIGINAL action_ref) and delete the sixth line entirely.
const after = putNotepadDay(
  DAY,
  [
    'unseen line — never looked at',
    'seen line — judged not actionable',
    'acted line — a real action was taken',
    'dismissed line — explicitly ruled out',
    'reconcile line — acted, then edited, meaning changed',
    // sixth line omitted -> deleted
  ].join('\n')
);
assert.equal(after.lines.length, 5, 'fixture must be five lines after the edit+delete');
// The line-identity diff must have preserved every surviving id (this is the
// premise the whole review module depends on — if this breaks, the fixture
// itself is invalid, not the module under test).
assert.equal(after.lines.find((l) => l.text.startsWith('unseen line'))?.id, unseenId);
assert.equal(after.lines.find((l) => l.text.startsWith('seen line'))?.id, seenId);
assert.equal(after.lines.find((l) => l.text.startsWith('acted line'))?.id, actedId);
assert.equal(after.lines.find((l) => l.text.startsWith('dismissed line'))?.id, dismissedId);
assert.equal(after.lines.find((l) => l.text.startsWith('reconcile line'))?.id, reconcileId);
assert.ok(!after.lines.some((l) => l.id === deleteId), 'sixth line must actually be gone');

// ── the real subject under test ───────────────────────────────────────────────
const ctx1 = buildNotepadReviewContext(DAY);

// (A) exactly five surviving lines
check('(A) all five surviving lines appear, lines.length === 5', ctx1.lines.length === 5, ctx1.lines.length);

// (B) document order: idx sequence, and order-of-appearance in `rendered`
{
  const idxSeq = ctx1.lines.map((l) => l.idx);
  const sortedIdxSeq = [...idxSeq].sort((a, b) => a - b);
  check('(B) idx sequence is in ascending document order', JSON.stringify(idxSeq) === JSON.stringify(sortedIdxSeq), idxSeq);

  const renderedLines = ctx1.rendered.split('\n');
  check('(B) rendered has one line per fixture line', renderedLines.length === 5, renderedLines.length);
  // Order of appearance in `rendered` must match `lines` order — check each
  // line's distinguishing substring shows up at increasing string offsets.
  const substrings = ['unseen line', 'seen line', 'acted line', 'dismissed line', 'reconcile line'];
  const offsets = substrings.map((s) => ctx1.rendered.indexOf(s));
  check('(B) every expected line text is present in rendered', offsets.every((o) => o >= 0), offsets);
  const sortedOffsets = [...offsets].sort((a, b) => a - b);
  check(
    '(B) order of appearance in rendered matches lines order',
    JSON.stringify(offsets) === JSON.stringify(sortedOffsets),
    { offsets, ctx1_lines: ctx1.lines.map((l) => l.text) }
  );
}

// (C) exact states, unseen resolved from a MISSING row (not a stored value)
{
  const byId = new Map(ctx1.lines.map((l) => [l.line_id, l]));
  check('(C) unseen line state === "unseen"', byId.get(unseenId)?.state === 'unseen', byId.get(unseenId));
  check('(C) seen line state === "seen"', byId.get(seenId)?.state === 'seen', byId.get(seenId));
  check('(C) acted line state === "acted"', byId.get(actedId)?.state === 'acted', byId.get(actedId));
  check('(C) dismissed line state === "dismissed"', byId.get(dismissedId)?.state === 'dismissed', byId.get(dismissedId));
  check('(C) reconcile line state === "acted"', byId.get(reconcileId)?.state === 'acted', byId.get(reconcileId));

  // Prove "unseen" comes from a MISSING notepad_line_state row, not a stored
  // value, by importing getNotepadLineState directly and confirming absence.
  const { getNotepadLineState } = await import(path.join(distDir, 'notepad.js'));
  check(
    '(C) unseen line truly has NO ledger row (state resolved from absence)',
    getNotepadLineState(unseenId) === undefined
  );
}

// (D) acted line's action_ref appears verbatim in lines AND rendered
{
  const acted = ctx1.lines.find((l) => l.line_id === actedId);
  check('(D) acted line action_ref matches verbatim in `lines`', acted?.action_ref === ACTED_REF, acted?.action_ref);
  check(
    '(D) acted line action_ref appears verbatim in `rendered`',
    ctx1.rendered.includes(ACTED_REF)
  );
}

// (E) reconcile line renders distinctly from a first_look line, and keeps its
//     ORIGINAL action_ref verbatim (both in `lines` and `rendered`).
{
  const reconcile = ctx1.lines.find((l) => l.line_id === reconcileId);
  const unseen = ctx1.lines.find((l) => l.line_id === unseenId);
  check('(E) reconcile line surfaced_kind === "reconcile"', reconcile?.surfaced_kind === 'reconcile', reconcile);
  check(
    '(E) reconcile line action_ref is the ORIGINAL, verbatim',
    reconcile?.action_ref === RECONCILE_REF,
    reconcile?.action_ref
  );
  check(
    '(E) reconcile action_ref appears verbatim in rendered',
    ctx1.rendered.includes(RECONCILE_REF)
  );

  // Extract each line's individual rendered row and compare the reconcile
  // row's marker text against what a genuine first_look (unseen) row looks
  // like — the two MUST render differently.
  const renderedRows = ctx1.rendered.split('\n');
  const unseenRow = renderedRows[ctx1.lines.findIndex((l) => l.line_id === unseenId)];
  const reconcileRow = renderedRows[ctx1.lines.findIndex((l) => l.line_id === reconcileId)];
  check(
    '(E) reconcile row is visually distinct from an unseen/first_look row',
    unseenRow !== undefined &&
      reconcileRow !== undefined &&
      !reconcileRow.startsWith('  ') && // unseen rows render as plain 2-space-indented text
      reconcileRow !== unseenRow.replace('unseen line', 'reconcile line'),
    { unseenRow, reconcileRow }
  );
}

// (F) acted line's rendering is distinguishable from the unseen line's
{
  const renderedRows = ctx1.rendered.split('\n');
  const unseenRow = renderedRows[ctx1.lines.findIndex((l) => l.line_id === unseenId)];
  const actedRow = renderedRows[ctx1.lines.findIndex((l) => l.line_id === actedId)];
  check(
    '(F) acted row marker text differs from unseen row marker text',
    unseenRow !== undefined && actedRow !== undefined && unseenRow.startsWith('  ') && !actedRow.startsWith('  ') && actedRow.includes('ACTED'),
    { unseenRow, actedRow }
  );
}

// (G) the deleted sixth line appears NOWHERE in lines or rendered
{
  check('(G) deleted line id absent from `lines`', !ctx1.lines.some((l) => l.line_id === deleteId));
  check(
    '(G) deleted line text absent from `rendered`',
    !ctx1.rendered.includes('sixth line') && !ctx1.rendered.includes('will be deleted')
  );
}

// (H) purity: two calls -> byte-identical rendered; no ledger state mutation
{
  const { getNotepadLineState } = await import(path.join(distDir, 'notepad.js'));
  const statesBefore = ctx1.lines.map((l) => [l.line_id, JSON.stringify(getNotepadLineState(l.line_id) ?? null)]);

  const ctx2 = buildNotepadReviewContext(DAY);
  check('(H) two calls produce byte-identical `rendered`', ctx1.rendered === ctx2.rendered);

  const statesAfter = ctx2.lines.map((l) => [l.line_id, JSON.stringify(getNotepadLineState(l.line_id) ?? null)]);
  check(
    '(H) calling buildNotepadReviewContext did not mutate any line ledger state',
    JSON.stringify(statesBefore) === JSON.stringify(statesAfter),
    { statesBefore, statesAfter }
  );
}

// (I) zero claude spawns across the whole run
const claudeAfter = countClaudeProcs();
console.log(`  claude processes before/after: ${claudeBefore}/${claudeAfter}`);
check('(I) no increase in claude process count (zero spawns)', claudeAfter <= claudeBefore, { claudeBefore, claudeAfter });

// ── summary line ──────────────────────────────────────────────────────────────
const counts = ctx1.counts;
const violations = failed ? 1 : 0; // coarse — the per-check FAIL lines above are the detail
console.log(
  `\nlines: ${ctx1.lines.length}  unseen/seen/acted/dismissed: ${counts.unseen}/${counts.seen}/${counts.acted}/${counts.dismissed}  surfaced: ${counts.surfaced}  claude_spawns: ${claudeAfter - claudeBefore}  violations: ${violations}`
);

console.log('\n--- rendered (five-line fixture) ---');
console.log(ctx1.rendered);
console.log('--- end rendered ---\n');

console.log(failed ? 'FAILED' : 'ALL PASS');
process.exit(failed ? 1 : 0);
