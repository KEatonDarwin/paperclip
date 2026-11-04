// GOALS GUARDS CHECK (CONTRACT §12.13, node #476) — drives the real goals.ts +
// goals-guards.ts + the express router on a throwaway port, against a SCRATCH
// sqlite DB and a FAKE Overwatch HTTP server on a random port. No live model
// calls (the guard cue's dynamic import('./agent.js') is stubbed by the loader
// hook below) and no live Overwatch (the fake server stands in). NO API KEYS.
//
//   npm run build && npm run goals:guards-check
//   (or: JARVIS_DB_PATH=/tmp/goals-guards.db npx tsx scripts/goals-guards-check.mjs)

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Stub the guard cue's dynamic import('./agent.js') → no real claude turn.
register(pathToFileURL(path.join(__dirname, 'goals-guards-check.hooks.mjs')), import.meta.url);

// ── scratch DB guard (before any dist/ module opens the sqlite handle) ──────
const raw = process.env.JARVIS_DB_PATH ?? '/tmp/goals-guards.db';
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
process.env.JARVIS_DB_PATH = DB_PATH;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[guards-check] scratch DB: ${DB_PATH}`);

process.env.HOPPER_GOV_ENABLED = '0';
process.env.HOPPER_ENGINE_SLOTS = process.env.HOPPER_ENGINE_SLOTS ?? '8';
process.env.GOAL_GUARD_POLLER = '0'; // we drive pollGuardsOnce() by hand
process.env.GOALS_GUARD_WEBHOOK_SECRET = 'test-webhook-secret';
delete process.env.ANTHROPIC_API_KEY;

// ── FAKE Overwatch server ───────────────────────────────────────────────────
const OW_KEY = 'test-ow-key';
const owState = {
  createBodies: [],
  patchBodies: [],
  deleteKeys: [],
  results: new Map(), // key -> last_result | null
  next422OnPatch: false,
  next404OnDelete: false,
  seq: 0,
};
function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'rule';
}
const owServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const auth = req.headers['authorization'] ?? '';
    const url = req.url ?? '';
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (auth !== `Bearer ${OW_KEY}`) { send(401, { error: 'Unauthorized' }); return; }
    let body = {};
    if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = {}; } }

    const m = /^\/api\/v1\/overwatch\/rules(?:\/([^/?]+))?/.exec(url);
    const key = m && m[1] ? decodeURIComponent(m[1]) : null;

    if (req.method === 'POST' && !key) {
      owState.createBodies.push(body);
      const k = `prompt.${slug(body.name)}-${(++owState.seq).toString(16).padStart(4, '0')}`;
      owState.results.set(k, null);
      send(201, { ...body, key: k, dashboard_url: 'https://health.thedarwinhub.com/overwatch', last_result: null, created: true });
      return;
    }
    if (req.method === 'GET' && key) {
      if (!owState.results.has(key)) { send(404, { error: `No prompt rule found for ${key}` }); return; }
      send(200, { key, last_result: owState.results.get(key) });
      return;
    }
    if (req.method === 'PATCH' && key) {
      if (owState.next422OnPatch) { owState.next422OnPatch = false; send(422, { error: 'sql was rejected: bad column' }); return; }
      owState.patchBodies.push({ key, body });
      send(200, { key, ...body });
      return;
    }
    if (req.method === 'DELETE' && key) {
      owState.deleteKeys.push(key);
      if (owState.next404OnDelete) { owState.next404OnDelete = false; send(404, { error: 'not found' }); return; }
      owState.results.delete(key);
      send(200, { deleted: true, key });
      return;
    }
    send(400, { error: 'bad request' });
  });
});
await new Promise((r) => owServer.listen(0, '127.0.0.1', r));
const owPort = owServer.address().port;
process.env.OVERWATCH_API_URL = `http://127.0.0.1:${owPort}`;
process.env.OVERWATCH_API_KEY = OW_KEY;
console.log(`[guards-check] fake Overwatch: ${process.env.OVERWATCH_API_URL}`);

