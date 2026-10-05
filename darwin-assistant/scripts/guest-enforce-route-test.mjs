#!/usr/bin/env node
// GUEST SCOPE ENFORCEMENT ROUTE TESTS — exercises the REAL Express router
// (hopper node #1360: guestScopeGate, mounted right after bearerAuth; node
// #1361: per-connection SSE scoping + thread write 403; node #1362:
// deny/allow acceptance suite + guest support in GET /threads/:external_id
// and POST /threads/:external_id/messages; #271: markdown in-scope ALLOW +
// the other ownership handlers guarded against the in-scope-500 gap) end to
// end over real HTTP on a throwaway port, against a scratch DB. No live
// data, no model calls, no touch of the live jarvis.db.
//
// This file only boots darwin-assistant's API router — it cannot exercise
// jarvis-command-center's SSR page gate (a separate repo/process). That
// proof — GET /flight-deck as a guest -> 302, plus the proxy forwarding her
// own token upstream instead of the admin key — lives in
// jarvis-command-center/scripts/guest-page-gate-test.ts, which boots this
// same darwin-assistant router as its real backend.
//
//   npm run build
//   npm run guest-enforce-route:test
//
// Proves:
//   1. A guest hitting a thread outside her scope -> 403 JSON {error:{code:'forbidden'}}.
//   2. ALLOW: GET /threads/:external_id/markdown on her own thread -> a real
//      200 with her markdown, not just "not 403" (#271: this used to crash
//      on req.apiKey!.id for an in-scope guest — the in-scope-500 gap).
//   2b. ALLOW: GET /threads/:external_id on her own thread -> 200 with the
//      thread's turns (node #1362 guest branch).
//   2c. ALLOW: POST /threads/:external_id/messages on her own thread -> 202,
//      a real turn gets queued (node #1362 guest branch).
//   3. A guest hitting a goal route outside allowed_projects -> denied.
//   4. A goal route matching allowed_projects -> passes (the shared
//      wish-catalog project page, goal-12).
//   5. A guest hitting any route with Accept: text/html -> 302 to /companion
//      instead of a JSON 403.
//   5c. DENY: a privileged/admin API (POST /work-switch) -> 403, never
//      reaches the stop-all switch.
//   5d. DENY: a non-shared page-DATA route (GET /workstreams, the Flight
//      Deck data feed) -> 403. This is an API-level denial, not the SSR
//      page-route proof — see jarvis-command-center's
//      guest-page-gate-test.ts for GET /flight-deck itself.
//   6. GET /session/whoami always passes for a guest, regardless of scope_claim
//      (identity bootstrap, not a protected resource).
//   7. Admin/api_key bearer auth is completely unaffected by the gate,
//      including a real 200 happy-path call.
//   8. GET /events (global SSE): a guest connection receives an event for
//      her own thread but not one for a foreign thread (node #1361).
//   9. GET /threads/:external_id/events (legacy per-thread SSE): a guest
//      connects to her own thread without crashing and receives its events.
//  10. POST /threads/:external_id/messages to a thread outside her scope
//      -> 403, never reaching the handler.

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
const { getOrCreateConversation } = await import(path.join(distDir, 'conversation-db.js'));
const { sseBus } = await import(path.join(distDir, 'sse-bus.js'));

