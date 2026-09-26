import { createHash } from 'node:crypto';
import { sqliteDb, getSetting, setSetting } from './conversation-db.js';
import { nativeCall } from './tools/mcp-native.js';
import { sseBus, type RelayMessageEvent } from './sse-bus.js';

/**
 * RELAY-CLIENT-ASSUMPTIONS — docs/relay/CONTRACT.md (DarwinIntakeSystem side)
 * did not exist yet when this was written, so the wire shapes below are read
 * straight off outbox/relay/DESIGN.md §1/§3. If CONTRACT.md lands with a
 * different shape, reconcile against this list, not against guesswork:
 *
 *  - Tool name: `relay-tool`, reached the same way as smarty-pants (native
 *    Streamable-HTTP client, principal `jarvis` stamped server-side by the
 *    route — nothing about identity is sent in the call args).
 *  - `inbox` takes no args and returns `{ messages: [{ id, thread_id, from,
 *    kind, subject, body, refs, created_at, ... }] }` — unread-for-me
 *    messages, newest first, each carrying its `thread_id`.
 *  - `read_thread` takes `{ id: <thread ulid> }` and returns
 *    `{ thread: { id, title, opened_by, status, exchange_count, read_by,
 *    created_at, updated_at }, messages: [ <full Message[]> ] }`. Calling it
 *    marks every message read by `jarvis` (the read receipt), so `read_by` on
 *    the returned thread is assumed to be a `{ party: iso_timestamp }` map.
 *  - `Message.from` is the server-stamped principal string (`jarvis` |
 *    `mike` | `kevin`); `refs` is a JSON-serializable array; all timestamps
 *    are ISO 8601 strings and are stored verbatim as TEXT.
 *  - `list_threads` / `search` exist per DESIGN §3 but are not called here —
 *    `inbox` + `read_thread` are sufficient to mirror everything relevant to
 *    JARVIS; a later REST-surface node may want them for the `/relay` page.
 */

export type RelayParty = 'jarvis' | 'mike' | 'kevin';
export type RelayMessageKind = 'request' | 'question' | 'answer' | 'update' | 'result' | 'ack' | 'note';
export type RelayThreadStatus = 'open' | 'waiting_jarvis' | 'waiting_mike' | 'waiting_kevin' | 'done' | 'paused';

export interface RelayThreadRow {
  id: string;
  title: string | null;
  opened_by: string | null;
  status: string;
  exchange_count: number;
  read_by: string | null;
  created_at: string;
  updated_at: string | null;
  mirrored_at: string;
}

export interface RelayMessageRow {
  id: number;
  message_id: string | null;
  thread_id: string;
  author: string;
  kind: string;
  subject: string | null;
  body: string;
  refs: string | null;
  content_hash: string;
  created_at: string;
  mirrored_at: string | null;
  cue_fired_at: string | null;
  is_draft: number;
}

export interface RawRelayMessage {
  id?: string;
  thread_id?: string;
  from?: string;
  kind?: string;
  subject?: string | null;
  body?: string;
  refs?: unknown;
  created_at?: string;
}

export interface RawRelayThread {
  id?: string;
  title?: string | null;
  opened_by?: string | null;
  status?: string;
  exchange_count?: number;
  read_by?: Record<string, string>;
  created_at?: string;
  updated_at?: string | null;
}

interface RawInboxResponse {
  messages?: RawRelayMessage[];
}

interface RawReadThreadResponse {
  thread?: RawRelayThread;
  messages?: RawRelayMessage[];
}

// -- settings-KV knobs (see conversation-db.ts for getSetting/setSetting) --

const RELAY_ENABLED_KEY = 'relay_enabled';
const RELAY_POLL_SECONDS_KEY = 'relay_poll_seconds';
const RELAY_AUTO_REPLY_KEY = 'relay_auto_reply';

const DEFAULT_RELAY_ENABLED = '0';
const DEFAULT_RELAY_POLL_SECONDS = '60';
const DEFAULT_RELAY_AUTO_REPLY = '0';

const MIN_POLL_SECONDS = 5;
const MAX_POLL_SECONDS = 3600;

/** Seed a setting to its default iff it has never been set, without clobbering
 *  a value someone (Kevin, the cockpit) already wrote. Exported so relay-cue.ts
 *  (the caps/dedupe/kill-switch layer) seeds its own settings the same way. */
export function ensureSettingDefault(key: string, defaultValue: string): void {
  if (getSetting(key) === null) setSetting(key, defaultValue);
}

