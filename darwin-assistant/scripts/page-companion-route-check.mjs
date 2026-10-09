#!/usr/bin/env node
// PAGE COMPANION ROUTE CHECK — the REAL Express router over real HTTP on a
// throwaway port against a scratch DB (tree-e753d989, node #1574). Proves the
// five /page-companion/* routes answer the shapes the Chrome extension will
// code against, that auth is enforced, and that bad input 400s instead of
// 500s. No model calls, no live DB, no network beyond 127.0.0.1.
//
//   npm run page-companion:route-check

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
process.env.CLAUDE_USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'page-companion-usage-'));
process.env.JARVIS_SIM = '1';
process.env.MIKE_RADAR_DRIVER = '0';

const distDir = path.join(__dirname, '..', 'dist');
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const { getOrCreateConversation, renameConversation, addTurn, getConversation } =
  await import(path.join(distDir, 'conversation-db.js'));
const { addThreadLink, listThreadLinks } = await import(path.join(distDir, 'thread-links.js'));

// ── fixtures ─────────────────────────────────────────────────────────────
const PAGE = 'http://192.168.1.25:8096/ad-review';
const existing = getOrCreateConversation('cockpit:pc-route-existing');
renameConversation(existing.id, 'Ad review board build');
addThreadLink(existing.id, `${PAGE}/`, 'Ad Review Board');
addTurn(existing.id, 'user', 'build it');

const vaultOnly = getOrCreateConversation('cockpit:pc-route-vault');
addThreadLink(vaultOnly.id, 'http://192.168.1.25:8080/settings/vault?file=outbox/x.md', 'report');
addTurn(vaultOnly.id, 'user', 'read it');

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const key = mintApiKey('page-companion-route-check', 'admin').plaintext;

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

console.log('\nPAGE COMPANION ROUTE CHECK\n');

console.log('auth');
for (const [method, p, body] of [
  ['POST', '/page-companion/lookup', { url: PAGE }],
  ['POST', '/page-companion/new-chat', { url: PAGE }],
  ['GET', '/page-companion/registry', undefined],
  ['POST', '/page-companion/registry', { url_pattern: 'http://x.test/*', project: 'X' }],
  ['POST', '/page-companion/seed', undefined],
]) {
  const r = await call(method, p, body, { noAuth: true });
  eq(`${method} ${p} without a bearer key → 401`, r.status, 401);
}

console.log('\nPOST /page-companion/lookup');
{
  const r = await call('POST', '/page-companion/lookup', { url: `${PAGE}/?tab=de#x` });
  eq('200', r.status, 200);
  t('ours:true from the thread_links reverse match', r.body.ours === true, JSON.stringify(r.body));
  eq('registry_id null (no registry row yet)', r.body.registry_id, null);
  eq('project null', r.body.project, null);
  eq('normalized_url is the canonical key', r.body.normalized_url, '192.168.1.25:8096/ad-review');
  t('threads is an array of {external_id,title,last_active}',
    Array.isArray(r.body.threads) && r.body.threads.length === 1
      && r.body.threads[0].external_id === 'cockpit:pc-route-existing'
      && r.body.threads[0].title === 'Ad review board build'
      && typeof r.body.threads[0].last_active === 'string',
    JSON.stringify(r.body.threads));

  const unknown = await call('POST', '/page-companion/lookup', { url: 'http://192.168.1.25:8096/nope' });
  eq('an unknown page still 200s', unknown.status, 200);
  eq('…with ours:false', unknown.body.ours, false);
  eq('…and no threads', unknown.body.threads.length, 0);

  const junk = await call('POST', '/page-companion/lookup', { url: 'chrome://extensions' });
  eq('a non-page URL 200s (the extension asks about every page)', junk.status, 200);
  eq('…with ours:false', junk.body.ours, false);

  const vault = await call('POST', '/page-companion/lookup', { url: 'http://192.168.1.25:8080/settings/vault?file=outbox/x.md' });
  eq('a vault-viewer link is never ours', vault.body.ours, false);
  eq('…and lists no threads', vault.body.threads.length, 0);

  for (const body of [{}, { url: '' }, { url: 42 }, undefined]) {
    const bad = await call('POST', '/page-companion/lookup', body);
    eq(`missing/blank url → 400 (${JSON.stringify(body)})`, bad.status, 400);
  }
}