// Opens an SSE connection, collects raw frames into `chunks` as they arrive,
// and returns a closer. Used by tests 8/9 below to observe exactly what a
// guest connection is forwarded, without a full EventSource client.
async function openSSE(urlPath, token) {
  const res = await fetch(`${base}${urlPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const chunks = [];
  const reader = res.body.getReader();
  let reading = true;
  (async () => {
    while (reading) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value).toString('utf8'));
    }
  })();
  return {
    status: res.status,
    buffer: () => chunks.join(''),
    close: () => {
      reading = false;
      reader.cancel().catch(() => {});
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  // 2. Thread matching allowed_thread_prefixes -> the gate lets it through
  // AND the handler itself actually serves it: a real 200 with real markdown,
  // not just "not 403". This used to crash (req.apiKey!.id on undefined for
  // a guest) — the #271 fix branches GET /threads/:external_id/markdown on
  // req.guestPrincipal the same way GET /threads/:external_id and
  // POST .../messages already did (node #1362). getOrCreateConversation is
  // idempotent — tests 2b/8/9 below reuse this same row.
  {
    getOrCreateConversation('cockpit:companion-chat-1');
    const res = await req('GET', '/threads/cockpit:companion-chat-1/markdown', { token: guestToken });
    assert.equal(res.status, 200, `expected 200 reading her own thread's markdown, got ${res.status}: ${JSON.stringify(res.json)}`);
  }
  console.log('  ✓ guest reads her own thread\'s markdown via GET /threads/:external_id/markdown -> 200 (in-scope ALLOW, not just "not 403")');

  // 2b. ALLOW: GET /threads/:external_id on her own thread -> a real 200,
  // not just "not 403" (node #1362 guest branch in the handler itself).
  // getOrCreateConversation is idempotent — tests 8/9 below reuse this same
  // row rather than creating a second one.
  {
    getOrCreateConversation('cockpit:companion-chat-1');
    const res = await req('GET', '/threads/cockpit:companion-chat-1', { token: guestToken });
    assert.equal(res.status, 200, `expected 200 reading her own thread, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json?.thread_id, 'cockpit:companion-chat-1');
    assert.ok(Array.isArray(res.json?.turns), 'response includes the turns array');
  }
  console.log('  ✓ guest reads her own thread via GET /threads/:external_id -> 200');

  // 2c. ALLOW: POST /threads/:external_id/messages on her own thread -> 202,
  // a real turn gets queued (node #1362 guest branch in the handler itself).
  {
    const res = await req('POST', '/threads/cockpit:companion-chat-1/messages', { token: guestToken, body: { text: 'hi from the companion' } });
    assert.equal(res.status, 202, `expected 202 posting to her own thread, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json?.status, 'processing');
    assert.ok(typeof res.json?.message_id === 'string', 'response includes a message_id');
  }
  console.log('  ✓ guest posts to her own thread via POST /threads/:external_id/messages -> 202');

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

  // 5c. DENY: a privileged/admin API (POST /work-switch, the stop-all switch)
  // -> 403, never reaches the handler.
  {
    const res = await req('POST', '/work-switch', { token: guestToken, body: { operation: 'stop_all' } });
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json?.error?.code, 'forbidden', 'error code must be forbidden');
  }
  console.log('  ✓ guest denied on a privileged admin API (POST /work-switch)');

  // 5d. DENY: a non-shared page route (GET /workstreams, the Flight Deck
  // data feed) -> 403.
  {
    const res = await req('GET', '/workstreams', { token: guestToken });
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.json)}`);
  }
  console.log('  ✓ guest denied on a non-shared page route (GET /workstreams)');

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

    // Happy-path: a real 200, not just "not 403" — proves the gate's
    // early-return for non-guest callers (req.guestPrincipal unset) doesn't
    // somehow regress ordinary admin traffic.
    const whoami = await req('GET', '/session/whoami', { token: adminKey });
    assert.equal(whoami.status, 200, `admin whoami must return 200, got ${whoami.status}: ${JSON.stringify(whoami.json)}`);
    assert.equal(whoami.json?.type, 'api_key');
  }
  console.log('  ✓ admin/api_key bearer auth completely unaffected by the guest gate (incl. a real 200 happy path)');

  // 8. GET /events (global SSE, node #1361): a guest connection receives an
  // event tied to her own thread but not one tied to a foreign thread.
  {
    const herConv = getOrCreateConversation('cockpit:companion-chat-1');
    const foreignConv = getOrCreateConversation('cockpit:someone-elses-thread');

    const stream = await openSSE('/events', guestToken);
    assert.equal(stream.status, 200, 'guest must be let onto the global stream (self-filtered downstream)');
    await sleep(150); // let the stream_types frame + listener registration land

    sseBus.emit('sse', { type: 'conversation_updated', conversationId: herConv.id, status: 'active', updatedAt: new Date().toISOString(), turnCount: 1 });
    sseBus.emit('sse', { type: 'conversation_updated', conversationId: foreignConv.id, status: 'active', updatedAt: new Date().toISOString(), turnCount: 1 });
    // Global, no-conversationId event (what the spec calls out by name) — must never reach a guest.
    sseBus.emit('sse', { type: 'notification', action: 'created', notification: { id: 1, severity: 'info', title: 'x', body: null, source: null, link: null, created_at: new Date().toISOString(), read_at: null } });

    await sleep(150);
    stream.close();
    const buf = stream.buffer();
    assert.ok(buf.includes('cockpit:companion-chat-1'), 'guest must receive the event for her own thread');
    assert.ok(!buf.includes('cockpit:someone-elses-thread'), 'guest must NOT receive the event for a foreign thread');
    assert.ok(!buf.includes('"type":"notification"') && !buf.includes('event: notification'), 'guest must NOT receive global/no-thread events like notification');
  }
  console.log('  ✓ GET /events: guest sees her own thread\'s events, not a foreign thread\'s or global events');

  // 9. GET /threads/:external_id/events (legacy per-thread SSE): a guest
  // connects to her own thread without the pre-existing req.apiKey! crash,
  // and receives that thread's events.
  {
    const herConv = getOrCreateConversation('cockpit:companion-chat-1');
    const stream = await openSSE('/threads/cockpit:companion-chat-1/events', guestToken);
    assert.equal(stream.status, 200, `guest must connect to her own thread's legacy SSE stream without crashing, got ${stream.status}`);
    await sleep(150);
    sseBus.emit('sse', { type: 'conversation_updated', conversationId: herConv.id, status: 'active', updatedAt: new Date().toISOString(), turnCount: 2 });
    await sleep(150);
    stream.close();
    assert.ok(stream.buffer().includes('conversation_updated'), 'guest must receive her own thread\'s event on the legacy per-thread stream');
  }
  console.log('  ✓ GET /threads/:external_id/events: guest connects to her own thread and receives its events, no crash');

  // 10. POST /threads/:external_id/messages to a thread outside her scope -> 403.
  {
    const res = await req('POST', '/threads/cockpit:someone-elses-thread/messages', { token: guestToken, body: { content: 'hi' } });
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json?.error?.code, 'forbidden', 'error code must be forbidden');
  }
  console.log('  ✓ POST /threads/:external_id/messages to a foreign thread -> 403, never reaches the handler');

  console.log('\n[guest-enforce-route-test] ALL 15 tests passed ✅');
} finally {
  server.close();
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
}
