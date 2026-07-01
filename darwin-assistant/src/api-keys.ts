import { createHash, randomBytes } from 'node:crypto';
import { sqliteDb as db } from './conversation-db.js';

const KEY_PREFIX = 'jrv_';

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash      TEXT NOT NULL UNIQUE,
    caller_label  TEXT NOT NULL,
    scope         TEXT NOT NULL DEFAULT 'jarvis',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
`);

export interface ApiKeyRow {
  id: number;
  key_hash: string;
  caller_label: string;
  scope: string;
  created_at: string;
  revoked_at: string | null;
}

const stmts = {
  insert: db.prepare<[string, string, string]>(
    `INSERT INTO api_keys (key_hash, caller_label, scope) VALUES (?, ?, ?)`,
  ),
  getByHash: db.prepare<[string], ApiKeyRow>(
    `SELECT * FROM api_keys WHERE key_hash = ?`,
  ),
  getById: db.prepare<[number], ApiKeyRow>(
    `SELECT * FROM api_keys WHERE id = ?`,
  ),
  list: db.prepare<[], ApiKeyRow>(
    `SELECT * FROM api_keys ORDER BY id ASC`,
  ),
  revoke: db.prepare<[number]>(
    `UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`,
  ),
};

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Mint a new API key. Returns the plaintext (shown to operator ONCE) and the
 * row id. Only the sha256 hash is persisted.
 */
export function mintApiKey(callerLabel: string, scope = 'jarvis'): { id: number; plaintext: string } {
  const random = randomBytes(24).toString('hex');
  const plaintext = `${KEY_PREFIX}${random}`;
  const hash = hashApiKey(plaintext);
  const info = stmts.insert.run(hash, callerLabel, scope);
  return { id: Number(info.lastInsertRowid), plaintext };
}

export function listApiKeys(): ApiKeyRow[] {
  return stmts.list.all();
}

export function revokeApiKey(id: number): boolean {
  const info = stmts.revoke.run(id);
  return info.changes > 0;
}

export function getApiKey(id: number): ApiKeyRow | undefined {
  return stmts.getById.get(id);
}

/**
 * Look up an API key by its plaintext bearer token. Returns the row if the key
 * exists and has not been revoked, otherwise null.
 */
export function authenticateBearer(bearer: string): ApiKeyRow | null {
  if (!bearer.startsWith(KEY_PREFIX)) return null;
  const row = stmts.getByHash.get(hashApiKey(bearer));
  if (!row) return null;
  if (row.revoked_at) return null;
  return row;
}

/**
 * The external_id prefix used for threads owned by this caller.
 * Shape: `api:{caller_key_id}:` — subsequent path segment is the per-thread UUID.
 */
export function callerExternalIdPrefix(callerKeyId: number): string {
  return `api:${callerKeyId}:`;
}

/**
 * Check whether the given external_id belongs to the given caller.
 */
export function callerOwnsExternalId(callerKeyId: number, externalId: string): boolean {
  return externalId.startsWith(callerExternalIdPrefix(callerKeyId));
}