console.log('\nPOST /page-companion/registry');
{
  const r = await call('POST', '/page-companion/registry', {
    url_pattern: 'HTTP://192.168.1.25:8096/*',
    project: 'Ad Review Board',
    primary_thread_ext: 'cockpit:pc-route-existing',
  });
  eq('201', r.status, 201);
  eq('pattern stored canonically', r.body.page.url_pattern, '192.168.1.25:8096/*');
  eq('source defaults to manual', r.body.page.source, 'manual');

  const again = await call('POST', '/page-companion/registry', {
    url_pattern: 'https://192.168.1.25:8096/*', project: 'Ad Review Board v2',
  });
  eq('re-registering the same canonical pattern reuses the row', again.body.page.id, r.body.page.id);

  const list = await call('GET', '/page-companion/registry');
  eq('GET registry 200', list.status, 200);
  eq('one row for that pattern', list.body.pages.filter((p) => p.url_pattern === '192.168.1.25:8096/*').length, 1);

  const now = await call('POST', '/page-companion/lookup', { url: `${PAGE}/detail` });
  eq('a sub-path under the prefix row is now ours', now.body.ours, true);
  eq('…with the project name', now.body.project, 'Ad Review Board v2');
  eq('…and the owning chat listed', now.body.threads[0]?.external_id, 'cockpit:pc-route-existing');

  for (const body of [{}, { url_pattern: 'http://x.test/*' }, { project: 'X' }]) {
    const bad = await call('POST', '/page-companion/registry', body);
    eq(`missing field → 400 (${JSON.stringify(body)})`, bad.status, 400);
  }
  const badPattern = await call('POST', '/page-companion/registry', { url_pattern: 'chrome://x', project: 'X' });
  eq('an unusable pattern → 400, not 500', badPattern.status, 400);
  eq('…with the typed code', badPattern.body.error?.code ?? badPattern.body.code, 'invalid_url_pattern');
}

console.log('\nPOST /page-companion/new-chat');
{
  const r = await call('POST', '/page-companion/new-chat', { url: `${PAGE}/detail?x=1` });
  eq('201', r.status, 201);
  t('external_id is cockpit:page-<uuid>', /^cockpit:page-[0-9a-f-]{36}$/.test(r.body.external_id ?? ''), r.body.external_id);
  eq('project inherited from the registry row', r.body.project, 'Ad Review Board v2');

  const conv = getConversation(r.body.external_id);
  t('the conversation row exists', !!conv);
  const links = listThreadLinks(conv.id);
  eq('exactly one thread_links row', links.length, 1);
  eq('…pointing at the page', links[0].url, `${PAGE}/detail?x=1`);

  const relookup = await call('POST', '/page-companion/lookup', { url: `${PAGE}/detail` });
  t('the new chat is listed on the very next lookup',
    relookup.body.threads.some((x) => x.external_id === r.body.external_id),
    JSON.stringify(relookup.body.threads));

  const explicit = await call('POST', '/page-companion/new-chat', { url: 'http://192.168.1.25:8099/thing', project: 'Brand New Thing' });
  eq('an explicit project is used verbatim', explicit.body.project, 'Brand New Thing');
  t('each call is a distinct chat', explicit.body.external_id !== r.body.external_id);

  for (const body of [{}, { url: 'chrome://x' }, { url: '/settings/vault?file=x' }]) {
    const bad = await call('POST', '/page-companion/new-chat', body);
    eq(`bad url → 400, no junk thread (${JSON.stringify(body)})`, bad.status, 400);
  }
}

console.log('\nPOST /page-companion/seed');
{
  const first = await call('POST', '/page-companion/seed');
  eq('200', first.status, 200);
  t('reports what it added', typeof first.body.manual_added === 'number' && typeof first.body.auto_added === 'number',
    JSON.stringify(first.body));
  const before = (await call('GET', '/page-companion/registry')).body.pages.length;
  const second = await call('POST', '/page-companion/seed');
  eq('a second seed adds no manual rows', second.body.manual_added, 0);
  eq('…and no auto rows', second.body.auto_added, 0);
  const after = (await call('GET', '/page-companion/registry')).body.pages.length;
  eq('registry row count unchanged', after, before);

  const heartbeat = await call('POST', '/page-companion/lookup', { url: 'http://192.168.1.25:8100/anything' });
  eq('a seeded dashboard is ours', heartbeat.body.ours, true);
  eq('…with its hand-given project name', heartbeat.body.project, 'Hub 1.0 Heartbeat');
}

server.close();
console.log(`\n${fail === 0 ? `ALL ${pass} route checks passed ✅` : `${fail} FAILED (${pass} passed) ❌`}\n`);
process.exit(fail === 0 ? 0 : 1);
