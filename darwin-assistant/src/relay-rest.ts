// RELAY REST (tree-3b42c6e2, node #920)
//
// Business logic behind the `/relay` REST surface (api-v1.ts wires the thin
// HTTP routes onto these functions). Every GET reads jarvis.db ONLY — never
// the live relay-tool. The one write path that reaches outside jarvis.db is
// postKevinMessage, which posts live as principal `kevin` via relay-tool
// `reply` (CONTRACT.md §1/§3/§7), gated by the same relay_enabled kill switch
// and thread-paused check used everywhere else in this feature, then mirrors
// the call's own response through relay.ts's upsertThread/upsertMessage — the
// exact functions the poller uses, so the mirror and SSE emission stay
// identical on both the inbound and Kevin-outbound paths.
//
// Read-receipt limitation (documented, not a bug to chase in this node): the
// jarvis.db mirror only carries a THREAD-level `read_by` map (relay.ts,
// RawRelayThread.read_by), not a per-message one, even though CONTRACT.md §2
// defines `read_by` on Message. Per-party "read_at" below is therefore an
// approximation: a message counts as read by party P the moment thread.read_by[P]
// is at or after that message's created_at (accurate for "has P caught up to
// this message", since a live `read_thread` call marks every earlier unread
// message read for that principal at once — see CONTRACT.md §3 read_thread and
// the REST table's own note under §7 on this same limitation).

import { sqliteDb, getSetting, setSetting } from './conversation-db.js';
import { sseBus } from './sse-bus.js';
import { nativeCallAsPrincipal } from './tools/mcp-native.js';
import {
  isRelayEnabled,
  setRelayEnabled,
  upsertThread,
  upsertMessage,
  type RelayThreadRow,
  type RelayMessageRow,
  type RelayMessageKind,
  type RawRelayThread,
  type RawRelayMessage,
} from './relay.js';

// -- additive columns (same idempotent PRAGMA pattern as relay-cue.ts) ------

function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  try {
    sqliteDb.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch {
    /* column already exists — raced with another loader */
  }
}

// pause_reason is also added by relay-cue.ts (guarded there the same way) —
// repeated here too since this module must not depend on relay-cue.ts having
// been imported first (index.ts side-effect-imports it, but a standalone
// script mounting just the API router may not). paused_by/paused_at are new
// here for the "record who paused and when" requirement (Kevin-initiated
// pause, distinct from an automatic cap-breach pause which has no "who").
addColumnIfMissing('relay_threads', 'pause_reason', 'pause_reason TEXT');
addColumnIfMissing('relay_threads', 'paused_by', 'paused_by TEXT');
addColumnIfMissing('relay_threads', 'paused_at', 'paused_at TEXT');

interface RelayThreadRowExt extends RelayThreadRow {
  pause_reason: string | null;
  paused_by: string | null;
  paused_at: string | null;
}

// -- queries ------------------------------------------------------------------

const listThreadsStmt = sqliteDb.prepare<[], RelayThreadRowExt>(
  `SELECT * FROM relay_threads ORDER BY COALESCE(updated_at, created_at) DESC`,
);
const getThreadStmt = sqliteDb.prepare<[string], RelayThreadRowExt>(
  `SELECT * FROM relay_threads WHERE id = ?`,
);
// Ordered ASC for message-list rendering and DTO derivation alike. One query
// per thread (no JOIN/aggregate) is deliberate: CONTRACT.md §5 caps the board
// at <=200 open threads and <=8 exchanges/thread, so N+1 here is bounded and
// cheap at the scale this feature is designed for.
const listMessagesForThreadStmt = sqliteDb.prepare<[string], RelayMessageRow>(
  `SELECT * FROM relay_messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC`,
);

const pauseThreadStmt = sqliteDb.prepare<[string | null, string, string]>(
  `UPDATE relay_threads
   SET status = 'paused', pause_reason = ?, paused_by = ?, paused_at = datetime('now'), updated_at = datetime('now')
   WHERE id = ?`,
);
// Clears the local pause override. 'open' is a neutral placeholder — the next
// poll (<=relay_poll_seconds away) reconciles this to the thread's true live
// status, same as any other non-'paused' value under relay.ts's upsert guard.
const resumeThreadStmt = sqliteDb.prepare<[string]>(
  `UPDATE relay_threads
   SET status = 'open', pause_reason = NULL, paused_by = NULL, paused_at = NULL, updated_at = datetime('now')
   WHERE id = ?`,
);

