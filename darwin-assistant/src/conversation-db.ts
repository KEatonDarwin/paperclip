import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sseBus,
  type TurnEvent,
  type ConversationCreatedEvent,
  type ConversationUpdatedEvent,
  type ConversationRenamedEvent,
  type ConversationDeletedEvent,
} from './sse-bus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.JARVIS_DB_PATH ?? path.join(__dirname, '..', 'jarvis.db');

const db: DatabaseType = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id   TEXT NOT NULL UNIQUE,
    slack_channel TEXT,
    claude_session_id TEXT,
    session_adapter TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    continued_from_id INTEGER REFERENCES conversations(id),
    continued_to_id   INTEGER REFERENCES conversations(id)
  );

  CREATE TABLE IF NOT EXISTS turns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    turn_index      INTEGER NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT,
    tool_name       TEXT,
    tool_args       TEXT,
    tool_result     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_turns_conversation ON turns(conversation_id, turn_index);
  CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
  CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

  -- Thread groups / folders (DAR-742). Created here (not in
  -- conversation-groups.ts, which owns the rest of the group CRUD) because
  -- the listConversationsByGroup/setThreadGroup statements below are
  -- prepared eagerly at module load and better-sqlite3 validates a SELECT's
  -- referenced tables at prepare() time, unlike ALTER TABLE ADD COLUMN's FK
  -- reference above (lenient) — so this table must exist before that happens.
  CREATE TABLE IF NOT EXISTS conversation_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    color      TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrate: add debug columns to turns table
for (const col of [
  'timing_ms INTEGER',
  'input_tokens INTEGER',
  'output_tokens INTEGER',
  'cache_read_tokens INTEGER',
  'cache_write_tokens INTEGER',
  'model TEXT',
  'claude_input TEXT',
  'claude_output TEXT',
  // Raw error message + stack captured when a run throws/is interrupted. Surfaced
  // to the UI as an expandable "Details" on the interrupted assistant turn.
  'error_detail TEXT',
]) {
  try { db.exec(`ALTER TABLE turns ADD COLUMN ${col}`); } catch {}
}

// Migrate: add lineage columns to conversations table (for "continue in new thread" feature)
// plus per-thread provider/model override columns (DAR-680 AC#4).
// NOTE: thread_adapter/thread_model are the USER's per-thread override choice.
// They are distinct from session_adapter, which records the adapter that owns the
// current live CLI session (auto-managed by updateSessionState).
for (const col of [
  'continued_from_id INTEGER REFERENCES conversations(id)',
  'continued_to_id INTEGER REFERENCES conversations(id)',
  'session_adapter TEXT',
  'thread_adapter TEXT',
  'thread_model TEXT',
  // User-set display name for a thread (rename). Null → fall back to a derived
  // title (from external_id / first message) on the client.
  'title TEXT',
  // True once Kevin has explicitly renamed the thread (via the rename endpoint
  // with a non-null title). Auto-naming (DAR-726) only ever writes `title` when
  // this is false, so it never clobbers a manual rename.
  'title_is_user_set INTEGER NOT NULL DEFAULT 0',
  // Pin-to-top (DAR-735). pinned_at (not just a boolean) so multiple pinned
  // threads order by most-recently-pinned rather than all tying on updated_at.
  'pinned INTEGER NOT NULL DEFAULT 0',
  'pinned_at TEXT',
  // Thread groups / folders (DAR-742). group_id is nullable folder membership;
  // the FK target (conversation_groups) is created lazily by
  // conversation-groups.ts — SQLite doesn't validate FK targets at ALTER TABLE
  // time, only on writes, so import order doesn't matter here. is_group_chat
  // marks the one conversations row per group that IS the group's own "cover"
  // chat (external_id 'cockpit:group:<id>') — distinct from group_id, which on
  // that row points at the group it covers, same as any other member.
  'group_id INTEGER REFERENCES conversation_groups(id)',
  'is_group_chat INTEGER NOT NULL DEFAULT 0',
]) {
  try { db.exec(`ALTER TABLE conversations ADD COLUMN ${col}`); } catch {}
}

