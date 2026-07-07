import { sqliteDb } from './conversation-db.js';
import { sseBus, type ThreadTodoEvent } from './sse-bus.js';

export type ThreadTodoStatus = 'todo' | 'doing' | 'done';

export type ThreadTodoOwner = 'kevin' | 'jarvis';

export interface ThreadTodoRow {
  id: number;
  conversation_id: number;
  content: string;
  status: ThreadTodoStatus;
  shim_task_id: string | null;
  // Visual-only ownership tag ("For Kevin" / "For Jarvis"). NOT enforced —
  // either party can action any todo. Null → unassigned.
  owner: ThreadTodoOwner | null;
  created_at: string;
  updated_at: string;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS thread_todos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    content         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
    shim_task_id    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_thread_todos_conversation
    ON thread_todos(conversation_id, created_at);
`);

// Migrate: visual owner tag (For Kevin / For Jarvis).
try { sqliteDb.exec(`ALTER TABLE thread_todos ADD COLUMN owner TEXT`); } catch {}

const insertStmt = sqliteDb.prepare<[number, string, string | null]>(`
  INSERT INTO thread_todos (conversation_id, content, owner)
  VALUES (?, ?, ?)
`);

const getByIdStmt = sqliteDb.prepare<[number], ThreadTodoRow>(
  `SELECT * FROM thread_todos WHERE id = ?`,
);

const listByConversationStmt = sqliteDb.prepare<[number], ThreadTodoRow>(`
  SELECT * FROM thread_todos
  WHERE conversation_id = ?
  ORDER BY created_at ASC, id ASC
`);

const updateStatusStmt = sqliteDb.prepare<[ThreadTodoStatus, number]>(`
  UPDATE thread_todos
  SET status = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const updateContentStmt = sqliteDb.prepare<[string, number]>(`
  UPDATE thread_todos
  SET content = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const setShimTaskStmt = sqliteDb.prepare<[string, number]>(`
  UPDATE thread_todos
  SET shim_task_id = ?, updated_at = datetime('now')
  WHERE id = ?
`);

function emit(conversationId: number, action: ThreadTodoEvent['action'], todo: ThreadTodoRow): void {
  sseBus.emit('sse', { type: 'thread_todo', conversationId, action, todo } satisfies ThreadTodoEvent);
}

export function listThreadTodos(conversationId: number): ThreadTodoRow[] {
  return listByConversationStmt.all(conversationId);
}

const openCountForConvStmt = sqliteDb.prepare<[number], { open_total: number; open_kevin: number }>(`
  SELECT
    COUNT(*)                                        AS open_total,
    SUM(CASE WHEN owner = 'kevin' THEN 1 ELSE 0 END) AS open_kevin
  FROM thread_todos
  WHERE conversation_id = ? AND status != 'done'
`);

/** Open (not-done) todo counts for one thread: total, and the subset tagged
 *  "for Kevin" — the sidebar uses forKevin to flag "something for you here". */
export function openTodoCount(conversationId: number): { total: number; forKevin: number } {
  const r = openCountForConvStmt.get(conversationId);
  return { total: r?.open_total ?? 0, forKevin: r?.open_kevin ?? 0 };
}

export function getThreadTodo(id: number): ThreadTodoRow | null {
  return getByIdStmt.get(id) ?? null;
}

export function createThreadTodo(
  conversationId: number,
  content: string,
  owner: ThreadTodoOwner | null = null,
): ThreadTodoRow {
  const info = insertStmt.run(conversationId, content, owner);
  const created = getThreadTodo(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to load thread todo after insert');
  emit(conversationId, 'created', created);
  return created;
}

const updateOwnerStmt = sqliteDb.prepare<[string | null, number]>(`
  UPDATE thread_todos
  SET owner = ?, updated_at = datetime('now')
  WHERE id = ?
`);

export function updateThreadTodoOwner(id: number, owner: ThreadTodoOwner | null): ThreadTodoRow | null {
  updateOwnerStmt.run(owner, id);
  const updated = getThreadTodo(id);
  if (updated) emit(updated.conversation_id, 'updated', updated);
  return updated;
}

export function updateThreadTodoStatus(id: number, status: ThreadTodoStatus): ThreadTodoRow | null {
  updateStatusStmt.run(status, id);
  const updated = getThreadTodo(id);
  if (updated) emit(updated.conversation_id, 'updated', updated);
  return updated;
}

export function updateThreadTodoContent(id: number, content: string): ThreadTodoRow | null {
  updateContentStmt.run(content, id);
  const updated = getThreadTodo(id);
  if (updated) emit(updated.conversation_id, 'updated', updated);
  return updated;
}

export function setThreadTodoShimTask(id: number, shimTaskId: string): ThreadTodoRow | null {
  setShimTaskStmt.run(shimTaskId, id);
  const updated = getThreadTodo(id);
  if (updated) emit(updated.conversation_id, 'updated', updated);
  return updated;
}

const deleteStmt = sqliteDb.prepare<[number]>(`DELETE FROM thread_todos WHERE id = ?`);

/** Delete a todo. Returns the removed row (for the SSE payload) or null. */
export function deleteThreadTodo(id: number): ThreadTodoRow | null {
  const row = getByIdStmt.get(id) ?? null;
  if (!row) return null;
  deleteStmt.run(id);
  emit(row.conversation_id, 'deleted', row);
  return row;
}

/** Bubble the currently-doing todo content for a conversation, if any. */
export function currentlyDoingTodo(conversationId: number): string | null {
  const doing = listByConversationStmt.all(conversationId).find((t: ThreadTodoRow) => t.status === 'doing');
  return doing?.content ?? null;
}
