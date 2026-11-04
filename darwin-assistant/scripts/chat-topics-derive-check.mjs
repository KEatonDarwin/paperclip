#!/usr/bin/env node
// CHAT TOPICS DERIVATION ENGINE CHECK (tree-c9800208 node #1579)
//
//   npm run build && npm run chat-topics-derive:check
//
// Hermetic regression suite for src/chat-topics-derive.ts, against the
// COMPILED dist on a scratch SQLite DB. The model call is faked: CLAUDE_BIN
// is a tiny node script that drains stdin, logs that it was invoked, and
// echoes back a canned response read from a file the test controls — so
// each section can prove a specific derivation outcome without any network
// or billed model call.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// ── fake claude CLI: drains stdin, appends to a call log, echoes back
//    whatever's in FAKE_CLAUDE_RESPONSE_FILE as a stream-json `result` line.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-topics-derive-check-'));
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

const distDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const topics = await import(path.join(distDir, 'chat-topics-store.js'));
const derive = await import(path.join(distDir, 'chat-topics-derive.js'));

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

let nextConvSeq = 0;
function createConversation(externalId) {
  const id = externalId ?? `cockpit:test-derive-${nextConvSeq++}`;
  const info = convDb.sqliteDb.prepare(`INSERT INTO conversations (external_id) VALUES (?)`).run(id);
  return Number(info.lastInsertRowid);
}

let nextTurnIdx = {};
function addTurn(convId, role, content) {
  nextTurnIdx[convId] = (nextTurnIdx[convId] ?? 0) + 1;
  convDb.sqliteDb
    .prepare(`INSERT INTO turns (conversation_id, turn_index, role, content) VALUES (?, ?, ?, ?)`)
    .run(convId, nextTurnIdx[convId], role, content);
}

function topicRowsFor(convId) {
  return convDb.sqliteDb
    .prepare(`SELECT * FROM conversation_topics WHERE conversation_id = ? ORDER BY topic_id`)
    .all(convId);
}

function topicCountBySlug(slug) {
  return convDb.sqliteDb.prepare(`SELECT COUNT(*) as cnt FROM topics WHERE slug = ?`).get(slug).cnt;
}

console.log('\nCHAT TOPICS DERIVATION ENGINE CHECK\n');

// ── 1. new-topic path ────────────────────────────────────────────────────
console.log('new-topic path');
{
  const convId = createConversation();
  addTurn(convId, 'user', 'How do we handle the media buy rollout for Perclickity?');
  addTurn(convId, 'assistant', 'Let me look into the redirect edit.');

  setResponse({ primary: 'Media Buy Rollout', secondary: null, matched_existing_ids: [] });
  resetCallLog();
  await derive.deriveTopicsForConversation(convId);

  t('claude CLI was invoked exactly once', callCount() === 1, String(callCount()));
  const rows = topicRowsFor(convId);
  t('exactly one topic row written', rows.length === 1, String(rows.length));
  t('new topic row is primary', rows[0]?.is_primary === 1);
  const topicRow = topics.getTopic(rows[0]?.topic_id);
  t('new topic has the proposed label', topicRow?.label === 'Media Buy Rollout', topicRow?.label);
}

// ── 2. cluster-to-existing makes NO duplicate topic row ─────────────────
console.log('\ncluster-to-existing: no duplicate topic row');
{
  const existingId = topics.upsertTopic('Suppression Files');
  const before = topicCountBySlug('suppression-files');

  const convId = createConversation();
  addTurn(convId, 'user', 'Can you check the suppression files adherence report again?');
  addTurn(convId, 'assistant', 'On it.');

  setResponse({ primary: 'Suppression Files', secondary: null, matched_existing_ids: [existingId] });
  await derive.deriveTopicsForConversation(convId);

  const after = topicCountBySlug('suppression-files');
  t('no new topics row created for the same slug', after === before, `${before} -> ${after}`);
  const rows = topicRowsFor(convId);
  t('conversation linked to the existing topic id', rows[0]?.topic_id === existingId, String(rows[0]?.topic_id));
}

