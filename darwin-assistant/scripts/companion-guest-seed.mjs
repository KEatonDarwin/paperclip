#!/usr/bin/env node
// SEED COMPANION GUEST — creates/refreshes the ONE guest identity for
// Kevin's wife (hopper node #1356). Idempotent: re-running upserts the
// existing 'companion' row by username instead of duplicating it.
//
// Usage:
//   JARVIS_DB_PATH=/tmp/scratch.db npm run seed-companion-guest   (any scratch DB)
//
//   To mint her REAL credential on the live cockpit DB, Kevin runs (node
//   #1370):
//     COMPANION_SEED_ALLOW_LIVE=1 JARVIS_DB_PATH=/home/kevin/paperclip/darwin-assistant/jarvis.db npm run seed-companion-guest
//   (or pass --live instead of the env var.) That is the ONLY way through
//   the live-DB guard below — any other unexpected path, or the live path
//   WITHOUT the flag, still refuses to run.
//
// SAFETY: refuses to run against the live jarvis.db unless explicitly
// opted in (see above). The placeholder password is randomly generated and
// printed ONCE to stdout — Kevin sets the real one later. Never hardcode a
// real password here.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
const LIVE_DB_PATH = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
const allowLive = process.env.COMPANION_SEED_ALLOW_LIVE === '1' || process.argv.includes('--live');
if (DB_PATH === LIVE_DB_PATH && !allowLive) {
  console.error('FATAL: refusing to run against the live jarvis.db without COMPANION_SEED_ALLOW_LIVE=1 (or --live).');
  process.exit(1);
}
if (DB_PATH !== LIVE_DB_PATH && allowLive) {
  console.error('FATAL: COMPANION_SEED_ALLOW_LIVE/--live only permits the live jarvis.db path, not an arbitrary one.');
  process.exit(1);
}

const distDir = path.join(__dirname, '..', 'dist');
const { createGuestIdentity, getGuestIdentityByUsername } = await import(
  path.join(distDir, 'guest-identities.js')
);
const { sqliteDb: db } = await import(path.join(distDir, 'conversation-db.js'));
const { hashApiKey } = await import(path.join(distDir, 'api-keys.js'));

const USERNAME = 'companion';
const SCOPE_CLAIM = {
  allowed_thread_prefixes: ['cockpit:companion-'],
  allowed_threads: [],
  allowed_projects: ['goal-12'],
  allowed_routes: [],
  deny_all_else: true,
};

const existing = getGuestIdentityByUsername(USERNAME);
if (existing) {
  // Upsert: rotate the password + refresh scope_claim in place, no duplicate row.
  const password = randomBytes(18).toString('base64url');
  db.prepare(`UPDATE guest_identities SET password_hash = ?, scope_claim = ?, disabled = 0 WHERE id = ?`).run(
    hashApiKey(password),
    JSON.stringify(SCOPE_CLAIM),
    existing.id,
  );
  console.log(`[seed-companion-guest] updated existing guest identity (id=${existing.id}, username=${USERNAME})`);
  console.log(`[seed-companion-guest] PLACEHOLDER PASSWORD (shown once): ${password}`);
} else {
  const password = randomBytes(18).toString('base64url');
  const { id } = createGuestIdentity(USERNAME, password, SCOPE_CLAIM);
  console.log(`[seed-companion-guest] created guest identity (id=${id}, username=${USERNAME})`);
  console.log(`[seed-companion-guest] PLACEHOLDER PASSWORD (shown once): ${password}`);
}
