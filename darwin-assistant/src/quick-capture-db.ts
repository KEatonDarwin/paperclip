import { sqliteDb } from './conversation-db.js';
import { sseBus, type QuickCaptureEvent } from './sse-bus.js';

// DAR-737 — quick-capture todo widget. A standalone scratchpad for things
// Kevin needs to do that don't yet belong to a specific task/project/thread.
// Distinct from thread-todos.ts (per-thread todo board): these items are
// global, not tied to any conversation.

export interface QuickCaptureItemRow {
  id: number;
  content: string;
  sort_order: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS quick_capture_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    content       TEXT NOT NULL,
    sort_order    REAL NOT NULL DEFAULT 0,
    completed_at  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_quick_capture_active ON quick_capture_items(completed_at, sort_order);
`);

const insertStmt = sqliteDb.prepare<[string, number]>(`
  INSERT INTO quick_capture_items (content, sort_order) VALUES (?, ?)
`);

const getByIdStmt = sqliteDb.prepare<[number], QuickCaptureItemRow>(
  `SELECT * FROM quick_capture_items WHERE id = ?`,
);

const listActiveStmt = sqliteDb.prepare<[], QuickCaptureItemRow>(`
  SELECT * FROM quick_capture_items WHERE completed_at IS NULL ORDER BY sort_order ASC, id ASC
`);

const maxSortOrderStmt = sqliteDb.prepare<[], { max_order: number | null }>(
  `SELECT MAX(sort_order) AS max_order FROM quick_capture_items WHERE completed_at IS NULL`,
);

const setSortOrderStmt = sqliteDb.prepare<[number, number]>(`
  UPDATE quick_capture_items SET sort_order = ?, updated_at = datetime('now') WHERE id = ?
`);

const setContentStmt = sqliteDb.prepare<[string, number]>(`
  UPDATE quick_capture_items SET content = ?, updated_at = datetime('now') WHERE id = ?
`);

const setCompletedStmt = sqliteDb.prepare<[string | null, number]>(`
  UPDATE quick_capture_items SET completed_at = ?, updated_at = datetime('now') WHERE id = ?
`);

const deleteStmt = sqliteDb.prepare<[number]>(`DELETE FROM quick_capture_items WHERE id = ?`);

export function getQuickCaptureItem(id: number): QuickCaptureItemRow | null {
  return getByIdStmt.get(id) ?? null;
}

export function listActiveQuickCaptureItems(): QuickCaptureItemRow[] {
  return listActiveStmt.all();
}

export function createQuickCaptureItem(content: string): QuickCaptureItemRow {
  const maxOrder = maxSortOrderStmt.get()?.max_order ?? 0;
  const info = insertStmt.run(content, maxOrder + 1);
  const created = getQuickCaptureItem(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to load quick-capture item after insert');
  sseBus.emit('sse', { type: 'quick_capture', action: 'created', item: created } satisfies QuickCaptureEvent);
  return created;
}

export function reorderQuickCaptureItems(orderedIds: number[]): QuickCaptureItemRow[] {
  const tx = sqliteDb.transaction((ids: number[]) => {
    ids.forEach((id, index) => setSortOrderStmt.run(index, id));
  });
  tx(orderedIds);
  const items = listActiveQuickCaptureItems();
  sseBus.emit('sse', { type: 'quick_capture', action: 'reordered', items } satisfies QuickCaptureEvent);
  return items;
}

export function renameQuickCaptureItem(id: number, content: string): QuickCaptureItemRow | null {
  setContentStmt.run(content, id);
  const updated = getQuickCaptureItem(id);
  if (updated) sseBus.emit('sse', { type: 'quick_capture', action: 'updated', item: updated } satisfies QuickCaptureEvent);
  return updated;
}

export function setQuickCaptureItemCompleted(id: number, completed: boolean): QuickCaptureItemRow | null {
  setCompletedStmt.run(completed ? new Date().toISOString() : null, id);
  const updated = getQuickCaptureItem(id);
  if (updated) sseBus.emit('sse', { type: 'quick_capture', action: 'updated', item: updated } satisfies QuickCaptureEvent);
  return updated;
}

export function deleteQuickCaptureItem(id: number): void {
  deleteStmt.run(id);
  sseBus.emit('sse', { type: 'quick_capture', action: 'deleted', id } satisfies QuickCaptureEvent);
}
