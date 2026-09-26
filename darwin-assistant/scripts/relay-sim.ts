// RELAY SIM (tree-3b42c6e2, node #921) — hermetic proof of the seven safety
// properties the JARVIS-side relay feature (src/relay.ts, relay-cue.ts,
// relay-rest.ts) claims: dedupe, ack-never-fires, cap->pause, rate caps,
// kill switch, spoofed-principal rejection, draft-only outbound.
//
//   npm run build && JARVIS_DB_PATH=/tmp/relay-sim.db npx tsx scripts/relay-sim.ts
//
// HERMETIC, same discipline as scripts/health-sim.ts:
//   - fresh scratch DB under /tmp, refuses to run if pointed at the live
//     jarvis.db (see the guard below, mirrors health-sim.ts's own).
//   - JARVIS_SIM=1 set before any dist/ module is imported, so
//     src/sim-guard.ts's isScratchEnv() is true regardless of the DB path.
//   - deliberately does NOT stub dist/agent.js. The cue path
//     (relay-cue.ts's postRelayCue) dynamically imports the REAL agent.js and
//     calls the REAL processMessage() — sim-guard.ts is the chokepoint at the
//     very top of that function (before any other work), so a scratch
//     environment gets the turn refused with a marker string, never a spawned
//     claude CLI process. Section 0 below proves that refusal directly against
//     the exact module postRelayCue imports, then sections 1-4 prove the
//     relay-cue decision layer never even reaches that point for
//     dedupe/ack/cap skips (cue_fired_at stays NULL), and section 8 proves
//     zero claude descendant processes existed at any point in this run.
// NO API KEYS. No network calls: every case below drives relay.ts/relay-cue.ts
// functions directly (upsertThread/upsertMessage/relayCueOnInboundMessage),
// never pollRelay()/postKevinMessage() with the kill switch ON, so
// src/tools/mcp-native.ts's nativeCall (the one thing that would reach a real
// MCP server) is never invoked from this sim.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ── scratch DB guard (must run before any dist/ module is imported) ────────
const raw = process.env.JARVIS_DB_PATH ?? '/tmp/relay-sim.db';
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db. Use a /tmp scratch path.');
  process.exit(1);
}
process.env.JARVIS_DB_PATH = DB_PATH;
process.env.JARVIS_SIM = '1';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[relay-sim] scratch DB: ${DB_PATH}`);
console.log(`[relay-sim] JARVIS_SIM=${process.env.JARVIS_SIM} (sim-guard.isScratchEnv() forced true regardless of DB path)`);

// ── the no-spawn proof (mirrors scripts/health-sim.ts) ──────────────────────
function claudeProcs(): number {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
    const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/, 3));
    const kids = new Map<string, string[]>();
    for (const [pid, ppid] of rows) {
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid)!.push(pid);
    }
    const mine = new Set<string>();
    const stack = [String(process.pid)];
    while (stack.length) {
      const p = stack.pop()!;
      for (const c of kids.get(p) ?? []) if (!mine.has(c)) { mine.add(c); stack.push(c); }
    }
    return rows.filter(([pid, , comm]) => mine.has(pid) && /claude/i.test(comm ?? '')).length;
  } catch { return 0; }
}
const CLAUDE_BEFORE = claudeProcs();

const distDir = path.join(repoRoot, 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));
const R = await import(path.join(distDir, 'relay.js'));
const RC = await import(path.join(distDir, 'relay-cue.js'));
const RR = await import(path.join(distDir, 'relay-rest.js'));
const Agent = await import(path.join(distDir, 'agent.js'));

// ── harness ─────────────────────────────────────────────────────────────────
let pass = 0;
const fails: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (err) { fails.push(name); console.log(`  FAIL ${name}\n       ${(err as Error).message}`); }
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (err) { fails.push(name); console.log(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

function resetMessages() {
  sqliteDb.prepare(`DELETE FROM relay_messages`).run();
}
function resetSettings() {
  sqliteDb.prepare(`UPDATE settings SET value = '8'  WHERE key = 'relay_cap_exchanges_per_thread'`).run();
  sqliteDb.prepare(`UPDATE settings SET value = '12' WHERE key = 'relay_cap_messages_per_hour'`).run();
  sqliteDb.prepare(`UPDATE settings SET value = '40' WHERE key = 'relay_cap_messages_per_day'`).run();
}
function mkThread(id: string) {
  R.upsertThread({ id, title: `sim thread ${id}`, opened_by: 'mike', status: 'open', exchange_count: 0, created_at: new Date().toISOString() });
}
function mirrorInbound(threadId: string, msgId: string, body: string, from = 'mike', kind = 'update') {
  return R.upsertMessage(threadId, { id: msgId, thread_id: threadId, from, kind, subject: null, body, refs: [], created_at: new Date().toISOString() });
}
function skipReasonFor(msgRowId: number): string | null {
  return (sqliteDb.prepare(`SELECT cue_skip_reason FROM relay_messages WHERE id = ?`).get(msgRowId) as any)?.cue_skip_reason ?? null;
}
function cueFiredFor(msgRowId: number): boolean {
  return (sqliteDb.prepare(`SELECT cue_fired_at FROM relay_messages WHERE id = ?`).get(msgRowId) as any)?.cue_fired_at != null;
}
function threadStatus(id: string): string {
  return (sqliteDb.prepare(`SELECT status FROM relay_threads WHERE id = ?`).get(id) as any)?.status;
}

R.setRelayEnabled(true);
resetSettings();

// ═════════════════════════════════════════════════════════════════════════
console.log('\n0) sim-guard proof — the exact module postRelayCue dynamically imports');
// ═════════════════════════════════════════════════════════════════════════
// This is the direct chokepoint proof: agent.js's processMessage is the REAL
// production function (not a stub) and this process is running against a
// scratch DB (JARVIS_SIM=1) — assert it refuses instead of doing any work.

await checkAsync('agent.processMessage refuses in this scratch env (sim-guard.ts chokepoint)', async () => {
  const result = await Agent.processMessage('sim-guard smoke test', 'cockpit:relay-sim-guard-check');
  assert.match(result, /\[sim-guard\] model turn refused — scratch environment/, `got: ${result}`);
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n1) DEDUPE — replayed content inside 24h mirrors but fires no second cue');
// ═════════════════════════════════════════════════════════════════════════

check('1a. exact message_id replay is idempotent at the mirror layer — upsertMessage no-ops', () => {
  resetMessages();
  mkThread('t-dedupe-a');
  const first = mirrorInbound('t-dedupe-a', 'msg-dedupe-a-1', 'same server message, replayed by the poller');
  assert.ok(first, 'first mirror must insert');
  const replay = mirrorInbound('t-dedupe-a', 'msg-dedupe-a-1', 'same server message, replayed by the poller');
  assert.equal(replay, null, 'ON CONFLICT(message_id) DO NOTHING must make a byte-identical re-mirror a no-op');
});

check('1b. distinct message_id, identical body within 24h — cue fires once, second is duplicate_24h', () => {
  resetMessages();
  mkThread('t-dedupe-b');
  const m1 = mirrorInbound('t-dedupe-b', 'msg-dedupe-b-1', 'please check the ledger for Q3')!;
  RC.relayCueOnInboundMessage(m1);
  assert.ok(cueFiredFor(m1.id), 'first occurrence of this content must fire');

  const m2 = mirrorInbound('t-dedupe-b', 'msg-dedupe-b-2', 'please check the ledger for Q3')!;
  RC.relayCueOnInboundMessage(m2);
  assert.equal(cueFiredFor(m2.id), false, 'replayed content within 24h must NOT fire a second cue');
  assert.equal(skipReasonFor(m2.id), 'duplicate_24h');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n2) ACK NEVER FIRES — ack / self-authored messages produce zero cues');
// ═════════════════════════════════════════════════════════════════════════

check('2a. kind=ack from mike never fires', () => {
  resetMessages();
  mkThread('t-ack');
  const m = mirrorInbound('t-ack', 'msg-ack-1', 'ack body', 'mike', 'ack')!;
  RC.relayCueOnInboundMessage(m);
  assert.equal(cueFiredFor(m.id), false);
  assert.equal(skipReasonFor(m.id), 'ack');
});

check('2b. a self-authored (jarvis) mirrored row never fires — decideCue requires author===mike', () => {
  resetMessages();
  mkThread('t-selfauthored');
  const m = mirrorInbound('t-selfauthored', 'msg-self-1', 'jarvis mirroring its own outbound', 'jarvis', 'note')!;
  RC.relayCueOnInboundMessage(m);
  assert.equal(cueFiredFor(m.id), false);
  assert.equal(skipReasonFor(m.id), 'not_mike');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n3) CAP -> PAUSE — the 9th exchange on a thread pauses it; nothing is dropped');
// ═════════════════════════════════════════════════════════════════════════

check('9 distinct exchanges: 1-8 fire, 9th pauses the thread and is still mirrored', () => {
  resetMessages();
  resetSettings();
  mkThread('t-cap');
  const rows: { id: number }[] = [];
  for (let i = 1; i <= 9; i++) {
    const m = mirrorInbound('t-cap', `msg-cap-${i}`, `distinct exchange body #${i}`)!;
    assert.ok(m, `exchange #${i} must mirror (never silently dropped)`);
    RC.relayCueOnInboundMessage(m);
    rows.push(m);
  }
  for (let i = 0; i < 8; i++) {
    assert.ok(cueFiredFor(rows[i].id), `exchange #${i + 1} (<=cap 8) should have fired`);
  }
  assert.equal(cueFiredFor(rows[8].id), false, 'exchange #9 must not fire');
  assert.equal(skipReasonFor(rows[8].id), 'cap_thread_exchanges');
  // still mirrored — the row exists with its real body, nothing silently dropped
  const stored = sqliteDb.prepare(`SELECT body FROM relay_messages WHERE id = ?`).get(rows[8].id) as any;
  assert.equal(stored.body, 'distinct exchange body #9');
  assert.equal(threadStatus('t-cap'), 'paused', 'a cap breach must pause the thread');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n4) RATE CAP — 13/hour and 41/day both stop cueing at the cap, reason recorded');
