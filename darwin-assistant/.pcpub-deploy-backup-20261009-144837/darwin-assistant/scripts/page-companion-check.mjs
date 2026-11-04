#!/usr/bin/env node
// PAGE COMPANION TESTS — hermetic unit tests for src/page-companion.ts
// (tree-e753d989, node #1574). No live data, no model calls, no network.
//
//   npm run build
//   npm run page-companion:check
//
// (drives the compiled dist/, like scripts/work-board-test.mjs. Importing
// dist/page-companion.js pulls in conversation-db.js, which opens a sqlite
// handle at import time, so a JARVIS_DB_PATH scratch guard is required.)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function guardDbPath() {
  const raw = process.env.JARVIS_DB_PATH;
  if (!raw || !raw.trim()) {
    console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path before running this script.');
    process.exit(1);
  }
  const resolved = path.resolve(raw);
  const live = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
  if (resolved === live) {
    console.error(`FATAL: refusing to run against the live jarvis.db (${live}). Use a /tmp scratch path.`);
    process.exit(1);
  }
  return resolved;
}

const DB_PATH = guardDbPath();
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[page-companion-check] scratch DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getOrCreateConversation, getConversation, addTurn, renameConversation, sqliteDb } =
  await import(path.join(distDir, 'conversation-db.js'));
const { setPreviewLink, addThreadLink, listThreadLinks } =
  await import(path.join(distDir, 'thread-links.js'));
