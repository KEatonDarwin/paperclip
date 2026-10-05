#!/usr/bin/env node
// SEED COMPANION GUEST — ACCEPTANCE TEST (hopper node #1356)
//
// Runs the migration + seed script against a scratch DB, then proves:
//   1. The seeded guest logs in and the server resolves a 'guest' principal
//      carrying the expected scope_claim.
//   2. Running the seed script a second time does NOT create a duplicate
//      row (idempotent upsert by username).
//   3. Neither run ever touches the live jarvis.db.
//
//   npm run build
//   npm run seed-companion-guest:test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
const LIVE_DB_PATH = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB_PATH) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

const liveStatBefore = fs.existsSync(LIVE_DB_PATH) ? fs.statSync(LIVE_DB_PATH).mtimeMs : null;

function runSeed() {
  return execFileSync('node', [path.join(repoRoot, 'scripts', 'companion-guest-seed.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, JARVIS_DB_PATH: DB_PATH },
    encoding: 'utf8',
  });
}

try {
  // 1. First run: migration (schema created on import) + seed.
  const firstOutput = runSeed();
  assert.match(firstOutput, /created guest identity/, 'first run creates the guest identity');
  const passwordMatch = firstOutput.match(/PLACEHOLDER PASSWORD \(shown once\): (\S+)/);
  assert.ok(passwordMatch, 'first run prints a placeholder password once');
  const firstPassword = passwordMatch[1];
  console.log('  ✓ migration + seed run creates the companion guest identity');

  // Open the same scratch DB in-process to assert login + resolution.
  const { loginGuest, resolveGuestSession, getGuestIdentityByUsername } = await import(
    path.join(repoRoot, 'dist', 'guest-identities.js')
  );
  const { sqliteDb: db } = await import(path.join(repoRoot, 'dist', 'conversation-db.js'));

  const EXPECTED_SCOPE_CLAIM = {
    allowed_thread_prefixes: ['cockpit:companion-'],
    allowed_threads: [],
    allowed_projects: ['goal-12'],
    allowed_routes: [],
    deny_all_else: true,
  };

  const login = loginGuest('companion', firstPassword);
  assert.ok(login, 'seeded guest logs in with the printed placeholder password');
  assert.deepEqual(login.principal.scope_claim, EXPECTED_SCOPE_CLAIM, 'login resolves the expected scope_claim');

  const resolved = resolveGuestSession(login.sessionToken);
  assert.ok(resolved, 'server resolves the minted session token');
  assert.equal(resolved.type, 'guest');
  assert.deepEqual(resolved.scope_claim, EXPECTED_SCOPE_CLAIM, 'resolved principal carries the expected scope_claim');
  console.log('  ✓ login + resolveGuestSession resolve a guest principal with the expected scope_claim');

  const rowCountBefore = db.prepare(`SELECT COUNT(*) AS n FROM guest_identities WHERE username = ?`).get('companion').n;
  assert.equal(rowCountBefore, 1, 'exactly one companion row exists after the first seed run');

  // 2. Second run: idempotent upsert, no duplicate row, old password revoked.
  const secondOutput = runSeed();
  assert.match(secondOutput, /updated existing guest identity/, 'second run updates in place, does not create');
  const secondPasswordMatch = secondOutput.match(/PLACEHOLDER PASSWORD \(shown once\): (\S+)/);
  assert.ok(secondPasswordMatch, 'second run prints a fresh placeholder password');
  const secondPassword = secondPasswordMatch[1];

  const rowCountAfter = db.prepare(`SELECT COUNT(*) AS n FROM guest_identities WHERE username = ?`).get('companion').n;
  assert.equal(rowCountAfter, 1, 'still exactly one companion row after the second seed run (idempotent)');
  console.log('  ✓ second seed run is idempotent: no duplicate row');

  const staleLogin = loginGuest('companion', firstPassword);
  assert.equal(staleLogin, null, 'the first run password no longer works after rotation');
  const freshLogin = loginGuest('companion', secondPassword);
  assert.ok(freshLogin, 'the second run password logs in');
  console.log('  ✓ password rotates on re-seed, identity id stable');

  const row = getGuestIdentityByUsername('companion');
  assert.equal(row.id, 1, 'the companion identity keeps the same row id across reseeds');

  // 3. Live jarvis.db was never touched.
  const liveStatAfter = fs.existsSync(LIVE_DB_PATH) ? fs.statSync(LIVE_DB_PATH).mtimeMs : null;
  assert.equal(liveStatAfter, liveStatBefore, 'live jarvis.db mtime unchanged — never written to');
  console.log('  ✓ live jarvis.db untouched');

  console.log('\n[seed-companion-guest-test] ALL 6 assertions passed ✅');
} finally {
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
}
