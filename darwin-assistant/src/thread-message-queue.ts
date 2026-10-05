import { sqliteDb } from './conversation-db.js';
import { sseBus, type QueuedMessageEvent } from './sse-bus.js';

// Server-owned submit queue. When a message is sent to a thread that's already
// running a turn, it lands here instead of bouncing with a 409. The queue is
// auto-drained (oldest-first) when the running turn ends, and is exposed over
// the API + SSE so it survives a browser refresh and stays in sync across every
// browser viewing the thread. "Server owns state, model owns story."

export interface QueuedMessageRow {
  id: number;
  conversation_id: number;
  content: string;
  created_at: string;
  images: string | null;
  /** tree-9b58ddb7: JSON array of attachment row ids attached to this message. */
  attachment_ids: string | null;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS thread_message_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_thread_message_queue_conversation
    ON thread_message_queue(conversation_id, id);
`);

// DAR-744: images attached to a message that got parked on the queue (a turn
// was already running) — same JSON shape as turns.images, decoded back into
// SavedImage[] on drain (see reconstructSavedImages in handlers/api-v1.ts).
try { sqliteDb.exec(`ALTER TABLE thread_message_queue ADD COLUMN images TEXT`); } catch {}

// Chat file attachments (tree-9b58ddb7): the `attachments` row ids that were
// sent with a message which got parked here. Ids (not content) because the
// bytes already live on disk and in the attachments table — the drain just
// re-resolves them, so a file deleted while the message waited is skipped
// rather than resurrected.
try { sqliteDb.exec(`ALTER TABLE thread_message_queue ADD COLUMN attachment_ids TEXT`); } catch {}

const insertStmt = sqliteDb.prepare<[number, string, string | null, string | null]>(`
  INSERT INTO thread_message_queue (conversation_id, content, images, attachment_ids)
  VALUES (?, ?, ?, ?)
`);

const getByIdStmt = sqliteDb.prepare<[number], QueuedMessageRow>(
  `SELECT * FROM thread_message_queue WHERE id = ?`,
);

const listByConversationStmt = sqliteDb.prepare<[number], QueuedMessageRow>(`
  SELECT * FROM thread_message_queue
  WHERE conversation_id = ?
  ORDER BY id ASC
`);

const oldestStmt = sqliteDb.prepare<[number], QueuedMessageRow>(`
  SELECT * FROM thread_message_queue
  WHERE conversation_id = ?
  ORDER BY id ASC
  LIMIT 1
`);

const deleteStmt = sqliteDb.prepare<[number]>(
  `DELETE FROM thread_message_queue WHERE id = ?`,
);

function emit(conversationId: number, action: QueuedMessageEvent['action'], item: QueuedMessageRow): void {
  sseBus.emit('sse', { type: 'queued_message', conversationId, action, item } satisfies QueuedMessageEvent);
}

export function listQueuedMessages(conversationId: number): QueuedMessageRow[] {
  return listByConversationStmt.all(conversationId);
}

export function enqueueMessage(
  conversationId: number,
  content: string,
  images?: string | null,
  attachmentIds?: string | null,
): QueuedMessageRow {
  const info = insertStmt.run(conversationId, content, images ?? null, attachmentIds ?? null);
  const created = getByIdStmt.get(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to load queued message after insert');
  emit(conversationId, 'created', created);
  return created;
}

/** Cancel a specific queued message. Returns the removed row (for the SSE) or null. */
export function deleteQueuedMessage(id: number): QueuedMessageRow | null {
  const row = getByIdStmt.get(id) ?? null;
  if (!row) return null;
  deleteStmt.run(id);
  emit(row.conversation_id, 'deleted', row);
  return row;
}

/** Pop the oldest queued message for a conversation (delete + return), or null. */
export function shiftQueuedMessage(conversationId: number): QueuedMessageRow | null {
  const row = oldestStmt.get(conversationId) ?? null;
  if (!row) return null;
  deleteStmt.run(row.id);
  emit(conversationId, 'deleted', row);
  return row;
}