ensureSettingDefault(RELAY_ENABLED_KEY, DEFAULT_RELAY_ENABLED);
ensureSettingDefault(RELAY_POLL_SECONDS_KEY, DEFAULT_RELAY_POLL_SECONDS);
ensureSettingDefault(RELAY_AUTO_REPLY_KEY, DEFAULT_RELAY_AUTO_REPLY);

export function isRelayEnabled(): boolean {
  return getSetting(RELAY_ENABLED_KEY) === '1';
}

export function getRelayPollSeconds(): number {
  const raw = Number(getSetting(RELAY_POLL_SECONDS_KEY));
  if (!Number.isFinite(raw)) return Number(DEFAULT_RELAY_POLL_SECONDS);
  return Math.max(MIN_POLL_SECONDS, Math.min(MAX_POLL_SECONDS, Math.round(raw)));
}

export function isRelayAutoReplyEnabled(): boolean {
  return getSetting(RELAY_AUTO_REPLY_KEY) === '1';
}

/** Flip the relay kill switch. Exported for the REST surface's `/relay/pause`
 *  (node #920): a global pause IS relay_enabled=0 — same switch that already
 *  gates the poller/cue/outbound (item 4), not a second flag. */
export function setRelayEnabled(enabled: boolean): void {
  setSetting(RELAY_ENABLED_KEY, enabled ? '1' : '0');
}

/** Observable kill-switch state for a future `/relay` surface (item 4): when
 *  relay_enabled is off this is the one place to read WHY polling/cues/outbound
 *  are all dark, instead of inferring it from silence. */
export interface RelayStatus {
  enabled: boolean;
  pollSeconds: number;
  autoReply: boolean;
  reason: string;
}

export function getRelayStatus(): RelayStatus {
  const enabled = isRelayEnabled();
  return {
    enabled,
    pollSeconds: getRelayPollSeconds(),
    autoReply: isRelayAutoReplyEnabled(),
    reason: enabled ? 'relay_enabled=1' : 'relay_enabled=0 (kill switch) — no polling, no cues, no outbound',
  };
}

