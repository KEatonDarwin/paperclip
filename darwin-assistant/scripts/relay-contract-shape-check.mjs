#!/usr/bin/env node
// RELAY CONTRACT-SHAPE CHECK (node #935 FIX 4) — a thin wire-shape test that
// fails the build the moment relay.ts/relay-rest.ts drift from
// docs/relay/CONTRACT.md §3/§7 again, instead of waiting for the first live
// poll to 503/error against the real relay-tool.
//
// For every nativeCall this branch emits against relay-tool (inbox,
// read_thread, reply) this asserts the arguments object:
//   - HAS `op` set to the expected op name (CONTRACT.md §3's op list — NOT
//     the old, wrong `operation` key)
//   - has NO identity key (`as`, `from`, `author`, `principal`) — CONTRACT.md
//     §35: the principal comes from the ROUTE, never from an argument.
//
// HERMETIC: global fetch is stubbed to an in-process fixture MCP server, same
// pattern as scripts/relay-check.mjs. No real network call, no model call.
//
//   npm run build && JARVIS_DB_PATH=/tmp/relay-contract-shape-check.db node scripts/relay-contract-shape-check.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -- scratch DB guard (same pattern as scripts/relay-check.mjs) --
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
console.log(`[relay-contract-shape-check] DB: ${DB_PATH}`);

// -- fixture: one thread, one inbound message, ready to poll and reply to --
const THREAD_ID = '01J8X3Z9K2N4Q6R8S0T1U3V5W7';
const THREAD = {
  id: THREAD_ID,
  title: 'contract-shape fixture thread',
  opened_by: 'mike',
  status: 'waiting_jarvis',
  exchange_count: 1,
  read_by: {},
  created_at: '2026-09-25T10:00:00Z',
  updated_at: '2026-09-25T10:00:00Z',
};
const MESSAGES = [
  {
    id: 'shape-m1', thread_id: THREAD_ID, from: 'mike', kind: 'question', subject: null,
    body: 'does field external_id mean linkId on your side?', refs: [], created_at: '2026-09-25T10:00:00Z',
  },
];
const INBOX_FIXTURE = { messages: MESSAGES };
const READ_THREAD_FIXTURE = { thread: THREAD, messages: MESSAGES };
const REPLY_FIXTURE = {
  thread: { ...THREAD, exchange_count: 2, updated_at: '2026-09-25T10:01:00Z' },
  message: {
    id: 'shape-m2', thread_id: THREAD_ID, from: 'kevin', kind: 'answer', subject: null,
    body: 'yes, external_id is linkId', refs: [], created_at: '2026-09-25T10:01:00Z',
  },
};

function jsonRpcResult(id, resultObj) {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(resultObj) }] } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// Captures the exact `arguments` object sent for every relay-tool tools/call,
// keyed by the op name the CALLER claims it's making — the whole point of
// this check is to catch a wrong/missing `op`, so lookups below fall back to
// the fixture responses by call ORDER, not by re-deriving the op from args.
const captured = [];
let callIndex = 0;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  if (body.method === 'initialize') {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '0' } } }),
      { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-fixture-shape' } },
    );
  }
  if (body.method === 'notifications/initialized') {
    return new Response(null, { status: 202 });
  }
  if (body.method === 'tools/call' && body.params.name === 'relay-tool') {
    const args = body.params.arguments ?? {};
    captured.push(args);
    callIndex++;
    // Order this fixture drives calls in: inbox, read_thread, reply.
    if (callIndex === 1) return jsonRpcResult(body.id, INBOX_FIXTURE);
    if (callIndex === 2) return jsonRpcResult(body.id, READ_THREAD_FIXTURE);
    if (callIndex === 3) return jsonRpcResult(body.id, REPLY_FIXTURE);
  }
  throw new Error(`unexpected fixture fetch: ${JSON.stringify(body)}`);
};

const distDir = path.join(__dirname, '..', 'dist');
const { setSetting } = await import(path.join(distDir, 'conversation-db.js'));
const { pollRelay } = await import(path.join(distDir, 'relay.js'));
const { postKevinMessage } = await import(path.join(distDir, 'relay-rest.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

const IDENTITY_KEYS = ['as', 'from', 'author', 'principal'];

function checkOpShape(label, args, expectedOp) {
  check(`${label}: has op='${expectedOp}' (CONTRACT.md §3, not 'operation')`, args?.op === expectedOp);
  check(`${label}: has NO 'operation' key`, !Object.prototype.hasOwnProperty.call(args ?? {}, 'operation'));
  for (const key of IDENTITY_KEYS) {
    check(`${label}: has NO identity key '${key}' (CONTRACT.md §35)`, !Object.prototype.hasOwnProperty.call(args ?? {}, key));
  }
}

// relay_enabled defaults to '0' (off) — flip it on so pollRelay/postKevinMessage
// actually reach the fixture transport instead of short-circuiting.
setSetting('relay_enabled', '1');

const pollResult = await pollRelay();
assert.equal(pollResult.ok, true, `pollRelay must succeed against the fixture: ${pollResult.error ?? ''}`);
assert.equal(captured.length, 2, `expected exactly 2 relay-tool calls from one poll (inbox + read_thread for 1 thread), got ${captured.length}`);

checkOpShape('inbox call', captured[0], 'inbox');
check('inbox call: id is inbox\'s own arg, not present (inbox takes no args)', captured[0].id === undefined);

checkOpShape('read_thread call', captured[1], 'read_thread');
check('read_thread call: carries id=<thread ulid>', captured[1].id === THREAD_ID);

const replyResult = await postKevinMessage(THREAD_ID, { kind: 'answer', body: 'yes, external_id is linkId' });
assert.equal(replyResult.ok, true, `postKevinMessage must succeed against the fixture: ${JSON.stringify(replyResult)}`);
assert.equal(captured.length, 3, `expected exactly 1 additional relay-tool call from postKevinMessage, got ${captured.length - 2} more`);

checkOpShape('reply call', captured[2], 'reply');
check('reply call: carries thread_id', captured[2].thread_id === THREAD_ID);
check('reply call: carries kind', captured[2].kind === 'answer');
check('reply call: carries body', captured[2].body === 'yes, external_id is linkId');

if (failed) {
  console.error('\nRELAY CONTRACT-SHAPE CHECK: FAIL');
  process.exit(1);
} else {
  console.log(`\n[relay-contract-shape-check] ${captured.length} relay-tool calls inspected, all clean`);
  console.log('RELAY CONTRACT-SHAPE CHECK: PASS');
}
