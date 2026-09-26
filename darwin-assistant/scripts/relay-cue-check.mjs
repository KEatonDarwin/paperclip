#!/usr/bin/env node
// RELAY CUE CHECK — proves src/relay-cue.ts fires exactly one cue per new
// inbound message from mike, is idempotent on replay, and auto-pauses a
// thread on the 9th exchange. ZERO real model calls: agent.processMessage is
// still reached (same seam as tree-cue.ts), but sim-guard.ts refuses to spawn
// a real turn against a non-live JARVIS_DB_PATH — so the cue fires, gets
// refused at the model chokepoint, and the DB-level proof (cue_fired_at /
// cue_skip_reason / thread pause) is unaffected either way.
//
//   npm run build && JARVIS_DB_PATH=/tmp/relay-cue-check.db node scripts/relay-cue-check.mjs

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
console.log(`[relay-cue-check] DB: ${DB_PATH}`);

function jsonRpcResult(id, resultObj) {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(resultObj) }] } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// One thread ('tA'), a growing message list. Each poll appends the next
// fixture message and re-serves the whole thread — upsertMessage's
// ON CONFLICT(message_id) DO NOTHING makes already-seen ids harmless, exactly
// like the real relay-tool re-serving a thread on every read_thread call.
const THREAD_A = {
  id: 'tA',
  title: 'Cap test thread',
  opened_by: 'mike',
  status: 'waiting_jarvis',
  exchange_count: 0,
  read_by: { mike: '2026-09-25T10:00:00Z' },
  created_at: '2026-09-25T10:00:00Z',
  updated_at: '2026-09-25T10:00:00Z',
};
let messagesA = [];

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
    if (name === 'relay-tool' && args.operation === 'inbox') {
      return jsonRpcResult(body.id, { messages: messagesA });
    }
    if (name === 'relay-tool' && args.operation === 'read_thread') {
      if (args.id !== 'tA') throw new Error(`fixture has no thread ${args.id}`);
      return jsonRpcResult(body.id, { thread: THREAD_A, messages: messagesA });
    }
  }
  throw new Error(`unexpected fixture fetch: ${JSON.stringify(body)}`);
};

