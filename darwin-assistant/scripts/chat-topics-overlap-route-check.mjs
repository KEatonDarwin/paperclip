#!/usr/bin/env node
// CHAT TOPICS OVERLAP + INDEX ROUTE CHECK (tree-c9800208 node #1580)
//
//   npm run build && npm run chat-topics-overlap:route-check
//
// The REAL Express router over real HTTP on a throwaway port against a
// scratch DB, seeded directly through the compiled chat-topics-store. Proves
// GET /chat-topics groups correctly (is_primary vs now_about), and that
// POST /chat-topics/overlap matches cheaply (no model call) and falls back to
// a FAKED haiku CLI (no network/API key) only on a cheap miss, always capped
// at 3, always excluding the caller's own external_id, and [] on empty/junk
// input. No live state touched.

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
process.env.CLAUDE_USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-topics-overlap-usage-'));

// ── fake claude CLI: drains stdin, logs a call, echoes FAKE_CLAUDE_RESPONSE
//    back as a stream-json `result` line — same shape chat-topics-derive-check
//    uses, so the "only call the model on a cheap miss" guarantee is provable.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-topics-overlap-check-'));
const FAKE_BIN = path.join(scratchDir, 'fake-claude.cjs');
const RESPONSE_FILE = path.join(scratchDir, 'response.json');
const CALL_LOG = path.join(scratchDir, 'calls.log');
fs.writeFileSync(
  FAKE_BIN,
  `#!/usr/bin/env node
const fs = require('fs');
try { fs.appendFileSync(${JSON.stringify(CALL_LOG)}, '1\\n'); } catch {}
let data = '';
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => {
  let result = '';
  try { result = fs.readFileSync(${JSON.stringify(RESPONSE_FILE)}, 'utf8'); } catch {}
  process.stdout.write(JSON.stringify({ type: 'result', result }) + '\\n');
  process.exit(0);
});
`,
);
fs.chmodSync(FAKE_BIN, 0o755);
process.env.CLAUDE_CLI_PATH = FAKE_BIN;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

