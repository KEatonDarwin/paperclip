#!/usr/bin/env node
// SSE EVENT-TYPE CONTRACT CHECK — exercises the REAL Express router's global
// stream over real HTTP on a throwaway port against a scratch DB. No model
// calls, no network, no touch of the live jarvis.db.
//
//   npm run build
//   npm run sse-event-types:check
//
// Proves the contract that replaced the three hand-maintained copies of the
// event list (GLOBAL_STREAM_EVENT_TYPES in src/sse-bus.ts):
//   1. GET /events/types answers exactly GLOBAL_STREAM_EVENT_TYPES.
//   2. The first frame on GET /events is `stream_types` carrying that same
//      list — it must land BEFORE any real event, since clients subscribe from
//      it.
//   3. `notification` is forwarded (the live bug: it was in the server's
//      forward set but missing from the cockpit SharedWorker's hardcoded copy,
//      so bell toasts never fired live on that transport).
//   4. `thread_group` is forwarded (the mirror bug: the cockpit subscribed, the
//      server never forwarded it).
//   5. A LOCAL_ONLY type (`tool_call`) is NOT forwarded on the global stream.
//   6. The kiosk credential is announced — and delivered — only its own
//      narrower set, so a kiosk client subscribing from the announcement can't
//      wait forever on an event it will never be sent.
//   7. The two classification lists are disjoint and duplicate-free.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
process.env.CLAUDE_USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-types-usage-'));

const distDir = path.join(__dirname, '..', 'dist');
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const { setSetting } = await import(path.join(distDir, 'conversation-db.js'));
const { sseBus, GLOBAL_STREAM_EVENT_TYPES, LOCAL_ONLY_SSE_EVENT_TYPES } = await import(
  path.join(distDir, 'sse-bus.js')
);
const { BIG_BOARD_KIOSK_EVENT_TYPES, BIG_BOARD_KIOSK_TOKEN_SETTING } = await import(
  path.join(distDir, 'big-board.js')
);

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}/api/v1`;

const adminKey = mintApiKey('sse-types-admin', 'admin').plaintext;
const KIOSK_TOKEN = 'kiosk-token-for-the-check';
setSetting(BIG_BOARD_KIOSK_TOKEN_SETTING, KIOSK_TOKEN);

/** Open an SSE stream and collect `event:`/`data:` frames as they arrive. */
async function openStream(urlPath, { token } = {}) {
  const headers = { accept: 'text/event-stream' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const controller = new AbortController();
  const res = await fetch(`${base}${urlPath}`, { headers, signal: controller.signal });
  assert.equal(res.status, 200, `stream ${urlPath} -> ${res.status}`);
  const frames = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = chunk.match(/^event: (.+)\ndata: (.*)$/s);
          if (m) frames.push({ type: m[1], data: m[2] });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    frames,
    close: () => controller.abort(),
    /** Wait for the stream to settle so emitted events have been written. */
    settle: () => new Promise((r) => setTimeout(r, 150)),
  };
}

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const check = async (msg, fn) => {
  try {
    await fn();
    ok(msg);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${msg}\n      ${err.message}`);
  }
};

console.log(`[sse-event-types-check] scratch DB: ${DB_PATH}`);
console.log(`[sse-event-types-check] server: ${base}`);

const EXPECTED = [...GLOBAL_STREAM_EVENT_TYPES];