export interface ConversationRow {
  id: number;
  external_id: string;
  slack_channel: string | null;
  claude_session_id: string | null;
  session_adapter: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  continued_from_id: number | null;
  continued_to_id: number | null;
  // Per-thread provider/model override (DAR-680 AC#4). Null → inherit the
  // global adapter/model settings. Distinct from session_adapter.
  thread_adapter: string | null;
  thread_model: string | null;
  // User-set display name (rename). Null → client derives a title.
  title: string | null;
  // 1 once Kevin has explicitly renamed the thread; gates auto-naming (DAR-726).
  title_is_user_set: number;
  // Pin-to-top (DAR-735). pinned_at drives ordering among multiple pinned threads.
  pinned: number;
  pinned_at: string | null;
  // Thread groups / folders (DAR-742). group_id is this thread's folder (null =
  // ungrouped). is_group_chat = 1 marks the one row per group that IS the
  // group's own cover chat (its group_id still points at the group it covers).
  group_id: number | null;
  is_group_chat: number;
}

/**
 * Canonical ingress source for a conversation, derived from its external_id
 * prefix. Slack uses `slack:...`, the cockpit `cockpit:...`, the watch relay
 * `watch:...`, etc. Used to badge messages by where they came from.
 */
export type ConversationSource =
  | 'slack' | 'cockpit' | 'watch' | 'api' | 'checkin' | 'webhook' | 'other';

export function deriveSource(externalId: string): ConversationSource {
  const prefix = externalId.split(':', 1)[0]?.toLowerCase() ?? '';
  switch (prefix) {
    case 'slack': return 'slack';
    case 'cockpit': return 'cockpit';
    case 'watch': return 'watch';
    case 'api': return 'api';
    case 'checkin': return 'checkin';
    case 'webhook': return 'webhook';
    default: return 'other';
  }
}

export interface TurnRow {
  id: number;
  conversation_id: number;
  turn_index: number;
  role: string;
  content: string | null;
  tool_name: string | null;
  tool_args: string | null;
  tool_result: string | null;
  created_at: string;
  timing_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  model: string | null;
  claude_input: string | null;
  claude_output: string | null;
  error_detail: string | null;
}

export interface TurnMetadata {
  timingMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
  claudeInput?: string;
  claudeOutput?: string;
  errorDetail?: string;
}

