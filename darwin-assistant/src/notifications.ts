import { sqliteDb } from './conversation-db.js';
import { sseBus, type NotificationEvent } from './sse-bus.js';

// DAR-761 — cockpit notification layer. Global (not thread-scoped): anything
// JARVIS or the system needs to surface to Kevin gets one record here, shown
// both as a toast (on arrival) and as a row in the notification center.

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';
export type NotificationActionKind = 'open_link' | 'checkin_snooze' | 'checkin_dismiss' | 'issue_reopen';
export type NotificationActionStyle = 'default' | 'secondary' | 'destructive';

export interface NotificationAction {
  kind: NotificationActionKind;
  label: string;
  href?: string;
  minutes?: number;
  issueId?: string;
  issueIdentifier?: string;
  reopenStatus?: string;
  style?: NotificationActionStyle;
}

export interface NotificationMeta {
  kind?: 'checkin';
  checkinId?: string;
  sourceType?: string | null;
  sourceId?: string | null;
}

export interface NotificationRow {
  id: number;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  source: string | null;
  link: string | null;
  actions: NotificationAction[];
  meta: NotificationMeta | null;
  created_at: string;
  read_at: string | null;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    severity   TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'error')),
    title      TEXT NOT NULL,
    body       TEXT,
    source     TEXT,
    link       TEXT,
    actions_json TEXT,
    meta_json    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
`);

for (const col of ['actions_json TEXT', 'meta_json TEXT']) {
  try { sqliteDb.exec(`ALTER TABLE notifications ADD COLUMN ${col}`); } catch {}
}

interface NotificationDbRow {
  id: number;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  source: string | null;
  link: string | null;
  actions_json: string | null;
  meta_json: string | null;
  created_at: string;
  read_at: string | null;
}

const insertStmt = sqliteDb.prepare<
  [NotificationSeverity, string, string | null, string | null, string | null, string | null, string | null]
>(`
  INSERT INTO notifications (severity, title, body, source, link, actions_json, meta_json)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getByIdStmt = sqliteDb.prepare<[number], NotificationDbRow>(`SELECT * FROM notifications WHERE id = ?`);

const listStmt = sqliteDb.prepare<[number], NotificationDbRow>(`
  SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ?
`);

const unreadCountStmt = sqliteDb.prepare<[], { unread: number }>(`
  SELECT COUNT(*) AS unread FROM notifications WHERE read_at IS NULL
`);

const markReadStmt = sqliteDb.prepare<[number]>(`
  UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL
`);

const markAllReadStmt = sqliteDb.prepare<[]>(`
  UPDATE notifications SET read_at = datetime('now') WHERE read_at IS NULL
`);

const deleteStmt = sqliteDb.prepare<[number]>(`DELETE FROM notifications WHERE id = ?`);

function emit(action: NotificationEvent['action'], notification: NotificationRow): void {
  sseBus.emit('sse', { type: 'notification', action, notification } satisfies NotificationEvent);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function hydrate(row: NotificationDbRow | null): NotificationRow | null {
  if (!row) return null;
  return {
    id: row.id,
    severity: row.severity,
    title: row.title,
    body: row.body,
    source: row.source,
    link: row.link,
    actions: parseJson<NotificationAction[]>(row.actions_json, []),
    meta: parseJson<NotificationMeta | null>(row.meta_json, null),
    created_at: row.created_at,
    read_at: row.read_at,
  };
}

export function getNotification(id: number): NotificationRow | null {
  return hydrate(getByIdStmt.get(id) ?? null);
}

export function listNotifications(limit = 100): NotificationRow[] {
  return listStmt.all(Math.max(1, Math.min(limit, 500))).map((row) => hydrate(row)).filter((row): row is NotificationRow => row !== null);
}

export function unreadNotificationCount(): number {
  return unreadCountStmt.get()?.unread ?? 0;
}

export function createNotification(args: {
  severity: NotificationSeverity;
  title: string;
  body?: string | null;
  source?: string | null;
  link?: string | null;
  actions?: NotificationAction[];
  meta?: NotificationMeta | null;
}): NotificationRow {
  const info = insertStmt.run(
    args.severity,
    args.title,
    args.body ?? null,
    args.source ?? null,
    args.link ?? null,
    JSON.stringify(args.actions ?? []),
    JSON.stringify(args.meta ?? null),
  );
  const created = getNotification(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to load notification after insert');
  emit('created', created);
  return created;
}

export function markNotificationRead(id: number): NotificationRow | null {
  markReadStmt.run(id);
  const updated = getNotification(id);
  if (updated) emit('updated', updated);
  return updated;
}

/** Returns the ids that actually flipped read (for the SSE payload / caller info). */
export function markAllNotificationsRead(): NotificationRow[] {
  const before = listStmt.all(500).filter((n) => !n.read_at);
  markAllReadStmt.run();
  const updated = before.map((n) => getNotification(n.id)).filter((n): n is NotificationRow => n !== null);
  updated.forEach((n) => emit('updated', n));
  return updated;
}

export function deleteNotification(id: number): NotificationRow | null {
  const row = getByIdStmt.get(id) ?? null;
  if (!row) return null;
  deleteStmt.run(id);
  const hydrated = hydrate(row);
  if (!hydrated) return null;
  emit('deleted', hydrated);
  return hydrated;
}
