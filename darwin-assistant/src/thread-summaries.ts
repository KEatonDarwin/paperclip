import { sqliteDb } from './conversation-db.js';
import { sseBus, type ThreadSummaryEvent } from './sse-bus.js';

// DAR-740 — point-in-time cockpit summary with an in-chat bookmark. A summary
// is anchored to the last turn that existed at generation time
// (anchor_turn_id/anchor_turn_index), so the client can render a "Summary
// generated" marker at that exact spot in the timeline and Kevin always knows
// what a given summary's coverage ends at. Multiple summaries persist over
// time, one per conversation per generation.

export interface ThreadSummaryRow {
  id: number;
  conversation_id: number;
  content: string;
  anchor_turn_id: number | null;
  anchor_turn_index: number;
  created_at: string;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS thread_summaries (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id   INTEGER NOT NULL REFERENCES conversations(id),
    content           TEXT NOT NULL,
    anchor_turn_id    INTEGER,
    anchor_turn_index INTEGER NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_thread_summaries_conversation
    ON thread_summaries(conversation_id, anchor_turn_index);
`);

const insertStmt = sqliteDb.prepare<[number, string, number | null, number]>(`
  INSERT INTO thread_summaries (conversation_id, content, anchor_turn_id, anchor_turn_index)
  VALUES (?, ?, ?, ?)
`);

const getByIdStmt = sqliteDb.prepare<[number], ThreadSummaryRow>(
  `SELECT * FROM thread_summaries WHERE id = ?`,
);

const listForConversationStmt = sqliteDb.prepare<[number], ThreadSummaryRow>(`
  SELECT * FROM thread_summaries WHERE conversation_id = ? ORDER BY anchor_turn_index ASC, id ASC
`);

const latestForConversationStmt = sqliteDb.prepare<[number], ThreadSummaryRow>(`
  SELECT * FROM thread_summaries WHERE conversation_id = ? ORDER BY anchor_turn_index DESC, id DESC LIMIT 1
`);

export function listThreadSummaries(conversationId: number): ThreadSummaryRow[] {
  return listForConversationStmt.all(conversationId);
}

export function getLatestThreadSummary(conversationId: number): ThreadSummaryRow | null {
  return latestForConversationStmt.get(conversationId) ?? null;
}

export function createThreadSummary(
  conversationId: number,
  content: string,
  anchorTurnId: number | null,
  anchorTurnIndex: number,
): ThreadSummaryRow {
  const info = insertStmt.run(conversationId, content, anchorTurnId, anchorTurnIndex);
  const created = getByIdStmt.get(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to load thread summary after insert');
  sseBus.emit('sse', {
    type: 'thread_summary',
    conversationId,
    action: 'created',
    summary: created,
  } satisfies ThreadSummaryEvent);
  return created;
}