try {
  await check('the two classification lists are disjoint and duplicate-free', () => {
    const all = [...GLOBAL_STREAM_EVENT_TYPES, ...LOCAL_ONLY_SSE_EVENT_TYPES];
    assert.equal(new Set(all).size, all.length, `duplicate entry across the lists: ${all.join(',')}`);
  });

  await check('GET /events/types answers exactly GLOBAL_STREAM_EVENT_TYPES', async () => {
    const res = await fetch(`${base}/events/types`, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.types, EXPECTED);
  });

  await check('GET /events/types requires auth', async () => {
    const res = await fetch(`${base}/events/types`);
    assert.equal(res.status, 401);
  });

  await check('the FIRST frame on GET /events is stream_types with that same list', async () => {
    const s = await openStream('/events', { token: adminKey });
    await s.settle();
    assert.ok(s.frames.length >= 1, 'no frames arrived');
    assert.equal(s.frames[0].type, 'stream_types', `first frame was ${s.frames[0].type}`);
    assert.deepEqual(JSON.parse(s.frames[0].data).types, EXPECTED);
    s.close();
  });

  await check('notification IS forwarded (the bell-toast bug)', async () => {
    const s = await openStream('/events', { token: adminKey });
    await s.settle();
    sseBus.emit('sse', {
      type: 'notification',
      action: 'created',
      notification: { id: 'n1', title: 'check' },
    });
    await s.settle();
    const got = s.frames.find((f) => f.type === 'notification');
    assert.ok(got, `only got: ${s.frames.map((f) => f.type).join(',') || '(nothing)'}`);
    assert.equal(JSON.parse(got.data).notification.id, 'n1');
    s.close();
  });

  await check('thread_group IS forwarded (the mirror bug)', async () => {
    const s = await openStream('/events', { token: adminKey });
    await s.settle();
    sseBus.emit('sse', { type: 'thread_group', action: 'updated', groupId: 7 });
    await s.settle();
    assert.ok(s.frames.some((f) => f.type === 'thread_group'), 'thread_group never arrived');
    s.close();
  });

  await check('a LOCAL_ONLY type (tool_call) is NOT forwarded', async () => {
    const s = await openStream('/events', { token: adminKey });
    await s.settle();
    sseBus.emit('sse', { type: 'tool_call', conversationId: 1, toolName: 'x' });
    await s.settle();
    assert.ok(!s.frames.some((f) => f.type === 'tool_call'), 'tool_call leaked onto the global stream');
    s.close();
  });

  await check('every LOCAL_ONLY type is absent from the announcement', () => {
    for (const t of LOCAL_ONLY_SSE_EVENT_TYPES) {
      assert.ok(!EXPECTED.includes(t), `${t} is in both lists`);
    }
  });

  await check('kiosk is announced ONLY its own narrower set', async () => {
    const s = await openStream(`/events?kiosk=${encodeURIComponent(KIOSK_TOKEN)}`);
    await s.settle();
    assert.equal(s.frames[0].type, 'stream_types');
    const announced = JSON.parse(s.frames[0].data).types;
    assert.ok(announced.length > 0 && announced.length < EXPECTED.length, `kiosk got ${announced.length} of ${EXPECTED.length}`);
    for (const t of announced) {
      assert.ok(BIG_BOARD_KIOSK_EVENT_TYPES.has(t), `${t} announced to kiosk but not in its allowance`);
      assert.ok(EXPECTED.includes(t), `${t} announced to kiosk but not forwarded at all`);
    }
    for (const t of BIG_BOARD_KIOSK_EVENT_TYPES) {
      assert.ok(announced.includes(t), `kiosk allows ${t} but it was not announced (not forwarded at all?)`);
    }
    s.close();
  });

  await check('kiosk is DELIVERED what it was announced, and nothing else', async () => {
    const s = await openStream(`/events?kiosk=${encodeURIComponent(KIOSK_TOKEN)}`);
    await s.settle();
    sseBus.emit('sse', { type: 'notification', action: 'created', notification: { id: 'k1' } });
    sseBus.emit('sse', {
      type: 'turn',
      conversationId: 1,
      turn: { id: 1, role: 'assistant', content: 'secret' },
    });
    await s.settle();
    assert.ok(s.frames.some((f) => f.type === 'notification'), 'kiosk did not get an announced type');
    assert.ok(!s.frames.some((f) => f.type === 'turn'), 'kiosk received transcript traffic');
    s.close();
  });

  await check('GET /events/types honours the kiosk token too', async () => {
    const res = await fetch(`${base}/events/types?kiosk=${encodeURIComponent(KIOSK_TOKEN)}`);
    assert.equal(res.status, 200, `kiosk /events/types -> ${res.status}`);
    const body = await res.json();
    assert.ok(body.types.length < EXPECTED.length, 'kiosk got the full list from /events/types');
    assert.deepEqual(body.types, EXPECTED.filter((t) => BIG_BOARD_KIOSK_EVENT_TYPES.has(t)));
  });

  await check('a bad kiosk token still 401s on /events/types (fails closed)', async () => {
    const res = await fetch(`${base}/events/types?kiosk=wrong`);
    assert.equal(res.status, 401);
  });
} finally {
  server.close();
}

if (failures) {
  console.error(`\n[sse-event-types-check] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[sse-event-types-check] all checks passed');
process.exit(0);