const PC = await import(path.join(distDir, 'page-companion.js'));

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// Backdate a turn so "newest activity first" is testable (addTurn always writes
// datetime('now'); addTurn returns the turn_index, not the row id).
function addTurnAt(conversationId, role, content, when) {
  const turnIndex = addTurn(conversationId, role, content);
  sqliteDb
    .prepare(`UPDATE turns SET created_at = ? WHERE conversation_id = ? AND turn_index = ?`)
    .run(when, conversationId, turnIndex);
  return turnIndex;
}
function hoursAgoStr(h) {
  return new Date(Date.now() - h * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
}
function clearRegistry() {
  sqliteDb.prepare(`DELETE FROM page_registry`).run();
}

// ── 1. normalization ──────────────────────────────────────────────────────
console.log('\nnormalizePageUrl');
{
  const n = PC.normalizePageUrl;
  const CANON = '192.168.1.25:8100/goals';
  for (const variant of [
    'http://192.168.1.25:8100/goals',
    'https://192.168.1.25:8100/goals',          // scheme is dropped
    'http://192.168.1.25:8100/goals/',          // trailing slash
    'http://192.168.1.25:8100/goals?tab=open',  // query
    'http://192.168.1.25:8100/goals#node-3',    // hash
    'http://192.168.1.25:8100/goals/?a=1#b',    // all three at once
    '  http://192.168.1.25:8100/goals  ',       // surrounding whitespace
    '192.168.1.25:8100/goals',                  // bare host:port/path
  ]) {
    assert.equal(n(variant), CANON, `${variant} → ${CANON}`);
  }
  ok('scheme / trailing slash / query / hash / whitespace all collapse to one key');

  assert.equal(n('http://JARVIS.local:8090/Docs'), 'jarvis.local:8090/Docs');
  ok('host is lowercased, path case is preserved');

  assert.equal(n('http://example.com'), 'example.com');
  assert.equal(n('http://example.com/'), 'example.com');
  assert.equal(n('http://example.com//'), 'example.com');
  ok('a bare host normalizes with no trailing slash');

  assert.equal(n('http://example.com:80/x'), 'example.com/x');
  assert.equal(n('https://example.com:443/x'), 'example.com/x');
  assert.equal(n('http://example.com:8080/x'), 'example.com:8080/x');
  ok('default ports are dropped, non-default ports are kept');

  for (const bad of [
    '', '   ', null, undefined, 42,
    'chrome://extensions',
    'file:///home/kevin/x.html',
    'about:blank',
    '/settings/vault?file=outbox/x.md',  // relative — no host to match on
    'not a url at all',
  ]) {
    assert.equal(n(bad), null, `${String(bad)} is not a page URL`);
  }
  ok('non-http(s), relative and junk inputs return null');
}

// ── 2. patterns ───────────────────────────────────────────────────────────
console.log('\npattern normalization + matching');
{
  assert.equal(PC.normalizePagePattern('http://192.168.1.25:8100/*'), '192.168.1.25:8100/*');
  assert.equal(PC.normalizePagePattern('HTTPS://Host:8094/Flip/*'), 'host:8094/Flip/*');
  assert.equal(PC.normalizePagePattern('http://host/dash*'), 'host/dash*');
  assert.equal(PC.normalizePagePattern('http://host/page'), 'host/page');
  assert.equal(PC.normalizePagePattern('*'), null, 'a bare * claims every page — rejected');
  assert.equal(PC.normalizePagePattern('chrome://*'), null);
  ok('patterns canonicalize like URLs and keep their wildcard');

  const m = PC.pagePatternMatches;
  assert.equal(m('192.168.1.25:8100/*', '192.168.1.25:8100'), true, 'host root is under host/*');
  assert.equal(m('192.168.1.25:8100/*', '192.168.1.25:8100/goals/5'), true);
  assert.equal(m('192.168.1.25:8100/*', '192.168.1.25:8101/goals'), false, 'different port is a different page');
  assert.equal(m('192.168.1.25:8100/*', '192.168.1.25:81009'), false, 'no partial-host bleed');
  ok('`host/*` covers the host and everything under it, nothing else');

  assert.equal(m('host/dash*', 'host/dashboard'), true, 'mid-segment prefix pattern');
  assert.equal(m('host/dash*', 'host/dash/x'), true);
  assert.equal(m('host/dash*', 'host/other'), false);
  ok('a `*` not on a / boundary is a raw string prefix');

  assert.equal(m('host/page', 'host/page'), true);
  assert.equal(m('host/page', 'host/page/sub'), false, 'exact row does not swallow children');
  ok('a pattern with no wildcard is an exact match');
}

// ── 3. registry matching / specificity ────────────────────────────────────
console.log('\nmatchPageRegistry');
{
  clearRegistry();
  PC.upsertPageRegistry({ url_pattern: 'http://192.168.1.25:8095/*', project: 'Restore Matrix + Leaks' });
  PC.upsertPageRegistry({ url_pattern: 'http://192.168.1.25:8095/leaks/*', project: 'Leaks board' });
  PC.upsertPageRegistry({ url_pattern: 'http://192.168.1.25:8095/leaks/one', project: 'One leak' });

  assert.equal(PC.matchPageRegistry('192.168.1.25:8095/downtime').project, 'Restore Matrix + Leaks');
  assert.equal(PC.matchPageRegistry('192.168.1.25:8095/leaks/two').project, 'Leaks board');
  assert.equal(PC.matchPageRegistry('192.168.1.25:8095/leaks/one').project, 'One leak');
  assert.equal(PC.matchPageRegistry('192.168.1.25:9999/x'), null);
  ok('the most specific covering row wins (exact > deep prefix > host prefix)');

  const before = PC.listPageRegistry().length;
  PC.upsertPageRegistry({ url_pattern: 'HTTPS://192.168.1.25:8095/*', project: 'Restore Matrix renamed' });
  assert.equal(PC.listPageRegistry().length, before, 'same canonical pattern = no new row');
  assert.equal(PC.matchPageRegistry('192.168.1.25:8095').project, 'Restore Matrix renamed');
  ok('upsert is keyed on the canonical pattern, not the raw string');

  assert.throws(() => PC.upsertPageRegistry({ url_pattern: 'chrome://x', project: 'nope' }), /invalid_url_pattern|not a usable/);
  assert.throws(() => PC.upsertPageRegistry({ url_pattern: 'http://host/x', project: '  ' }), /project is required/);
  ok('bad pattern / empty project are rejected, not stored');
}

// ── 4. thread_links reverse lookup ────────────────────────────────────────
console.log('\nlookupPage — thread_links reverse match');
{
  clearRegistry();
  const PAGE = 'http://192.168.1.25:8096/ad-review';

  const older = getOrCreateConversation('cockpit:pc-older');
  renameConversation(older.id, 'Ad review board build');
  setPreviewLink(older.id, PAGE, 'Ad Review Board');
  addTurnAt(older.id, 'user', 'build it', hoursAgoStr(10));

  const newer = getOrCreateConversation('cockpit:pc-newer');
  renameConversation(newer.id, 'Ad review follow-up');
  // Linked with a different surface form — normalization must still match.
  addThreadLink(newer.id, 'HTTPS://192.168.1.25:8096/ad-review/?tab=de#x', 'same page');
  addTurnAt(newer.id, 'user', 'tweak it', hoursAgoStr(1));

  const unrelated = getOrCreateConversation('cockpit:pc-unrelated');
  addThreadLink(unrelated.id, 'http://192.168.1.25:8096/other', 'other page');
  addTurnAt(unrelated.id, 'user', 'nope', hoursAgoStr(2));

  const r = PC.lookupPage('http://192.168.1.25:8096/ad-review?from=extension');
  assert.equal(r.ours, true, 'a linked page is ours even with no registry row');
  assert.equal(r.registry_id, null);
  assert.equal(r.project, null);
  assert.equal(r.normalized_url, '192.168.1.25:8096/ad-review');
  assert.deepEqual(
    r.threads.map((t) => t.external_id),
    ['cockpit:pc-newer', 'cockpit:pc-older'],
    'newest activity first, unrelated page excluded',
  );
  assert.equal(r.threads[0].title, 'Ad review follow-up');
  assert.ok(r.threads[0].last_active > r.threads[1].last_active);
  ok('reverse lookup matches across URL surface forms and orders by activity');

  // Two links on one thread pointing at the same page must not list it twice.
  addThreadLink(newer.id, PAGE, 'again');
  const dup = PC.lookupPage(PAGE);
  assert.equal(dup.threads.filter((t) => t.external_id === 'cockpit:pc-newer').length, 1);
  ok('a thread with two links to the same page is listed once');

  const miss = PC.lookupPage('http://192.168.1.25:8096/never-seen');
  assert.deepEqual(miss, {
    ours: false, project: null, registry_id: null, threads: [],
    normalized_url: '192.168.1.25:8096/never-seen',
  });
  ok('an unknown page is not ours and lists nothing');

  assert.equal(PC.lookupPage('chrome://extensions').ours, false);
  assert.equal(PC.lookupPage('chrome://extensions').normalized_url, null);
  ok('a non-page URL answers ours:false instead of throwing');
}

// ── 5. vault-viewer link exclusion ────────────────────────────────────────
console.log('\nvault-viewer links');
{
  assert.equal(PC.isVaultViewerLink('/settings/vault?file=outbox/report.md'), true);
  assert.equal(PC.isVaultViewerLink('http://192.168.1.25:8080/settings/vault?file=outbox/x.md'), true);
  assert.equal(PC.isVaultViewerLink('http://192.168.1.25:8080/settings/vault'), true);
  assert.equal(PC.isVaultViewerLink('http://192.168.1.25:8080/settings/vaultish'), false);
  assert.equal(PC.isVaultViewerLink('http://192.168.1.25:8080/goals'), false);
  ok('isVaultViewerLink recognizes both the relative and absolute forms');

  assert.equal(PC.pageKeyFromThreadLink('http://192.168.1.25:8080/settings/vault?file=x.md'), null);
  assert.equal(PC.pageKeyFromThreadLink('http://192.168.1.25:8080/goals/'), '192.168.1.25:8080/goals');
  ok('pageKeyFromThreadLink drops vault links, keeps real pages');

  clearRegistry();
  const vaulty = getOrCreateConversation('cockpit:pc-vault');
  addThreadLink(vaulty.id, 'http://192.168.1.25:8080/settings/vault?file=outbox/report.md', 'report');
  const r = PC.lookupPage('http://192.168.1.25:8080/settings/vault?file=outbox/report.md');
  assert.equal(r.ours, false, 'the vault viewer itself is never claimed as a built page');
  assert.deepEqual(r.threads, []);
  ok('a thread whose only link is a vault link never makes a page ours');
}

// ── 6. registry match + primary thread union ──────────────────────────────
console.log('\nlookupPage — registry + primary thread');
{
  clearRegistry();
  const owner = getOrCreateConversation('cockpit:pc-heartbeat-owner');
  renameConversation(owner.id, 'Heartbeat build');
  addTurnAt(owner.id, 'user', 'ship it', hoursAgoStr(20));

  const row = PC.upsertPageRegistry({
    url_pattern: 'http://192.168.1.25:8100/*',
    project: 'Hub 1.0 Heartbeat',
    primary_thread_ext: 'cockpit:pc-heartbeat-owner',
  });

  const r = PC.lookupPage('http://192.168.1.25:8100/anything/deep?x=1');
  assert.equal(r.ours, true);
  assert.equal(r.project, 'Hub 1.0 Heartbeat');
  assert.equal(r.registry_id, row.id);
  assert.deepEqual(r.threads.map((t) => t.external_id), ['cockpit:pc-heartbeat-owner']);
  ok('a registry prefix row claims the page and surfaces its owning chat');

  // A registry row with a dangling owner must still be `ours`, just thread-less.
  PC.upsertPageRegistry({ url_pattern: 'http://192.168.1.25:8101/*', project: 'Orphan', primary_thread_ext: 'cockpit:does-not-exist' });
  const orphan = PC.lookupPage('http://192.168.1.25:8101/x');
  assert.equal(orphan.ours, true);
  assert.deepEqual(orphan.threads, []);
  ok('a registry row pointing at a missing chat is still ours, with no threads');

  // Owner + a separately-linked chat: union, deduped, activity-ordered.
  const linked = getOrCreateConversation('cockpit:pc-heartbeat-linked');
  addThreadLink(linked.id, 'http://192.168.1.25:8100/anything/deep', 'the page');
  addTurnAt(linked.id, 'user', 'later edit', hoursAgoStr(1));
  addThreadLink(owner.id, 'http://192.168.1.25:8100/anything/deep', 'same page');
  const union = PC.lookupPage('http://192.168.1.25:8100/anything/deep');
  assert.deepEqual(
    union.threads.map((t) => t.external_id),
    ['cockpit:pc-heartbeat-linked', 'cockpit:pc-heartbeat-owner'],
  );
  ok('primary thread and linked threads are unioned without duplicates');
}

// ── 7. throwaway threads are never surfaced ───────────────────────────────
console.log('\nlookupPage — excluded thread kinds');
{
  clearRegistry();
  const PAGE = 'http://192.168.1.25:8093/scratch';
  for (const ext of ['ephemeral:pc-1', 'checkin:pc-1']) {
    const c = getOrCreateConversation(ext);
    addThreadLink(c.id, PAGE, 'scratch');
    addTurnAt(c.id, 'user', 'x', hoursAgoStr(1));
  }
  const r = PC.lookupPage(PAGE);
  assert.deepEqual(r.threads, [], 'ephemeral/checkin conversations are not listable threads');
  assert.equal(r.ours, false, 'and they do not make the page ours on their own');
  ok('ephemeral: and checkin: conversations are excluded');
}

// ── 8. new page chat ──────────────────────────────────────────────────────
console.log('\ncreatePageChat');
{
  clearRegistry();
  PC.upsertPageRegistry({ url_pattern: 'http://192.168.1.25:8094/*', project: 'Circle & Flip' });

  const made = PC.createPageChat('http://192.168.1.25:8094/flip?tab=a');
  assert.match(made.external_id, /^cockpit:page-[0-9a-f-]{36}$/, 'external_id is cockpit:page-<uuid>');
  assert.equal(made.project, 'Circle & Flip', 'project inferred from the registry when not passed');

  const conv = getConversation(made.external_id);
  assert.ok(conv, 'the conversation row exists');
  assert.equal(conv.id, made.conversation_id);
  assert.equal(conv.title, 'Circle & Flip · page chat');

  const turns = sqliteDb
    .prepare(`SELECT role, content FROM turns WHERE conversation_id = ? ORDER BY turn_index`)
    .all(conv.id);
  assert.equal(turns.length, 1, 'exactly one seeded turn — zero model calls');
  assert.equal(turns[0].role, 'assistant');
  assert.ok(turns[0].content.includes('http://192.168.1.25:8094/flip?tab=a'), 'the page URL is pinned');
  assert.ok(turns[0].content.includes('Circle & Flip'), 'the project name is pinned');

  const links = listThreadLinks(conv.id);
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, 'preview');
  assert.equal(links[0].url, 'http://192.168.1.25:8094/flip?tab=a');
  ok('new-chat creates the conversation, pins the page, and writes the link row');

  // The whole point: the next lookup on that page lists the chat it created.
  const after = PC.lookupPage('https://192.168.1.25:8094/flip/');
  assert.ok(after.threads.some((t) => t.external_id === made.external_id),
    'the chat the page just created is listed on the next lookup');
  ok('a page-created chat is immediately discoverable from the page');

  const explicit = PC.createPageChat('192.168.1.25:8099/new-thing', 'Brand New Thing');
  assert.equal(explicit.project, 'Brand New Thing');
  assert.equal(explicit.page_url, 'http://192.168.1.25:8099/new-thing', 'bare host input gets an http:// form');
  assert.notEqual(explicit.external_id, made.external_id, 'every call is a distinct chat');
  ok('an explicit project wins, and a bare host/path input is canonicalized');

  for (const bad of ['chrome://x', '', '/settings/vault?file=x', null]) {
    assert.throws(() => PC.createPageChat(bad), /invalid_url|url must be/, `rejects ${String(bad)}`);
  }
  ok('new-chat refuses a non-page URL instead of creating a junk thread');
}

