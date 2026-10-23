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
//   (J) EVERY rendered line carries its own "[line_id N] " prefix, ahead of
//       any state tag (node #942 — the moves model needs a way to map ids
//       back onto rendered text)
//   (K) `blocks` covers the same lines per docs/notepad/BLOCKS.md: this
//       fixture's five surviving lines are all zero-indent (Kevin's "topic
//       on its own line, nothing under it" case), so each is its own
//       single-line block, in document order, headline === the line's own
//       text and member_line_ids === [that line's id] -- the parser used
//       here is the exact same parseNotepadBlocks() notepad-blocks-check.mjs
//       exercises in depth; this only proves the wiring into review context
//   (L) the same wiring against a day shaped like Kevin's REAL notes — an
//       indented mid-thought lead-in (headline:null block) plus two topic
//       headlines with unevenly indented (space/6-space/tab) children and an
//       interior blank line; the [line_id N] prefix holds on indented and
//       blank rows too, and raw indentation survives after the prefix
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

// Every rendered row is now prefixed "[line_id N] " ahead of any state tag
// (node #942) — strip it before applying the pre-existing state-tag
// assertions below, so those checks keep testing the state-tag rendering
// itself rather than the id prefix in front of it.
function stripLineIdPrefix(row) {
  return row.replace(/^\[line_id \d+\] /, '');
}

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
  const unseenRow = stripLineIdPrefix(renderedRows[ctx1.lines.findIndex((l) => l.line_id === unseenId)]);
  const reconcileRow = stripLineIdPrefix(renderedRows[ctx1.lines.findIndex((l) => l.line_id === reconcileId)]);
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
  const unseenRow = stripLineIdPrefix(renderedRows[ctx1.lines.findIndex((l) => l.line_id === unseenId)]);
  const actedRow = stripLineIdPrefix(renderedRows[ctx1.lines.findIndex((l) => l.line_id === actedId)]);
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

// (J) EVERY rendered line carries its own "[line_id N] " prefix, ahead of any
// state tag. Without this, a model told to judge a set of line_ids has no
// way to map its verdicts back onto the rendered text it read (node #942's
// root-cause fix for yesterday's moves-model dry run).
{
  const renderedRows = ctx1.rendered.split('\n');
  check('(J) rendered has exactly one row per surviving line', renderedRows.length === ctx1.lines.length, renderedRows.length);
  const allPrefixed = ctx1.lines.every((l, i) => renderedRows[i]?.startsWith(`[line_id ${l.line_id}] `));
  check(
    '(J) every rendered row starts with its OWN "[line_id N] " prefix, in order',
    allPrefixed,
    { rows: renderedRows, ids: ctx1.lines.map((l) => l.line_id) }
  );
}

// (K) `blocks` covers the same five surviving lines. This fixture's lines
// are all zero-indent, so per THE BLOCK RULE each is its own single-line
// block — proves buildNotepadReviewContext is actually wired to
// parseNotepadBlocks() (notepad-blocks-check.mjs covers the parser's real
// nesting/indent logic in depth; this is the integration point).
{
  check('(K) blocks.length === lines.length (all zero-indent -> one block per line)', ctx1.blocks.length === ctx1.lines.length, ctx1.blocks.length);
  const idsInOrder = ctx1.lines.map((l) => l.line_id);
  const blockMemberIds = ctx1.blocks.map((b) => b.member_line_ids[0]);
  check('(K) blocks appear in the same document order as `lines`', JSON.stringify(blockMemberIds) === JSON.stringify(idsInOrder), { blockMemberIds, idsInOrder });
  const everySingleMember = ctx1.blocks.every((b) => b.member_line_ids.length === 1);
  check('(K) every block is single-line (member_line_ids.length === 1)', everySingleMember);
  const headlinesMatch = ctx1.blocks.every((b, i) => b.headline === ctx1.lines[i].text && b.headline_line_id === ctx1.lines[i].line_id);
  check('(K) each block\'s headline is exactly its line\'s own text/id', headlinesMatch);
}

// (L) the SAME wiring against a day shaped like Kevin's REAL notes — a
// mid-thought indented lead-in before any headline, then two topic headlines
// with unevenly indented children (spaces and a tab, dash-prefixed) and an
// interior blank line. (K) above only proves the degenerate all-zero-indent
// case; this proves buildNotepadReviewContext hands back the blocks Kevin's
// actual format produces, with the id prefix intact on indented rows too.
{
  const DAY_L = '2026-09-26';
  const leadIn = '  - finishing yesterday’s thought about the KPI substrate';
  const h1 = 'Universal KPI Goal';
  const h1a = '  - base class is built and verified live';
  const h1b = '      - still no row cap on the prod SELECTs';
  const blank = '';
  const h1c = '\t- decide the timeout before scheduling anything';
  const h2 = 'Suppression files';
  const h2a = ' - six sources are not suppressing yet';
  const fixture = [leadIn, h1, h1a, h1b, blank, h1c, h2, h2a];
  putNotepadDay(DAY_L, fixture.join('\n'));
  const ctxL = buildNotepadReviewContext(DAY_L);

  check('(L) all eight fixture lines survive (blank line included)', ctxL.lines.length === 8, ctxL.lines.length);
  check('(L) three blocks: the headline-less lead-in + two topics', ctxL.blocks.length === 3, ctxL.blocks.map((b) => b.headline));

  const [b0, b1, b2] = ctxL.blocks;
  check('(L) the lead-in block has headline === null', b0?.headline === null && b0?.headline_line_id === null, b0);
  check('(L) the lead-in block holds exactly that one line', b0?.member_line_ids.length === 1);
  check('(L) block 2 is the first topic, headline verbatim', b1?.headline === h1, b1?.headline);
  check(
    '(L) block 2 swallows all four indented children INCLUDING the interior blank line (space-, 6-space- and tab-indented)',
    b1?.member_line_ids.length === 5,
    b1?.member_line_ids.length
  );
  check('(L) block 3 is the second topic with its single child', b2?.headline === h2 && b2?.member_line_ids.length === 2, b2);
  const allIds = ctxL.blocks.flatMap((b) => b.member_line_ids);
  check(
    '(L) every line lands in exactly one block, in document order',
    JSON.stringify(allIds) === JSON.stringify(ctxL.lines.map((l) => l.line_id)),
    { allIds, lineIds: ctxL.lines.map((l) => l.line_id) }
  );

  // The id prefix must hold on INDENTED rows too — that is precisely where
  // the moves model lost track of which id it was judging.
  const rowsL = ctxL.rendered.split('\n');
  check(
    '(L) every rendered row — indented and blank rows included — carries its own [line_id N] prefix',
    ctxL.lines.every((l, i) => rowsL[i]?.startsWith(`[line_id ${l.line_id}] `)),
    rowsL
  );
  check(
    '(L) rendered preserves each line’s raw indentation after the prefix',
    rowsL.some((r) => r.includes('\t- decide the timeout')) && rowsL.some((r) => r.includes('      - still no row cap')),
    rowsL
  );
}

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
