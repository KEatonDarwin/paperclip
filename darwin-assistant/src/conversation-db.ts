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
    `SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 100`,
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
  renameConversation: db.prepare<[string | null, number]>(
    `UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?`,
  ),
  setConversationStatus: db.prepare<[string, number]>(
    `UPDATE conversations SET status = ?, updated_at = datetime('now') WHERE id = ?`,
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
  // Cross-thread live feed (DAR-747): human-visible messages across every
  // conversation, newest first. `t.id` is a global autoincrement so it doubles
  // as a stable pagination cursor (equivalent to insertion order).
  listRecentTurnsAcrossThreads: db.prepare<[number, number], TurnRow & { external_id: string; conv_title: string | null }>(
    `SELECT t.*, c.external_id as external_id, c.title as conv_title
     FROM turns t JOIN conversations c ON c.id = t.conversation_id
     WHERE t.role IN ('user', 'assistant') AND t.id < ?
     ORDER BY t.id DESC LIMIT ?`,
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

export interface FeedTurnRow extends TurnRow {
  external_id: string;
  conv_title: string | null;
}

/** Human-visible messages across every thread, newest first, for the cross-thread live feed. */
export function listRecentTurnsAcrossThreads(limit: number, beforeId?: number): FeedTurnRow[] {
  return stmts.listRecentTurnsAcrossThreads.all(beforeId ?? Number.MAX_SAFE_INTEGER, limit);
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

/** Rename a thread (user-set display title). Pass null to clear. */
export function renameConversation(id: number, title: string | null): void {
  stmts.renameConversation.run(title, id);
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

export { db as sqliteDb };
