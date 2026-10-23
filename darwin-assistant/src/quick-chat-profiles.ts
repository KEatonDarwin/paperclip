import { randomUUID } from 'node:crypto';
import {
  getConversation,
  getConversationById,
  getOrCreateConversation,
  renameConversation,
  setConversationStatus,
  sqliteDb,
  type ConversationRow,
} from './conversation-db.js';

export interface QuickChatProfileRow {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  tool_scope: string | null;
  ttl_hours: number;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuickChatSessionRow {
  id: number;
  profile_id: string;
  conversation_id: number;
  external_id: string;
  opened_at: string;
  expires_at: string;
  closed_at: string | null;
  archived_at: string | null;
}

export interface QuickChatSessionWithProfile extends QuickChatSessionRow {
  profile: QuickChatProfileRow;
  conversation: ConversationRow | null;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS quick_chat_profiles (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT,
    instructions  TEXT NOT NULL,
    tool_scope    TEXT,
    ttl_hours     INTEGER NOT NULL DEFAULT 48,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    archived_at   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS quick_chat_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      TEXT NOT NULL REFERENCES quick_chat_profiles(id),
    conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    external_id     TEXT NOT NULL UNIQUE,
    opened_at       TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at      TEXT NOT NULL,
    closed_at       TEXT,
    archived_at     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_quick_chat_profiles_active
    ON quick_chat_profiles(archived_at, sort_order, name);

  CREATE INDEX IF NOT EXISTS idx_quick_chat_sessions_profile
    ON quick_chat_sessions(profile_id, opened_at DESC);

  CREATE INDEX IF NOT EXISTS idx_quick_chat_sessions_expiry
    ON quick_chat_sessions(closed_at, expires_at);
`);

const DEFAULT_TOOL_SCOPE = 'Current JARVIS tools, especially smarty-pants/MCP and read-only database inspection tools when available.';

const SEED_PROFILES: Array<{
  id: string;
  name: string;
  description: string;
  instructions: string;
  tool_scope: string;
  ttl_hours: number;
  sort_order: number;
}> = [
  {
    id: 'hub-1-database',
    name: 'Hub 1.0 Database',
    description: 'Short-lived read-only operator chat for Hub 1.0 database questions.',
    tool_scope: DEFAULT_TOOL_SCOPE,
    ttl_hours: 48,
    sort_order: 10,
    instructions: [
      'You are a short-lived Hub 1.0 database query console for Kevin.',
      'Use available smarty-pants/MCP/database tools to inspect Hub 1.0 data when Kevin asks questions about advertisers, fulfillment runs, campaigns, accounts, or operational status.',
      'Default to read-only inspection. Do not write, mutate, deploy, or run destructive SQL unless Kevin explicitly asks for that exact action in this session.',
      'Keep answers concise: state what you checked, the result, and any uncertainty.',
      'When the question names an advertiser/account/campaign vaguely, resolve it with a narrow lookup first before making claims.',
    ].join('\n'),
  },
  {
    id: 'hub-2-database',
    name: 'Hub 2.0 Database',
    description: 'Short-lived read-only operator chat for Hub 2.0 staging/production questions.',
    tool_scope: DEFAULT_TOOL_SCOPE,
    ttl_hours: 48,
    sort_order: 20,
    instructions: [
      'You are a short-lived Hub 2.0 database query console for Kevin.',
      'Default Hub 2.0 database context is staging Supabase project shichdueoyytrcvdmlkz unless Kevin explicitly says live/production.',
      'Live Hub 2.0 Supabase project kuojrvfdjjqhqyvkuiam is hands-off for writes. Read-only inspection is allowed only when Kevin asks for live/production context.',
      'Use available smarty-pants/MCP/Supabase tools to answer questions about campaigns, fulfillment, accounting, crons, edge-function output, and migration state.',
      'Keep answers concise: state what you checked, the result, and any follow-up query worth running.',
    ].join('\n'),
  },
  {
    id: 'paperclip-database',
    name: 'Paperclip Database',
    description: 'Short-lived operator chat for Paperclip issues, agents, jobs, and health checks.',
    tool_scope: DEFAULT_TOOL_SCOPE,
    ttl_hours: 48,
    sort_order: 30,
    instructions: [
      'You are a short-lived Paperclip database/operator console for Kevin.',
      'Use Paperclip tools and local database/API access to inspect issues, agents, Foreman jobs, runs, comments, and system health.',
      'Default to read-only inspection and status reporting. Mutate issues only when Kevin asks for a concrete change.',
      'Use the correct DAR issue link format whenever referencing issues.',
      'Keep answers tight and operational.',
    ].join('\n'),
  },
];

const seedStmt = sqliteDb.prepare<[
  string, string, string, string, string, number, number,
]>(`
  INSERT OR IGNORE INTO quick_chat_profiles
    (id, name, description, instructions, tool_scope, ttl_hours, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

for (const p of SEED_PROFILES) {
  seedStmt.run(p.id, p.name, p.description, p.instructions, p.tool_scope, p.ttl_hours, p.sort_order);
}

const listProfilesStmt = sqliteDb.prepare<[], QuickChatProfileRow>(`
  SELECT * FROM quick_chat_profiles
  WHERE archived_at IS NULL
  ORDER BY sort_order ASC, name ASC
`);

const getProfileStmt = sqliteDb.prepare<[string], QuickChatProfileRow>(
  `SELECT * FROM quick_chat_profiles WHERE id = ?`,
);

const upsertProfileStmt = sqliteDb.prepare<[
  string, string, string | null, string, string | null, number, number,
]>(`
  INSERT INTO quick_chat_profiles
    (id, name, description, instructions, tool_scope, ttl_hours, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    instructions = excluded.instructions,
    tool_scope = excluded.tool_scope,
    ttl_hours = excluded.ttl_hours,
    sort_order = excluded.sort_order,
    archived_at = NULL,
    updated_at = datetime('now')
`);

const archiveProfileStmt = sqliteDb.prepare<[string]>(`
  UPDATE quick_chat_profiles
  SET archived_at = datetime('now'), updated_at = datetime('now')
  WHERE id = ?
`);

const openSessionStmt = sqliteDb.prepare<[string, number, string, number]>(`
  INSERT INTO quick_chat_sessions (profile_id, conversation_id, external_id, expires_at)
  VALUES (?, ?, ?, datetime('now', '+' || ? || ' hours'))
`);

const getSessionByExternalIdStmt = sqliteDb.prepare<[string], QuickChatSessionRow>(
  `SELECT * FROM quick_chat_sessions WHERE external_id = ?`,
);

const getSessionByConversationIdStmt = sqliteDb.prepare<[number], QuickChatSessionRow>(
  `SELECT * FROM quick_chat_sessions WHERE conversation_id = ?`,
);

const listSessionsStmt = sqliteDb.prepare<[number], QuickChatSessionRow>(`
  SELECT * FROM quick_chat_sessions
  ORDER BY opened_at DESC
  LIMIT ?
`);

const closeSessionStmt = sqliteDb.prepare<[string]>(`
  UPDATE quick_chat_sessions
  SET closed_at = COALESCE(closed_at, datetime('now')), archived_at = COALESCE(archived_at, datetime('now'))
  WHERE external_id = ?
`);

const expiredSessionsStmt = sqliteDb.prepare<[], QuickChatSessionRow>(`
  SELECT * FROM quick_chat_sessions
  WHERE closed_at IS NULL
    AND expires_at <= datetime('now')
`);

const maxProfileOrderStmt = sqliteDb.prepare<[], { max_order: number | null }>(
  `SELECT MAX(sort_order) AS max_order FROM quick_chat_profiles WHERE archived_at IS NULL`,
);

function slugifyId(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || `quick-chat-${randomUUID().slice(0, 8)}`;
}

function normalizeTtlHours(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 48;
  return Math.max(1, Math.min(168, Math.floor(n)));
}

function hydrateSession(row: QuickChatSessionRow): QuickChatSessionWithProfile | null {
  const profile = getProfileStmt.get(row.profile_id);
  if (!profile) return null;
  return {
    ...row,
    profile,
    conversation: getConversationById(row.conversation_id) ?? null,
  };
}

export function listQuickChatProfiles(): QuickChatProfileRow[] {
  return listProfilesStmt.all();
}

export function getQuickChatProfile(id: string): QuickChatProfileRow | null {
  return getProfileStmt.get(id) ?? null;
}

export function saveQuickChatProfile(input: {
  id?: unknown;
  name: unknown;
  description?: unknown;
  instructions: unknown;
  tool_scope?: unknown;
  ttl_hours?: unknown;
  sort_order?: unknown;
}): QuickChatProfileRow {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!name) throw new Error('name is required');
  const instructions = typeof input.instructions === 'string' ? input.instructions.trim().slice(0, 12_000) : '';
  if (!instructions) throw new Error('instructions are required');
  const id = typeof input.id === 'string' && input.id.trim()
    ? slugifyId(input.id)
    : slugifyId(name);
  const description = typeof input.description === 'string' && input.description.trim()
    ? input.description.trim().slice(0, 500)
    : null;
  const toolScope = typeof input.tool_scope === 'string' && input.tool_scope.trim()
    ? input.tool_scope.trim().slice(0, 1000)
    : DEFAULT_TOOL_SCOPE;
  const ttlHours = normalizeTtlHours(input.ttl_hours);
  const sortOrder = typeof input.sort_order === 'number' && Number.isFinite(input.sort_order)
    ? Math.floor(input.sort_order)
    : (maxProfileOrderStmt.get()?.max_order ?? 0) + 10;

  upsertProfileStmt.run(id, name, description, instructions, toolScope, ttlHours, sortOrder);
  const saved = getQuickChatProfile(id);
  if (!saved) throw new Error('failed to save quick chat profile');
  return saved;
}

export function archiveQuickChatProfile(id: string): boolean {
  const info = archiveProfileStmt.run(id);
  return info.changes > 0;
}

export function openQuickChatSession(profileId: string): QuickChatSessionWithProfile {
  const profile = getQuickChatProfile(profileId);
  if (!profile || profile.archived_at) throw new Error('quick chat profile not found');
  const externalId = `quick:${profile.id}:${randomUUID()}`;
  const conv = getOrCreateConversation(externalId);
  renameConversation(conv.id, `${profile.name} · quick chat`);
  openSessionStmt.run(profile.id, conv.id, externalId, profile.ttl_hours);
  const session = getSessionByExternalIdStmt.get(externalId);
  if (!session) throw new Error('failed to open quick chat session');
  return hydrateSession(session)!;
}

export function listQuickChatSessions(limit = 50): QuickChatSessionWithProfile[] {
  return listSessionsStmt
    .all(Math.max(1, Math.min(200, limit)))
    .map(hydrateSession)
    .filter((s): s is QuickChatSessionWithProfile => !!s);
}

export function getQuickChatSessionByExternalId(externalId: string): QuickChatSessionWithProfile | null {
  const row = getSessionByExternalIdStmt.get(externalId);
  return row ? hydrateSession(row) : null;
}

export function getQuickChatSessionForConversation(conversationId: number): QuickChatSessionWithProfile | null {
  const row = getSessionByConversationIdStmt.get(conversationId);
  return row ? hydrateSession(row) : null;
}

export function closeQuickChatSession(externalId: string): QuickChatSessionWithProfile | null {
  const existing = getQuickChatSessionByExternalId(externalId);
  if (!existing) return null;
  closeSessionStmt.run(externalId);
  const conv = getConversation(externalId);
  if (conv && conv.status === 'active') setConversationStatus(conv.id, 'archived');
  return getQuickChatSessionByExternalId(externalId);
}

export function archiveExpiredQuickChatSessions(): number {
  const expired = expiredSessionsStmt.all();
  for (const session of expired) {
    closeSessionStmt.run(session.external_id);
    const conv = getConversationById(session.conversation_id);
    if (conv && conv.status === 'active') setConversationStatus(conv.id, 'archived');
  }
  return expired.length;
}

export function buildQuickChatContext(externalId: string): string {
  const session = getQuickChatSessionByExternalId(externalId);
  if (!session || session.closed_at) return '';
  return [
    '<quick_chat_profile>',
    `This is a short-lived Quick Chat session. Profile: ${session.profile.name}.`,
    session.profile.description ? `Purpose: ${session.profile.description}` : '',
    `Session expires at: ${session.expires_at} UTC-ish server time. Keep useful context inside this window only; do not treat it as a permanent project thread.`,
    '',
    'Behavior:',
    '- Stay scoped to this profile unless Kevin explicitly redirects.',
    '- Prefer direct inspection/tool calls over broad explanations.',
    '- For database/system questions, default to read-only checks. Do not mutate data, deploy, or run destructive commands unless Kevin explicitly asks for that action in this session.',
    '- Give concise operational answers: what you checked, what it means, and the next query/action if one is obvious.',
    '',
    'Allowed/tool scope:',
    session.profile.tool_scope ?? DEFAULT_TOOL_SCOPE,
    '',
    'Profile instructions:',
    session.profile.instructions,
    '</quick_chat_profile>',
    '',
  ].filter((line) => line !== '').join('\n');
}

export function serializeQuickChatProfile(row: QuickChatProfileRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    tool_scope: row.tool_scope,
    ttl_hours: row.ttl_hours,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function serializeQuickChatSession(row: QuickChatSessionWithProfile): Record<string, unknown> {
  return {
    id: row.id,
    profile_id: row.profile_id,
    external_id: row.external_id,
    conversation_id: row.conversation_id,
    opened_at: row.opened_at,
    expires_at: row.expires_at,
    closed_at: row.closed_at,
    archived_at: row.archived_at,
    profile: serializeQuickChatProfile(row.profile),
  };
}