const stmts = {
  getConversation: db.prepare<[string], ConversationRow>(
    `SELECT * FROM conversations WHERE external_id = ?`,
  ),
  getConversationById: db.prepare<[number], ConversationRow>(
    `SELECT * FROM conversations WHERE id = ?`,
  ),
  createConversation: db.prepare<[string, string | null]>(
    `INSERT INTO conversations (external_id, slack_channel) VALUES (?, ?)`,
  ),
  updateSessionState: db.prepare<[string | null, string | null, number]>(
    `UPDATE conversations
     SET claude_session_id = ?, session_adapter = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ),
  touchConversation: db.prepare<[number]>(
    `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`,
  ),
  setThreadModelOverride: db.prepare<[string | null, string | null, number]>(
    `UPDATE conversations
     SET thread_adapter = ?, thread_model = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ),
  closeConversation: db.prepare<[string]>(
    `UPDATE conversations SET status = 'closed', updated_at = datetime('now') WHERE external_id = ?`,
  ),
  getMaxTurnIndex: db.prepare<[number], { max_idx: number | null }>(
    `SELECT MAX(turn_index) as max_idx FROM turns WHERE conversation_id = ?`,
  ),
  insertTurn: db.prepare<[number, number, string, string | null, string | null, string | null, string | null, number | null, number | null, number | null, number | null, number | null, string | null, string | null, string | null, string | null]>(
    `INSERT INTO turns (conversation_id, turn_index, role, content, tool_name, tool_args, tool_result, timing_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, claude_input, claude_output, error_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  getTurns: db.prepare<[number], TurnRow>(
    `SELECT * FROM turns WHERE conversation_id = ? ORDER BY turn_index ASC`,
  ),
  listActiveConversations: db.prepare<[], ConversationRow>(
    `SELECT * FROM conversations WHERE status = 'active' ORDER BY updated_at DESC`,
  ),
  listAllConversations: db.prepare<[], ConversationRow>(
    `SELECT * FROM conversations ORDER BY pinned DESC, pinned_at DESC, updated_at DESC LIMIT 100`,
  ),
  countTurns: db.prepare<[number], { cnt: number }>(
    `SELECT COUNT(*) as cnt FROM turns WHERE conversation_id = ?`,
  ),
  // "Messages" = the human-visible back-and-forth (user + assistant), excluding
  // tool_call / tool_result plumbing turns. Drives the sidebar message count.
  countMessages: db.prepare<[number], { cnt: number }>(
    `SELECT COUNT(*) as cnt FROM turns WHERE conversation_id = ? AND role IN ('user', 'assistant')`,
  ),
  // Role of the most recent human-visible message — powers the "who spoke last"
  // color coding (user = waiting on JARVIS, assistant = ball in Kevin's court).
  getLastMessageRole: db.prepare<[number], { role: string }>(
    `SELECT role FROM turns WHERE conversation_id = ? AND role IN ('user', 'assistant') ORDER BY turn_index DESC LIMIT 1`,
  ),
  setTurnError: db.prepare<[string | null, number]>(
    `UPDATE turns SET error_detail = ? WHERE id = ?`,
  ),
  getLastAssistantTurnId: db.prepare<[number], { id: number }>(
    `SELECT id FROM turns WHERE conversation_id = ? AND role = 'assistant' ORDER BY turn_index DESC LIMIT 1`,
  ),
  renameConversation: db.prepare<[string | null, number, number]>(
    `UPDATE conversations SET title = ?, title_is_user_set = ?, updated_at = datetime('now') WHERE id = ?`,
  ),
  // Auto-name only ever wins the race against a manual rename by construction:
  // it's guarded to rows that are still untitled and never user-renamed.
  autoNameConversation: db.prepare<[string, number]>(
    `UPDATE conversations SET title = ?, updated_at = datetime('now')
     WHERE id = ? AND title IS NULL AND title_is_user_set = 0`,
  ),
  // Manually-triggered re-title (DAR-728): unguarded, but leaves
  // title_is_user_set untouched so auto-naming semantics are unaffected.
  forceAutoNameConversation: db.prepare<[string, number]>(
    `UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?`,
  ),
  setConversationStatus: db.prepare<[string, number]>(
    `UPDATE conversations SET status = ?, updated_at = datetime('now') WHERE id = ?`,
  ),
  setThreadPinned: db.prepare<[number, string | null, number]>(
    `UPDATE conversations SET pinned = ?, pinned_at = ? WHERE id = ?`,
  ),
  setThreadGroup: db.prepare<[number | null, number]>(
    `UPDATE conversations SET group_id = ?, updated_at = datetime('now') WHERE id = ?`,
  ),
  initGroupChat: db.prepare<[number, number]>(
    `UPDATE conversations SET group_id = ?, is_group_chat = 1, updated_at = datetime('now') WHERE id = ?`,
  ),
  listConversationsByGroup: db.prepare<[number], ConversationRow>(
    `SELECT * FROM conversations WHERE group_id = ? AND is_group_chat = 0 ORDER BY updated_at DESC`,
  ),
  ungroupMembers: db.prepare<[number]>(
    `UPDATE conversations SET group_id = NULL, updated_at = datetime('now') WHERE group_id = ? AND is_group_chat = 0`,
  ),
  deleteTurnsForConversation: db.prepare<[number]>(
    `DELETE FROM turns WHERE conversation_id = ?`,
  ),
  deleteConversationRow: db.prepare<[number]>(
    `DELETE FROM conversations WHERE id = ?`,
  ),
  copyTurns: db.prepare<[number, number]>(
    `INSERT INTO turns (conversation_id, turn_index, role, content, tool_name, tool_args, tool_result, created_at, timing_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, claude_input, claude_output, error_detail)
     SELECT ?, turn_index, role, content, tool_name, tool_args, tool_result, created_at, timing_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, claude_input, claude_output, error_detail
     FROM turns WHERE conversation_id = ? ORDER BY turn_index ASC`,
  ),
};

export function getConversation(externalId: string): ConversationRow | undefined {
  return stmts.getConversation.get(externalId);
}

export function getConversationById(id: number): ConversationRow | undefined {
  return stmts.getConversationById.get(id);
}

export function getOrCreateConversation(externalId: string, slackChannel?: string): ConversationRow {
  const row = stmts.getConversation.get(externalId);
  if (row && row.status === 'active') return row;
  if (row && row.status === 'closed') {
    db.prepare(`UPDATE conversations SET external_id = ? WHERE id = ?`).run(
      `${externalId}:closed:${Date.now()}`, row.id,
    );
  }
  stmts.createConversation.run(externalId, slackChannel ?? null);
  const created = stmts.getConversation.get(externalId)!;
  sseBus.emit('sse', {
    type: 'conversation_created',
    conversationId: created.id,
    externalId: created.external_id,
    status: created.status,
    createdAt: created.created_at,
  } satisfies ConversationCreatedEvent);
  return created;
}

export function updateSessionState(conversationId: number, sessionId: string | null, adapterId: string | null): void {
  stmts.updateSessionState.run(sessionId, adapterId, conversationId);
}

export function touchConversation(conversationId: number): void {
  stmts.touchConversation.run(conversationId);
}

// Set (or clear) the per-thread provider/model override. Pass null for both to
// clear the override so the thread falls back to the global adapter/model.
export function setThreadModelOverride(
  conversationId: number,
  adapterId: string | null,
  model: string | null,
): void {
  stmts.setThreadModelOverride.run(adapterId, model, conversationId);
}

export function closeConversation(externalId: string): void {
  const row = stmts.getConversation.get(externalId);
  if (row) {
    db.prepare(`UPDATE conversations SET external_id = ?, status = 'closed', updated_at = datetime('now') WHERE id = ?`).run(
      externalId + ':closed:' + Date.now(), row.id,
    );
  }
}

export function addTurn(
  conversationId: number,
  role: string,
  content: string | null,
  toolName?: string,
  toolArgs?: string,
  toolResult?: string,
  metadata?: TurnMetadata,
): number {
  const maxRow = stmts.getMaxTurnIndex.get(conversationId);
  const nextIndex = (maxRow?.max_idx ?? -1) + 1;
  const info = stmts.insertTurn.run(
    conversationId, nextIndex, role, content,
    toolName ?? null, toolArgs ?? null, toolResult ?? null,
    metadata?.timingMs ?? null, metadata?.inputTokens ?? null,
    metadata?.outputTokens ?? null, metadata?.cacheReadTokens ?? null,
    metadata?.cacheWriteTokens ?? null, metadata?.model ?? null,
    metadata?.claudeInput ?? null, metadata?.claudeOutput ?? null,
    metadata?.errorDetail ?? null,
  );
  stmts.touchConversation.run(conversationId);

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  sseBus.emit('sse', {
    type: 'turn',
    conversationId,
    turn: {
      id: Number(info.lastInsertRowid),
      turn_index: nextIndex,
      role,
      content: content ?? null,
      tool_name: toolName ?? null,
      tool_args: toolArgs ?? null,
      tool_result: toolResult ?? null,
      created_at: now,
      timing_ms: metadata?.timingMs ?? null,
      input_tokens: metadata?.inputTokens ?? null,
      output_tokens: metadata?.outputTokens ?? null,
      cache_read_tokens: metadata?.cacheReadTokens ?? null,
      cache_write_tokens: metadata?.cacheWriteTokens ?? null,
      model: metadata?.model ?? null,
      claude_input: metadata?.claudeInput ?? null,
      claude_output: metadata?.claudeOutput ?? null,
    },
  } satisfies TurnEvent);

  const turnCount = stmts.countTurns.get(conversationId)?.cnt ?? 0;
  sseBus.emit('sse', {
    type: 'conversation_updated',
    conversationId,
    status: 'active',
    updatedAt: now,
    turnCount,
  } satisfies ConversationUpdatedEvent);

  return nextIndex;
}

// Shared with agent.ts so a live-interrupted turn (Fix C) and a boot-healed turn
// (Fix B) render as the exact same bubble.
export const INTERRUPTED_MARKER =
  '_⚠️ This reply was interrupted before it finished saving. Send another message to retry._';

/**
 * Fix B (DAR-676): on startup, heal assistant turns that were persisted empty
 * because a run was torn down mid-flight (process restart / subprocess kill).
 * Empty assistant turns render as a blank bubble and read as "still working";
 * marking them gives the UI a real terminal state. Scoped to empty assistant
 * turns only — we do NOT append replies to user-ended threads (that would
 * pollute the many threads a user legitimately left without a response).
 * Returns the number of turns healed.
 */
export function reconcileInterruptedRuns(): number {
  const info = db
    .prepare(
      `UPDATE turns SET content = ?
       WHERE role = 'assistant' AND (content IS NULL OR trim(content) = '')`,
    )
    .run(INTERRUPTED_MARKER);
  return info.changes;
}

export function getTurns(conversationId: number): TurnRow[] {
  return stmts.getTurns.all(conversationId);
}

export function listActiveConversations(): ConversationRow[] {
  return stmts.listActiveConversations.all();
}

export function listAllConversations(): ConversationRow[] {
  return stmts.listAllConversations.all();
}

export function countTurns(conversationId: number): number {
  return stmts.countTurns.get(conversationId)?.cnt ?? 0;
}

/** Count of human-visible messages (user + assistant) in a conversation. */
export function countMessages(conversationId: number): number {
  return stmts.countMessages.get(conversationId)?.cnt ?? 0;
}

/** Role ('user' | 'assistant') of the most recent visible message, or null. */
export function getLastMessageRole(conversationId: number): 'user' | 'assistant' | null {
  const row = stmts.getLastMessageRole.get(conversationId);
  return (row?.role as 'user' | 'assistant' | undefined) ?? null;
}

/** Store the raw error message/stack on a specific turn (expandable UI "Details"). */
export function setTurnError(turnId: number, detail: string): void {
  stmts.setTurnError.run(detail, turnId);
}

/** Id of the most recent assistant turn for a conversation, if any. */
export function getLastAssistantTurnId(conversationId: number): number | null {
  return stmts.getLastAssistantTurnId.get(conversationId)?.id ?? null;
}

/**
 * Rename a thread (user-set display title). Pass null to clear it back to a
 * derived/auto-nameable title — this also clears `title_is_user_set`, so
 * auto-naming (DAR-726) is free to fill it back in on the next opportunity.
 */
export function renameConversation(id: number, title: string | null): void {
  stmts.renameConversation.run(title, title !== null ? 1 : 0, id);
  sseBus.emit('sse', {
    type: 'conversation_renamed',
    conversationId: id,
    title,
  } satisfies ConversationRenamedEvent);
}

/**
 * Auto-generate a thread's title (DAR-726) from its first message. No-op if
 * Kevin already renamed it or another writer already set a title — the
 * update is guarded in SQL so a slow LLM call can't clobber a rename that
 * happened while it was in flight.
 */
export function autoNameConversation(id: number, title: string): void {
  const { changes } = stmts.autoNameConversation.run(title, id);
  if (changes > 0) {
    sseBus.emit('sse', {
      type: 'conversation_renamed',
      conversationId: id,
      title,
    } satisfies ConversationRenamedEvent);
  }
}

/**
 * Manually re-trigger a thread's auto title (DAR-728) — e.g. from the "Auto
 * generate title" context menu action. Always writes, overwriting any
 * existing title (auto-generated or user-set), but does not flip
 * title_is_user_set, so this title still counts as auto-generated.
 */
export function forceAutoNameConversation(id: number, title: string): void {
  stmts.forceAutoNameConversation.run(title, id);
  sseBus.emit('sse', {
    type: 'conversation_renamed',
    conversationId: id,
    title,
  } satisfies ConversationRenamedEvent);
}

/** Update a conversation's status (e.g. active/archived) and nudge clients to refresh. */
export function setConversationStatus(id: number, status: string): void {
  stmts.setConversationStatus.run(status, id);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  sseBus.emit('sse', {
    type: 'conversation_updated',
    conversationId: id,
    status,
    updatedAt: now,
    turnCount: countTurns(id),
  } satisfies ConversationUpdatedEvent);
}

/** Pin or unpin a thread (DAR-735). pinned_at is set to now on pin, cleared on unpin. */
export function setThreadPinned(id: number, pinned: boolean): void {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  stmts.setThreadPinned.run(pinned ? 1 : 0, pinned ? now : null, id);
  sseBus.emit('sse', {
    type: 'conversation_updated',
    conversationId: id,
    status: getConversationById(id)?.status ?? 'active',
    updatedAt: now,
    turnCount: countTurns(id),
  } satisfies ConversationUpdatedEvent);
}

/** File (or unfile, with null) a thread into a group (DAR-742). */
export function setThreadGroup(id: number, groupId: number | null): void {
  stmts.setThreadGroup.run(groupId, id);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  sseBus.emit('sse', {
    type: 'conversation_updated',
    conversationId: id,
    status: getConversationById(id)?.status ?? 'active',
    updatedAt: now,
    turnCount: countTurns(id),
  } satisfies ConversationUpdatedEvent);
}

/** Mark a freshly-created conversation as a group's own cover chat (DAR-742). */
export function initGroupChatConversation(id: number, groupId: number): void {
  stmts.initGroupChat.run(groupId, id);
}

/** Member threads of a group, excluding the group's own cover chat (DAR-742). */
export function listConversationsByGroup(groupId: number): ConversationRow[] {
  return stmts.listConversationsByGroup.all(groupId);
}

/** Ungroup every member of a group (used when the group itself is deleted). */
export function ungroupMembers(groupId: number): void {
  const members = stmts.listConversationsByGroup.all(groupId);
  stmts.ungroupMembers.run(groupId);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (const m of members) {
    sseBus.emit('sse', {
      type: 'conversation_updated',
      conversationId: m.id,
      status: m.status,
      updatedAt: now,
      turnCount: countTurns(m.id),
    } satisfies ConversationUpdatedEvent);
  }
}

/**
 * Auto-hide sweep: archive `active` threads that have been idle longer than
 * `days` — but never one that still has an open (not-done) todo, so nothing
 * actionable disappears on Kevin. Preserves `updated_at` so the "idle since"
 * signal stays truthful. Returns the number archived; emits a refresh per row
 * so open cockpits update live. `days <= 0` disables the sweep.
 */
export function autoHideStaleThreads(days: number): number {
  if (!days || days <= 0) return 0;
  const cutoff = `-${Math.floor(days)} days`;
  const candidates = db
    .prepare<[string], { id: number }>(
      `SELECT id FROM conversations
        WHERE status = 'active'
          AND updated_at < datetime('now', ?)
          AND id NOT IN (SELECT conversation_id FROM thread_todos WHERE status != 'done')`,
    )
    .all(cutoff);
  if (candidates.length === 0) return 0;

  const markArchived = db.prepare<[number]>(
    `UPDATE conversations SET status = 'archived' WHERE id = ?`,
  );
  const txn = db.transaction(() => {
    for (const c of candidates) markArchived.run(c.id);
  });
  txn();

  for (const c of candidates) {
    sseBus.emit('sse', {
      type: 'conversation_updated',
      conversationId: c.id,
      status: 'archived',
      updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      turnCount: countTurns(c.id),
    } satisfies ConversationUpdatedEvent);
  }
  return candidates.length;
}

/** Permanently delete a conversation and all of its turns + todos. */
export function deleteConversation(id: number): void {
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM thread_todos WHERE conversation_id = ?`).run(id);
    stmts.deleteTurnsForConversation.run(id);
    stmts.deleteConversationRow.run(id);
  });
  txn();
  sseBus.emit('sse', {
    type: 'conversation_deleted',
    conversationId: id,
  } satisfies ConversationDeletedEvent);
}