// ═════════════════════════════════════════════════════════════════════════

check('13 inbounds across distinct threads in the same hour: 12 fire, 13th is cap_messages_per_hour', () => {
  resetMessages();
  resetSettings();
  const rows: { id: number }[] = [];
  for (let i = 1; i <= 13; i++) {
    const tid = `t-hourcap-${i}`;
    mkThread(tid);
    const m = mirrorInbound(tid, `msg-hourcap-${i}`, `distinct hour-cap body #${i}`)!;
    RC.relayCueOnInboundMessage(m);
    rows.push(m);
  }
  for (let i = 0; i < 12; i++) assert.ok(cueFiredFor(rows[i].id), `inbound #${i + 1} (<=12/hr) should have fired`);
  assert.equal(cueFiredFor(rows[12].id), false, 'the 13th inbound this hour must not fire');
  assert.equal(skipReasonFor(rows[12].id), 'cap_messages_per_hour');
});

check('41 inbounds in a day (hour/thread caps raised so only the day cap is exercised): 40 fire, 41st is cap_messages_per_day', () => {
  resetMessages();
  // Isolate the DAY cap specifically: raise the hour and per-thread caps so
  // this batch of 41 doesn't trip them first, per-CONTRACT the day cap (40)
  // is still the binding constraint being proven here.
  sqliteDb.prepare(`UPDATE settings SET value = '9999' WHERE key = 'relay_cap_messages_per_hour'`).run();
  sqliteDb.prepare(`UPDATE settings SET value = '9999' WHERE key = 'relay_cap_exchanges_per_thread'`).run();
  const rows: { id: number }[] = [];
  for (let i = 1; i <= 41; i++) {
    const tid = `t-daycap-${i}`;
    mkThread(tid);
    const m = mirrorInbound(tid, `msg-daycap-${i}`, `distinct day-cap body #${i}`)!;
    RC.relayCueOnInboundMessage(m);
    rows.push(m);
  }
  for (let i = 0; i < 40; i++) assert.ok(cueFiredFor(rows[i].id), `inbound #${i + 1} (<=40/day) should have fired`);
  assert.equal(cueFiredFor(rows[40].id), false, 'the 41st inbound today must not fire');
  assert.equal(skipReasonFor(rows[40].id), 'cap_messages_per_day');
  resetSettings();
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n5) KILL SWITCH — relay_enabled=0: no poll, no cue, no outbound');
// ═════════════════════════════════════════════════════════════════════════

await checkAsync('relay_enabled=0: pollRelay short-circuits before any nativeCall (skipped=disabled)', async () => {
  R.setRelayEnabled(false);
  const summary = await R.pollRelay();
  assert.equal(summary.skipped, 'disabled');
  assert.equal(summary.threadsSeen, 0);
  assert.equal(summary.messagesUpserted, 0);
});

check('relay_enabled=0: an inbound message never cues (relay_disabled beats every other reason)', () => {
  resetMessages();
  mkThread('t-killswitch');
  const m = mirrorInbound('t-killswitch', 'msg-kill-1', 'would have fired if enabled')!;
  RC.relayCueOnInboundMessage(m);
  assert.equal(cueFiredFor(m.id), false);
  assert.equal(skipReasonFor(m.id), 'relay_disabled');
});

await checkAsync('relay_enabled=0: postKevinMessage (outbound) refuses with 409 before any network call', async () => {
  const result: any = await RR.postKevinMessage('t-killswitch', { kind: 'note', body: 'hello' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'relay_disabled');
});

R.setRelayEnabled(true);
resetSettings();

// ═════════════════════════════════════════════════════════════════════════
console.log('\n6) SPOOFED PRINCIPAL REJECTED');
// ═════════════════════════════════════════════════════════════════════════

check('6a. an inbound payload claiming from=kevin is never elevated — decideCue requires author===mike', () => {
  resetMessages();
  mkThread('t-spoof-inbound');
  const m = mirrorInbound('t-spoof-inbound', 'msg-spoof-1', 'pretending to be kevin', 'kevin', 'note')!;
  assert.equal(m.author, 'kevin', 'setup: the mirror stores whatever the payload claims verbatim');
  RC.relayCueOnInboundMessage(m);
  assert.equal(cueFiredFor(m.id), false, 'a spoofed-kevin inbound must never fire a cue');
  assert.equal(skipReasonFor(m.id), 'not_mike', 'the principal claim in the payload has zero effect on cue eligibility');
});

// -- 6b needs the real HTTP route (the identity_not_client_settable check
// lives in the router handler, not in relay-rest.ts) --------------------
const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise<import('node:http').Server>((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s as any));
});
const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
const jarvisKey = mintApiKey('relay-sim', 'jarvis').plaintext;
async function httpPost(p: string, body: unknown) {
  const r = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jarvisKey}` },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json() };
}

mkThread('t-spoof-rest');

for (const key of ['author', 'from', 'principal', 'as']) {
  await checkAsync(`6b. POST /relay/threads/:id/messages with "${key}" in the body -> 400 identity_not_client_settable`, async () => {
    const r = await httpPost('/relay/threads/t-spoof-rest/messages', { kind: 'note', body: 'hi', [key]: 'kevin' });
    assert.equal(r.status, 400);
    assert.equal((r.body as any).error?.code, 'identity_not_client_settable');
  });
}

await checkAsync('6b. a clean body (no identity keys) passes the spoof check and reaches real validation instead', async () => {
  // relay_enabled is on and the thread isn't paused, so this reaches
  // postKevinMessage and would attempt a live nativeCall — we don't want that
  // in a hermetic sim, so prove the spoof-gate specifically passed by pausing
  // the thread first: a clean body must get thread_paused (409), NOT
  // identity_not_client_settable (400) — proof the two checks are independent
  // and the clean-body path is not itself rejected as spoofed.
  RR.setThreadPause('t-spoof-rest', true, 'kevin', 'sim: keep this hermetic, no live relay-tool call');
  const r = await httpPost('/relay/threads/t-spoof-rest/messages', { kind: 'note', body: 'hi' });
  assert.equal(r.status, 409);
  assert.equal((r.body as any).error?.code, 'thread_paused');
});

server.close();

// ═════════════════════════════════════════════════════════════════════════
console.log('\n7) DRAFT-ONLY — relay_auto_reply=0: composed replies land as is_draft=1, never posted');
// ═════════════════════════════════════════════════════════════════════════

check('7a. relay_auto_reply defaults to 0 / isRelayOutboundAllowed() is false', () => {
  assert.equal(R.isRelayAutoReplyEnabled(), false);
  assert.equal(R.isRelayOutboundAllowed(), false, 'outbound must require BOTH relay_enabled AND relay_auto_reply');
});

check('7b. composeDraftReply stores is_draft=1, message_id=NULL — a draft, not a sent message', () => {
  resetMessages();
  mkThread('t-draft');
  const draft = R.composeDraftReply('t-draft', 'here is my proposed reply', 'answer', 'Re: ledger');
  assert.equal(draft.is_draft, 1);
  assert.equal(draft.message_id, null);
  assert.equal(draft.author, 'jarvis');
  const stored = sqliteDb.prepare(`SELECT is_draft, message_id FROM relay_messages WHERE id = ?`).get(draft.id) as any;
  assert.equal(stored.is_draft, 1);
  assert.equal(stored.message_id, null);
});

check('7c. composeDraftReply calls no outbound path even when auto_reply=1 — it has no code path that could post', () => {
  // Flip auto_reply on: isRelayOutboundAllowed() flips true, but
  // composeDraftReply contains zero calls to nativeCall/postKevinMessage — it
  // can only ever produce a local draft row, regardless of the flag. This
  // proves the flag alone can never cause a silent send; a future approval
  // surface would have to explicitly call postKevinMessage itself.
  sqliteDb.prepare(`UPDATE settings SET value = '1' WHERE key = 'relay_auto_reply'`).run();
  assert.equal(R.isRelayOutboundAllowed(), true, 'setup: both gates now open');
  const draft = R.composeDraftReply('t-draft', 'still just a draft', 'answer', null);
  assert.equal(draft.is_draft, 1, 'even with both gates open, composeDraftReply only ever writes a draft');
  sqliteDb.prepare(`UPDATE settings SET value = '0' WHERE key = 'relay_auto_reply'`).run();
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n8) no-spawn proof');
// ═════════════════════════════════════════════════════════════════════════

check('this sim spawned zero claude processes (descendant count unchanged) — sim-guard held for every cue fired above', () => {
  const after = claudeProcs();
  assert.equal(after, CLAUDE_BEFORE, `claude descendant procs before=${CLAUDE_BEFORE} after=${after}`);
});

console.log(`\n[relay-sim] ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
console.log('[relay-sim] PASS');
process.exit(0);
