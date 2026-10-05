#!/usr/bin/env node
/**
 * MIKE RADAR PARSE CHECK — the tool-use / diff / headline parsers.
 *
 * Two halves:
 *  1. FIXTURES (always run): the exact edge cases DESIGN.md §1 measured —
 *     the double-encoded diff string, the plain-object diff, a summary-only
 *     hunk, a hunk with neither lines nor summary, the non-JSON junk line, a
 *     description leaked into `name`, and the `&apos;`/`&quot;`-escaped
 *     attribute payloads.
 *  2. REAL ARCHIVE (skipped if absent): re-derives §1's measured counts over
 *     the live 27 MB archive. This is the assertion the design asked for — the
 *     tool-use counts came from a grep and were never independently re-derived.
 *
 * Zero model calls, zero DB. Pure functions only.
 *
 *   npm run build && npm run mike-radar:parse-check
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');
const P = await import(join(dist, 'mike-radar-parse.js'));

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (name, actual, expected) =>
  t(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

console.log('\nMIKE RADAR PARSE CHECK\n');

// ---------------------------------------------------------------------------
console.log('line classification');
// ---------------------------------------------------------------------------
eq('blank line is nothing', P.classifyArchiveLine('   '), null);
eq(
  'the real junk line (e22bf3e2 line 1) is bad, not a throw',
  P.classifyArchiveLine('EMPTY')?.kind,
  'bad',
);
eq('a JSON array is bad', P.classifyArchiveLine('[1,2]')?.kind, 'bad');
eq(
  'message row',
  P.classifyArchiveLine(JSON.stringify({ role: 'user', message_id: 'm1', project_id: 'p' }))?.kind,
  'message',
);
eq(
  'project-meta row (keyed `id`, no role)',
  P.classifyArchiveLine(JSON.stringify({ id: 'abc', name: 'X' }))?.kind,
  'project_meta',
);

// ---------------------------------------------------------------------------
console.log('\ntool-use parsing');
// ---------------------------------------------------------------------------
const TU = (name, data, extra = '') =>
  `<lov-tool-use id="x" name="${name}" integration-id="code"${extra} data="${data}">\n</lov-tool-use>`;

// Attribute escaping as the watcher actually captures it: structural JSON
// quotes are \" and a literal quote inside a value is \\\".
const lineReplace = TU(
  'code--line_replace',
  '{\\"file_path\\": \\"src/routes/dash.index.tsx\\", \\"old_content\\": \\"    status: \\\\\\"coming-soon\\\\\\",\\", \\"first_replaced_line\\": 45}',
);
{
  const changes = P.parseToolUses(lineReplace);
  eq('one change', changes.length, 1);
  eq('action', changes[0].action, 'edit');
  eq('tool', changes[0].tool, 'code--line_replace');
  eq('path survives the double escaping', changes[0].path, 'src/routes/dash.index.tsx');
}

{
  // Reads are NOT changes — this is what makes change_count mean something.
  const reads = [
    TU('code--view', '{\\"file_path\\": \\"src/a.tsx\\"}'),
    TU('supabase--read_query', '{\\"query\\": \\"select 1\\"}'),
    TU('code--exec', '{\\"command\\": \\"ls\\"}'),
    '<lov-tool-use id="thinking-" name="lov-think" data="I&apos;m looking around." duration="0">\n</lov-tool-use>',
    TU('tool_search', '{\\"q\\": \\"x\\"}'),
  ].join('\n');
  eq('view/read/exec/think/search produce no changes', P.parseToolUses(reads).length, 0);
}

{
  const multi = [
    TU('code--write', '{\\"file_path\\": \\"src/a.tsx\\"}'),
    TU('code--line_replace', '{\\"file_path\\": \\"src/a.tsx\\"}'),
    TU('code--line_replace', '{\\"file_path\\": \\"src/a.tsx\\"}'),
    TU('code--line_replace', '{\\"file_path\\": \\"src/b.tsx\\"}'),
  ].join('\n');
  const changes = P.parseToolUses(multi);
  eq('duplicate (action,path) pairs collapse', changes.length, 3);
  t('write and edit of the same file both survive',
    changes.some((c) => c.action === 'write' && c.path === 'src/a.tsx') &&
    changes.some((c) => c.action === 'edit' && c.path === 'src/a.tsx'));
}

{
  const risky = [
    TU('supabase--migration', '{\\"name\\": \\"add_leads_idx\\", \\"query\\": \\"CREATE INDEX ...\\"}'),
    TU('supabase--run_sql', '{\\"query\\": \\"UPDATE leads SET x=1\\"}'),
    TU('supabase--deploy_edge_functions', '{\\"function_names\\": [\\"score-lead\\", \\"clearing-links\\"]}'),
    TU('secrets--update_secret', '{\\"secret_name\\": \\"STRIPE_KEY\\", \\"value\\": \\"sk_live_abc123\\"}'),
  ].join('\n');
  const changes = P.parseToolUses(risky);
  eq('four risky actions', changes.length, 4);
  const byAction = Object.fromEntries(changes.map((c) => [c.action, c]));
  t('migration note carries name + sql', (byAction.migration.note ?? '').startsWith('add_leads_idx:'));
  eq('sql note is the statement', byAction.sql.note, 'UPDATE leads SET x=1');
  eq('edge_fn note lists the functions', byAction.edge_fn.note, 'score-lead, clearing-links');
  eq('secret note is the NAME only', byAction.secret.note, 'STRIPE_KEY');
  t('a secret VALUE never lands in the change row',
    !JSON.stringify(changes).includes('sk_live_abc123'));
  const flags = P.riskFlagsFromChanges(changes);
  eq('risk flags', flags.join(','), 'edge_fn,migration,prod_sql,secret');
}

eq('no risk flags for plain edits',
  P.riskFlagsFromChanges(P.parseToolUses(lineReplace)).length, 0);

{
  // `&quot;` does appear inside real payloads (3,977 times archive-wide) — the
  // entity-decode fallback has to rescue those.
  const entity = TU('code--write', '{&quot;file_path&quot;: &quot;src/entity.tsx&quot;}');
  eq('entity-escaped data still yields a path', P.parseToolUses(entity)[0]?.path, 'src/entity.tsx');
}

eq('unparseable data is still a change, just pathless',
  P.parseToolUses(TU('code--write', 'not json at all'))[0]?.path, null);
eq('no text = no changes', P.parseToolUses(undefined).length, 0);

// ---------------------------------------------------------------------------
console.log('\nheadline + tool stripping');
// ---------------------------------------------------------------------------
{
  const msg = `${lineReplace}\n\nFixed the **Save edit** button so it enables when a draft changes.\n\nMore detail here.`;
  eq('headline is the first prose line, markdown unwrapped',
    P.deriveHeadline(msg),
    'Fixed the Save edit button so it enables when a draft changes.');
  const stripped = P.stripToolUses(msg);
  t('stripping collapses the block to a marker', stripped.includes('[tool: code--line_replace src/routes/dash.index.tsx]'));
  t('stripping keeps the prose', stripped.includes('Fixed the'));
  t('stripping is much smaller than the original', stripped.length < msg.length);
  t('lov-think blocks vanish entirely',
    !P.stripToolUses('<lov-tool-use id="t" name="lov-think" data="musing" duration="0">\n</lov-tool-use>\nHello').includes('lov-think'));
}
eq('a tool-only message has no headline', P.deriveHeadline(lineReplace), null);
eq('headline is capped', P.deriveHeadline('x'.repeat(500))?.length, 200);
eq('apostrophe entities decode in prose',
  P.deriveHeadline('It&apos;s done.'), "It's done.");

// ---------------------------------------------------------------------------
console.log('\ndiff normalisation');
// ---------------------------------------------------------------------------
const hunkWithLines = {
  oldStart: 0, oldCount: 0, newStart: 1, newCount: 2,
  lines: [{ type: 'add', content: 'line a' }, { type: 'add', content: 'line b' }],
};
const summaryOnlyHunk = { summary: 'add relTime() relative-time formatter' };
const emptyHunk = { oldStart: 1 };

eq('null diff', P.normalizeDiff(null).kind, 'none');
eq('undefined diff', P.normalizeDiff(undefined).kind, 'none');
eq('the string "null"', P.normalizeDiff('null').kind, 'none');

{
  // Shape 1: the double-encoded JSON string (84 of 90 real rows).
  const asString = JSON.stringify({
    diffs: [{ action: 'new', file_path: 'src/x.tsx', file_type: 'tsx', is_image: false, hunks: [hunkWithLines] }],
  });
  const r = P.normalizeDiff(asString);
  eq('string-form diff parses', r.kind, 'parsed');
  eq('file path kept', r.diff.diffs[0].file_path, 'src/x.tsx');
  eq('hunk count', r.hunk_count, 1);
  eq('lines kept', r.diff.diffs[0].hunks[0].lines.length, 2);
  eq('diffFilePaths', P.diffFilePaths(r.diff).join(','), 'src/x.tsx');
}
{
  // Shape 2: already a plain object (6 of 90 real rows).
  const r = P.normalizeDiff({ diffs: [{ file_path: 'src/y.ts', hunks: [hunkWithLines] }] });
  eq('object-form diff parses', r.kind, 'parsed');
  eq('object-form file path', r.diff.diffs[0].file_path, 'src/y.ts');
}
{
  // DESIGN §1 fact 6: 18 of 540 hunks carry only `summary`.
  const r = P.normalizeDiff({ diffs: [{ file_path: 'a.ts', hunks: [hunkWithLines, summaryOnlyHunk, emptyHunk] }] });
  eq('summary-only hunk is KEPT', r.hunk_count, 2);
  eq('and counted', r.summary_only_hunks, 1);
  eq('a hunk with neither lines nor summary is dropped', r.dropped_hunks, 1);
  eq('the kept summary text', r.diff.diffs[0].hunks[1].summary, 'add relTime() relative-time formatter');
}
{
  // The defensive valve — claims 0 real rows today, must degrade not throw.
  const r = P.normalizeDiff("{'diffs': [{'file_path': 'x'}]}");
  eq('a python-repr-ish string is opaque', r.kind, 'opaque');
  t('and the original is preserved verbatim', r.raw.includes("'diffs'"));
  eq('opaque has no parsed diff', r.diff, null);
}
eq('a bare array of files is accepted',
  P.normalizeDiff([{ file_path: 'z.ts', hunks: [] }]).kind, 'parsed');

// Shape 4 — plain unified-diff TEXT. DESIGN §1 fact 3 said every captured diff
// is JSON; re-measured, ~43 of the 90 are this, carrying 500 hunks / 152 files.
{
  const unified = [
    '--- a/src/pages/Article.tsx',
    '+++ b/src/pages/Article.tsx',
    '@@ -1,5 +1,5 @@',
    ' import { useParams, Link } from "react-router-dom";',
    '-import { useEffect, useMemo, useRef } from "react";',
    '+import { useEffect, useRef } from "react";',
    ' import DOMPurify from "dompurify";',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,2 @@',
    '+export const a = 1;',
    '+export const b = 2;',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-export const gone = true;',
  ].join('\n');
  t('looksLikeUnifiedDiff recognises it', P.looksLikeUnifiedDiff(unified));
  const r = P.normalizeDiff(unified);
  eq('unified text PARSES (not opaque)', r.kind, 'parsed');
  eq('source is tagged', r.source, 'unified_text');
  eq('three files', r.diff.diffs.length, 3);
  eq('a/ and b/ prefixes are stripped', r.diff.diffs[0].file_path, 'src/pages/Article.tsx');
  eq('three hunks', r.hunk_count, 3);
  const h = r.diff.diffs[0].hunks[0];
  eq('hunk oldStart', h.oldStart, 1);
  eq('hunk newCount', h.newCount, 5);
  eq('add/del/context all captured', h.lines.length, 4);
  eq('a del line', h.lines.find((l) => l.type === 'del').content, 'import { useEffect, useMemo, useRef } from "react";');
  eq('a context line keeps its text', h.lines[0].content, 'import { useParams, Link } from "react-router-dom";');
  eq('/dev/null on the old side = a new file', r.diff.diffs[1].action, 'new');
  eq('and its path comes from the + side', r.diff.diffs[1].file_path, 'src/new.ts');
  eq('/dev/null on the new side = a delete', r.diff.diffs[2].action, 'delete');
  eq('a delete keeps the old path', r.diff.diffs[2].file_path, 'src/gone.ts');
  eq('all three paths surface', P.diffFilePaths(r.diff).length, 3);
}
eq('prose is NOT mistaken for a diff', P.normalizeDiff('I changed the button --- it works now').kind, 'opaque');
eq('a diff header with no hunks is not a diff',
  P.normalizeDiff('--- a/x\n+++ b/x\nnothing else').kind, 'opaque');
eq('unified-diff source tagging for JSON strings',
  P.normalizeDiff(JSON.stringify({ diffs: [{ file_path: 'a', hunks: [] }] })).source, 'json_string');

// ---------------------------------------------------------------------------
console.log('\nname guard (DESIGN §1 fact 2 — 12 leaked descriptions)');
// ---------------------------------------------------------------------------
eq('a short name is a name', P.guardProjectName('Perclickity Command Center', null).name, 'Perclickity Command Center');
{
  const leaked = 'A '.repeat(400); // 800 chars, like 816a7a7c's 650-char "name"
  const g = P.guardProjectName(leaked, null);
  eq('a 800-char "name" is demoted', g.name, null);
  t('and lands in description', (g.description ?? '').startsWith('A A'));
}
eq('a newline in a name demotes it', P.guardProjectName('Line one\nLine two', null).name, null);
eq('an explicit description is preserved', P.guardProjectName('X', 'the desc').description, 'the desc');
eq('empty name', P.guardProjectName('   ', null).name, null);
eq('exactly 80 chars is allowed', P.guardProjectName('n'.repeat(80), null).name?.length, 80);
eq('81 chars is not', P.guardProjectName('n'.repeat(81), null).name, null);

// ---------------------------------------------------------------------------
console.log('\nids');
// ---------------------------------------------------------------------------
eq('short id', P.shortId('2decdf12-1234-5678-9abc-def012345678'), '2decdf12');
eq('agent sequence', P.messageSeq('main:agent#00000000062791#don:TBUDWCXY')?.seq, 62791);
eq('agent namespace', P.messageSeq('main:agent#00000000062791#don:TBUDWCXY')?.ns, 'main:agent');
eq('user sequence', P.messageSeq('main:user#00000000000087#usr:NKLJ7LJA')?.seq, 87);
// The namespaces are distinguishable, which is how we PROVED the sequence is
// useless as a gap detector: only 10% of consecutive main:user ids and 0% of
// main:agent ids step by 1, so DESIGN §10's +1 check is not shipped. The parser
// keeps the accessor for ordering/diagnostics.
eq('user namespace', P.messageSeq('main:user#00000000000087#usr:NKLJ7LJA')?.ns, 'main:user');
eq('a non-sequenced id contributes nothing', P.messageSeq('abc-def'), null);
eq('no id', P.messageSeq(null), null);

// ---------------------------------------------------------------------------
// Real archive — re-derive DESIGN §1's measured counts.
// ---------------------------------------------------------------------------
const ARCHIVE = process.env.MIKE_RADAR_ARCHIVE_DIR ?? '/home/kevin/perclickity-suite/lovable-watch/archive';
if (!existsSync(ARCHIVE)) {
  console.log(`\n(archive not present at ${ARCHIVE} — skipping the real-data assertions)`);
} else {
  console.log(`\nreal archive: ${ARCHIVE}`);
  const files = readdirSync(ARCHIVE).filter((f) => /^[0-9a-f-]{36}\.jsonl$/i.test(f)).sort();
  let rows = 0, bad = 0, meta = 0, user = 0, assistant = 0;
  let withDiff = 0, parsedDiff = 0, opaqueDiff = 0, hunks = 0, summaryOnly = 0;
  let withToolUse = 0, withCommit = 0, rowsWithChanges = 0, headlines = 0;
  const toolCounts = new Map();
  const diffSources = new Map();

  for (const f of files) {
    const content = readFileSync(join(ARCHIVE, f), 'utf8');
    for (const line of content.split('\n')) {
      const c = P.classifyArchiveLine(line);
      if (!c) continue;
      if (c.kind === 'bad') { bad++; continue; }
      if (c.kind === 'project_meta') { meta++; continue; }
      rows++;
      const row = c.row;
      if (row.role === 'user') user++; else if (row.role === 'assistant') assistant++;
      if (row.commit_sha) withCommit++;
      if (row.text && row.text.includes('<lov-tool-use')) withToolUse++;
      if (P.deriveHeadline(row.text)) headlines++;

      const changes = P.parseToolUses(row.text);
      if (changes.length) rowsWithChanges++;
      for (const ch of changes) toolCounts.set(ch.tool, (toolCounts.get(ch.tool) ?? 0) + 1);

      if (row.diff !== null && row.diff !== undefined) {
        withDiff++;
        const d = P.normalizeDiff(row.diff);
        if (d.kind === 'parsed') parsedDiff++;
        else if (d.kind === 'opaque') opaqueDiff++;
        diffSources.set(d.source, (diffSources.get(d.source) ?? 0) + 1);
        hunks += d.hunk_count;
        summaryOnly += d.summary_only_hunks;
      }
    }
  }

  console.log(`  (${files.length} files · ${rows} messages · ${meta} inline meta rows)`);

  // BASELINE, measured 2026-10-05 ~11:50 CT. The watcher APPENDS hourly, so the
  // live numbers only ever grow — these are `>=` assertions with the current
  // value printed, not equalities that would go red every hour.
  const atLeast = (name, actual, floor) =>
    t(`${name} (now ${actual}, baseline ${floor})`, actual >= floor, `got ${actual}, want >= ${floor}`);

  eq('100 project files', files.length, 100);
  atLeast('>= 2,764 message rows', rows, 2764);
  atLeast('>= 1,364 user rows', user, 1364);
  atLeast('>= 1,400 assistant rows', assistant, 1400);
  eq('exactly 1 non-JSON line', bad, 1);
  atLeast('>= 90 rows carry a diff', withDiff, 90);
  atLeast('>= 1,118 rows carry tool-use blocks', withToolUse, 1118);
  atLeast('>= 772 rows carry a commit sha', withCommit, 772);

  // THE POINT OF THIS BLOCK: essentially every diff the archive carries is
  // turned into real hunks. DESIGN §1 fact 3 said all 90 were JSON; in reality
  // ~45% are textual diffs, and 3 rows are plain English prose with no diff
  // structure at all ("New page src/pages/FreeContentRuns.tsx + route in
  // App.tsx; ..."). Those 3 are CORRECTLY opaque — there is nothing to parse —
  // and the UI shows them verbatim as a note.
  t(`>= 95% of diff rows parse into hunks (${parsedDiff}/${withDiff})`,
    parsedDiff / withDiff >= 0.95, `${parsedDiff}/${withDiff}`);
  t(`<= 5 prose-only diffs stay opaque (${opaqueDiff})`, opaqueDiff <= 5, `${opaqueDiff}`);
  eq('parsed + opaque accounts for every diff row', parsedDiff + opaqueDiff, withDiff);
  atLeast('>= 1,000 hunks recovered', hunks, 1000);
  atLeast('>= 18 summary-only hunks', summaryOnly, 18);
  console.log(`  diff wire shapes: ${[...diffSources.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  t('both JSON and unified-text shapes are present',
    (diffSources.get('json_string') ?? 0) > 0 && (diffSources.get('unified_text') ?? 0) > 0);

  atLeast('>= 600 rows yield at least one parsed change', rowsWithChanges, 600);
  t('headlines are derived for the vast majority of rows',
    headlines > rows * 0.9, `${headlines} of ${rows}`);

  // DESIGN §1 fact 4's tool counts, independently re-derived. These are deduped
  // per message (the parser collapses repeated (action,path) pairs), so they are
  // LOWER than the raw grep counts the design quoted — assert the shape, not the
  // exact numbers.
  const top = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('  change tools (deduped per message):');
  for (const [tool, n] of top) console.log(`    ${String(n).padStart(5)}  ${tool}`);
  const get = (k) => toolCounts.get(k) ?? 0;
  t('code--line_replace is the dominant change tool', get('code--line_replace') > 300);
  t('code--write is present', get('code--write') > 200);
  t('code--apply_patch is present', get('code--apply_patch') > 50);
  t('lov-line-replace is present', get('lov-line-replace') > 50);
  t('supabase--migration is present', get('supabase--migration') > 50);
  t('supabase--deploy_edge_functions is present', get('supabase--deploy_edge_functions') > 30);
  t('supabase--run_sql is present', get('supabase--run_sql') > 30);
  t('a secrets tool is present', get('secrets--update_secret') + get('secrets--set_secret') + get('secrets--add_secret') > 20);
  t('no read-only tool leaked into the change set',
    !['code--view', 'code--exec', 'lov-think', 'supabase--read_query', 'tool_search', 'lov-view']
      .some((k) => toolCounts.has(k)),
    [...toolCounts.keys()].join(','));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