// -- helpers -------------------------------------------------------------------

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeParseReadBy(raw: string | null): Record<string, string> {
  if (!raw) return {};
  const parsed = safeJsonParse<Record<string, string>>(raw);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function safeParseRefs(raw: string | null): unknown[] | null {
  if (!raw) return null;
  const parsed = safeJsonParse<unknown>(raw);
  return Array.isArray(parsed) ? parsed : null;
}

const PARTIES = ['kevin', 'mike', 'jarvis'] as const;
type Party = (typeof PARTIES)[number];

function emitRelay(
  action: 'thread_mirrored' | 'message_mirrored' | 'message_updated',
  threadId: string,
  extra: { thread?: RelayThreadRow; message?: RelayMessageRow },
): void {
  sseBus.emit('sse', { type: 'relay_message', action, thread_id: threadId, ...extra });
}

function computeUnreadCounts(readBy: Record<string, string>, messages: RelayMessageRow[]): Record<Party, number> {
  const counts: Record<Party, number> = { kevin: 0, mike: 0, jarvis: 0 };
  for (const party of PARTIES) {
    const readAt = readBy[party];
    for (const m of messages) {
      if (m.author === party) continue;
      if (!readAt || m.created_at > readAt) counts[party]++;
    }
  }
  return counts;
}

function messageReadAt(readBy: Record<string, string>, message: RelayMessageRow): Record<Party, string | null> {
  const result = {} as Record<Party, string | null>;
  for (const party of PARTIES) {
    if (message.author === party) {
      result[party] = null;
      continue;
    }
    const readAt = readBy[party];
    result[party] = readAt && readAt >= message.created_at ? readAt : null;
  }
  return result;
}

const ACTIVE_STATUSES = new Set(['open', 'waiting_jarvis', 'waiting_mike', 'waiting_kevin']);

function secondsBetween(earlierIso: string, laterIso: string): number {
  return Math.max(0, Math.round((Date.parse(laterIso) - Date.parse(earlierIso)) / 1000));
}

export interface RelayMessageDTO {
  id: number;
  message_id: string | null;
  author: string;
  kind: string;
  subject: string | null;
  body: string;
  refs: unknown[] | null;
  created_at: string;
  read_at: Record<Party, string | null>;
  is_draft: boolean;
}

export interface RelayThreadListItem {
  id: string;
  title: string | null;
  status: string;
  opened_by: string | null;
  exchange_count: number;
  created_at: string;
  updated_at: string | null;
  last_message_at: string | null;
  last_message_from: string | null;
  needs_kevin: boolean;
  paused: boolean;
  pause_reason: string | null;
  paused_by: string | null;
  paused_at: string | null;
  unread: Record<Party, number>;
  // How long the current last message has sat waiting for a reply, while the
  // thread is still active (open/waiting_*). null once done/paused, or if
  // there are no messages yet.
  awaiting_seconds: number | null;
  // Turnaround time of the most recently COMPLETED reply (the last pair of
  // consecutive messages with different authors). CONTRACT.md §2's reply_lag
  // is defined per-message looking forward; this is that same quantity for
  // the latest exchange, which is what a thread-list row can usefully show.
  reply_lag_seconds: number | null;
  // Fastest read-receipt lag on the last message, across parties other than
  // its author, or null if no one (else) has read it yet.
  read_lag_seconds: number | null;
}

function toMessageDTO(readBy: Record<string, string>, m: RelayMessageRow): RelayMessageDTO {
  return {
    id: m.id,
    message_id: m.message_id,
    author: m.author,
    kind: m.kind,
    subject: m.subject,
    body: m.body,
    refs: safeParseRefs(m.refs),
    created_at: m.created_at,
    read_at: messageReadAt(readBy, m),
    is_draft: m.is_draft === 1,
  };
}

function toThreadListItem(thread: RelayThreadRowExt, messages: RelayMessageRow[]): RelayThreadListItem {
  const readBy = safeParseReadBy(thread.read_by);
  const last = messages.length > 0 ? messages[messages.length - 1] : null;

  let awaiting_seconds: number | null = null;
  if (last && ACTIVE_STATUSES.has(thread.status)) {
    awaiting_seconds = secondsBetween(last.created_at, new Date().toISOString());
  }

  let reply_lag_seconds: number | null = null;
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].author !== messages[i - 1].author) {
      reply_lag_seconds = secondsBetween(messages[i - 1].created_at, messages[i].created_at);
      break;
    }
  }

  let read_lag_seconds: number | null = null;
  if (last) {
    for (const party of PARTIES) {
      if (party === last.author) continue;
      const readAt = readBy[party];
      if (readAt && readAt >= last.created_at) {
        const lag = secondsBetween(last.created_at, readAt);
        if (read_lag_seconds === null || lag < read_lag_seconds) read_lag_seconds = lag;
      }
    }
  }

  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    opened_by: thread.opened_by,
    exchange_count: thread.exchange_count,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    last_message_at: last ? last.created_at : null,
    last_message_from: last ? last.author : null,
    needs_kevin: thread.status === 'waiting_kevin',
    paused: thread.status === 'paused',
    pause_reason: thread.pause_reason ?? null,
    paused_by: thread.paused_by ?? null,
    paused_at: thread.paused_at ?? null,
    unread: computeUnreadCounts(readBy, messages),
    awaiting_seconds,
    reply_lag_seconds,
    read_lag_seconds,
  };
}