// ── 3. pivot: second derive adds a 2nd topic, keeps the 1st ─────────────
console.log('\npivot: adds 2nd topic, keeps 1st, flips primary');
{
  const convId = createConversation();
  addTurn(convId, 'user', 'How do we handle the media buy rollout for Perclickity?');
  addTurn(convId, 'assistant', 'Let me look into the redirect edit.');

  setResponse({ primary: 'Media Buy Rollout', secondary: null, matched_existing_ids: [] });
  await derive.deriveTopicsForConversation(convId);
  let rows = topicRowsFor(convId);
  t('first derive: 1 topic row', rows.length === 1, String(rows.length));
  const firstTopicId = rows[0]?.topic_id;

  // Pivot: conversation moves on to a new subject.
  addTurn(convId, 'user', 'Different question — can we look at the budget review numbers instead?');
  addTurn(convId, 'assistant', 'Sure, pulling those up.');

  setResponse({ primary: 'Budget Review', secondary: null, matched_existing_ids: [] });
  await derive.deriveTopicsForConversation(convId);
  rows = topicRowsFor(convId);
  t('pivot: now 2 topic rows (old kept, not deleted)', rows.length === 2, String(rows.length));
  const oldRow = rows.find((r) => r.topic_id === firstTopicId);
  const newRow = rows.find((r) => r.topic_id !== firstTopicId);
  t('old topic row still present', !!oldRow);
  t('old topic primary flipped OFF', oldRow?.is_primary === 0);
  t('new topic primary flipped ON', newRow?.is_primary === 1);
}

// ── 4. ineligible thread skipped (no model call at all) ─────────────────
console.log('\nineligible thread: skipped, zero model calls');
{
  const convId = createConversation('cockpit:hopper-node-999-deadbeef');
  addTurn(convId, 'user', 'background worker chatter');
  addTurn(convId, 'assistant', 'ack');

  setResponse({ primary: 'Should Never Be Used', secondary: null, matched_existing_ids: [] });
  resetCallLog();
  await derive.deriveTopicsForConversation(convId);

  t('claude CLI was never invoked', callCount() === 0, String(callCount()));
  t('no topic rows written', topicRowsFor(convId).length === 0, String(topicRowsFor(convId).length));
}

// ── 5. malformed model output is dropped, never guessed ─────────────────
console.log('\nmalformed model output: dropped');
{
  const convId = createConversation();
  addTurn(convId, 'user', 'Totally normal eligible message.');
  addTurn(convId, 'assistant', 'Sure.');

  const topicsBefore = convDb.sqliteDb.prepare(`SELECT COUNT(*) as cnt FROM topics`).get().cnt;
  fs.writeFileSync(RESPONSE_FILE, 'not json at all {{{ garbage');
  resetCallLog();
  await derive.deriveTopicsForConversation(convId);

  t('claude CLI was invoked', callCount() === 1, String(callCount()));
  t('no topic rows written for garbage output', topicRowsFor(convId).length === 0);
  const topicsAfter = convDb.sqliteDb.prepare(`SELECT COUNT(*) as cnt FROM topics`).get().cnt;
  t('no stray topic row created from garbage', topicsAfter === topicsBefore, `${topicsBefore} -> ${topicsAfter}`);

  // Same for well-formed JSON that's missing the required "primary" field.
  setResponse({ secondary: 'Some Topic', matched_existing_ids: [] });
  await derive.deriveTopicsForConversation(convId);
  t('no topic rows written when "primary" is missing', topicRowsFor(convId).length === 0);
}

// ── 6. shouldRederive trigger policy ─────────────────────────────────────
console.log('\nshouldRederive trigger policy');
{
  const convId = createConversation();
  t('no turns yet: not due', derive.shouldRederive(convId) === false);

  addTurn(convId, 'user', 'first message');
  t('1 user turn, no topics: not due yet', derive.shouldRederive(convId) === false);

  addTurn(convId, 'assistant', 'reply');
  addTurn(convId, 'user', 'second message');
  t('2 user turns, no topics: due', derive.shouldRederive(convId) === true);

  setResponse({ primary: 'Shouldrederive Topic', secondary: null, matched_existing_ids: [] });
  await derive.deriveTopicsForConversation(convId);
  t('right after a derive: not due again', derive.shouldRederive(convId) === false);

  for (let i = 0; i < 5; i++) addTurn(convId, i % 2 === 0 ? 'user' : 'assistant', `filler ${i}`);
  t('5 new turns since derive: still not due', derive.shouldRederive(convId) === false);

  addTurn(convId, 'user', 'the 6th new turn');
  t('6 new turns since derive: due again', derive.shouldRederive(convId) === true);
}

// ── wrap up ──────────────────────────────────────────────────────────────
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
fs.rmSync(scratchDir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} chat-topics-derive-check: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