/** Copy all turns (preserving order + metadata) from one conversation to another. */
export function copyTurns(fromId: number, toId: number): void {
  stmts.copyTurns.run(toId, fromId);
}

const lineageStmts = {
  linkContinuation: db.prepare<[number, number]>(
    `UPDATE conversations SET continued_to_id = ?, updated_at = datetime('now') WHERE id = ?`,
  ),
  linkPredecessor: db.prepare<[number, number]>(
    `UPDATE conversations SET continued_from_id = ?, updated_at = datetime('now') WHERE id = ?`,
  ),
};

/**
 * Mark `predecessorId` as having been continued by `successorId`. Sets both
 * directions atomically. Use after posting the primer message that starts the
 * new Slack thread.
 */
export function linkContinuedThreads(predecessorId: number, successorId: number): void {
  const txn = db.transaction(() => {
    lineageStmts.linkContinuation.run(successorId, predecessorId);
    lineageStmts.linkPredecessor.run(predecessorId, successorId);
  });
  txn();
}

// -- JARVIS-created issues tracking (for review-ready notifications) --

db.exec(`
  CREATE TABLE IF NOT EXISTS jarvis_created_issues (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id      TEXT NOT NULL UNIQUE,
    identifier    TEXT NOT NULL,
    title         TEXT NOT NULL,
    original_ask  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_jci_issue_id ON jarvis_created_issues(issue_id);
`);

