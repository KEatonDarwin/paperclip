#!/usr/bin/env node
// NOTEPAD BLOCKS CHECK — node #941's acceptance bar for src/notepad-blocks.ts:
// THE BLOCK RULE applied to Kevin's real headline+indented-dash formatting.
//
// PURE FUNCTION TEST: no DB, no JARVIS_DB_PATH, no model call. notepad-blocks.ts
// has zero imports beyond its own types, so this runs against the compiled
// dist output directly.
//
//   npm run build && node scripts/notepad-blocks-check.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
const { parseNotepadBlocks } = await import(path.join(distDir, 'notepad-blocks.js'));

let pass = 0;
let fail = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertEqual(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `expected ${e}, got ${a}`);
}

// Build a day of {id, idx, text} lines from raw text rows, in document order.
function makeDay(rows, startId = 1) {
  return rows.map((text, i) => ({ id: startId + i, idx: i, text }));
}

// ── Case 1: realistic fixture in the shape of Kevin's real 2026-09-25 day ──
// Headlines at zero indent, dash children at irregular (never uniform)
// spacing, nested deeper indents, blank separators inside blocks, 70+ lines.
{
  const rows = [
    'Universal KPI Goal',
    ' - goal #5, universal tracker across brands',
    '  - base class + append-only value store',
    '     - built and verified live',
    '',
    '  - gap: no row cap or timeout on prod SELECTs',
    '   - need to fix before scheduling it for real',
    '',
    'IPInfo',
    ' - lookup working end to end',
    '    - added a caching layer to cut lookups',
    '  - still need to backfill historical rows',
    '   - ~30min cookie expiry is the gotcha, same as the HEB watcher',
    '',
    'Smart notepad',
    ' - one line at a time is not really "a thing to do"',
    '  - my notes are topic BLOCKS not lines',
    '     - topic on its own line, no indent',
    '     - everything under it indented, mostly with a dash',
    '        - indents are eyeballed, never exact',
    '',
    ' - change it from per-line to a block judgment layer',
    '  - storage/line identity/ledger/carry-forward all stay per-line',
    '',
    'Suppression files + adherence monitor',
    ' - per-brand MD5 files from Mike, Hub 2.0 suppression_build',
    '  - skill lives at skills/suppression-files',
    '  - timer runs 3x/day, writes outbox/suppression-adherence/latest.md',
    '     - first check found 6 sources not suppressing',
    '        - flagged for Mike to fix on his end',
    '  - skill at skills/suppression-files handles the format',
    '',
    'Foundry Foundation Gate',
    ' - suppression-manager fake-laravel incident',
    '  - v0.1 deployed, retry fired',
    '  - tree-53a87489 builds scaffold-first + server-run checks',
    '   - both branches now build clean',
    '',
    'Governor cross-pool diversion',
    ' - tree-6ecf478c, branch hopper/gov-diversion off gov-overrides',
    '  - ceiling-blocked ready node auto-diverts to a pool with headroom',
    '   - raised unblock ceiling from 75 to 85',
    '  - sparked by zoom-3 n266 stalling on codex at 91 percent',
    '     - hand-fixed by rerouting in jarvis.db and jarvis-bridge-node.py',
    '',
    'Flight Deck day-management surface',
    ' - approved 2026-09-16, tree-888e6d4c building',
    '  - workstream turn + next_action model',
    '  - /flight-deck page, JARVIS deploys',
    '     - this is commitment #42',
    '  - approved 2026-09-16',
    '',
    'Multi-Claude subscriptions',
    ' - tree-44d2ff4a builds account A to B auto-swap on 5h exhaustion',
    '  - registry + selector + adapter CLAUDE_CONFIG_DIR + governor headroom',
    '  - branch hopper/multi-claude',
    '     - needs Kevin\'s 2nd Claude subscription login',
    '        - degrades to 1 account without it',
    '  - registry + selector + adapter already merged',
    '',
    'Smart Unblocker + Nudge review re-run',
    ' - trees e8e8750a and 4f8bb8b7 blocked at review since 9/15',
    '  - gov_override dep now merged',
    '  - re-run opus-5 reviews plus DOCS/PUSH in a fresh claude window',
    '     - both trees blocked at review since 9/15',
    '  - gov_override merge unblocked both',
    '   - kicked off a fresh claude window for the re-run',
    '',
    'Perclickity v2 isolated copy',
    ' - full copy including DB, everything LIVE',
    '  - zoom3 mode=live, apply_reversals ON',
    '  - sim-vs-live lane juggling is NOT the dev strategy',
  ];
  ok('case1: fixture has 70+ lines', rows.length >= 70, `rows=${rows.length}`);
  const day = makeDay(rows);
  const blocks = parseNotepadBlocks(day);

  const headlines = blocks.map((b) => b.headline);
  assertEqual('case1: 10 headline blocks, in document order', headlines, [
    'Universal KPI Goal',
    'IPInfo',
    'Smart notepad',
    'Suppression files + adherence monitor',
    'Foundry Foundation Gate',
    'Governor cross-pool diversion',
    'Flight Deck day-management surface',
    'Multi-Claude subscriptions',
    'Smart Unblocker + Nudge review re-run',
    'Perclickity v2 isolated copy',
  ]);

  ok('case1: no headline block has a null headline_line_id', blocks.every((b) => b.headline_line_id !== null));

  const kpiBlock = blocks[0];
  ok(
    'case1: "Universal KPI Goal" block includes its nested children and the internal blank line',
    kpiBlock.member_line_ids.length === 8,
    `got ${kpiBlock.member_line_ids.length} members: ${JSON.stringify(kpiBlock.member_line_ids)}`,
  );
  ok(
    'case1: "Universal KPI Goal" block text preserves raw indentation and line-id prefixes',
    kpiBlock.text.includes('[line_id 1] Universal KPI Goal') &&
      kpiBlock.text.includes('[line_id 4]      - built and verified live') &&
      kpiBlock.text.split('\n').length === 8,
  );

  const smartNotepadBlock = blocks[2];
  ok(
    'case1: "Smart notepad" block absorbs its interior blank line as a member, not a break',
    smartNotepadBlock.member_line_ids.includes(day[19].id) /* '' between the two dash groups */,
  );
}