// -- reads ----------------------------------------------------------------------

export function listRelayThreads(): RelayThreadListItem[] {
  return listThreadsStmt.all().map((t) => toThreadListItem(t, listMessagesForThreadStmt.all(t.id)));
}

export interface RelayThreadDetail {
  thread: RelayThreadListItem;
  messages: RelayMessageDTO[];
}

export function getRelayThreadDetail(id: string): RelayThreadDetail | null {
  const thread = getThreadStmt.get(id);
  if (!thread) return null;
  const messages = listMessagesForThreadStmt.all(id);
  const readBy = safeParseReadBy(thread.read_by);
  return {
    thread: toThreadListItem(thread, messages),
    messages: messages.map((m) => toMessageDTO(readBy, m)),
  };
}

// -- write: post as kevin --------------------------------------------------------

const VALID_KINDS = new Set<RelayMessageKind>(['request', 'question', 'answer', 'update', 'result', 'ack', 'note']);
const MAX_BODY_BYTES = 32768; // CONTRACT.md §2/§5

export interface PostKevinMessageInput {
  kind: string;
  subject?: string | null;
  body: string;
  refs?: unknown[];
}

export type PostKevinMessageResult =
  | { ok: true; message: RelayMessageDTO; thread: RelayThreadListItem }
  | { ok: false; status: number; code: string; message: string };

/** Posts live to the relay as principal `kevin` via relay-tool `reply`.
 *  CONTRACT.md §1/§35: the principal is whichever ROUTE a call lands on, not
 *  anything sent in the call's arguments — an `as`/`from`/`author`/`principal`
 *  argument is ignored and logged server-side, never trusted. So "posting as
 *  kevin" means calling over the kevin-connected route, via
 *  `nativeCallAsPrincipal('kevin', ...)` below — there is no argument that
 *  could do it instead. Every check below runs BEFORE the outbound call, so a
 *  disabled/paused relay never reaches the network. */
export async function postKevinMessage(threadId: string, input: PostKevinMessageInput): Promise<PostKevinMessageResult> {
  const thread = getThreadStmt.get(threadId);
  if (!thread) {
    return { ok: false, status: 404, code: 'relay_thread_not_found', message: 'relay thread not found' };
  }
  if (!isRelayEnabled()) {
    return { ok: false, status: 409, code: 'relay_disabled', message: 'relay is off (relay_enabled=0 / paused) — message not sent' };
  }
  if (thread.status === 'paused') {
    const suffix = thread.pause_reason ? ` (${thread.pause_reason})` : '';
    return { ok: false, status: 409, code: 'thread_paused', message: `thread is paused${suffix} — message not sent` };
  }
  if (!VALID_KINDS.has(input.kind as RelayMessageKind)) {
    return { ok: false, status: 400, code: 'invalid_kind', message: `kind must be one of ${[...VALID_KINDS].join(', ')}` };
  }
  const body = input.body.trim();
  if (!body) {
    return { ok: false, status: 400, code: 'invalid_body', message: 'body is required and must be a non-empty string' };
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, status: 413, code: 'body_too_large', message: `body exceeds ${MAX_BODY_BYTES} bytes` };
  }

  const call = await nativeCallAsPrincipal('kevin', 'relay-tool', {
    op: 'reply',
    thread_id: threadId,
    kind: input.kind,
    subject: input.subject ?? undefined,
    body,
    refs: input.refs,
  });
  if (!call.ok) {
    return { ok: false, status: 502, code: 'relay_send_failed', message: call.error ?? 'relay-tool reply call failed' };
  }
  const parsed = safeJsonParse<{ thread?: RawRelayThread; message?: RawRelayMessage }>(call.result);
  if (!parsed?.message) {
    return { ok: false, status: 502, code: 'relay_send_failed', message: 'reply response was not valid JSON or missing message' };
  }

  if (parsed.thread) upsertThread(parsed.thread);
  const mirrored = upsertMessage(threadId, parsed.message);
  const updatedThread = getThreadStmt.get(threadId) ?? thread;
  const messages = listMessagesForThreadStmt.all(threadId);
  const readBy = safeParseReadBy(updatedThread.read_by);
  const dto = mirrored
    ? toMessageDTO(readBy, mirrored)
    : toMessageDTO(readBy, messages[messages.length - 1]);

  return { ok: true, message: dto, thread: toThreadListItem(updatedThread, messages) };
}