// ── 9. seeding ────────────────────────────────────────────────────────────
console.log('\nseedPageRegistry');
{
  clearRegistry();
  // A thread link on a page NOT covered by any manual row → one auto row.
  const linkedConv = getOrCreateConversation('cockpit:pc-seed-linked');
  renameConversation(linkedConv.id, 'Some build thread');
  addThreadLink(linkedConv.id, 'http://192.168.1.25:8077/tool/', 'Tool page');
  // A link UNDER a manual seed row → must NOT produce a redundant auto row.
  addThreadLink(linkedConv.id, 'http://192.168.1.25:8100/heartbeat/detail', 'heartbeat detail');
  // A vault link → never a registry row.
  addThreadLink(linkedConv.id, 'http://192.168.1.25:8080/settings/vault?file=outbox/x.md', 'report');

  const first = PC.seedPageRegistry();
  assert.equal(first.manual_added, 4, 'the four hand-listed dashboards land');
  const rows = PC.listPageRegistry();
  const byPattern = new Map(rows.map((r) => [r.url_pattern, r]));
  for (const { url_pattern, project } of PC.MANUAL_PAGE_REGISTRY_SEED) {
    const canon = PC.normalizePagePattern(url_pattern);
    assert.equal(byPattern.get(canon)?.project, project, `${canon} → ${project}`);
    assert.equal(byPattern.get(canon)?.source, 'manual');
  }
  assert.ok(byPattern.has('192.168.1.25:8077/tool'), 'the uncovered linked page gets an auto row');
  assert.equal(byPattern.get('192.168.1.25:8077/tool').source, 'thread_links_auto');
  assert.equal(byPattern.get('192.168.1.25:8077/tool').project, 'Tool page', 'auto row takes the link label');
  assert.equal(byPattern.get('192.168.1.25:8077/tool').primary_thread_ext, 'cockpit:pc-seed-linked');
  assert.ok(!byPattern.has('192.168.1.25:8100/heartbeat/detail'), 'a page already under a manual prefix gets no auto row');
  assert.ok(![...byPattern.keys()].some((k) => k.includes('settings/vault')), 'vault links never become registry rows');
  ok('seed adds the manual dashboards + auto rows only for uncovered linked pages');

  const countAfterFirst = PC.listPageRegistry().length;
  const second = PC.seedPageRegistry();
  assert.deepEqual(
    { manual_added: second.manual_added, auto_added: second.auto_added },
    { manual_added: 0, auto_added: 0 },
    'a second run adds nothing',
  );
  assert.equal(PC.listPageRegistry().length, countAfterFirst, 'row count unchanged');
  ok('seeding is idempotent — running twice adds nothing');

  // A hand-renamed project must survive re-seeding.
  PC.upsertPageRegistry({ url_pattern: 'http://192.168.1.25:8100/*', project: 'Heartbeat (Kevin renamed)' });
  PC.seedPageRegistry();
  assert.equal(PC.matchPageRegistry('192.168.1.25:8100/x').project, 'Heartbeat (Kevin renamed)');
  ok('re-seeding never clobbers a project name Kevin changed');

  // And a seeded dashboard is now `ours` with no chats at all.
  const bare = PC.lookupPage('http://192.168.1.25:8090/architecture');
  assert.equal(bare.ours, true);
  assert.equal(bare.project, 'Engine Docs');
  ok('a seeded dashboard answers ours:true before any chat links it');
}

console.log(`\n[page-companion-check] ALL ${passed} tests passed ✅`);
