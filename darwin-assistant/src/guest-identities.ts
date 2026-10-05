import { sqliteDb as db } from './conversation-db.js';

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