const distDir = path.join(__dirname, '..', 'dist');
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));
const { setSetting, getSetting } = await import(path.join(distDir, 'conversation-db.js'));
const { pollRelay } = await import(path.join(distDir, 'relay.js'));
// side-effect import: registers relayCueOnInboundMessage on relay's inbound seam
await import(path.join(distDir, 'relay-cue.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

setSetting('relay_enabled', '1');
// keep the hourly/daily caps well above what this run will send so only the
// per-thread exchange cap (default 8) trips.
console.log(`[relay-cue-check] caps: per-thread=${getSetting('relay_cap_exchanges_per_thread')} per-hour=${getSetting('relay_cap_messages_per_hour')} per-day=${getSetting('relay_cap_messages_per_day')}`);

function cueFiredCount() {
  return sqliteDb.prepare(`SELECT COUNT(*) AS n FROM relay_messages WHERE cue_fired_at IS NOT NULL`).get().n;
}
function threadStatus(id) {
  return sqliteDb.prepare(`SELECT status, pause_reason FROM relay_threads WHERE id = ?`).get(id);
}

// -- (a) one inbound -> exactly one cue row ----------------------------------
messagesA = [
  { id: 'a1', thread_id: 'tA', from: 'mike', kind: 'request', subject: null, body: 'message 1', refs: [], created_at: '2026-09-25T10:00:00Z' },
];
const p1 = await pollRelay();
check('(a) poll ok', p1.ok === true);
check('(a) exactly one message mirrored', p1.messagesUpserted === 1);
check('(a) exactly one cue row after first inbound', cueFiredCount() === 1);
const a1Row = sqliteDb.prepare(`SELECT * FROM relay_messages WHERE message_id = 'a1'`).get();
check('(a) a1 cue_fired_at populated', typeof a1Row.cue_fired_at === 'string' && a1Row.cue_fired_at.length > 0);
check('(a) a1 cue_skip_reason is NULL (it fired)', a1Row.cue_skip_reason === null);

// -- (b) the SAME inbound replayed -> still exactly one ----------------------
const fetchCallsBeforeReplay = fetchCalls;
const p2 = await pollRelay();
check('(b) replay poll ok', p2.ok === true);
check('(b) replay mirrors ZERO new messages (message_id already seen)', p2.messagesUpserted === 0);
check('(b) replay still hit the transport (not a cached no-op)', fetchCalls > fetchCallsBeforeReplay);
check('(b) cue row count UNCHANGED after replay', cueFiredCount() === 1);

// -- (c) a 9th exchange on the thread -> thread paused -----------------------
// Messages 2-8 (7 more, unique bodies so 24h dedupe never trips) should each
// cue normally, bringing the thread to 8 total messages / 8 cues. The 9th
// breaches the per-thread cap (default 8) and must NOT cue; the thread must
// auto-pause instead.
for (let i = 2; i <= 8; i++) {
  messagesA.push({
    id: `a${i}`, thread_id: 'tA', from: 'mike', kind: 'update', subject: null,
    body: `message ${i} — unique body ${i}`, refs: [], created_at: `2026-09-25T10:0${i}:00Z`,
  });
  await pollRelay();
}
check('(c) 8 messages mirrored so far', sqliteDb.prepare(`SELECT COUNT(*) AS n FROM relay_messages WHERE thread_id='tA'`).get().n === 8);
check('(c) 8 cues fired so far', cueFiredCount() === 8);
check('(c) thread NOT paused yet at 8', threadStatus('tA').status !== 'paused');

messagesA.push({
  id: 'a9', thread_id: 'tA', from: 'mike', kind: 'update', subject: null,
  body: 'message 9 — unique body 9', refs: [], created_at: '2026-09-25T10:09:00Z',
});
await pollRelay();

const a9Row = sqliteDb.prepare(`SELECT * FROM relay_messages WHERE message_id = 'a9'`).get();
check('(c) 9th message mirrored', a9Row !== undefined);
check('(c) 9th message did NOT cue', a9Row.cue_fired_at === null);
check('(c) 9th message cue_skip_reason is cap_thread_exchanges', a9Row.cue_skip_reason === 'cap_thread_exchanges');
check('(c) cue count STILL 8 (9th did not cue)', cueFiredCount() === 8);
const tAAfter = threadStatus('tA');
check('(c) thread tA is now paused', tAAfter.status === 'paused');
check('(c) thread tA pause_reason recorded', tAAfter.pause_reason === 'cap_thread_exchanges');

// -- a paused thread mirrors but does not cue further inbound ----------------
messagesA.push({
  id: 'a10', thread_id: 'tA', from: 'mike', kind: 'update', subject: null,
  body: 'message 10 — unique body 10', refs: [], created_at: '2026-09-25T10:10:00Z',
});
await pollRelay();
const a10Row = sqliteDb.prepare(`SELECT * FROM relay_messages WHERE message_id = 'a10'`).get();
check('(d) 10th message still mirrored despite pause', a10Row !== undefined);
check('(d) 10th message did NOT cue (thread paused)', a10Row.cue_fired_at === null);
check('(d) 10th message cue_skip_reason is thread_paused', a10Row.cue_skip_reason === 'thread_paused');
// This poll also re-mirrored tA's thread row from the fixture (which still
// says status: 'waiting_jarvis') — proves upsertThreadStmt's CASE WHEN guard
// (relay.ts) keeps a local pause from being clobbered by the next re-mirror.
check('(d) local pause SURVIVES the thread being re-mirrored', threadStatus('tA').status === 'paused');

// -- ack never cues (fresh, unpaused thread) ---------------------------------
sqliteDb.prepare(`INSERT INTO relay_threads (id, title, opened_by, status, exchange_count, read_by, created_at, updated_at, mirrored_at) VALUES ('tB', 'ack test', 'mike', 'open', 0, NULL, '2026-09-25T10:00:00Z', NULL, datetime('now'))`).run();
const { relayCueOnInboundMessage } = await import(path.join(distDir, 'relay-cue.js'));
sqliteDb.prepare(`INSERT INTO relay_messages (message_id, thread_id, author, kind, subject, body, refs, content_hash, created_at, mirrored_at, cue_fired_at, is_draft) VALUES ('bAck', 'tB', 'mike', 'ack', NULL, 'thanks', NULL, 'hashbAck', '2026-09-25T10:00:00Z', datetime('now'), NULL, 0)`).run();
const bAckRow = sqliteDb.prepare(`SELECT * FROM relay_messages WHERE message_id = 'bAck'`).get();
relayCueOnInboundMessage(bAckRow);
const bAckAfter = sqliteDb.prepare(`SELECT * FROM relay_messages WHERE message_id = 'bAck'`).get();
check('(e) ack never cues', bAckAfter.cue_fired_at === null && bAckAfter.cue_skip_reason === 'ack');

// -- kevin/jarvis-authored messages never cue --------------------------------
sqliteDb.prepare(`INSERT INTO relay_messages (message_id, thread_id, author, kind, subject, body, refs, content_hash, created_at, mirrored_at, cue_fired_at, is_draft) VALUES ('bKevin', 'tB', 'kevin', 'note', NULL, 'kevin said hi', NULL, 'hashbKevin', '2026-09-25T10:01:00Z', datetime('now'), NULL, 0)`).run();
const bKevinRow = sqliteDb.prepare(`SELECT * FROM relay_messages WHERE message_id = 'bKevin'`).get();
relayCueOnInboundMessage(bKevinRow);
const bKevinAfter = sqliteDb.prepare(`SELECT * FROM relay_messages WHERE message_id = 'bKevin'`).get();
check('(f) kevin-authored message never cues', bKevinAfter.cue_fired_at === null && bKevinAfter.cue_skip_reason === 'not_mike');

// -- kill switch: relay_enabled=0 blocks cues too ----------------------------
setSetting('relay_enabled', '0');
sqliteDb.prepare(`INSERT INTO relay_messages (message_id, thread_id, author, kind, subject, body, refs, content_hash, created_at, mirrored_at, cue_fired_at, is_draft) VALUES ('bOff', 'tB', 'mike', 'request', NULL, 'are you there', NULL, 'hashbOff', '2026-09-25T10:02:00Z', datetime('now'), NULL, 0)`).run();
const bOffRow = sqliteDb.prepare(`SELECT * FROM relay_messages WHERE message_id = 'bOff'`).get();
relayCueOnInboundMessage(bOffRow);
const bOffAfter = sqliteDb.prepare(`SELECT * FROM relay_messages WHERE message_id = 'bOff'`).get();
check('(g) kill switch blocks cue', bOffAfter.cue_fired_at === null && bOffAfter.cue_skip_reason === 'relay_disabled');
setSetting('relay_enabled', '1');

// -- draft-only outbound: composeDraftReply never touches the network -------
const fetchCallsBeforeDraft = fetchCalls;
const { composeDraftReply, isRelayOutboundAllowed } = await import(path.join(distDir, 'relay.js'));
check('(h) auto-reply default is off', isRelayOutboundAllowed() === false);
const draft = composeDraftReply('tB', 'here is a draft answer', 'answer');
check('(h) draft is_draft=1', draft.is_draft === 1);
check('(h) draft author is jarvis', draft.author === 'jarvis');
check('(h) draft message_id is NULL (local only)', draft.message_id === null);
check('(h) composeDraftReply made zero network calls', fetchCalls === fetchCallsBeforeDraft);

if (failed) {
  console.error('\nRELAY CUE CHECK: FAIL');
  process.exit(1);
} else {
  console.log('\nRELAY CUE CHECK: PASS');
}