const jciStmts = {
  track: db.prepare<[string, string, string, string | null]>(
    `INSERT OR IGNORE INTO jarvis_created_issues (issue_id, identifier, title, original_ask) VALUES (?, ?, ?, ?)`,
  ),
  get: db.prepare<[string], { issue_id: string; identifier: string; title: string; original_ask: string | null; created_at: string }>(
    `SELECT * FROM jarvis_created_issues WHERE issue_id = ?`,
  ),
};

export function trackCreatedIssue(issueId: string, identifier: string, title: string, originalAsk?: string): void {
  jciStmts.track.run(issueId, identifier, title, originalAsk ?? null);
}

export function getTrackedIssue(issueId: string) {
  return jciStmts.get.get(issueId) ?? null;
}

// -- Settings table --

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const settingsStmts = {
  get: db.prepare<[string], { key: string; value: string; updated_at: string }>(
    `SELECT * FROM settings WHERE key = ?`,
  ),
  getAll: db.prepare<[], { key: string; value: string; updated_at: string }>(
    `SELECT * FROM settings ORDER BY key`,
  ),
  upsert: db.prepare<[string, string]>(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ),
  remove: db.prepare<[string]>(
    `DELETE FROM settings WHERE key = ?`,
  ),
};

export function getSetting(key: string): string | null {
  return settingsStmts.get.get(key)?.value ?? null;
}

