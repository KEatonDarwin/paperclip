#!/usr/bin/env node
// GUEST SCOPE ENFORCEMENT ROUTE TESTS — exercises the REAL Express router
// (hopper node #1360: guestScopeGate, mounted right after bearerAuth) end
// to end over real HTTP on a throwaway port, against a scratch DB. No live
// data, no model calls, no touch of the live jarvis.db.
//
//   npm run build
//   npm run guest-enforce-route:test
//
// Proves:
//   1. A guest hitting a thread outside her scope -> 403 JSON {error:{code:'forbidden'}}.
//   2. A guest hitting a thread matching allowed_thread_prefixes -> passes
//      the gate (reaches the real handler, not blocked at 403/404-by-gate).
//   3. A guest hitting a goal route outside allowed_projects -> denied.
//   4. A guest hitting a goal route matching allowed_projects -> passes.
//   5. A guest hitting any route with Accept: text/html -> 302 to /companion
//      instead of a JSON 403.
//   6. GET /session/whoami always passes for a guest, regardless of scope_claim
//      (identity bootstrap, not a protected resource).
//   7. Admin/api_key bearer auth is completely unaffected by the gate.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/v1`;

async function req(method, urlPath, { token, body, accept } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (accept) headers['Accept'] = accept;
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    redirect: 'manual',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, location: res.headers.get('location') };
}

console.log(`[guest-enforce-route-test] scratch DB: ${DB_PATH}`);
console.log(`[guest-enforce-route-test] server: ${base}`);

const SCOPE_CLAIM = {
  allowed_thread_prefixes: ['cockpit:companion-'],
  allowed_threads: [],
  allowed_projects: ['goal-12'],
  allowed_routes: [],
  deny_all_else: true,
};

try {
  createGuestIdentity('enforce-guest', 'correct-horse-battery', SCOPE_CLAIM);
  const login = await req('POST', '/guest/login', { body: { username: 'enforce-guest', password: 'correct-horse-battery' } });
  assert.equal(login.status, 200, `login should succeed, got ${login.status}: ${JSON.stringify(login.json)}`);
  const guestToken = login.json.session_token;

  // 1. Thread outside scope -> 403 forbidden.
  {
    const res = await req('GET', '/threads/cockpit:someone-elses-thread/markdown', { token: guestToken });
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json?.error?.code, 'forbidden', 'error code must be forbidden');
  }
  console.log('  ✓ guest denied on a thread outside her scope (403 forbidden)');

  // 2. Thread matching allowed_thread_prefixes -> passes the gate (reaches
  // the handler, not short-circuited at 403). Note: the handler itself then
  // throws trying to read req.apiKey!.id, logging a stack trace below — this
  // is the PRE-EXISTING gap ENFORCE-PLAN.md documents ("every existing
  // handler assumes req.apiKey! is present... a crash, not a clean deny"),
  // not a defect in this gate. Patching the ~60 ownership-checking handlers
  // to branch on req.guestPrincipal is explicitly out of scope for #1360
  // (the gate itself) — this assertion only proves the gate let the request
  // through.
  {
    const res = await req('GET', '/threads/cockpit:companion-chat-1/markdown', { token: guestToken });
    assert.notEqual(res.status, 403, `gate should not block a matching thread prefix, got 403: ${JSON.stringify(res.json)}`);
  }
  console.log('  ✓ guest passes the gate on a thread matching allowed_thread_prefixes (handler-side req.apiKey! crash is the pre-existing, documented, out-of-scope gap)');

  // 3. Goal route outside allowed_projects -> denied.
  {
    const res = await req('GET', '/goals/99', { token: guestToken });
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.json)}`);
  }
  console.log('  ✓ guest denied on a goal outside allowed_projects');

  // 4. Goal route matching allowed_projects ("goal-12") -> passes the gate.
  {
    const res = await req('GET', '/goals/12', { token: guestToken });
    assert.notEqual(res.status, 403, `gate should not block goal-12, got 403: ${JSON.stringify(res.json)}`);
  }
  console.log('  ✓ guest passes the gate on goal-12 (matches allowed_projects)');

  // 5. Unmatched route + Accept: text/html -> 302 redirect to /companion, not JSON 403.
  {
    const res = await req('GET', '/throttle', { token: guestToken, accept: 'text/html,application/xhtml+xml' });
    assert.equal(res.status, 302, `expected 302, got ${res.status}`);
    assert.equal(res.location, '/companion', `expected redirect to /companion, got ${res.location}`);
  }
  console.log('  ✓ guest page request (Accept: html) denied with a 302 to /companion, not a JSON 403');

  // 5b. Same unmatched route, ambiguous Accept -> stays JSON 403 (the common fetch() case).
  {
    const res = await req('GET', '/throttle', { token: guestToken });
    assert.equal(res.status, 403, `expected 403 for a plain API-shaped request, got ${res.status}`);
  }
  console.log('  ✓ guest API request (no explicit html Accept) stays a JSON 403');

  // 6. /session/whoami always passes for a guest regardless of scope_claim
  // (allowed_routes is empty in SCOPE_CLAIM above).
  {
    const res = await req('GET', '/session/whoami', { token: guestToken });
    assert.equal(res.status, 200, `whoami must always resolve for a guest, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.type, 'guest');
  }
  console.log('  ✓ /session/whoami always passes for a guest (identity bootstrap, not gated)');

  // 7. Admin/api_key bearer auth is completely unaffected.
  {
    const adminKey = mintApiKey('guest-enforce-route-test-admin', 'admin').plaintext;
    const res = await req('GET', '/threads/cockpit:someone-elses-thread/markdown', { token: adminKey });
    assert.notEqual(res.status, 403, `admin caller must never be blocked by the guest gate, got 403: ${JSON.stringify(res.json)}`);
    const goalRes = await req('GET', '/goals/99', { token: adminKey });
    assert.notEqual(goalRes.status, 403, `admin caller must never be blocked by the guest gate, got 403: ${JSON.stringify(goalRes.json)}`);
  }
  console.log('  ✓ admin/api_key bearer auth completely unaffected by the guest gate');

  console.log('\n[guest-enforce-route-test] ALL 7 tests passed ✅');
} finally {
  server.close();
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
}
