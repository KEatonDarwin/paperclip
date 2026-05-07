import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
]) {
  try { db.exec(`ALTER TABLE turns ADD COLUMN ${col}`); } catch {}
}

export interface ConversationRow {
  id: number;
  external_id: string;
  slack_channel: string | null;
  claude_session_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
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
  updateSessionId: db.prepare<[string, number]>(
    `UPDATE conversations SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?`,
  ),
  touchConversation: db.prepare<[number]>(
    `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`,
  ),
  closeConversation: db.prepare<[string]>(
    `UPDATE conversations SET status = 'closed', updated_at = datetime('now') WHERE external_id = ?`,
  ),
  getMaxTurnIndex: db.prepare<[number], { max_idx: number | null }>(
    `SELECT MAX(turn_index) as max_idx FROM turns WHERE conversation_id = ?`,
  ),
  insertTurn: db.prepare<[number, number, string, string | null, string | null, string | null, string | null, number | null, number | null, number | null, number | null, number | null, string | null, string | null, string | null]>(
    `INSERT INTO turns (conversation_id, turn_index, role, content, tool_name, tool_args, tool_result, timing_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, claude_input, claude_output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  return stmts.getConversation.get(externalId)!;
}

export function updateSessionId(conversationId: number, sessionId: string): void {
  stmts.updateSessionId.run(sessionId, conversationId);
}

export function touchConversation(conversationId: number): void {
  stmts.touchConversation.run(conversationId);
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
  stmts.insertTurn.run(
    conversationId, nextIndex, role, content,
    toolName ?? null, toolArgs ?? null, toolResult ?? null,
    metadata?.timingMs ?? null, metadata?.inputTokens ?? null,
    metadata?.outputTokens ?? null, metadata?.cacheReadTokens ?? null,
    metadata?.cacheWriteTokens ?? null, metadata?.model ?? null,
    metadata?.claudeInput ?? null, metadata?.claudeOutput ?? null,
  );
  stmts.touchConversation.run(conversationId);
  return nextIndex;
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

export { db as sqliteDb };