// -- write: pause / resume --------------------------------------------------------

const GLOBAL_PAUSE_BY_KEY = 'relay_global_pause_by';
const GLOBAL_PAUSE_AT_KEY = 'relay_global_pause_at';
const GLOBAL_PAUSE_REASON_KEY = 'relay_global_pause_reason';

export interface GlobalPauseStatus {
  paused: boolean;
  paused_by: string | null;
  paused_at: string | null;
  reason: string | null;
  // RELAY-DEVIATIONS (b), relay.ts: this pause is LOCAL to JARVIS only. See
  // callDarwinIntakeGlobalPause below for where the real cross-host call
  // belongs and why it isn't wired up yet.
  scope: 'local_only';
  note: string;
}

const LOCAL_ONLY_PAUSE_NOTE =
  'LOCAL ONLY: stops JARVIS\'s own poller/cue/outbound (relay_enabled=0). ' +
  'Does NOT reach DarwinIntakeSystem — Mike\'s AI can still post to the board ' +
  'until CONTRACT.md §7\'s POST /api/relay/pause is wired up (see RELAY-DEVIATIONS in relay.ts).';

/** SEAM for CONTRACT.md §7's global pause: a real implementation would POST
 *  to DarwinIntakeSystem's `/api/relay/pause` (bearer `RELAY_PAUSE_TOKEN`) to
 *  set `paused.flag` there, so Mike's AI is actually blocked too — not just
 *  JARVIS's own poller. NOT implemented in this node: `RELAY_PAUSE_TOKEN`
 *  isn't provisioned yet (CONTRACT.md §9 item 3, Kevin's call), and this
 *  worker's guardrails forbid reaching out to a live host on its own anyway.
 *  This function is intentionally unused — it is the one place that call
 *  belongs once the token exists. Do not wire it up without Kevin's say-so. */
async function callDarwinIntakeGlobalPause(_paused: boolean, _reason: string | null): Promise<void> {
  throw new Error('not implemented — RELAY_PAUSE_TOKEN not provisioned (CONTRACT.md §9 item 3); see RELAY-DEVIATIONS (b) in relay.ts');
}
void callDarwinIntakeGlobalPause; // seam kept visible for the caller who wires it up later

/** A global pause IS relay_enabled=0 — the same kill switch relay.ts already
 *  gates the poller/cue/outbound on (item 4), not a second flag. Settings-KV
 *  records who/when/why on top of the flip, since the raw flag alone can't.
 *  This is LOCAL ONLY — see callDarwinIntakeGlobalPause above. */
export function setGlobalPause(paused: boolean, actor: string, reason: string | null): GlobalPauseStatus {
  setRelayEnabled(!paused);
  setSetting(GLOBAL_PAUSE_BY_KEY, paused ? actor : '');
  setSetting(GLOBAL_PAUSE_AT_KEY, paused ? new Date().toISOString() : '');
  setSetting(GLOBAL_PAUSE_REASON_KEY, paused ? (reason ?? '') : '');
  if (paused) {
    console.warn(`[relay] ${LOCAL_ONLY_PAUSE_NOTE}`);
  }
  return getGlobalPauseStatus();
}

export function getGlobalPauseStatus(): GlobalPauseStatus {
  return {
    paused: !isRelayEnabled(),
    paused_by: getSetting(GLOBAL_PAUSE_BY_KEY) || null,
    paused_at: getSetting(GLOBAL_PAUSE_AT_KEY) || null,
    reason: getSetting(GLOBAL_PAUSE_REASON_KEY) || null,
    scope: 'local_only',
    note: LOCAL_ONLY_PAUSE_NOTE,
  };
}

export type SetThreadPauseResult =
  | { ok: true; thread: RelayThreadListItem }
  | { ok: false; error: 'thread_not_found' };

export function setThreadPause(threadId: string, paused: boolean, actor: string, reason: string | null): SetThreadPauseResult {
  const existing = getThreadStmt.get(threadId);
  if (!existing) return { ok: false, error: 'thread_not_found' };

  if (paused) {
    pauseThreadStmt.run(reason ?? null, actor, threadId);
  } else {
    resumeThreadStmt.run(threadId);
  }
  const updated = getThreadStmt.get(threadId) as RelayThreadRowExt;
  emitRelay('thread_mirrored', threadId, { thread: updated });
  const messages = listMessagesForThreadStmt.all(threadId);
  return { ok: true, thread: toThreadListItem(updated, messages) };
}
