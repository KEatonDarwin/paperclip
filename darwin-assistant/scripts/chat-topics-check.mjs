#!/usr/bin/env node
// CHAT TOPICS BACKEND CHECK (tree-c9800208 node #1578)
//
//   npm run build && npm run chat-topics:check
//
// Hermetic regression suite for src/chat-topics-store.ts + the
// topics/conversation_topics schema in src/conversation-db.ts. Runs against
// the COMPILED dist on a scratch SQLite DB. Zero network, zero model calls,
// no live state touched.

import fs from 'node:fs';
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

const distDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const topics = await import(path.join(distDir, 'chat-topics-store.js'));
const { sseBus } = await import(path.join(distDir, 'sse-bus.js'));

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

function createConversation(externalId) {
  const info = convDb.sqliteDb
    .prepare(`INSERT INTO conversations (external_id) VALUES (?)`)
    .run(externalId);
  return Number(info.lastInsertRowid);
}

function conversationTopicRows(convId) {
  return convDb.sqliteDb
    .prepare(`SELECT * FROM conversation_topics WHERE conversation_id = ? ORDER BY topic_id`)
    .all(convId);
}

console.log('\nCHAT TOPICS STORE CHECK\n');

// ── 1. table creation ──────────────────────────────────────────────────────
console.log('table creation');
{
  const tableNames = convDb.sqliteDb
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('topics', 'conversation_topics')`)
    .all()
    .map((r) => r.name);
  t('topics table exists', tableNames.includes('topics'));
  t('conversation_topics table exists', tableNames.includes('conversation_topics'));
}

// ── 2. upsertTopic dedupe ───────────────────────────────────────────────────
console.log('\nupsertTopic (slugify + case-insensitive dedupe)');
{
  const id1 = topics.upsertTopic('Media Buy Rollout');
  const id2 = topics.upsertTopic('media buy rollout');
  const id3 = topics.upsertTopic('MEDIA BUY ROLLOUT');
  t('same label (any case) resolves to the same topic id', id1 === id2 && id2 === id3, `${id1} ${id2} ${id3}`);
  const row = topics.getTopic(id1);
  t('slug is lowercased/dashed', row?.slug === 'media-buy-rollout', row?.slug);
  t('label preserves original casing from first insert', row?.label === 'Media Buy Rollout', row?.label);

  const otherId = topics.upsertTopic('Suppression Files');
  t('a different label gets a different topic id', otherId !== id1);
}

// ── 3. many-to-many add + pivot keeps old ───────────────────────────────────
console.log('\nmany-to-many add: pivot keeps the old topic, adds the new, flips primary');
{
  const convId = createConversation('cockpit:test-pivot-thread-1');
  const topicA = topics.upsertTopic('Topic A');
  const topicB = topics.upsertTopic('Topic B');

  topics.addConversationTopic(convId, topicA, { primary: true, source: 'auto' });
  let rows = conversationTopicRows(convId);
  t('first topic added: 1 row', rows.length === 1, String(rows.length));
  t('first topic is primary', rows[0].is_primary === 1);

  topics.addConversationTopic(convId, topicB, { primary: true, source: 'auto' });
  rows = conversationTopicRows(convId);
  t('pivot: now 2 rows (old topic kept, not deleted)', rows.length === 2, String(rows.length));
  const rowA = rows.find((r) => r.topic_id === topicA);
  const rowB = rows.find((r) => r.topic_id === topicB);
  t('old topic (A) row still present', !!rowA);
  t('old topic (A) primary flipped OFF', rowA?.is_primary === 0);
  t('new topic (B) primary flipped ON', rowB?.is_primary === 1);

  const forConv = topics.listTopicsForConversation(convId);
  t('listTopicsForConversation returns both topics', forConv.length === 2, String(forConv.length));
  t('listTopicsForConversation orders primary first', forConv[0].id === topicB);

  const forTopicA = topics.listConversationsForTopic(topicA);
  t('listConversationsForTopic finds the conversation for topic A', forTopicA.some((c) => c.id === convId));
}

// ── 4. idempotent add (UNIQUE constraint, add-only) ─────────────────────────
console.log('\nidempotent add-only (never deletes on conflict)');
{
  const convId = createConversation('cockpit:test-idempotent-thread');
  const topicC = topics.upsertTopic('Topic C');
  topics.addConversationTopic(convId, topicC, { primary: true });
  topics.addConversationTopic(convId, topicC, { primary: false }); // re-add, should no-op the insert
  const rows = conversationTopicRows(convId);
  t('re-adding the same topic does not duplicate the row', rows.length === 1, String(rows.length));
}

// ── 5. setPrimaryTopic never deletes ────────────────────────────────────────
console.log('\nsetPrimaryTopic flips primary without deleting rows');
{
  const convId = createConversation('cockpit:test-setprimary-thread');
  const topicD = topics.upsertTopic('Topic D');
  const topicE = topics.upsertTopic('Topic E');
  topics.addConversationTopic(convId, topicD, { primary: true });
  topics.addConversationTopic(convId, topicE, { primary: false });
  topics.setPrimaryTopic(convId, topicE);
  const rows = conversationTopicRows(convId);
  t('setPrimaryTopic keeps both rows', rows.length === 2, String(rows.length));
  t('setPrimaryTopic flips the requested topic to primary', rows.find((r) => r.topic_id === topicE)?.is_primary === 1);
  t('setPrimaryTopic demotes the previous primary', rows.find((r) => r.topic_id === topicD)?.is_primary === 0);
}

// ── 6. scope exclusions ─────────────────────────────────────────────────────
console.log('\nisTopicEligible scope rule');
{
  t('plain cockpit: thread is eligible', topics.isTopicEligible('cockpit:abc123'));
  t('cockpit:hopper-node- is excluded', !topics.isTopicEligible('cockpit:hopper-node-1578-ac7222f6'));
  t('cockpit:unblocker- is excluded', !topics.isTopicEligible('cockpit:unblocker-foo'));
  t('cockpit:shift- is excluded', !topics.isTopicEligible('cockpit:shift-42'));
  t('cockpit:goal- is excluded', !topics.isTopicEligible('cockpit:goal-6'));
  t('cockpit:workstream- is excluded', !topics.isTopicEligible('cockpit:workstream-3'));
  t('cockpit:teams-catch- is excluded', !topics.isTopicEligible('cockpit:teams-catch-1'));
  t('cockpit:mike-radar is excluded', !topics.isTopicEligible('cockpit:mike-radar'));
  t('cockpit:mike-radar-xyz (prefix match) is excluded', !topics.isTopicEligible('cockpit:mike-radar-xyz'));
  t('quick: prefix is excluded', !topics.isTopicEligible('quick:capture-1'));
  t('non-cockpit prefix is excluded', !topics.isTopicEligible('slack:C123'));
}

// ── 7. touchTopicActivity + listTopics ordering ─────────────────────────────
console.log('\ntouchTopicActivity + listTopics ordering');
{
  const topicF = topics.upsertTopic('Topic F Freshly Touched');
  const before = topics.getTopic(topicF);
  t('last_active_at starts null', before?.last_active_at === null);
  // datetime('now') is second-resolution — sleep past the prior section's
  // touches so this one sorts unambiguously last.
  await new Promise((r) => setTimeout(r, 1100));
  topics.touchTopicActivity(topicF);
  const after = topics.getTopic(topicF);
  t('touchTopicActivity sets last_active_at', typeof after?.last_active_at === 'string' && after.last_active_at.length > 0);
  const list = topics.listTopics({ limit: 5 });
  t('listTopics surfaces the freshly-touched topic first', list[0]?.id === topicF, JSON.stringify(list[0]));
}

// ── 8. SSE event emission ───────────────────────────────────────────────────
console.log('\ntopic_assigned SSE event');
{
  const events = [];
  const handler = (ev) => events.push(ev);
  sseBus.on('sse', handler);
  const convId = createConversation('cockpit:test-sse-thread');
  const topicG = topics.upsertTopic('Topic G');
  topics.addConversationTopic(convId, topicG, { primary: true, source: 'manual' });
  sseBus.off('sse', handler);
  const assigned = events.filter((e) => e.type === 'topic_assigned');
  t('addConversationTopic emits exactly one topic_assigned event', assigned.length === 1, String(assigned.length));
  t('event carries conversationId', assigned[0]?.conversationId === convId);
  t('event carries topicId', assigned[0]?.topicId === topicG);
  t('event carries isPrimary true', assigned[0]?.isPrimary === true);
  t('event carries the topic row', assigned[0]?.topic?.id === topicG);
}

// ── wrap up ──────────────────────────────────────────────────────────────
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} chat-topics-check: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
