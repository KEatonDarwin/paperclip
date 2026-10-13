import { sqliteDb } from './conversation-db.js';
import { sseBus, type TopicAssignedEvent } from './sse-bus.js';

export interface TopicRow {
  id: number;
  label: string;
  slug: string;
  created_at: string;
  updated_at: string | null;
  last_active_at: string | null;
}

export interface ConversationTopicRow {
  conversation_id: number;
  topic_id: number;
  is_primary: number;
  source: string | null;
  assigned_at: string;
}

// Machine/auto conversation prefixes excluded from topics entirely — topics
// are a human-day-to-day-chat concept, not a tag on background workers.
const EXCLUDED_PREFIXES = [
  'cockpit:hopper-node-',
  'cockpit:unblocker-',
  'cockpit:shift-',
  'cockpit:goal-',
  'cockpit:workstream-',
  'cockpit:teams-catch-',
  'cockpit:mike-radar',
];

/** Topics apply only to cockpit day-to-day human chats, excluding machine/auto threads. */
export function isTopicEligible(externalId: string): boolean {
  if (!externalId.startsWith('cockpit:')) return false;
  return !EXCLUDED_PREFIXES.some((prefix) => externalId.startsWith(prefix));
}

function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const getTopicByIdStmt = sqliteDb.prepare<[number], TopicRow>(
  `SELECT * FROM topics WHERE id = ?`,
);

const getTopicBySlugStmt = sqliteDb.prepare<[string], TopicRow>(
  `SELECT * FROM topics WHERE slug = ?`,
);

const insertTopicStmt = sqliteDb.prepare<[string, string]>(
  `INSERT INTO topics (label, slug) VALUES (?, ?)`,
);

/** Create a topic, or return the existing one if its slug already exists (case-insensitive dedupe). */
export function upsertTopic(label: string): number {
  const slug = slugify(label);
  const existing = getTopicBySlugStmt.get(slug);
  if (existing) return existing.id;
  const info = insertTopicStmt.run(label.trim(), slug);
  return Number(info.lastInsertRowid);
}

export function getTopic(topicId: number): TopicRow | null {
  return getTopicByIdStmt.get(topicId) ?? null;
}

const listTopicsStmt = sqliteDb.prepare<[number], TopicRow>(
  `SELECT * FROM topics ORDER BY last_active_at DESC, created_at DESC LIMIT ?`,
);

export function listTopics(opts: { limit?: number } = {}): TopicRow[] {
  return listTopicsStmt.all(opts.limit ?? 50);
}

const insertConversationTopicStmt = sqliteDb.prepare<[number, number, number, string | null]>(
  `INSERT INTO conversation_topics (conversation_id, topic_id, is_primary, source)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(conversation_id, topic_id) DO NOTHING`,
);

const clearOtherPrimariesStmt = sqliteDb.prepare<[number, number]>(
  `UPDATE conversation_topics SET is_primary = 0
   WHERE conversation_id = ? AND topic_id != ?`,
);

const setPrimaryStmt = sqliteDb.prepare<[number, number]>(
  `UPDATE conversation_topics SET is_primary = 1
   WHERE conversation_id = ? AND topic_id = ?`,
);

const touchActivityStmt = sqliteDb.prepare<[number]>(
  `UPDATE topics SET last_active_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
);

function emitAssigned(conversationId: number, topicId: number, isPrimary: boolean): void {
  const topic = getTopic(topicId);
  if (!topic) return;
  sseBus.emit('sse', {
    type: 'topic_assigned',
    conversationId,
    topicId,
    isPrimary,
    topic,
  } satisfies TopicAssignedEvent);
}

/**
 * Add-only: links a conversation to a topic. Idempotent on the UNIQUE
 * constraint — re-adding the same (conversation, topic) pair is a no-op.
 * Never deletes a row; a pivot that wants a new primary must still call
 * setPrimaryTopic separately (or pass primary: true here, which demotes any
 * other primary for this conversation but keeps every row).
 */
export function addConversationTopic(
  conversationId: number,
  topicId: number,
  opts: { primary?: boolean; source?: string } = {},
): void {
  const primary = opts.primary ?? false;
  insertConversationTopicStmt.run(conversationId, topicId, primary ? 1 : 0, opts.source ?? null);
  if (primary) {
    clearOtherPrimariesStmt.run(conversationId, topicId);
    setPrimaryStmt.run(conversationId, topicId);
  }
  touchActivityStmt.run(topicId);
  emitAssigned(conversationId, topicId, primary);
}

/** Flip is_primary to this topic for this conversation. Never deletes any row. */
export function setPrimaryTopic(conversationId: number, topicId: number): void {
  clearOtherPrimariesStmt.run(conversationId, topicId);
  setPrimaryStmt.run(conversationId, topicId);
  touchActivityStmt.run(topicId);
  emitAssigned(conversationId, topicId, true);
}

const listTopicsForConversationStmt = sqliteDb.prepare<[number], TopicRow & { is_primary: number }>(`
  SELECT t.*, ct.is_primary AS is_primary
  FROM conversation_topics ct
  JOIN topics t ON t.id = ct.topic_id
  WHERE ct.conversation_id = ?
  ORDER BY ct.is_primary DESC, ct.assigned_at DESC
`);

export function listTopicsForConversation(conversationId: number): (TopicRow & { is_primary: number })[] {
  return listTopicsForConversationStmt.all(conversationId);
}

const listConversationsForTopicStmt = sqliteDb.prepare<[number], { id: number; external_id: string; updated_at: string }>(`
  SELECT c.id, c.external_id, c.updated_at
  FROM conversation_topics ct
  JOIN conversations c ON c.id = ct.conversation_id
  WHERE ct.topic_id = ?
  ORDER BY c.updated_at DESC
`);

export function listConversationsForTopic(topicId: number): { id: number; external_id: string; updated_at: string }[] {
  return listConversationsForTopicStmt.all(topicId);
}

export function touchTopicActivity(topicId: number): void {
  touchActivityStmt.run(topicId);
}

const listConversationsForTopicDetailedStmt = sqliteDb.prepare<
  [number],
  { id: number; external_id: string; title: string | null; updated_at: string; is_primary: number }
>(`
  SELECT c.id, c.external_id, c.title, c.updated_at, ct.is_primary AS is_primary
  FROM conversation_topics ct
  JOIN conversations c ON c.id = ct.conversation_id
  WHERE ct.topic_id = ?
  ORDER BY c.updated_at DESC
`);

/** Like listConversationsForTopic, plus title + this pivot row's is_primary —
 *  what the /chat-topics index and the overlap matcher both need. */
export function listConversationsForTopicDetailed(
  topicId: number,
): { id: number; external_id: string; title: string | null; updated_at: string; is_primary: number }[] {
  return listConversationsForTopicDetailedStmt.all(topicId);
}

const listPrimaryTopicAssignmentsStmt = sqliteDb.prepare<
  [],
  { conversation_id: number; topic_id: number; label: string; slug: string }
>(`
  SELECT ct.conversation_id, t.id AS topic_id, t.label, t.slug
  FROM conversation_topics ct
  JOIN topics t ON t.id = ct.topic_id
  WHERE ct.is_primary = 1
`);

/** Every conversation's CURRENT primary topic, regardless of which topic
 *  group it's being rendered under — backs the /chat-topics "now_about"
 *  field for chats surfaced in a non-primary (secondary) topic group. */
export function listPrimaryTopicAssignments(): { conversation_id: number; topic_id: number; label: string; slug: string }[] {
  return listPrimaryTopicAssignmentsStmt.all();
}