export function getAllSettings(): Record<string, string> {
  const rows = settingsStmts.getAll.all();
  const result: Record<string, string> = {};
  for (const r of rows) result[r.key] = r.value;
  return result;
}

export function setSetting(key: string, value: string): void {
  settingsStmts.upsert.run(key, value);
}

export function deleteSetting(key: string): void {
  settingsStmts.remove.run(key);
}

// -- Personality stats (DAR-729) --
// Six 1-10 dials that used to live only as prose in memory.md. Current values
// are stored as a JSON blob in the generic `settings` table (same pattern as
// `model_presets`); every change is also appended to a dedicated history
// table so the control panel can show a real audit trail (old, new, when,
// who/what changed it) without re-deriving it from settings snapshots.

export const PERSONALITY_STAT_KEYS = [
  'forwardThinking',
  'directness',
  'charisma',
  'sarcasm',
  'humor',
  'formality',
] as const;

export type PersonalityStatKey = (typeof PERSONALITY_STAT_KEYS)[number];

export type PersonalityStats = Record<PersonalityStatKey, number>;

// Seed values are the numbers recorded in the "JARVIS PERSONALITY STATS"
// memory.md section as of 2026-07-13, migrated into a real backend here.
const DEFAULT_PERSONALITY_STATS: PersonalityStats = {
  forwardThinking: 9,
  directness: 8,
  charisma: 6,
  sarcasm: 5,
  humor: 5,
  formality: 4,
};

