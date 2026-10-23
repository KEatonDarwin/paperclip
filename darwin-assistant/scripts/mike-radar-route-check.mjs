#!/usr/bin/env node
// MIKE RADAR ROUTE CHECK — the REAL Express router over real HTTP on a throwaway
// port against a scratch DB and a fixture archive. Proves the 12 /mike-radar/*
// routes answer the shapes the cockpit node will code against, that auth is
// enforced, and that bad input 400s instead of 500s. No model calls (JARVIS_SIM=1
// makes the generate route's one-shot refuse), nothing of Mike's touched.
//
//   npm run mike-radar:route-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const raw = process.env.JARVIS_DB_PATH;
if (!raw || !/\/tmp\//.test(raw)) {
  console.error('FATAL: JARVIS_DB_PATH must be a scratch path under /tmp.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
process.env.CLAUDE_USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mike-route-usage-'));
process.env.JARVIS_SIM = '1';
process.env.MIKE_RADAR_DRIVER = '0';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mike-route-'));
const archive = path.join(work, 'archive');
fs.mkdirSync(archive, { recursive: true });
process.env.MIKE_RADAR_ARCHIVE_DIR = archive;
process.env.MIKE_RADAR_OUTBOX_DIR = path.join(work, 'outbox');

const PA = '816a7a7c-bb38-406a-8207-ea8dfe3b1db4';
const TU = (name, data) =>
  `<lov-tool-use id="x" name="${name}" integration-id="code" data="${data}">\n</lov-tool-use>`;
const DAY = '2026-10-04';
fs.writeFileSync(path.join(archive, `${PA}.jsonl`), [
  { captured_at: '2026-10-04T18:00:00Z', project_id: PA, message_id: 'm1', role: 'user',
    created_at: '2026-10-04T15:00:00Z', text: 'fix the save button', commit_sha: null, diff: null },
  { captured_at: '2026-10-04T18:00:00Z', project_id: PA, message_id: 'm2', role: 'assistant',
    created_at: '2026-10-04T15:01:00Z',
    text: `${TU('code--line_replace', '{\\"file_path\\": \\"src/a.tsx\\"}')}\n\nFixed it.`,
    commit_sha: 'abc', diff: '--- a/src/a.tsx\n+++ b/src/a.tsx\n@@ -1,1 +1,1 @@\n-const a = 0;\n+const a = 1;\n' },
  { captured_at: '2026-10-04T18:00:00Z', project_id: PA, message_id: 'm3', role: 'user',
    created_at: '2026-10-04T15:05:00Z', text: 'thanks', commit_sha: null, diff: null },
].map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');

const distDir = path.join(__dirname, '..', 'dist');
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const I = await import(path.join(distDir, 'mike-radar-ingest.js'));

I.runMikeIngest();

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const key = mintApiKey('mike-route-check', 'admin').plaintext;

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (name, a, b) => t(name, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

async function call(method, p, body, opts = {}) {
  const headers = {};
  if (!opts.noAuth) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${p}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

console.log('\nMIKE RADAR ROUTE CHECK\n');

console.log('auth');
for (const p of ['/mike-radar/projects', '/mike-radar/reports', '/mike-radar/ingest/runs']) {
  const r = await call('GET', p, undefined, { noAuth: true });
  t(`${p} requires auth`, r.status === 401 || r.status === 403, `got ${r.status}`);
}

console.log('\nGET /mike-radar/projects');
{
  const r = await call('GET', `/mike-radar/projects?day=${DAY}`);
  eq('200', r.status, 200);
  eq('one project', r.body.projects.length, 1);
  const p = r.body.projects[0];
  eq('short_id', p.short_id, '816a7a7c');
  for (const k of ['display_name', 'msg_count', 'change_count', 'today_msg_count',
    'today_change_count', 'latest_headline', 'has_report_today', 'risk_flags_today',
    'thread_ext', 'last_activity_at', 'is_key', 'watch_state']) {
    t(`row carries ${k}`, k in p);
  }
  for (const k of ['projects', 'messages', 'changes', 'today_messages']) {
    t(`totals carries ${k}`, k in r.body.totals);
  }
  eq('key_only works', (await call('GET', '/mike-radar/projects?key_only=1')).body.projects.length, 1);
  eq('bad watch_state 400s', (await call('GET', '/mike-radar/projects?watch_state=zzz')).status, 400);
  eq('bad day 400s', (await call('GET', '/mike-radar/projects?day=nope')).status, 400);
}

console.log('\nGET /mike-radar/projects/:shortId');
{
  const r = await call('GET', '/mike-radar/projects/816a7a7c');
  eq('200 by short id', r.status, 200);
  eq('project returned', r.body.project.short_id, '816a7a7c');
  t('report stubs array', Array.isArray(r.body.reports));
  eq('200 by full uuid', (await call('GET', `/mike-radar/projects/${PA}`)).status, 200);
  eq('unknown ref 404s', (await call('GET', '/mike-radar/projects/deadbeef')).status, 404);
  eq('404 code', (await call('GET', '/mike-radar/projects/deadbeef')).body.error?.code ??
    (await call('GET', '/mike-radar/projects/deadbeef')).body.code, 'mike_project_not_found');
}

console.log('\nPATCH /mike-radar/projects/:shortId');
{
  eq('is_key toggles', (await call('PATCH', '/mike-radar/projects/816a7a7c', { is_key: false })).body.project.is_key, 0);
  eq('and back', (await call('PATCH', '/mike-radar/projects/816a7a7c', { is_key: true })).body.project.is_key, 1);
  const muted = await call('PATCH', '/mike-radar/projects/816a7a7c', { watch_state: 'muted' });
  eq('watch_state changes', muted.body.project.watch_state, 'muted');
  await call('PATCH', '/mike-radar/projects/816a7a7c', { watch_state: 'watched' });
  const named = await call('PATCH', '/mike-radar/projects/816a7a7c', { name: 'PerClickity' });
  eq('name settable by Kevin', named.body.project.name, 'PerClickity');
  eq("and tagged as Kevin's so no sweep clobbers it", named.body.project.name_source, 'kevin');
  eq('a long name is truncated, not rejected',
    (await call('PATCH', '/mike-radar/projects/816a7a7c', { name: 'x'.repeat(200) })).body.project.name.length, 80);
  await call('PATCH', '/mike-radar/projects/816a7a7c', { name: 'PerClickity' });
  eq('bad watch_state 400s',
    (await call('PATCH', '/mike-radar/projects/816a7a7c', { watch_state: 'zzz' })).status, 400);
  eq('an unwritable field 400s (nothing to update)',
    (await call('PATCH', '/mike-radar/projects/816a7a7c', { msg_count: 999 })).status, 400);
  eq('msg_count was NOT written',
    (await call('GET', '/mike-radar/projects/816a7a7c')).body.project.msg_count, 3);
}

console.log('\nGET /mike-radar/projects/:shortId/feed');
{
  const r = await call('GET', '/mike-radar/projects/816a7a7c/feed');
  eq('200', r.status, 200);
  eq('3 rows', r.body.items.length, 3);
  const row = r.body.items.find((i) => i.role === 'assistant');
  t('full text present', row.text.includes('<lov-tool-use'));
  t('headline present', !!row.headline);
  t('changes present', Array.isArray(row.changes) && row.changes.length === 1);
  eq('has_diff', row.has_diff, true);
  t('the DIFF BODY is not in the list payload', !row.diff_json && !row.diff_raw);
  eq('next_before null on the last page', r.body.next_before, null);

  const p1 = await call('GET', '/mike-radar/projects/816a7a7c/feed?limit=2');
  eq('limit respected', p1.body.items.length, 2);
  t('cursor offered', typeof p1.body.next_before === 'number');
  const p2 = await call('GET', `/mike-radar/projects/816a7a7c/feed?before=${p1.body.next_before}&limit=2`);
  eq('page 2', p2.body.items.length, 1);
  eq('role filter', (await call('GET', '/mike-radar/projects/816a7a7c/feed?role=user')).body.items.length, 2);
  eq('changes_only', (await call('GET', '/mike-radar/projects/816a7a7c/feed?changes_only=1')).body.items.length, 1);
  eq('day filter', (await call('GET', `/mike-radar/projects/816a7a7c/feed?day=${DAY}`)).body.items.length, 3);
  eq('bad role 400s', (await call('GET', '/mike-radar/projects/816a7a7c/feed?role=zzz')).status, 400);
  eq('bad day 400s', (await call('GET', '/mike-radar/projects/816a7a7c/feed?day=zzz')).status, 400);
  eq('unknown project 404s', (await call('GET', '/mike-radar/projects/deadbeef/feed')).status, 404);
}

console.log('\nGET /mike-radar/activity/:id');
{
  const feed = await call('GET', '/mike-radar/projects/816a7a7c/feed?changes_only=1');
  const id = feed.body.items[0].id;
  const r = await call('GET', `/mike-radar/activity/${id}`);
  eq('200', r.status, 200);
  t('item present', !!r.body.item);
  t('the diff body IS here', !!r.body.diff);
  eq('a parsed unified diff', r.body.diff.diffs[0].file_path, 'src/a.tsx');
  eq('hunk lines', r.body.diff.diffs[0].hunks[0].lines.length, 2);
  eq('missing id 404s', (await call('GET', '/mike-radar/activity/999999')).status, 404);
  eq('non-numeric id 400s', (await call('GET', '/mike-radar/activity/abc')).status, 400);
}

console.log('\nreports');
{
  const idx = await call('GET', `/mike-radar/reports?date=${DAY}`);
  eq('200', idx.status, 200);
  t('one queued report', idx.body.reports.length === 1);
  eq('the index omits markdown', idx.body.reports[0].markdown, null);
  eq('bad date 400s', (await call('GET', '/mike-radar/reports?date=zzz')).status, 400);
  eq('unknown project 404s', (await call('GET', '/mike-radar/reports?project=deadbeef')).status, 404);

  const one = await call('GET', `/mike-radar/reports/816a7a7c/${DAY}`);
  eq('200', one.status, 200);
  eq('report returned', one.body.report.report_date, DAY);

  // A day Mike didn't touch is a legitimate answer, not a 404.
  const quiet = await call('GET', '/mike-radar/reports/816a7a7c/2026-09-01');
  eq('200 for an untouched day', quiet.status, 200);
  eq('report is null', quiet.body.report, null);
  eq('and the day message count is 0', quiet.body.day_msg_count, 0);
  eq('bad date 400s', (await call('GET', '/mike-radar/reports/816a7a7c/zzz')).status, 400);

  const gen = await call('POST', `/mike-radar/reports/816a7a7c/${DAY}/generate`, {});
  eq('generate answers 202', gen.status, 202);
  eq('with the queued row', gen.body.report.status, 'queued');
  eq('generating a day with no activity 409s',
    (await call('POST', '/mike-radar/reports/816a7a7c/2026-09-01/generate', {})).status, 409);
  eq('bad date 400s',
    (await call('POST', '/mike-radar/reports/816a7a7c/zzz/generate', {})).status, 400);
  eq('unknown project 404s',
    (await call('POST', `/mike-radar/reports/deadbeef/${DAY}/generate`, {})).status, 404);
}

console.log('\ningest');
{
  const r = await call('POST', '/mike-radar/ingest', {});
  eq('200', r.status, 200);
  eq('run done', r.body.run.status, 'done');
  eq('nothing new on a repeat sweep', r.body.run.rows_new, 0);
  const full = await call('POST', '/mike-radar/ingest', { full: true });
  eq('full re-reads', full.body.run.rows_seen, 3);
  eq('and still inserts nothing', full.body.run.rows_new, 0);

  const runs = await call('GET', '/mike-radar/ingest/runs?limit=5');
  eq('200', runs.status, 200);
  t('runs listed newest first', runs.body.runs.length >= 2 && runs.body.runs[0].id > runs.body.runs[1].id);
  for (const k of ['files_seen', 'rows_seen', 'rows_new', 'rows_bad', 'projects_new', 'capped_projects']) {
    t(`run row carries ${k}`, k in runs.body.runs[0]);
  }
}

console.log('\nthread bootstrap');
{
  const r = await call('POST', '/mike-radar/projects/816a7a7c/thread', {});
  eq('200', r.status, 200);
  eq('external_id', r.body.external_id, 'cockpit:mike-816a7a7c');
  eq('created', r.body.created, true);
  t('seed_text for the CALLER to post', !!r.body.seed_text);
  t('seed states the read-only rule', r.body.seed_text.includes('READ-ONLY'));
  const again = await call('GET', '/mike-radar/projects/816a7a7c/thread');
  eq('GET behaves identically', again.body.external_id, 'cockpit:mike-816a7a7c');
  eq('and does not re-create', again.body.created, false);
  eq('unknown project 404s', (await call('POST', '/mike-radar/projects/deadbeef/thread', {})).status, 404);
}

server.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
