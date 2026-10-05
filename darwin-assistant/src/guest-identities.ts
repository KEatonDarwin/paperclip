import { randomBytes } from 'node:crypto';
import { sqliteDb as db } from './conversation-db.js';
import { hashApiKey } from './api-keys.js';

// Schema for the scoped guest-login principal (iPhone companion access).
// Separate from `api_keys` (api-keys.ts): that table is token-based with no
// username/password concept, so a human login identity gets its own table
// rather than an overload. See outbox/companion/AUTH-RECON.md for the full
// auth-chain recon this plugs into.
db.exec(`
  CREATE TABLE IF NOT EXISTS guest_identities (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    scope_claim    TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at  TEXT,
    disabled       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_guest_identities_username ON guest_identities(username);

  -- A guest session is the bearer-token analog of api_keys, minted on
  -- successful login (node #1355). Same shape/precedent as api_keys:
  -- only the hash is stored, the plaintext is shown once at login.
  CREATE TABLE IF NOT EXISTS guest_sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_hash  TEXT NOT NULL UNIQUE,
    guest_id      INTEGER NOT NULL REFERENCES guest_identities(id),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_guest_sessions_hash ON guest_sessions(session_hash);
`);

export interface GuestIdentityRow {
  id: number;
  username: string;
  password_hash: string;
  scope_claim: string;
  created_at: string;
  last_login_at: string | null;
  disabled: number;
}

interface GuestSessionRow {
  id: number;
  session_hash: string;
  guest_id: number;
  created_at: string;
  revoked_at: string | null;
}

/**
 * Parsed shape of `scope_claim`. Written as JSON text in the column.
 */
export interface GuestScopeClaim {
  allowed_thread_prefixes: string[];
  allowed_threads: string[];
  allowed_projects: string[];
  allowed_routes: string[];
  deny_all_else: boolean;
}

/**
 * The resolved principal attached to a request/session once a guest's
 * bearer session token checks out. Downstream enforcement (#271) reads
 * `scope_claim` off of this — not off the raw row.
 */
export interface GuestPrincipal {
  type: 'guest';
  guest_id: number;
  scope_claim: GuestScopeClaim;
}

const SESSION_TOKEN_PREFIX = 'gst_';

const stmts = {
  insertIdentity: db.prepare<[string, string, string]>(
    `INSERT INTO guest_identities (username, password_hash, scope_claim) VALUES (?, ?, ?)`,
  ),
  getIdentityByUsername: db.prepare<[string], GuestIdentityRow>(
    `SELECT * FROM guest_identities WHERE username = ?`,
  ),
  getIdentityById: db.prepare<[number], GuestIdentityRow>(
    `SELECT * FROM guest_identities WHERE id = ?`,
  ),
  touchLastLogin: db.prepare<[number]>(
    `UPDATE guest_identities SET last_login_at = datetime('now') WHERE id = ?`,
  ),
  insertSession: db.prepare<[string, number]>(
    `INSERT INTO guest_sessions (session_hash, guest_id) VALUES (?, ?)`,
  ),
  getSessionByHash: db.prepare<[string], GuestSessionRow>(
    `SELECT * FROM guest_sessions WHERE session_hash = ?`,
  ),
};

function parseScopeClaim(raw: string): GuestScopeClaim {
  return JSON.parse(raw) as GuestScopeClaim;
}

/**
 * Create a guest login identity. Password is hashed with `hashApiKey`
 * (api-keys.ts) — the SAME sha256 util the cockpit already uses for
 * api_keys/secrets, not a new scheme. Returns the new row id.
 */
export function createGuestIdentity(username: string, password: string, scopeClaim: GuestScopeClaim): { id: number } {
  const passwordHash = hashApiKey(password);
  const info = stmts.insertIdentity.run(username, passwordHash, JSON.stringify(scopeClaim));
  return { id: Number(info.lastInsertRowid) };
}

export function getGuestIdentityByUsername(username: string): GuestIdentityRow | undefined {
  return stmts.getIdentityByUsername.get(username);
}

/**
 * Resolve username+password into a fresh guest session. Mints a bearer
 * token (`gst_` + 24 random bytes hex, mirroring `mintApiKey`'s `jrv_`
 * shape) and persists only its sha256 hash, exactly like api_keys. Returns
 * null on unknown username, wrong password, or a disabled identity.
 */
export function loginGuest(username: string, password: string): { sessionToken: string; principal: GuestPrincipal } | null {
  const row = stmts.getIdentityByUsername.get(username);
  if (!row) return null;
  if (row.disabled) return null;
  if (row.password_hash !== hashApiKey(password)) return null;

  const sessionToken = `${SESSION_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
  stmts.insertSession.run(hashApiKey(sessionToken), row.id);
  stmts.touchLastLogin.run(row.id);

  return {
    sessionToken,
    principal: { type: 'guest', guest_id: row.id, scope_claim: parseScopeClaim(row.scope_claim) },
  };
}

/**
 * Resolve a bearer token into a guest principal. This is the login-
 * resolution half of the auth chokepoint: called from `bearerAuth`
 * (api-v1.ts) for any token carrying the `gst_` prefix, the same way
 * `authenticateBearer` resolves `jrv_` tokens. Returns null on an unknown/
 * revoked session or a disabled identity (fails closed).
 */
export function resolveGuestSession(token: string): GuestPrincipal | null {
  if (!token.startsWith(SESSION_TOKEN_PREFIX)) return null;
  const session = stmts.getSessionByHash.get(hashApiKey(token));
  if (!session || session.revoked_at) return null;
  const guest = stmts.getIdentityById.get(session.guest_id);
  if (!guest || guest.disabled) return null;
  return { type: 'guest', guest_id: guest.id, scope_claim: parseScopeClaim(guest.scope_claim) };
}
