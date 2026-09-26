#!/usr/bin/env node
// RELAY CHECK — proves src/relay.ts pollRelay() mirrors a fixture relay
// inbox into jarvis.db idempotently, with ZERO real network/model calls
// (global fetch is stubbed to a fixture in-process MCP server) and ZERO
// duplicate rows / double-fired listeners on a re-run over the same inbox.
//
//   npm run build && JARVIS_DB_PATH=/tmp/relay-check.db node scripts/relay-check.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -- scratch DB guard (same pattern as scripts/notepad-check.mjs) --
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
console.log(`[relay-check] DB: ${DB_PATH}`);

// -- fixture inbox: 2 threads, 3 inbound messages from mike --
const THREAD_T1 = {
  id: 't1',
  title: 'Build an endpoint for lead counts',
  opened_by: 'mike',
  status: 'waiting_jarvis',
  exchange_count: 2,
  read_by: { mike: '2026-09-25T10:00:00Z' },
  created_at: '2026-09-25T10:00:00Z',
  updated_at: '2026-09-25T10:05:00Z',
};
const THREAD_T2 = {
  id: 't2',
  title: 'What does field X mean',
  opened_by: 'mike',
  status: 'waiting_jarvis',
  exchange_count: 1,
  read_by: { mike: '2026-09-25T11:00:00Z' },
  created_at: '2026-09-25T11:00:00Z',
  updated_at: '2026-09-25T11:00:00Z',
};

const MESSAGES_T1 = [
  {
    id: 'm1', thread_id: 't1', from: 'mike', kind: 'request', subject: 'lead counts endpoint',
    body: '**What**\nAn endpoint returning lead counts by brand.\n**Why**\nHub 2.0 dashboard.\n**Acceptance**\nReturns JSON.\n**System**\nDarwinIntakeSystem',
    refs: [], created_at: '2026-09-25T10:00:00Z',
  },
  {
    id: 'm2', thread_id: 't1', from: 'mike', kind: 'ack', subject: null,
    body: 'thanks, watching for the branch', refs: [], created_at: '2026-09-25T10:05:00Z',
  },
];
const MESSAGES_T2 = [
  {
    id: 'm3', thread_id: 't2', from: 'mike', kind: 'question', subject: null,
    body: 'does field external_id mean linkId on your side?', refs: [], created_at: '2026-09-25T11:00:00Z',
  },
];

const THREADS_BY_ID = {
  t1: { thread: THREAD_T1, messages: MESSAGES_T1 },
  t2: { thread: THREAD_T2, messages: MESSAGES_T2 },
};
const INBOX_FIXTURE = { messages: [...MESSAGES_T1, ...MESSAGES_T2] };

function jsonRpcResult(id, resultObj) {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(resultObj) }] } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

let fetchCalls = 0;
globalThis.fetch = async (_url, init) => {
  fetchCalls++;
  const body = JSON.parse(init.body);
  if (body.method === 'initialize') {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '0' } } }),
      { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-fixture-1' } },
    );
  }
  if (body.method === 'notifications/initialized') {
    return new Response(null, { status: 202 });
  }
  if (body.method === 'tools/call') {
    const { name, arguments: args } = body.params;
    if (name === 'relay-tool' && args.operation === 'inbox') return jsonRpcResult(body.id, INBOX_FIXTURE);
    if (name === 'relay-tool' && args.operation === 'read_thread') {
      const found = THREADS_BY_ID[args.id];
      if (!found) throw new Error(`fixture has no thread ${args.id}`);
      return jsonRpcResult(body.id, found);
    }
  }
  throw new Error(`unexpected fixture fetch: ${JSON.stringify(body)}`);
};

const distDir = path.join(__dirname, '..', 'dist');
const { setSetting, sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));
const { pollRelay, registerRelayInboundListener } = await import(path.join(distDir, 'relay.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

// relay_enabled defaults to '0' (off) — flip it on for this check.
setSetting('relay_enabled', '1');

let listenerFireCount = 0;
registerRelayInboundListener(() => {
  listenerFireCount++;
});

const first = await pollRelay();
check('first poll ok', first.ok === true);
check('first poll saw 2 threads', first.threadsSeen === 2);
check('first poll mirrored 3 messages', first.messagesUpserted === 3);
check('first poll surfaced 3 new (non-jarvis) messages', first.newMessages.length === 3);
check('inbound listener fired 3 times on first poll', listenerFireCount === 3);

const threadRowCount = sqliteDb.prepare('SELECT COUNT(*) AS n FROM relay_threads').get().n;
const messageRowCount = sqliteDb.prepare('SELECT COUNT(*) AS n FROM relay_messages').get().n;
check('relay_threads has exactly 2 rows', threadRowCount === 2);
check('relay_messages has exactly 3 rows', messageRowCount === 3);

const m1 = sqliteDb.prepare("SELECT * FROM relay_messages WHERE message_id = 'm1'").get();
check('m1 content_hash populated', typeof m1.content_hash === 'string' && m1.content_hash.length === 64);
check('m1 is_draft = 0', m1.is_draft === 0);
check('m1 cue_fired_at is NULL (cue firing is a later node)', m1.cue_fired_at === null);
check('m1 mirrored_at populated', typeof m1.mirrored_at === 'string' && m1.mirrored_at.length > 0);

const t1Row = sqliteDb.prepare("SELECT * FROM relay_threads WHERE id = 't1'").get();
check('t1 title mirrored', t1Row.title === THREAD_T1.title);
check('t1 status mirrored', t1Row.status === 'waiting_jarvis');
check('t1 read_by mirrored as JSON', JSON.parse(t1Row.read_by).mike === '2026-09-25T10:00:00Z');

// -- idempotence: re-run over the EXACT SAME fixture inbox --
const fetchCallsBeforeSecond = fetchCalls;
const second = await pollRelay();
check('second poll ok', second.ok === true);
check('second poll mirrors ZERO new messages', second.messagesUpserted === 0);
check('second poll surfaces ZERO new messages', second.newMessages.length === 0);
check('listener did NOT fire again on second poll', listenerFireCount === 3);
check('second poll still hit the fixture transport (not a cached no-op)', fetchCalls > fetchCallsBeforeSecond);

const messageRowCountAfterSecond = sqliteDb.prepare('SELECT COUNT(*) AS n FROM relay_messages').get().n;
check('relay_messages STILL has exactly 3 rows after re-run', messageRowCountAfterSecond === 3);

// -- disabled gate: relay_enabled=0 must make pollRelay a true no-op --
setSetting('relay_enabled', '0');
const fetchCallsBeforeDisabled = fetchCalls;
const disabled = await pollRelay();
check('disabled poll reports skipped', disabled.skipped === 'disabled');
check('disabled poll makes no fetch calls', fetchCalls === fetchCallsBeforeDisabled);

if (failed) {
  console.error('\nRELAY CHECK: FAIL');
  process.exit(1);
} else {
  console.log('\nRELAY CHECK: PASS');
}