// ── Case 2: a day starting with indented lines -> null-headline block ──────
{
  const rows = [' - stray thought before any headline', '   - a nested stray thought', 'Real headline', ' - child'];
  const day = makeDay(rows, 100);
  const blocks = parseNotepadBlocks(day);
  assertEqual('case2: first block has headline=null', blocks[0].headline, null);
  assertEqual('case2: first block has headline_line_id=null', blocks[0].headline_line_id, null);
  assertEqual('case2: first block absorbs both leading indented lines', blocks[0].member_line_ids, [100, 101]);
  assertEqual('case2: second block is the real headline', blocks[1].headline, 'Real headline');
  ok('case2: exactly 2 blocks', blocks.length === 2, `got ${blocks.length}`);
}

// ── Case 3: consecutive headlines -> each its own single-line block ────────
{
  const rows = ['Headline A', 'Headline B', 'Headline C'];
  const day = makeDay(rows, 200);
  const blocks = parseNotepadBlocks(day);
  ok('case3: 3 blocks for 3 consecutive headlines', blocks.length === 3, `got ${blocks.length}`);
  ok(
    'case3: every block is single-line (headline only, no children)',
    blocks.every((b) => b.member_line_ids.length === 1),
  );
  assertEqual('case3: headlines in order', blocks.map((b) => b.headline), ['Headline A', 'Headline B', 'Headline C']);
}

// ── Case 4: a blank line INSIDE a block's children stays in that block ─────
{
  const rows = ['Headline', ' - child one', '', ' - child two', 'Next headline'];
  const day = makeDay(rows, 300);
  const blocks = parseNotepadBlocks(day);
  assertEqual('case4: first block absorbs the interior blank line', blocks[0].member_line_ids, [300, 301, 302, 303]);
  ok('case4: second block starts clean at the next headline', blocks[1].headline === 'Next headline');
}

// ── Case 5: tabs as indent ───────────────────────────────────────────────
{
  const rows = ['Headline', '\t- tab-indented child', '\t\t- deeper tab-indented child', 'Next'];
  const day = makeDay(rows, 400);
  const blocks = parseNotepadBlocks(day);
  assertEqual('case5: tab-indented lines join the headline block', blocks[0].member_line_ids, [400, 401, 402]);
  ok('case5: block text preserves the raw tab characters', blocks[0].text.includes('[line_id 401] \t- tab-indented child'));
}

// ── Case 6: whitespace-only lines are treated as blank, not as headlines ──
{
  const rows = ['Headline', ' - child', '    ', ' - another child'];
  const day = makeDay(rows, 500);
  const blocks = parseNotepadBlocks(day);
  ok('case6: exactly 1 block (whitespace-only line did not start a new block)', blocks.length === 1, `got ${blocks.length}`);
  assertEqual('case6: whitespace-only line absorbed as a member', blocks[0].member_line_ids, [500, 501, 502, 503]);
}

// ── Case 7: every input line lands in exactly one block, order preserved ──
{
  const rows = [
    'H1',
    ' - a',
    '  - b',
    '',
    'H2',
    '',
    ' - c',
    'H3',
    ' - d',
    '   - e',
    '      - f',
  ];
  const day = makeDay(rows, 600);
  const blocks = parseNotepadBlocks(day);
  const allIds = day.map((l) => l.id);
  const concatenated = blocks.flatMap((b) => b.member_line_ids);
  assertEqual('case7: concatenation of member ids across blocks equals all input ids, in order', concatenated, allIds);
  const seen = new Set();
  let noDuplicates = true;
  for (const id of concatenated) {
    if (seen.has(id)) noDuplicates = false;
    seen.add(id);
  }
  ok('case7: no line id appears in more than one block', noDuplicates);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