const PERSONALITY_STATS_SETTING_KEY = 'personality_stats';

db.exec(`
  CREATE TABLE IF NOT EXISTS personality_stats_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_key    TEXT NOT NULL,
    old_value   INTEGER,
    new_value   INTEGER NOT NULL,
    changed_by  TEXT,
    changed_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_personality_history_changed_at ON personality_stats_history(changed_at DESC);
`);

export interface PersonalityStatsHistoryRow {
  id: number;
  stat_key: PersonalityStatKey;
  old_value: number | null;
  new_value: number;
  changed_by: string | null;
  changed_at: string;
}

const personalityStmts = {
  insertHistory: db.prepare<[string, number | null, number, string | null]>(
    `INSERT INTO personality_stats_history (stat_key, old_value, new_value, changed_by) VALUES (?, ?, ?, ?)`,
  ),
  listHistory: db.prepare<[number], PersonalityStatsHistoryRow>(
    `SELECT * FROM personality_stats_history ORDER BY changed_at DESC, id DESC LIMIT ?`,
  ),
};

function clampStat(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)));
}

/** Current personality stat values, seeded with the memory.md defaults on first read. */
export function getPersonalityStats(): PersonalityStats {
  const raw = getSetting(PERSONALITY_STATS_SETTING_KEY);
  if (!raw) {
    setSetting(PERSONALITY_STATS_SETTING_KEY, JSON.stringify(DEFAULT_PERSONALITY_STATS));
    return { ...DEFAULT_PERSONALITY_STATS };
  }
  const parsed = JSON.parse(raw) as Partial<PersonalityStats>;
  const merged = { ...DEFAULT_PERSONALITY_STATS, ...parsed };
  return merged;
}

