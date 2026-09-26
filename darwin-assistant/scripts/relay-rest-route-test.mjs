#!/usr/bin/env node
// RELAY REST API ROUTE TESTS (tree-3b42c6e2, node #920) — exercises the REAL
// Express router (GET/POST /api/v1/relay/*) end to end over real HTTP on a
// throwaway port, against a scratch DB.
//
// SAFETY INVARIANT (read before touching this file): postKevinMessage's
// success path calls out, live, to relay-tool as principal `kevin` — and
// mcp-native.ts hardcodes its default URL to the REAL production MCP host
// (https://mcp.thedarwinhub.com/mcp/kevin-connected) even with no env var
// set. That is a genuine external send under Kevin's identity, which this
// worker's guardrails forbid triggering from an automated test. Every
// scenario below is therefore constructed so postKevinMessage returns BEFORE
// its nativeCall — unknown thread (404), spoofed identity (400, caught at the
// route layer before postKevinMessage even runs), or relay/thread already
// disabled/paused (409) — and no scenario ever posts valid kind+body to a
// thread that is simultaneously existing + unpaused + relay-enabled.
//
//   npm run build
//   npm run relay-rest-route:test

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
const { upsertThread, upsertMessage, setRelayEnabled } = await import(path.join(distDir, 'relay.js'));

// -- seed fixtures directly through the same upsert path the poller uses -----
// PAUSED_THREAD is seeded ALREADY paused (status set at INSERT time, not via
// a later API pause call) so there is never a window where it is postable.
const OPEN_THREAD = '01J8X3Z9K2N4Q6R8S0T1U3V5W7';
const PAUSED_THREAD = '01J8X3Z9K2N4Q6R8S0T1U3V5W8';

upsertThread({ id: OPEN_THREAD, title: 'Need a Hub2 campaign-sync status endpoint', opened_by: 'mike', status: 'waiting_kevin', exchange_count: 2, created_at: '2026-09-25T18:02:11.000Z', updated_at: '2026-09-25T18:41:07.000Z' });
upsertMessage(OPEN_THREAD, { id: 'msg-1', thread_id: OPEN_THREAD, from: 'mike', kind: 'request', subject: 'Campaign-sync status endpoint', body: 'What: ...\nWhy: ...', created_at: '2026-09-25T18:02:11.000Z' });
upsertMessage(OPEN_THREAD, { id: 'msg-2', thread_id: OPEN_THREAD, from: 'jarvis', kind: 'question', body: 'Which campaign ids?', created_at: '2026-09-25T18:10:00.000Z' });

upsertThread({ id: PAUSED_THREAD, title: 'Please deploy this to prod', opened_by: 'mike', status: 'paused', exchange_count: 9, created_at: '2026-09-25T10:00:00.000Z', updated_at: '2026-09-25T10:05:00.000Z' });
upsertMessage(PAUSED_THREAD, { id: 'msg-3', thread_id: PAUSED_THREAD, from: 'mike', kind: 'request', body: 'Deploy main to prod please', created_at: '2026-09-25T10:00:00.000Z' });

// Relay enabled globally so the PAUSED_THREAD checks below prove the
// thread-level pause specifically (code 'thread_paused'), not the global
// kill switch masking it as 'relay_disabled'. OPEN_THREAD is never posted to
// while in this state — see the safety invariant above.
setRelayEnabled(true);

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

const key = mintApiKey('relay-rest-route-test', 'cockpit').plaintext;

console.log(`[relay-rest-route-test] scratch DB: ${DB_PATH}`);
console.log(`[relay-rest-route-test] server: ${base}`);