// ── real dist modules ───────────────────────────────────────────────────────
const distDir = path.join(repoRoot, 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const hopperEngine = await import(path.join(distDir, 'hopper-engine.js'));
const goals = await import(path.join(distDir, 'goals.js'));
const guards = await import(path.join(distDir, 'goals-guards.js'));

hopperEngine.startHopperEngine(async () => 'FAKE_WORKER_OK');

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/v1`;
const cockpitKey = mintApiKey('guards-check-admin', 'cockpit').plaintext;

async function req(method, urlPath, { token = cockpitKey, body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}${urlPath}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const get = (p, opts) => req('GET', p, opts);
const post = (p, body, opts = {}) => req('POST', p, { body, ...opts });
const patch = (p, body, opts = {}) => req('PATCH', p, { body, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function guardCueCalls() { return globalThis.__guardCueCalls ?? []; }
async function waitForCues(n, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (guardCueCalls().length < n && Date.now() < deadline) await sleep(20);
}

// ── results ───────────────────────────────────────────────────────────────
const results = [];
let currentSection = '';
function section(s) { currentSection = s; }
async function check(name, fn) {
  try { await fn(); results.push({ ok: true, name: `${currentSection} — ${name}` }); console.log(`  ✓ ${name}`); }
  catch (err) { results.push({ ok: false, name: `${currentSection} — ${name}`, err: err?.message ?? String(err) }); console.log(`  ✗ ${name}\n     ${err?.message ?? err}`); }
}

// ── SSE capture (admin key) — assert goal_guard reaches the stream ──────────
const sseEvents = [];
const sseAbort = new AbortController();
(async () => {
  try {
    const res = await fetch(`${base}/events`, { headers: { Authorization: `Bearer ${cockpitKey}` }, signal: sseAbort.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let evType = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event:')) evType = line.slice(6).trim();
        else if (line.startsWith('data:')) { sseEvents.push({ type: evType, data: line.slice(5).trim() }); }
      }
    }
  } catch { /* aborted */ }
})();
await sleep(150); // let the SSE stream connect

// ── helper: drive a fresh done node ─────────────────────────────────────────
async function makeDoneNode(goalId, title) {
  const n = await post(`/goals/${goalId}/nodes`, { title, done_means: `${title} works`, authored_by: 'kevin' });
  const id = n.json.node.id;
  await post(`/goals/${goalId}/nodes/${id}/leaf_kind`, { leaf_kind: 'human' });
  await post(`/goals/${goalId}/nodes/${id}/human_done`, {});
  await post(`/goals/${goalId}/nodes/${id}/verify`, { passed: true });
  return id;
}

// ─────────────────────────────────────────────────────────────────────────
section('setup');
const g = await post('/goals', { title: 'Monitoring goal', done_means: 'hub monitored' });
const goalId = g.json.goal.id;
const doneNode = await makeDoneNode(goalId, 'Create monitoring');

section('1. propose preconditions');
let ghostGuardId = null;
await check('propose_guard on a done node → 201 ghost', async () => {
  const r = await post(`/goals/${goalId}/guards/propose`, {
    node_id: doneNode, mode: 'query', title: 'daily revenue vs 7-day avg',
    sql: 'SELECT pct FROM rev', comparator: 'gte', threshold: -5, value_column: 'pct',
    sample_columns: ['pct', 'day'], severity: 'high', ow_group: 'revenue', actor: 'jarvis',
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.guard.state, 'ghost');
  assert.equal(r.json.guard.health, 'unknown');
  assert.deepEqual(r.json.guard.sample_columns, ['pct', 'day']);
  ghostGuardId = r.json.guard.id;
});
await check('propose on a set (unverified) node → 409 node_not_verifiable', async () => {
  const n = await post(`/goals/${goalId}/nodes`, { title: 'unverified', done_means: 'x', authored_by: 'kevin' });
  const r = await post(`/goals/${goalId}/guards/propose`, { node_id: n.json.node.id, mode: 'query', title: 't', actor: 'jarvis' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'node_not_verifiable');
});
await check('second propose on a node that already has a guard → 409 guard_exists', async () => {
  const r = await post(`/goals/${goalId}/guards/propose`, { node_id: doneNode, mode: 'query', title: 'dup', actor: 'jarvis' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'guard_exists');
});

section('2. accept');
let owKey = null;
await check('accept with configured Overwatch → set, key stored, health unknown, create body correct', async () => {
  const before = owState.createBodies.length;
  const r = await post(`/goals/${goalId}/guards/${ghostGuardId}/accept`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.guard.state, 'set');
  assert.equal(r.json.guard.health, 'unknown');
  assert.ok(r.json.guard.overwatch_key, 'overwatch_key stored');
  owKey = r.json.guard.overwatch_key;
  assert.equal(owState.createBodies.length, before + 1, 'create hit Overwatch once');
  const body = owState.createBodies[before];
  assert.ok(body.name.includes(`Goal ${goalId} · node ${doneNode}`), `name has identity: ${body.name}`);
  assert.equal(body.mode, 'query');
  assert.equal(body.sql, 'SELECT pct FROM rev');
  assert.equal(body.comparator, 'gte');
  assert.equal(body.threshold, -5);
  assert.equal(body.group, 'revenue');
  assert.equal(body.cadence_minutes, 60);
  assert.equal(body.created_by, 'goals');
  assert.deepEqual(body.sample_columns, ['pct', 'day']);
});
await check('guard_set goal_event written', async () => {
  const ev = await get(`/goals/${goalId}/events`);
  assert.ok(ev.json.events.some((e) => e.kind === 'guard_set'), 'guard_set event present');
});
await check('accept with Overwatch UNCONFIGURED → 503 overwatch_not_connected, guard stays ghost', async () => {
  const node2 = await makeDoneNode(goalId, 'Second win condition');
  const p = await post(`/goals/${goalId}/guards/propose`, { node_id: node2, mode: 'query', title: 't2', sql: 'SELECT 1 AS v', comparator: 'gte', threshold: 0, actor: 'jarvis' });
  const gid = p.json.guard.id;
  const savedKey = process.env.OVERWATCH_API_KEY;
  delete process.env.OVERWATCH_API_KEY; // unconfigure at call time
  const r = await post(`/goals/${goalId}/guards/${gid}/accept`, {});
  process.env.OVERWATCH_API_KEY = savedKey;
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'overwatch_not_connected');
  const after = await get(`/goals/${goalId}/guards/${gid}`);
  assert.equal(after.json.guard.state, 'ghost', 'guard stays ghost');
});

section('3. poller health transitions');
await check("status 'ok' → passing (unknown→passing: SSE flip, NO cue)", async () => {
  const cuesBefore = guardCueCalls().length;
  owState.results.set(owKey, { status: 'ok', value: 1.2, summary: 'revenue +1.2%', at: new Date().toISOString() });
  await guards.pollGuardsOnce();
  const cur = (await get(`/goals/${goalId}/guards`)).json.guards.find((x) => x.overwatch_key === owKey);
  assert.equal(cur.health, 'passing');
  await sleep(100);
  assert.equal(guardCueCalls().length, cuesBefore, 'no cue on unknown→passing');
});
await check("status 'fail' → failing, guard_failed cue fired ONCE", async () => {
  const cuesBefore = guardCueCalls().length;
  owState.results.set(owKey, { status: 'fail', value: -7.4, summary: 'revenue -7.4% vs 7-day avg', at: new Date().toISOString() });
  await guards.pollGuardsOnce();
  await waitForCues(cuesBefore + 1);
  const cur = (await get(`/goals/${goalId}/guards`)).json.guards.find((x) => x.overwatch_key === owKey);
  assert.equal(cur.health, 'failing');
  assert.equal(guardCueCalls().length, cuesBefore + 1, 'exactly one cue');
  assert.match(guardCueCalls().at(-1).text, /FAILING/);
});
await check('second identical tick → NO new event, NO new cue', async () => {
  const cuesBefore = guardCueCalls().length;
  await guards.pollGuardsOnce();
  await sleep(100);
  assert.equal(guardCueCalls().length, cuesBefore, 'no duplicate cue');
});
await check("status 'ok' again (fail→passing) → guard_recovered cue", async () => {
  const cuesBefore = guardCueCalls().length;
  owState.results.set(owKey, { status: 'ok', value: 0.5, summary: 'revenue +0.5%', at: new Date().toISOString() });
  await guards.pollGuardsOnce();
  await waitForCues(cuesBefore + 1);
  assert.match(guardCueCalls().at(-1).text, /RECOVERED/);
});
await check("status 'error' → error, guard_error cue", async () => {
  const cuesBefore = guardCueCalls().length;
  owState.results.set(owKey, { status: 'error', value: null, summary: 'query threw', at: new Date().toISOString() });
  await guards.pollGuardsOnce();
  await waitForCues(cuesBefore + 1);
  const cur = (await get(`/goals/${goalId}/guards`)).json.guards.find((x) => x.overwatch_key === owKey);
  assert.equal(cur.health, 'error');
  assert.match(guardCueCalls().at(-1).text, /ERRORED/);
});

section('4. patch a set guard');
await check('PATCH threshold → Overwatch PATCH called; stub 422 → 422 overwatch_rejected, row unchanged', async () => {
  // reset to passing first so the 422 path is clean
  owState.results.set(owKey, { status: 'ok', value: 1, summary: 'ok', at: new Date().toISOString() });
  await guards.pollGuardsOnce();
  const before = (await get(`/goals/${goalId}/guards`)).json.guards.find((x) => x.overwatch_key === owKey);
  owState.next422OnPatch = true;
  const r = await patch(`/goals/${goalId}/guards/${before.id}`, { threshold: -10, actor: 'kevin' });
  assert.equal(r.status, 422, JSON.stringify(r.json));
  assert.equal(r.json.error.code, 'overwatch_rejected');
  const after = (await get(`/goals/${goalId}/guards`)).json.guards.find((x) => x.overwatch_key === owKey);
  assert.equal(after.threshold, before.threshold, 'threshold unchanged after 422');
});
await check('PATCH threshold (Overwatch accepts) → row updated + OW patch body sent', async () => {
  const before = (await get(`/goals/${goalId}/guards`)).json.guards.find((x) => x.overwatch_key === owKey);
  const patchesBefore = owState.patchBodies.length;
  const r = await patch(`/goals/${goalId}/guards/${before.id}`, { threshold: -3, actor: 'kevin' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.guard.threshold, -3);
  assert.equal(owState.patchBodies.length, patchesBefore + 1);
  assert.equal(owState.patchBodies.at(-1).body.threshold, -3);
});

section('5. discard');
await check('discard a set guard → Overwatch DELETE called, discarded; stub 404 tolerated', async () => {
  const cur = (await get(`/goals/${goalId}/guards`)).json.guards.find((x) => x.overwatch_key === owKey);
  const delsBefore = owState.deleteKeys.length;
  owState.next404OnDelete = true;
  const r = await post(`/goals/${goalId}/guards/${cur.id}/discard`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.guard.state, 'discarded');
  assert.equal(owState.deleteKeys.length, delsBefore + 1, 'DELETE hit Overwatch');
});

section('6. webhook');
let webhookKey = null;
await check('setup: a fresh set guard for the webhook', async () => {
  const node3 = await makeDoneNode(goalId, 'Webhook target');
  const p = await post(`/goals/${goalId}/guards/propose`, { node_id: node3, mode: 'query', title: 'wh', sql: 'SELECT 1 AS v', comparator: 'gte', threshold: 0, actor: 'jarvis' });
  const a = await post(`/goals/${goalId}/guards/${p.json.guard.id}/accept`, {});
  webhookKey = a.json.guard.overwatch_key;
  assert.ok(webhookKey);
});
await check('valid secret + known key → 200, applyGuardHealth path (health flips, cue once)', async () => {
  const cuesBefore = guardCueCalls().length;
  const r = await post('/goals/guards/webhook', { key: webhookKey, status: 'fail', value: -9, summary: 'wh failing', ran_at: new Date().toISOString() },
    { token: null, headers: { 'X-Goals-Guard-Secret': 'test-webhook-secret' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await waitForCues(cuesBefore + 1);
  const cur = (await get(`/goals/${goalId}/guards`)).json.guards.find((x) => x.overwatch_key === webhookKey);
  assert.equal(cur.health, 'failing');
  assert.equal(guardCueCalls().length, cuesBefore + 1, 'exactly one cue');
});
await check('wrong secret → 401', async () => {
  const r = await post('/goals/guards/webhook', { key: webhookKey, status: 'ok' }, { token: null, headers: { 'X-Goals-Guard-Secret': 'nope' } });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'invalid_webhook_secret');
});
await check('unset secret → 503', async () => {
  const saved = process.env.GOALS_GUARD_WEBHOOK_SECRET;
  delete process.env.GOALS_GUARD_WEBHOOK_SECRET;
  const r = await post('/goals/guards/webhook', { key: webhookKey, status: 'ok' }, { token: null, headers: { 'X-Goals-Guard-Secret': 'anything' } });
  process.env.GOALS_GUARD_WEBHOOK_SECRET = saved;
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'webhook_secret_unset');
});
await check('unknown key → 404 no_guard_for_key', async () => {
  const r = await post('/goals/guards/webhook', { key: 'prompt.nope-ffff', status: 'ok' }, { token: null, headers: { 'X-Goals-Guard-Secret': 'test-webhook-secret' } });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'no_guard_for_key');
});

section('7. counts + snapshot');
await check('GoalCounts.guards / guards_failing reflect set/failing guards', async () => {
  const tree = await get(`/goals/${goalId}`);
  const c = tree.json.goal.counts;
  // set guards: webhook guard (failing). the revenue guard was discarded.
  assert.ok(c.guards >= 1, `guards=${c.guards}`);
  assert.ok(c.guards_failing >= 1, `guards_failing=${c.guards_failing}`);
});
await check('need_you unchanged by guard state', async () => {
  const tree = await get(`/goals/${goalId}`);
  const c = tree.json.goal.counts;
  // need_you = ghosts + human_open + check + plan_proposed — no guard term.
  const expected = c.ghosts + c.human_open + c.check + 0;
  assert.equal(c.need_you, expected, `need_you=${c.need_you} expected~${expected}`);
});
await check('buildGoalThreadContext shows guards_failing + node 🛡✗ suffix', async () => {
  const ctx = goals.buildGoalThreadContext(`cockpit:goal-${goalId}`);
  assert.match(ctx, /guards_failing="\d+"/, 'guards_failing attr present');
  assert.match(ctx, /🛡/, 'guard shield marker present');
  assert.match(ctx, /🛡✗/, 'failing guard marker present');
});

section('8. SSE');
await check('goal_guard event reached the /events stream (admin)', async () => {
  await sleep(150);
  assert.ok(sseEvents.some((e) => e.type === 'goal_guard'), `goal_guard SSE seen (types: ${[...new Set(sseEvents.map((e) => e.type))].join(',')})`);
});

// ── report ──────────────────────────────────────────────────────────────
sseAbort.abort();
guards.stopGuardPoller();
server.close();
owServer.close();

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
const reportDir = '/home/kevin/obsidian/paperclip-wiki/outbox/goals';
try {
  fs.mkdirSync(reportDir, { recursive: true });
  const lines = [
    '# GOALS GUARDS — backend check report',
    '', `Ran: ${new Date().toISOString()}`, `Result: **${passed}/${results.length} passed**`, '',
    ...results.map((r) => `- ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n    - ${r.err}`}`),
  ];
  fs.writeFileSync(path.join(reportDir, 'guards-check-report.md'), lines.join('\n'));
} catch (e) { console.warn('report write failed', e?.message); }

console.log(`\n[guards-check] ${passed}/${results.length} passed`);
if (failed.length) {
  console.error(`[guards-check] FAILURES:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join('\n')}`);
  process.exit(1);
}
console.log('[guards-check] ALL PASS');
process.exit(0);
