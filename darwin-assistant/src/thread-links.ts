import { sqliteDb } from './conversation-db.js';
import { sseBus, type ThreadLinkEvent } from './sse-bus.js';

// A "relevant link" attached to a cockpit thread — the per-thread mini link bar
// under the title. `kind='preview'` is the single primary/hero link (the live
// preview / builds URL for whatever this thread is building); `kind='link'` are
// any number of secondary reference links. JARVIS sets these via the
// `thread_links` tool so the bar fills in the moment a lane produces a build,
// and Kevin can tell his ~5 side-by-side group windows apart by which preview
// each one points at. Deliberately NOT a freeform scratchpad — just links.
export type ThreadLinkKind = 'preview' | 'link';

export interface ThreadLinkRow {
  id: number;
  conversation_id: number;
  url: string;
  label: string | null;
  kind: ThreadLinkKind;
  created_at: string;
  updated_at: string;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS thread_links (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    url             TEXT NOT NULL,
    label           TEXT,
    kind            TEXT NOT NULL DEFAULT 'link' CHECK (kind IN ('preview', 'link')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_thread_links_conversation
    ON thread_links(conversation_id, created_at);
`);

const insertStmt = sqliteDb.prepare<[number, string, string | null, ThreadLinkKind]>(`
  INSERT INTO thread_links (conversation_id, url, label, kind)
  VALUES (?, ?, ?, ?)
`);

const getByIdStmt = sqliteDb.prepare<[number], ThreadLinkRow>(
  `SELECT * FROM thread_links WHERE id = ?`,
);

// Preview (hero) link first, then secondary links oldest-first.
const listByConversationStmt = sqliteDb.prepare<[number], ThreadLinkRow>(`
  SELECT * FROM thread_links
  WHERE conversation_id = ?
  ORDER BY CASE kind WHEN 'preview' THEN 0 ELSE 1 END, created_at ASC, id ASC
`);

const getPreviewStmt = sqliteDb.prepare<[number], ThreadLinkRow>(`
  SELECT * FROM thread_links WHERE conversation_id = ? AND kind = 'preview' LIMIT 1
`);

const updatePreviewStmt = sqliteDb.prepare<[string, string | null, number]>(`
  UPDATE thread_links
  SET url = ?, label = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const deleteStmt = sqliteDb.prepare<[number]>(`DELETE FROM thread_links WHERE id = ?`);

function emit(conversationId: number, action: ThreadLinkEvent['action'], link: ThreadLinkRow): void {
  sseBus.emit('sse', { type: 'thread_link', conversationId, action, link } satisfies ThreadLinkEvent);
}

export function listThreadLinks(conversationId: number): ThreadLinkRow[] {
  return listByConversationStmt.all(conversationId);
}

export function getThreadLink(id: number): ThreadLinkRow | null {
  return getByIdStmt.get(id) ?? null;
}

/** Count of links on a thread — drives the sidebar "has a preview" indicator. */
const countStmt = sqliteDb.prepare<[number], { n: number; has_preview: number }>(`
  SELECT COUNT(*) AS n,
         SUM(CASE WHEN kind = 'preview' THEN 1 ELSE 0 END) AS has_preview
  FROM thread_links WHERE conversation_id = ?
`);
export function threadLinkCount(conversationId: number): { total: number; hasPreview: boolean } {
  const r = countStmt.get(conversationId);
  return { total: r?.n ?? 0, hasPreview: !!(r?.has_preview ?? 0) };
}

/** Upsert the single primary/preview link for a thread. Idempotent — a second
 *  call replaces the URL/label rather than stacking a second hero link. */
export function setPreviewLink(
  conversationId: number,
  url: string,
  label: string | null = null,
): ThreadLinkRow {
  const existing = getPreviewStmt.get(conversationId);
  if (existing) {
    updatePreviewStmt.run(url, label, existing.id);
    const updated = getThreadLink(existing.id);
    if (!updated) throw new Error('Failed to load thread link after update');
    emit(conversationId, 'updated', updated);
    return updated;
  }
  const info = insertStmt.run(conversationId, url, label, 'preview');
  const created = getThreadLink(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to load thread link after insert');
  emit(conversationId, 'created', created);
  return created;
}

/** Append a secondary reference link. */
export function addThreadLink(
  conversationId: number,
  url: string,
  label: string | null = null,
): ThreadLinkRow {
  const info = insertStmt.run(conversationId, url, label, 'link');
  const created = getThreadLink(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to load thread link after insert');
  emit(conversationId, 'created', created);
  return created;
}

/** Delete one link. Returns the removed row (for the SSE payload) or null. */
export function deleteThreadLink(id: number): ThreadLinkRow | null {
  const row = getByIdStmt.get(id) ?? null;
  if (!row) return null;
  deleteStmt.run(id);
  emit(row.conversation_id, 'deleted', row);
  return row;
}

/** Remove every link on a thread (emits a delete per row so all clients reconcile). */
export function clearThreadLinks(conversationId: number): number {
  const rows = listThreadLinks(conversationId);
  for (const row of rows) {
    deleteStmt.run(row.id);
    emit(conversationId, 'deleted', row);
  }
  return rows.length;
}