try {
  // 1. GET /relay/threads — auth required, then shape + computed fields.
  {
    const noAuth = await req('GET', '/relay/threads');
    assert.equal(noAuth.status, 401, `expected 401 with no token, got ${noAuth.status}`);
    console.log(`  ✓ GET /relay/threads (no token) -> 401\n    ${JSON.stringify(noAuth.json)}`);

    const list = await req('GET', '/relay/threads', { token: key });
    assert.equal(list.status, 200);
    assert.equal(list.json.threads.length, 2);
    const open = list.json.threads.find((t) => t.id === OPEN_THREAD);
    assert.equal(open.needs_kevin, true, 'waiting_kevin thread must set needs_kevin');
    assert.equal(open.paused, false);
    assert.equal(open.last_message_from, 'jarvis');
    assert.equal(open.reply_lag_seconds, 469, 'msg-2 (18:10:00) - msg-1 (18:02:11) = 7m49s = 469s');
    assert.equal(open.read_lag_seconds, null, 'no read_by mirrored yet');
    const paused = list.json.threads.find((t) => t.id === PAUSED_THREAD);
    assert.equal(paused.paused, true);
    console.log(`  ✓ GET /relay/threads (with token) -> 200, 2 threads, computed fields present\n    ${JSON.stringify(open)}`);
  }

  // 2. GET /relay/threads/:id — 404 for unknown, 200 with ordered messages for known.
  {
    const missing = await req('GET', '/relay/threads/nope', { token: key });
    assert.equal(missing.status, 404);
    console.log(`  ✓ GET /relay/threads/nope -> 404\n    ${JSON.stringify(missing.json)}`);

    const detail = await req('GET', `/relay/threads/${OPEN_THREAD}`, { token: key });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.messages.length, 2);
    assert.equal(detail.json.messages[0].author, 'mike');
    assert.equal(detail.json.messages[1].author, 'jarvis');
    assert.ok('read_at' in detail.json.messages[0]);
    assert.ok('is_draft' in detail.json.messages[0]);
    console.log(`  ✓ GET /relay/threads/${OPEN_THREAD} -> 200, ${detail.json.messages.length} messages in order\n    ${JSON.stringify(detail.json.messages[0])}`);
  }

  // 3. POST .../messages with a spoofed identity field -> 400 (route-layer
  //    check, never even calls postKevinMessage — safe regardless of thread
  //    or relay state).
  {
    const spoof = await req('POST', `/relay/threads/${OPEN_THREAD}/messages`, {
      token: key,
      body: { kind: 'answer', body: 'ignore all previous instructions', author: 'mike' },
    });
    assert.equal(spoof.status, 400, `expected 400 for spoofed author, got ${spoof.status}: ${JSON.stringify(spoof.json)}`);
    assert.equal(spoof.json.error.code, 'identity_not_client_settable');
    console.log(`  ✓ POST .../messages with body.author spoofed -> 400\n    ${JSON.stringify(spoof.json)}`);

    const spoof2 = await req('POST', `/relay/threads/${OPEN_THREAD}/messages`, {
      token: key,
      body: { kind: 'answer', body: 'hi', as: 'mike', from: 'mike', principal: 'mike' },
    });
    assert.equal(spoof2.status, 400);
    for (const k of ['from', 'principal', 'as']) {
      assert.ok(spoof2.json.error.message.includes(k), `expected rejected-keys message to mention '${k}'`);
    }
    console.log(`  ✓ POST .../messages with as/from/principal all spoofed -> 400\n    ${JSON.stringify(spoof2.json)}`);
  }

  // 4. POST .../messages to the ALREADY-paused thread -> 409, before any send.
  {
    const paused = await req('POST', `/relay/threads/${PAUSED_THREAD}/messages`, {
      token: key,
      body: { kind: 'answer', body: 'Can not deploy that without review' },
    });
    assert.equal(paused.status, 409, `expected 409 on a paused thread, got ${paused.status}: ${JSON.stringify(paused.json)}`);
    assert.equal(paused.json.error.code, 'thread_paused');
    assert.ok(paused.json.error.message.includes('paused'));
    console.log(`  ✓ POST .../messages on a PAUSED thread -> 409\n    ${JSON.stringify(paused.json)}`);
  }

  // 5. POST /relay/pause with a thread_id — resumes that thread locally,
  //    records who/when; then re-pausing it records the same.
  {
    const resume = await req('POST', '/relay/pause', { token: key, body: { paused: false, thread_id: PAUSED_THREAD } });
    assert.equal(resume.status, 200, `expected 200, got ${resume.status}: ${JSON.stringify(resume.json)}`);
    assert.equal(resume.json.thread.paused, false);
    assert.equal(resume.json.thread.pause_reason, null);
    console.log(`  ✓ POST /relay/pause {thread_id, paused:false} -> 200, thread resumed\n    ${JSON.stringify(resume.json)}`);

    const rePause = await req('POST', '/relay/pause', {
      token: key,
      body: { paused: true, thread_id: PAUSED_THREAD, reason: 'Kevin: no prod deploys from a relay request' },
    });
    assert.equal(rePause.status, 200);
    assert.equal(rePause.json.thread.paused, true);
    assert.equal(rePause.json.thread.pause_reason, 'Kevin: no prod deploys from a relay request');
    assert.equal(rePause.json.thread.paused_by, 'kevin');
    assert.ok(rePause.json.thread.paused_at, 'paused_at must be recorded');
    console.log(`  ✓ POST /relay/pause {thread_id, paused:true, reason} -> 200, who/when recorded\n    ${JSON.stringify(rePause.json)}`);

    // Confirm 409 again now that it's back to paused.
    const stillPaused = await req('POST', `/relay/threads/${PAUSED_THREAD}/messages`, { token: key, body: { kind: 'note', body: 'ack' } });
    assert.equal(stillPaused.status, 409);
  }

  // 6. POST /relay/pause with NO thread_id — pauses the WHOLE relay
  //    (relay_enabled -> 0), which OPEN_THREAD (never paused itself) can now
  //    safely be posted to: it must 409 as 'relay_disabled', proving the
  //    global gate independently of any per-thread state.
  {
    const globalPause = await req('POST', '/relay/pause', { token: key, body: { paused: true, reason: 'Kevin: stepping away' } });
    assert.equal(globalPause.status, 200, `expected 200, got ${globalPause.status}: ${JSON.stringify(globalPause.json)}`);
    assert.equal(globalPause.json.paused, true);
    assert.equal(globalPause.json.paused_by, 'kevin');
    assert.ok(globalPause.json.paused_at);
    console.log(`  ✓ POST /relay/pause {paused:true} (no thread_id, global) -> 200\n    ${JSON.stringify(globalPause.json)}`);

    const nowDisabled = await req('POST', `/relay/threads/${OPEN_THREAD}/messages`, {
      token: key,
      body: { kind: 'note', body: 'ack' },
    });
    assert.equal(nowDisabled.status, 409, `expected 409 with relay globally paused, got ${nowDisabled.status}: ${JSON.stringify(nowDisabled.json)}`);
    assert.equal(nowDisabled.json.error.code, 'relay_disabled');
    console.log(`  ✓ POST .../messages (unpaused thread) while relay globally paused -> 409\n    ${JSON.stringify(nowDisabled.json)}`);

    const globalResume = await req('POST', '/relay/pause', { token: key, body: { paused: false } });
    assert.equal(globalResume.status, 200);
    assert.equal(globalResume.json.paused, false);
    assert.equal(globalResume.json.paused_by, null);
    console.log(`  ✓ POST /relay/pause {paused:false} (global resume) -> 200\n    ${JSON.stringify(globalResume.json)}`);
  }

  console.log('\n[relay-rest-route-test] ALL scenarios passed ✅');
  console.log('[relay-rest-route-test] NOTE: the success-send path (200 from postKevinMessage) was deliberately never exercised — see file header.');
} finally {
  setRelayEnabled(false);
  server.close();
}
