#!/usr/bin/env node
// GUEST AUTH ROUTE TESTS — exercises the REAL Express router (hopper node
// #1355: scoped guest credential issuance + login resolution) end to end
// over real HTTP on a throwaway port, against a scratch DB. No live data,
// no model calls, no touch of the live jarvis.db.
//
//   npm run build
//   npm run guest-auth-route:test
//
// Proves:
//   1. createGuestIdentity() + POST /guest/login resolves a session token.
//   2. GET /session/whoami with that session token returns a resolved
//      principal of type 'guest' with the SAME scope_claim given at creation.
//   3. Wrong password / unknown username -> 401, no session minted.
//   4. A disabled guest identity cannot log in even with the right password.
//   5. Existing admin/api_key bearer auth is completely unaffected (still
//      resolves to type 'api_key' on /session/whoami).
//   6. (node #1370) Default-deny stopgap: a guest token gets 403 — not 200,
//      not 500 — on /hopper-trees, /settings, /brief, /threads, while an
//      in-scope route (a goal in her allowed_projects) returns 200,
//      proving the gate isn't just a blanket block.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard ─────────────────────────────────────────────────────────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

const distDir = path.join(__dirname, '..', 'dist');
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const { createGuestIdentity } = await import(path.join(distDir, 'guest-identities.js'));
const { createGoal } = await import(path.join(distDir, 'goals.js'));

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/v1`;

async function req(method, urlPath, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

console.log(`[guest-auth-route-test] scratch DB: ${DB_PATH}`);
console.log(`[guest-auth-route-test] server: ${base}`);

const SCOPE_CLAIM = {
  allowed_thread_prefixes: ['cockpit:goal-13'],
  allowed_threads: [],
  allowed_projects: [],
  allowed_routes: [],
  deny_all_else: true,
};

try {
  // 1+2. Create a guest, log in, whoami resolves type 'guest' + the same claim.
  {
    const { id: guestId } = createGuestIdentity('wife', 'correct-horse-battery', SCOPE_CLAIM);
    assert.ok(guestId > 0, 'createGuestIdentity returns a positive row id');

    const login = await req('POST', '/guest/login', { body: { username: 'wife', password: 'correct-horse-battery' } });
    assert.equal(login.status, 200, `expected 200, got ${login.status}: ${JSON.stringify(login.json)}`);
    assert.ok(login.json.session_token.startsWith('gst_'), 'session token carries the gst_ prefix');
    assert.equal(login.json.guest_id, guestId);
    assert.deepEqual(login.json.scope_claim, SCOPE_CLAIM, 'login response echoes the scope_claim');

    const whoami = await req('GET', '/session/whoami', { token: login.json.session_token });
    assert.equal(whoami.status, 200, `expected 200, got ${whoami.status}: ${JSON.stringify(whoami.json)}`);
    assert.equal(whoami.json.type, 'guest', 'resolved principal type must be guest');
    assert.equal(whoami.json.guest_id, guestId);
    assert.deepEqual(whoami.json.scope_claim, SCOPE_CLAIM, 'resolved principal carries the parsed scope_claim, unchanged');
  }
  console.log('  ✓ create + login + whoami resolves type=guest with the parsed scope_claim');

  // 3. Wrong password / unknown username -> 401.
  {
    const wrongPw = await req('POST', '/guest/login', { body: { username: 'wife', password: 'nope' } });
    assert.equal(wrongPw.status, 401, `expected 401 for wrong password, got ${wrongPw.status}`);
    const unknown = await req('POST', '/guest/login', { body: { username: 'ghost', password: 'whatever' } });
    assert.equal(unknown.status, 401, `expected 401 for unknown username, got ${unknown.status}`);
  }
  console.log('  ✓ wrong password / unknown username -> 401, no session minted');

  // 4. Disabled identity cannot log in.
  {
    const dbMod = await import(path.join(distDir, 'conversation-db.js'));
    createGuestIdentity('disabled-guest', 'somepassword', SCOPE_CLAIM);
    dbMod.sqliteDb.prepare(`UPDATE guest_identities SET disabled = 1 WHERE username = ?`).run('disabled-guest');
    const attempt = await req('POST', '/guest/login', { body: { username: 'disabled-guest', password: 'somepassword' } });
    assert.equal(attempt.status, 401, `expected 401 for disabled guest, got ${attempt.status}`);
  }
  console.log('  ✓ disabled guest identity cannot log in');

  // 5. Existing admin/api_key auth is unaffected.
  {
    const adminKey = mintApiKey('guest-auth-route-test-admin', 'admin').plaintext;
    const whoami = await req('GET', '/session/whoami', { token: adminKey });
    assert.equal(whoami.status, 200, `expected 200, got ${whoami.status}: ${JSON.stringify(whoami.json)}`);
    assert.equal(whoami.json.type, 'api_key', 'admin bearer token still resolves to an api_key principal');
    assert.equal(whoami.json.scope, 'admin');

    const noToken = await req('GET', '/session/whoami');
    assert.equal(noToken.status, 401, 'no token -> 401, same as before this node');
  }
  console.log('  ✓ admin/api_key bearer auth unchanged');

  // 6. Default-deny route gate (node #1370): out-of-scope routes 403, an
  //    in-scope goal route 200, admin/api_key tokens unaffected.
  {
    const { goal } = createGoal({ title: 'companion test goal' });
    const scopeClaim = {
      allowed_thread_prefixes: ['cockpit:companion-'],
      allowed_threads: [],
      allowed_projects: [`goal-${goal.id}`],
      allowed_routes: [],
      deny_all_else: true,
    };
    createGuestIdentity('companion-gate-test', 'correct-horse-battery-2', scopeClaim);
    const login = await req('POST', '/guest/login', { body: { username: 'companion-gate-test', password: 'correct-horse-battery-2' } });
    assert.equal(login.status, 200, `expected 200, got ${login.status}: ${JSON.stringify(login.json)}`);
    const token = login.json.session_token;

    for (const outOfScopePath of ['/hopper-trees', '/settings', '/brief', '/threads']) {
      const res = await req('GET', outOfScopePath, { token });
      assert.equal(res.status, 403, `expected 403 for ${outOfScopePath}, got ${res.status}: ${JSON.stringify(res.json)}`);
    }
    console.log('  ✓ out-of-scope routes (/hopper-trees, /settings, /brief, /threads) -> 403, not 200/500');

    const inScope = await req('GET', `/goals/${goal.id}`, { token });
    assert.equal(inScope.status, 200, `expected 200 for in-scope goal route, got ${inScope.status}: ${JSON.stringify(inScope.json)}`);
    console.log(`  ✓ in-scope goal route (/goals/${goal.id}, matches allowed_projects) -> 200`);

    // Admin/api_key tokens: byte-identical behaviour, untouched by the gate.
    const adminKey2 = mintApiKey('guest-auth-route-test-admin-2', 'admin').plaintext;
    const adminHopperTrees = await req('GET', '/hopper-trees', { token: adminKey2 });
    assert.notEqual(adminHopperTrees.status, 403, 'admin token must never be 403d by the guest gate');
  }
  console.log('  ✓ guest default-deny route gate: 403 out of scope, 200 in scope, admin unaffected');

  console.log('\n[guest-auth-route-test] ALL 6 tests passed ✅');
} finally {
  server.close();
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
}