// -- schema (inline create-if-not-exists, same pattern as intel-desk.ts / notepad.ts) --

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS relay_threads (
    id              TEXT PRIMARY KEY,
    title           TEXT,
    opened_by       TEXT,
    status          TEXT NOT NULL DEFAULT 'open',
    exchange_count  INTEGER NOT NULL DEFAULT 0,
    read_by         TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT,
    mirrored_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_relay_threads_status
    ON relay_threads(status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS relay_messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id     TEXT,
    thread_id      TEXT NOT NULL REFERENCES relay_threads(id),
    author         TEXT NOT NULL,
    kind           TEXT NOT NULL,
    subject        TEXT,
    body           TEXT NOT NULL,
    refs           TEXT,
    content_hash   TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    mirrored_at    TEXT,
    cue_fired_at   TEXT,
    is_draft       INTEGER NOT NULL DEFAULT 0
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_messages_message_id
    ON relay_messages(message_id);

  CREATE INDEX IF NOT EXISTS idx_relay_messages_content_hash
    ON relay_messages(content_hash);

  CREATE INDEX IF NOT EXISTS idx_relay_messages_thread_created
    ON relay_messages(thread_id, created_at);
`);

const upsertThreadStmt = sqliteDb.prepare<[
  string, string | null, string | null, string, number, string | null, string, string | null,
]>(`
  INSERT INTO relay_threads (id, title, opened_by, status, exchange_count, read_by, created_at, updated_at, mirrored_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    opened_by = excluded.opened_by,
    -- A local cap-breach pause (relay-cue.ts) is JARVIS-side rate limiting the
    -- remote server has no concept of. Without this guard, the very next poll
    -- re-mirrors the server's own status and silently un-pauses the thread,
    -- defeating the cap the moment it fires.
    status = CASE WHEN relay_threads.status = 'paused' THEN 'paused' ELSE excluded.status END,
    exchange_count = excluded.exchange_count,
    read_by = excluded.read_by,
    updated_at = excluded.updated_at,
    mirrored_at = datetime('now')
`);

const insertMessageStmt = sqliteDb.prepare<[
  string | null, string, string, string, string | null, string, string | null, string, string,
]>(`
  INSERT INTO relay_messages (
    message_id, thread_id, author, kind, subject, body, refs, content_hash, created_at, mirrored_at, cue_fired_at, is_draft
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL, 0)
  ON CONFLICT(message_id) DO NOTHING
`);

const getMessageStmt = sqliteDb.prepare<[number], RelayMessageRow>(
  `SELECT * FROM relay_messages WHERE id = ?`,
);

const getThreadStmt = sqliteDb.prepare<[string], RelayThreadRow>(
  `SELECT * FROM relay_threads WHERE id = ?`,
);

function nowIso(): string {
  return new Date().toISOString();
}

function contentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Fired on the shared bus (payload carries its own `type`, per sse-bus.ts
 *  convention) whenever a thread or message is mirrored, so a future `/relay`
 *  page can render live instead of polling (item 6). */
function emitRelayEvent(
  action: RelayMessageEvent['action'],
  threadId: string,
  extra: { thread?: RelayThreadRow; message?: RelayMessageRow },
): void {
  sseBus.emit('sse', { type: 'relay_message', action, thread_id: threadId, ...extra } satisfies RelayMessageEvent);
}

/** Exported for the REST surface (node #920): after `postKevinMessage` posts
 *  live via relay-tool `reply`, it mirrors the call's own `{thread, message}`
 *  response through these same two functions the poller uses — same insert
 *  path, same dedupe, same SSE emit, no second round-trip poll needed. */
export function upsertThread(raw: RawRelayThread): void {
  if (!raw.id) return;
  upsertThreadStmt.run(
    raw.id,
    raw.title ?? null,
    raw.opened_by ?? null,
    raw.status ?? 'open',
    Number.isFinite(raw.exchange_count) ? Number(raw.exchange_count) : 0,
    raw.read_by ? JSON.stringify(raw.read_by) : null,
    raw.created_at ?? nowIso(),
    raw.updated_at ?? null,
  );
  const thread = getThreadStmt.get(raw.id) ?? undefined;
  emitRelayEvent('thread_mirrored', raw.id, { thread });
}

/** Insert one message idempotently. Returns the row iff this call actually
 *  inserted it (a re-run over an already-mirrored message returns null via
 *  the ON CONFLICT(message_id) DO NOTHING no-op). */
export function upsertMessage(threadId: string, raw: RawRelayMessage): RelayMessageRow | null {
  if (!raw.id || !raw.body) return null;
  const info = insertMessageStmt.run(
    raw.id,
    threadId,
    raw.from ?? 'unknown',
    raw.kind ?? 'note',
    raw.subject ?? null,
    raw.body,
    raw.refs !== undefined ? JSON.stringify(raw.refs) : null,
    contentHash(raw.body),
    raw.created_at ?? nowIso(),
  );
  if (info.changes === 0) return null;
  const message = getMessageStmt.get(Number(info.lastInsertRowid)) ?? null;
  if (message) emitRelayEvent('message_mirrored', threadId, { message });
  return message;
}

// -- draft-only outbound (item 5) -------------------------------------------
// While relay_auto_reply=0 (the DEFAULT), any reply JARVIS composes is stored
// here as a local draft (is_draft=1, message_id=NULL — the nullable UNIQUE
// index on message_id was reserved for exactly this by the previous node) and
// is NEVER sent to the relay. There is no code path anywhere in this file that
// calls relay-tool to post a message. Whether an approval surface is ever
// built to let a draft become a real outbound post — and whether the
// relay_auto_reply default itself is ever flipped to 1 — is Kevin's call, not
// this code's; isRelayOutboundAllowed() below exists so that future surface
// has one place to check both gates, but nothing in this codebase calls it yet.
const insertDraftStmt = sqliteDb.prepare<[string, string, string | null, string, string]>(`
  INSERT INTO relay_messages (
    message_id, thread_id, author, kind, subject, body, refs, content_hash, created_at, mirrored_at, cue_fired_at, is_draft
  )
  VALUES (NULL, ?, 'jarvis', ?, ?, ?, NULL, ?, datetime('now'), NULL, NULL, 1)
`);

/** Store a JARVIS-composed reply as a draft. Never posts it anywhere. */
export function composeDraftReply(
  threadId: string,
  body: string,
  kind: RelayMessageKind = 'answer',
  subject: string | null = null,
): RelayMessageRow {
  const info = insertDraftStmt.run(threadId, kind, subject, body, contentHash(body));
  const row = getMessageStmt.get(Number(info.lastInsertRowid));
  if (!row) throw new Error('composeDraftReply: insert did not produce a row');
  emitRelayEvent('message_mirrored', threadId, { message: row });
  return row;
}

/** True only when BOTH the kill switch is on and Kevin has explicitly flipped
 *  auto-reply on. Nothing in this codebase currently acts on this — it is the
 *  single check a future approval/auto-post path must gate on. */
export function isRelayOutboundAllowed(): boolean {
  return isRelayEnabled() && isRelayAutoReplyEnabled();
}

// -- cue seam --------------------------------------------------------------
// Cue firing (turning a new inbound message into a governed JARVIS turn),
// exchange/rate caps, and content-hash dedupe live in src/relay-cue.ts, which
// registers itself below via registerRelayInboundListener — same shape as
// hopper-engine's registerTreeStatusListener. Listener errors are caught so
// one bad handler can never break the poll loop.

type RelayInboundListener = (message: RelayMessageRow) => void;

const inboundListeners = new Set<RelayInboundListener>();

/** Register a callback invoked once per newly-mirrored message authored by
 *  someone other than jarvis (i.e. a real inbound message, never our own
 *  outbound mirror). Returns an unregister function. */
export function registerRelayInboundListener(listener: RelayInboundListener): () => void {
  inboundListeners.add(listener);
  return () => inboundListeners.delete(listener);
}

function notifyInbound(message: RelayMessageRow): void {
  for (const listener of inboundListeners) {
    try {
      listener(message);
    } catch (err) {
      console.error('[relay] inbound listener error:', err);
    }
  }
}

// -- poller ------------------------------------------------------------------

export interface RelayPollSummary {
  ok: boolean;
  skipped?: 'disabled';
  threadsSeen: number;
  messagesUpserted: number;
  newMessages: RelayMessageRow[];
  error?: string;
}

async function doPoll(): Promise<RelayPollSummary> {
  if (!isRelayEnabled()) {
    return { ok: true, skipped: 'disabled', threadsSeen: 0, messagesUpserted: 0, newMessages: [] };
  }

  const inboxCall = await nativeCall('smarty-pants', 'relay-tool', { operation: 'inbox' });
  if (!inboxCall.ok) {
    return { ok: false, threadsSeen: 0, messagesUpserted: 0, newMessages: [], error: inboxCall.error };
  }
  const inbox = safeJsonParse<RawInboxResponse>(inboxCall.result);
  if (!inbox) {
    return { ok: false, threadsSeen: 0, messagesUpserted: 0, newMessages: [], error: 'inbox response was not valid JSON' };
  }

  const threadIds = Array.from(
    new Set((inbox.messages ?? []).map((m) => m.thread_id).filter((id): id is string => Boolean(id))),
  );

  let messagesUpserted = 0;
  const newMessages: RelayMessageRow[] = [];
  const errors: string[] = [];

  for (const threadId of threadIds) {
    const threadCall = await nativeCall('smarty-pants', 'relay-tool', { operation: 'read_thread', id: threadId });
    if (!threadCall.ok) {
      errors.push(`read_thread ${threadId}: ${threadCall.error}`);
      continue;
    }
    const data = safeJsonParse<RawReadThreadResponse>(threadCall.result);
    if (!data) {
      errors.push(`read_thread ${threadId}: response was not valid JSON`);
      continue;
    }
    if (data.thread) upsertThread(data.thread);
    for (const raw of data.messages ?? []) {
      const inserted = upsertMessage(threadId, raw);
      if (!inserted) continue;
      messagesUpserted++;
      if (inserted.author !== 'jarvis') newMessages.push(inserted);
    }
  }

  for (const message of newMessages) notifyInbound(message);

  return {
    ok: errors.length === 0,
    threadsSeen: threadIds.length,
    messagesUpserted,
    newMessages,
    error: errors.length > 0 ? errors.join('; ') : undefined,
  };
}

let inFlight: Promise<RelayPollSummary> | null = null;

/** Poll the relay inbox and mirror every new message into jarvis.db. Makes
 *  ZERO model calls — a plain fetch() through the native MCP client. Safe to
 *  call concurrently; overlapping calls share the same in-flight poll. */
export function pollRelay(): Promise<RelayPollSummary> {
  if (inFlight) return inFlight;
  inFlight = doPoll().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// -- interval wiring -----------------------------------------------------

let started = false;

/** Start the relay poller loop. Self-rescheduling (not setInterval) so a
 *  change to relay_poll_seconds takes effect on the very next tick without a
 *  process restart. When relay_enabled is off, this still ticks on schedule
 *  but pollRelay() is a no-op each time — flipping the flag on needs no
 *  restart either. */
export function startRelayPoller(): void {
  if (started) return;
  started = true;
  const tick = () => {
    pollRelay()
      .catch((err) => console.error('[relay] poll error:', err))
      .finally(() => {
        setTimeout(tick, getRelayPollSeconds() * 1000);
      });
  };
  console.log('[relay] poller started (enabled=%s, poll_seconds=%d)', isRelayEnabled(), getRelayPollSeconds());
  tick();
}