/**
 * Apply a partial update to the personality stats, logging one history row
 * per changed key (unchanged keys are skipped — no-op writes shouldn't pad
 * the audit trail). `changedBy` is a free-form label (e.g. a Paperclip
 * agent/user identifier) for the "who/what changed it" column.
 */
export function updatePersonalityStats(
  patch: Partial<Record<PersonalityStatKey, number>>,
  changedBy: string | null,
): PersonalityStats {
  const current = getPersonalityStats();
  const next = { ...current };
  const txn = db.transaction(() => {
    for (const key of PERSONALITY_STAT_KEYS) {
      const rawValue = patch[key];
      if (rawValue === undefined || rawValue === null) continue;
      const value = clampStat(rawValue);
      if (value === current[key]) continue;
      personalityStmts.insertHistory.run(key, current[key], value, changedBy);
      next[key] = value;
    }
    setSetting(PERSONALITY_STATS_SETTING_KEY, JSON.stringify(next));
  });
  txn();
  return next;
}

/** Most recent personality stat changes, newest first. */
export function getPersonalityStatsHistory(limit = 100): PersonalityStatsHistoryRow[] {
  return personalityStmts.listHistory.all(limit);
}

// -- Run history (DAR-729) --
// A "run" is a conversation/thread. This aggregates the fields the control
// panel's historical run log needs (duration, tool-call count, outcome) on
// top of the existing conversations/turns tables — no new tables required.

export interface RunHistoryRow {
  id: number;
  external_id: string;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  duration_seconds: number;
  turn_count: number;
  tool_call_count: number;
  error_count: number;
  // error_detail of the last errored turn, used to distinguish a deliberate
  // stop (message is exactly 'Run stopped by user') and a hang-timeout from a
  // genuine crash — see classifyRunOutcome. Null when error_count is 0.
  last_error_detail: string | null;
}

const runHistoryStmt = db.prepare<[number, number], RunHistoryRow>(`
  SELECT
    c.id,
    c.external_id,
    c.title,
    c.status,
    c.created_at,
    c.updated_at,
    CAST(strftime('%s', c.updated_at) AS INTEGER) - CAST(strftime('%s', c.created_at) AS INTEGER) AS duration_seconds,
    (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turn_count,
    (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id AND t.tool_name IS NOT NULL) AS tool_call_count,
    (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id AND t.error_detail IS NOT NULL) AS error_count,
    (SELECT t.error_detail FROM turns t WHERE t.conversation_id = c.id AND t.error_detail IS NOT NULL
       ORDER BY t.turn_index DESC LIMIT 1) AS last_error_detail
  FROM conversations c
  ORDER BY c.created_at DESC
  LIMIT ? OFFSET ?
`);

const runHistoryCountStmt = db.prepare<[], { cnt: number }>(
  `SELECT COUNT(*) as cnt FROM conversations`,
);

/** Paginated historical run log (newest first) with derived duration/tool-call/error counts. */
export function listRunHistory(limit = 50, offset = 0): { rows: RunHistoryRow[]; total: number } {
  const rows = runHistoryStmt.all(limit, offset);
  const total = runHistoryCountStmt.get()?.cnt ?? 0;
  return { rows, total };
}

export type RunOutcome = 'active' | 'completed' | 'stopped' | 'timeout' | 'error';

/**
 * A run with error_detail rows isn't necessarily a crash: pressing the cockpit
 * Stop button and the idle-timeout watchdog both persist an error_detail too
 * (see agent.ts's 'Run stopped by user' / RunTimeoutError), and neither is a
 * genuine failure worth a red badge. Only an error_detail that matches
 * neither known benign case is classified as a real 'error'.
 */
export function classifyRunOutcome(
  running: boolean,
  status: string,
  errorCount: number,
  lastErrorDetail: string | null,
): RunOutcome {
  if (running || status === 'active') return 'active';
  if (errorCount === 0) return 'completed';
  if (lastErrorDetail === 'Run stopped by user') return 'stopped';
  if (lastErrorDetail && /terminated as hung/i.test(lastErrorDetail)) return 'timeout';
  return 'error';
}

export { db as sqliteDb };