function setResponse(obj) {
  fs.writeFileSync(RESPONSE_FILE, JSON.stringify(obj));
}
function callCount() {
  try {
    return fs.readFileSync(CALL_LOG, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}
function resetCallLog() {
  fs.rmSync(CALL_LOG, { force: true });
}

const distDir = path.join(__dirname, '..', 'dist');
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const topics = await import(path.join(distDir, 'chat-topics-store.js'));

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const key = mintApiKey('chat-topics-overlap-route-check', 'admin').plaintext;

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

// ── seed helpers (direct store calls against the compiled dist, like the
//    sibling chat-topics-check.mjs / chat-topics-derive-check.mjs suites) ──
let seq = 0;
function createConversation(externalId, { title } = {}) {
  const id = externalId ?? `cockpit:test-overlap-${seq++}`;
  const info = convDb.sqliteDb.prepare(`INSERT INTO conversations (external_id, title) VALUES (?, ?)`).run(id, title ?? null);
  return Number(info.lastInsertRowid);
}
function ageConversation(convId, daysAgo) {
  const iso = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const sqliteStamp = iso.slice(0, 19).replace('T', ' ');
  convDb.sqliteDb.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(sqliteStamp, convId);
}

console.log('\nCHAT TOPICS OVERLAP + INDEX ROUTE CHECK\n');

console.log('auth');
for (const p of ['/chat-topics']) {
  const r = await call('GET', p, undefined, { noAuth: true });
  t(`${p} requires auth`, r.status === 401 || r.status === 403, `got ${r.status}`);
}
{
  const r = await call('POST', '/chat-topics/overlap', { text: 'x' }, { noAuth: true });
  t('POST /chat-topics/overlap requires auth', r.status === 401 || r.status === 403, `got ${r.status}`);
}

console.log('\nGET /chat-topics — grouping, is_primary, now_about');
{
  const topicAId = topics.upsertTopic('Media Buy Rollout');
  const topicBId = topics.upsertTopic('Budget Review');

  const conv1 = createConversation(undefined, { title: 'Media buy chat' });
  topics.addConversationTopic(conv1, topicAId, { primary: true, source: 'auto' });

  // conv2 pivots: topic A kept (now secondary), topic B is the new primary.
  const conv2 = createConversation(undefined, { title: 'Pivoted chat' });
  topics.addConversationTopic(conv2, topicAId, { primary: true, source: 'auto' });
  topics.addConversationTopic(conv2, topicBId, { primary: true, source: 'auto' });

  const r = await call('GET', '/chat-topics');
  eq('200', r.status, 200);
  const groupA = r.body.topics.find((g) => g.topic_id === topicAId);
  const groupB = r.body.topics.find((g) => g.topic_id === topicBId);
  t('topic A group present', !!groupA);
  t('topic B group present', !!groupB);
  eq('topic A has both chats', groupA.chats.length, 2);

  const c1InA = groupA.chats.find((c) => c.external_id === convDb.getConversationById(conv1).external_id);
  const c2InA = groupA.chats.find((c) => c.external_id === convDb.getConversationById(conv2).external_id);
  eq('conv1 is primary in group A (its only topic)', c1InA.is_primary, true);
  eq('conv1 now_about is label A', c1InA.now_about, 'Media Buy Rollout');
  eq('conv2 is NOT primary in group A (demoted by the pivot)', c2InA.is_primary, false);
  eq('conv2 now_about reflects its CURRENT primary (B), not group A', c2InA.now_about, 'Budget Review');

  const c2InB = groupB.chats.find((c) => c.external_id === convDb.getConversationById(conv2).external_id);
  eq('conv2 is primary in group B', c2InB.is_primary, true);
  eq('conv2 title carried through', c2InB.title, 'Pivoted chat');

  // Ineligible chats never appear even if somehow topic-linked.
  const hopperConv = createConversation('cockpit:hopper-node-55-feedface');
  topics.addConversationTopic(hopperConv, topicAId, { primary: true, source: 'manual' });
  const r2 = await call('GET', '/chat-topics');
  const groupA2 = r2.body.topics.find((g) => g.topic_id === topicAId);
  t('ineligible (hopper-node) chat excluded from the index', !groupA2.chats.some((c) => c.external_id === 'cockpit:hopper-node-55-feedface'));
}

console.log('\nPOST /chat-topics/overlap — cheap match, no model call');
{
  const cheapTopicId = topics.upsertTopic('Suppression Files');
  const existing = createConversation(undefined, { title: 'Suppression files thread' });
  topics.addConversationTopic(existing, cheapTopicId, { primary: true, source: 'auto' });

  resetCallLog();
  const r = await call('POST', '/chat-topics/overlap', { text: 'can we check the suppression files report again' });
  eq('200', r.status, 200);
  eq('claude CLI NOT invoked (cheap substring hit)', callCount(), 0);
  eq('one candidate', r.body.candidates.length, 1);
  eq('candidate external_id', r.body.candidates[0].external_id, convDb.getConversationById(existing).external_id);
  eq('candidate matched_label', r.body.candidates[0].matched_label, 'Suppression Files');
  eq('candidate title', r.body.candidates[0].title, 'Suppression files thread');
}

console.log('\nPOST /chat-topics/overlap — excludes the caller\'s own external_id');
{
  const topicId = topics.upsertTopic('Exclude Me Topic');
  const selfConv = createConversation(undefined, { title: 'Self' });
  topics.addConversationTopic(selfConv, topicId, { primary: true, source: 'auto' });
  const selfExt = convDb.getConversationById(selfConv).external_id;

  const r = await call('POST', '/chat-topics/overlap', { text: 'exclude me topic please', exclude_external_id: selfExt });
  eq('200', r.status, 200);
  t('self is excluded even though it is the only match', !r.body.candidates.some((c) => c.external_id === selfExt));
}

console.log('\nPOST /chat-topics/overlap — caps at 3, newest first');
{
  const topicId = topics.upsertTopic('Capped Topic');
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = createConversation(undefined, { title: `capped ${i}` });
    topics.addConversationTopic(id, topicId, { primary: true, source: 'auto' });
    ageConversation(id, 5 - i); // i=4 is most recent (ageConversation(id,1))
    ids.push(id);
  }
  const r = await call('POST', '/chat-topics/overlap', { text: 'capped topic chatter' });
  eq('200', r.status, 200);
  eq('capped at 3', r.body.candidates.length, 3);
  const newestExt = convDb.getConversationById(ids[4]).external_id;
  eq('newest first', r.body.candidates[0].external_id, newestExt);
}

console.log('\nPOST /chat-topics/overlap — recency window (~14 days)');
{
  const topicId = topics.upsertTopic('Stale Topic Only');
  const staleConv = createConversation(undefined, { title: 'stale' });
  topics.addConversationTopic(staleConv, topicId, { primary: true, source: 'auto' });
  ageConversation(staleConv, 30);

  const r = await call('POST', '/chat-topics/overlap', { text: 'stale topic only chatter' });
  eq('200', r.status, 200);
  eq('a 30-day-old chat is excluded as stale', r.body.candidates.length, 0);
}

console.log('\nPOST /chat-topics/overlap — falls back to the haiku CLI on a cheap miss');
{
  const topicId = topics.upsertTopic('Darwin Hub Rate Review');
  const conv = createConversation(undefined, { title: 'rate review thread' });
  topics.addConversationTopic(conv, topicId, { primary: true, source: 'auto' });

  setResponse({ label: 'Darwin Hub Rate Review' });
  resetCallLog();
  const r = await call('POST', '/chat-topics/overlap', { text: 'hey can we look at whether those numbers from last week still hold up' });
  eq('200', r.status, 200);
  eq('claude CLI invoked exactly once (cheap match missed)', callCount(), 1);
  eq('one candidate via model fallback', r.body.candidates.length, 1);
  eq('candidate matched via model label', r.body.candidates[0].matched_label, 'Darwin Hub Rate Review');
}

console.log('\nPOST /chat-topics/overlap — [] on no-match / junk / model error, never throws');
{
  resetCallLog();
  setResponse({ label: null });
  const noMatch = await call('POST', '/chat-topics/overlap', { text: 'completely unrelated one-off gibberish qqzxy' });
  eq('200 on a genuine no-match', noMatch.status, 200);
  eq('[] candidates', noMatch.body.candidates.length, 0);

  const empty = await call('POST', '/chat-topics/overlap', { text: '' });
  eq('200 on empty text', empty.status, 200);
  eq('[] candidates for empty text', empty.body.candidates.length, 0);

  const missing = await call('POST', '/chat-topics/overlap', {});
  eq('200 on missing text field', missing.status, 200);
  eq('[] candidates for missing text', missing.body.candidates.length, 0);

  // Malformed model output on a cheap miss must still resolve to [], not 500.
  fs.writeFileSync(RESPONSE_FILE, 'not json at all {{{ garbage');
  const junk = await call('POST', '/chat-topics/overlap', { text: 'another totally novel one-off phrase zzqq' });
  eq('200 even when the model reply is garbage', junk.status, 200);
  eq('[] candidates on malformed model output', junk.body.candidates.length, 0);
}

console.log('\nPOST /chat-topics/derive/:convId — manual re-derive');
{
  const conv = createConversation(undefined, { title: 'manual derive target' });
  convDb.sqliteDb.prepare(`INSERT INTO turns (conversation_id, turn_index, role, content) VALUES (?, 1, 'user', ?)`).run(conv, 'what is the status of the media buy rollout');
  convDb.sqliteDb.prepare(`INSERT INTO turns (conversation_id, turn_index, role, content) VALUES (?, 2, 'assistant', ?)`).run(conv, 'checking now');

  setResponse({ primary: 'Manual Derive Target', secondary: null, matched_existing_ids: [] });
  const r = await call('POST', `/chat-topics/derive/${conv}`, {});
  eq('200', r.status, 200);
  t('topic assigned', r.body.topics.some((tp) => tp.label === 'Manual Derive Target'));

  eq('non-numeric convId 400s', (await call('POST', '/chat-topics/derive/abc', {})).status, 400);
  eq('unknown convId 404s', (await call('POST', '/chat-topics/derive/999999', {})).status, 404);
}

server.close();
fs.rmSync(scratchDir, { recursive: true, force: true });
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
