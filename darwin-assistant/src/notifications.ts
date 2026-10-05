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
  scheduleNtfyDelivery(created);
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

// ── ntfy desktop-push bridge ─────────────────────────────────────────────────
// Opt-in, env-only: set JARVIS_NTFY_TOPIC_URL (the full ntfy publish URL,
// e.g. https://ntfy.sh/<topic>) to turn this on. No topic configured = no-op,
// no hardcoded topic/secret anywhere in code. Delivery is async, time-bounded,
// best-effort, and fully isolated from createNotification: every failure is
// swallowed here so a flaky/unreachable ntfy server can never make a
// notification write fail or delay the SQLite/SSE path.

const NTFY_DEFAULT_SEVERITIES: readonly NotificationSeverity[] = ['success', 'warning', 'error'];
const NTFY_TIMEOUT_MS = 5_000;
const NTFY_MAX_CONCURRENT = 2;
const NTFY_MAX_QUEUED = 50;

function ntfyTopicUrl(): string | null {
  const raw = process.env.JARVIS_NTFY_TOPIC_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.pathname.replace(/^\//, '')) return null;
    return raw;
  } catch {
    return null;
  }
}

function ntfyAllowedSeverities(): ReadonlySet<NotificationSeverity> {
  const raw = process.env.JARVIS_NTFY_SEVERITIES?.trim();
  if (!raw) return new Set(NTFY_DEFAULT_SEVERITIES);
  const allowed = new Set<NotificationSeverity>();
  for (const part of raw.split(',')) {
    const sev = part.trim().toLowerCase();
    if (sev === 'info' || sev === 'success' || sev === 'warning' || sev === 'error') {
      allowed.add(sev);
    }
  }
  return allowed.size > 0 ? allowed : new Set(NTFY_DEFAULT_SEVERITIES);
}

function ntfySeverityMeta(severity: NotificationSeverity): { priority: number; tags: string[] } {
  switch (severity) {
    case 'error':
      return { priority: 5, tags: ['rotating_light'] };
    case 'warning':
      return { priority: 4, tags: ['warning'] };
    case 'success':
      return { priority: 3, tags: ['white_check_mark'] };
    default:
      return { priority: 3, tags: ['information_source'] };
  }
}

/** http/https only — never file:, javascript:, etc. Returns null if it can't be made absolute. */
function ntfyAbsoluteHttpUrl(candidate: string, base: string | null): string | null {
  let resolved: URL;
  try {
    resolved = new URL(candidate);
  } catch {
    if (!base) return null;
    try {
      resolved = new URL(candidate, base);
    } catch {
      return null;
    }
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  return resolved.toString();
}

/** Resolves the notification's click target against JARVIS_COCKPIT_PUBLIC_URL, falling back to a deep link by id. */
function resolveNtfyClickUrl(notification: NotificationRow): string | null {
  const base = process.env.JARVIS_COCKPIT_PUBLIC_URL?.trim() || null;
  const path = notification.link?.trim() || `/notifications?notification=${notification.id}`;
  return ntfyAbsoluteHttpUrl(path, base);
}

interface NtfyQueueTask {
  (): Promise<void>;
}

let ntfyInFlight = 0;
const ntfyPending: NtfyQueueTask[] = [];

function ntfyRunNext(): void {
  const task = ntfyPending.shift();
  if (!task) return;
  ntfyInFlight++;
  task()
    .catch(() => {})
    .finally(() => {
      ntfyInFlight--;
      ntfyRunNext();
    });
}

/** Small in-process limiter so a burst of notifications can't hammer the ntfy server. */
function ntfyEnqueue(task: NtfyQueueTask): void {
  if (ntfyInFlight < NTFY_MAX_CONCURRENT) {
    ntfyInFlight++;
    task()
      .catch(() => {})
      .finally(() => {
        ntfyInFlight--;
        ntfyRunNext();
      });
    return;
  }
  if (ntfyPending.length >= NTFY_MAX_QUEUED) {
    console.error('[ntfy] delivery queue full, dropping a notification');
    return;
  }
  ntfyPending.push(task);
}

async function publishNtfy(notification: NotificationRow): Promise<void> {
  const topicUrl = ntfyTopicUrl();
  if (!topicUrl) return;

  let origin: string;
  let topic: string;
  try {
    const u = new URL(topicUrl);
    origin = `${u.protocol}//${u.host}`;
    topic = u.pathname.replace(/^\//, '');
  } catch {
    return;
  }
  if (!topic) return;

  const { priority, tags } = ntfySeverityMeta(notification.severity);
  const click = resolveNtfyClickUrl(notification);

  const payload: Record<string, unknown> = {
    topic,
    title: notification.title,
    message: notification.body?.trim() || notification.title,
    priority,
    tags,
  };
  if (click) payload.click = click;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NTFY_TIMEOUT_MS);
  try {
    const res = await fetch(origin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Deliberately omit the topic URL/name from logs — it's the secret.
      console.error(`[ntfy] publish failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[ntfy] publish error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget: never throws, never awaited by callers. No-op unless JARVIS_NTFY_TOPIC_URL is set. */
export function scheduleNtfyDelivery(notification: NotificationRow): void {
  if (!ntfyTopicUrl()) return;
  if (!ntfyAllowedSeverities().has(notification.severity)) return;
  try {
    ntfyEnqueue(() => publishNtfy(notification));
  } catch {
    // Scheduling itself must never throw into createNotification's caller.
  }
}
