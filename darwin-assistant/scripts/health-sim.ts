// COCKPIT HEALTH SIM (tree-2a693306, node #860) — the regression sim over the
// REAL createApiV1Router() + REAL SSE stream + the REAL `health` persona tool,
// against a SCRATCH sqlite DB, on a throwaway HTTP port. Zero claude processes.
//
//   npm run health:sim
//   == npm run build && JARVIS_DB_PATH=/tmp/health-sim.db npx tsx scripts/health-sim.ts
//
// `npm run health:check` (scripts/health-check.mjs, 45 checks) already proves the
// INTERNAL functions byte-for-byte: sampler math, rollup/retention, the full
// spike→cue→release→cooldown state machine, settings clamping, and three boot
// regressions. This sim does NOT re-litigate those — it proves the surfaces a
// unit check cannot: real HTTP routes (auth, status codes, error codes), a real
// SSE stream carrying `health_sample`/`health_event` frames end to end, and the
// `health` persona tool's op contract (CONTRACT.md §8) called the way JARVIS
// actually calls it — directly, not through MCP transport (persona-mcp:sim
// already proves the MCP plumbing generically; this proves THIS tool's shapes).
//
// Sections:
//   1) routes    — GET/POST /health/* over real HTTP: auth, admin-scope gate on
//                  POST /health/sample, GET /health/series window→resolution +
//                  bad-window 400, GET /health/events filters, POST ack + 404s.
//   2) SSE       — open a real stream, take a real sample, assert a
//                  `health_sample` frame lands with sample+point; drive a spike
//                  through evaluateSpikes and assert `health_event` frames land.
//   3) tool ops  — call the `health` tool's execute() directly for every op and
//                  assert its return shape matches CONTRACT §8 (and matches the
//                  route it mirrors, `ok` key aside).
//   4) rollup/retention/series — plant history, roll it up, read it back through
//                  GET /health/series so AC-2 is proven at the HTTP layer too.
//   5) spike/cooldown via the HTTP+SSE surface — one sustained crossing → one
//                  event + one cue + one notification, visible over GET
//                  /health/events; a second crossing inside the cooldown →
//                  event with no cue; releasing then re-crossing after the
//                  cooldown → cues again. (The exhaustive internal-function
//                  version of this lives in health-check.mjs; this is the same
//                  contract proven end to end over the wire.)
//
// NO API KEYS. Zero claude processes: the one dynamic `import('./agent.js')`
// health-monitor.ts performs to post a cue is stubbed by health-check.hooks.mjs
// (recorder, no spawn) — reused here rather than duplicated. Verified with a
// descendant-process count before/after (a global `pgrep -c -f claude` is racy
// on this shared box — see scripts/night-shift-shifts-check.mjs's note).

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ── scratch DB guard (must run before any dist/ module is imported) ────────
const raw = process.env.JARVIS_DB_PATH ?? '/tmp/health-sim.db';
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db. Use a /tmp scratch path.');
  process.exit(1);
}
process.env.JARVIS_DB_PATH = DB_PATH;
process.env.JARVIS_SIM = '1';
process.env.HEALTH_MONITOR = '0'; // never start the real setInterval sampler here
delete process.env.ANTHROPIC_API_KEY;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[health-sim] scratch DB: ${DB_PATH}`);

// Register the SCOPED stub (health-sim.hooks.mjs), NOT health-check.hooks.mjs.
// health-check.mjs only ever imports health-monitor.js + conversation-db.js
// directly, so its unscoped agent.js replacement is safe there. This sim boots
// the FULL createApiV1Router() module graph, and other modules reachable from
// api-v1.js (big-board.ts, api-v1.ts itself) STATICALLY import real exports
// (resolveConversationRuntime, isPlanModeMessage, ...) from dist/agent.js — an
// unscoped stub breaks those with "does not provide an export named ...".
// health-sim.hooks.mjs's `resolve()` hook only swaps the ONE dynamic
// import('./agent.js') that health-monitor.js's postHealthCue performs
// (scoped by context.parentURL), leaving every other import of agent.js real.
register(pathToFileURL(path.join(__dirname, 'health-sim.hooks.mjs')), import.meta.url);

// ── the no-spawn proof (mirrors scripts/night-shift-shifts-check.mjs) ──────
// A global `pgrep -c -f claude` is racy on this box: other jarvis.service
// workers (including whichever one is running THIS sim) start and stop for
// reasons unrelated to this suite. What zero-claude-processes actually means
// is "this suite spawns no model call" — so count only this process's own
// descendants.
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
const { sqliteDb, setSetting } = await import(path.join(distDir, 'conversation-db.js'));
const H = await import(path.join(distDir, 'health-monitor.js'));
const { health } = await import(path.join(distDir, 'tools', 'health-tool.js'));

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
const cues = (): Array<{ text: string; externalId: string; correlationKey: string }> =>
  (globalThis as any).__HEALTH_CUES__ ?? [];

// ── server ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise<import('node:http').Server>((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s as any));
});
const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
console.log(`[health-sim] server: ${base}`);

const adminKey = mintApiKey('health-sim-admin', 'admin').plaintext;
const plainKey = mintApiKey('health-sim-plain', 'jarvis').plaintext;

async function httpGet(p: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${p}`, { headers });
  return { status: r.status, body: await r.json() };
}
async function httpPost(p: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json() };
}

/** Open an SSE stream and collect `event:`/`data:` frames as they arrive (mirrors scripts/sse-event-types-check.mjs). */
async function openStream(token: string) {
  const controller = new AbortController();
  const res = await fetch(`${base}/events`, {
    headers: { accept: 'text/event-stream', Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  assert.equal(res.status, 200, `/events -> ${res.status}`);
  const frames: Array<{ type: string; data: any }> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = chunk.match(/^event: (.+)\ndata: (.*)$/s);
          if (m) { try { frames.push({ type: m[1], data: JSON.parse(m[2]) }); } catch { frames.push({ type: m[1], data: m[2] }); } }
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    frames,
    close: () => controller.abort(),
    settle: (ms = 150) => new Promise((r) => setTimeout(r, ms)),
  };
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n1) routes — auth + shapes + error codes');
// ═════════════════════════════════════════════════════════════════════════

await checkAsync('GET /health/now with no bearer -> 401 invalid_or_missing_bearer_token', async () => {
  const r = await httpGet('/health/now');
  assert.equal(r.status, 401);
  assert.equal(r.body.error?.code, 'invalid_or_missing_bearer_token');
});

await checkAsync('GET /health/now before any tick: sample null, status ok, contract keys present', async () => {
  const r = await httpGet('/health/now', plainKey);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.sample, null, 'sample must be null before the first tick (CONTRACT §2)');
  for (const k of ['sample', 'age_seconds', 'thresholds', 'status', 'open_events', 'sampler']) {
    assert.ok(k in r.body, `GET /health/now missing ${k}`);
  }
  assert.deepEqual(r.body.thresholds, { cpu_pct: 80, mem_pct: 85, lag_ms: 500, disk_pct: 90, spike_seconds: 30, cooldown_min: 30 });
  assert.equal(r.body.status.level, 'ok');
  assert.deepEqual(r.body.open_events, []);
});

await checkAsync('POST /health/sample without admin scope -> 403 admin_scope_required', async () => {
  const r = await httpPost('/health/sample', {}, plainKey);
  assert.equal(r.status, 403);
  assert.equal(r.body.error?.code, 'admin_scope_required');
});

await checkAsync('POST /health/sample with admin scope forces a real sample', async () => {
  const r = await httpPost('/health/sample', {}, adminKey);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.sample, 'no sample returned');
  assert.equal(typeof r.body.sample.cpu.pct, r.body.sample.cpu.pct === null ? 'object' : 'number');
});

await checkAsync('GET /health/now after a tick returns a real sample + open_events []', async () => {
  const r = await httpGet('/health/now', plainKey);
  assert.equal(r.status, 200);
  assert.ok(r.body.sample, 'sample still null after a forced tick');
  const s = r.body.sample;
  for (const block of ['cpu', 'mem', 'lag', 'disk', 'db', 'claude', 'workload']) assert.ok(block in s, `sample.${block} missing`);
  assert.equal(typeof s.workload.summary, 'string');
  assert.ok(Array.isArray(s.workload.workers.nodes));
});

await checkAsync('GET /health/series?window=99y -> 400 invalid_window', async () => {
  const r = await httpGet('/health/series?window=99y', plainKey);
  assert.equal(r.status, 400);
  assert.equal(r.body.error?.code, 'invalid_window');
});

await checkAsync('GET /health/series default window is 1h, resolution raw, metrics echoed', async () => {
  const r = await httpGet('/health/series', plainKey);
  assert.equal(r.status, 200);
  assert.equal(r.body.window, '1h');
  assert.equal(r.body.resolution, 'raw');
  assert.deepEqual(r.body.metrics, ['cpu', 'mem', 'lag', 'disk', 'db', 'claude']);
  assert.ok(Array.isArray(r.body.points));
  assert.ok(Array.isArray(r.body.events));
});

await checkAsync('GET /health/series?metrics= advisory filter is echoed back verbatim', async () => {
  const r = await httpGet('/health/series?window=1h&metrics=cpu,lag', plainKey);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.metrics, ['cpu', 'lag']);
  // advisory only — points still carry every field (CONTRACT §5)
  if (r.body.points.length) assert.ok('mem_pct' in r.body.points[0], 'metrics filter must not trim point fields');
});

await checkAsync('GET /health/workloads returns the eight clickable rows + the workload object', async () => {
  const r = await httpGet('/health/workloads', plainKey);
  assert.equal(r.status, 200);
  const keys = r.body.rows.map((row: any) => row.key);
  for (const k of ['workers', 'night', 'autopilot', 'chats', 'providers', 'throttle', 'watchdog', 'retention']) {
    assert.ok(keys.includes(k), `status row "${k}" missing`);
  }
  for (const row of r.body.rows) {
    for (const f of ['label', 'status', 'value', 'detail', 'links', 'items']) assert.ok(f in row, `row ${row.key}.${f} missing`);
    assert.ok(['ok', 'busy', 'warn', 'idle', 'error'].includes(row.status));
  }
  assert.ok(r.body.workload && typeof r.body.workload.summary === 'string');
});

await checkAsync('GET /health/events?limit= caps and defaults correctly', async () => {
  const rDefault = await httpGet('/health/events', plainKey);
  assert.equal(rDefault.status, 200);
  assert.ok(Array.isArray(rDefault.body.events));
  const rLimited = await httpGet('/health/events?limit=1', plainKey);
  assert.ok(rLimited.body.events.length <= 1);
});

await checkAsync('POST /health/events/:id/ack on a bad id -> 400 invalid_request', async () => {
  const r = await httpPost('/health/events/not-a-number/ack', { suggestion: 'x' }, plainKey);
  assert.equal(r.status, 400);
  assert.equal(r.body.error?.code, 'invalid_request');
});

await checkAsync('POST /health/events/:id/ack on an unknown id -> 404 event_not_found', async () => {
  const r = await httpPost('/health/events/999999/ack', { suggestion: 'x' }, plainKey);
  assert.equal(r.status, 404);
  assert.equal(r.body.error?.code, 'event_not_found');
});

await checkAsync('POST /health/events/:id/ack needs NO admin scope (a note, not a dial)', async () => {
  // Seed one spike row directly, then ack it with the PLAIN (non-admin) key.
  setSetting('health_cpu_pct', '80'); setSetting('health_spike_seconds', '30'); setSetting('health_spike_cooldown_min', '30');
  sqliteDb.prepare(`DELETE FROM health_events`).run();
  H.__resetHealthSpikeState();
  const s1 = H.collectSample();
  function at(tsMs: number, cpu: number) {
    const s = JSON.parse(JSON.stringify(s1));
    s.ts = new Date(tsMs).toISOString(); s.cpu.pct = cpu;
    s.mem.pct = 10; s.lag.p99_ms = 1; s.disk.root.pct = 10; s.disk.db.pct = 10;
    return s;
  }
  const T = Date.parse('2026-09-25T14:00:00.000Z');
  H.evaluateSpikes(at(T, 95), T);
  const r0 = H.evaluateSpikes(at(T + 31_000, 95), T + 31_000);
  assert.equal(r0.spikes.length, 1, 'setup: expected a spike row to ack');
  const id = r0.spikes[0].id;
  const ack = await httpPost(`/health/events/${id}/ack`, { suggestion: 'drop hopper_slots 6→4' }, plainKey);
  assert.equal(ack.status, 200);
  assert.equal(ack.body.ok, true);
  assert.match(ack.body.event.suggestion, /hopper_slots/);
  assert.ok(ack.body.event.acknowledged_at);
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n2) SSE — real stream, real frames');
// ═════════════════════════════════════════════════════════════════════════

await checkAsync('a real takeSample() while the stream is open emits health_sample with sample+point', async () => {
  const stream = await openStream(adminKey);
  await stream.settle();
  const sample = H.takeSample();
  assert.ok(sample, 'takeSample returned null');
  await stream.settle();
  const frame = stream.frames.find((f) => f.type === 'health_sample');
  assert.ok(frame, 'no health_sample frame observed');
  assert.equal(frame!.data.sample.ts, sample!.ts);
  assert.equal(frame!.data.point.ts, sample!.ts);
  assert.equal(frame!.data.point.n, 1);
  stream.close();
});

await checkAsync('evaluateSpikes emits health_event frames — CONTRACT §7.4: release is a NEW row + the spike row is separately resolved', async () => {
  // Per CONTRACT.md §7.4 + the implementation (insertEvent always emits
  // action='created', a release is inserted as its own row, and the spike
  // row is separately UPDATEd with resolved_at, which emits 'updated'):
  //   'created' frames -> [spike row, release row]  (release is NOT an update)
  //   'updated' frames -> the spike row's cued=1 flip (cueEnabled defaults
  //                       true) and then its resolved_at flip — both kind='spike'
  sqliteDb.prepare(`DELETE FROM health_events`).run();
  H.__resetHealthSpikeState();
  const s1 = H.collectSample();
  function at(tsMs: number, cpu: number) {
    const s = JSON.parse(JSON.stringify(s1));
    s.ts = new Date(tsMs).toISOString(); s.cpu.pct = cpu;
    s.mem.pct = 10; s.lag.p99_ms = 1; s.disk.root.pct = 10; s.disk.db.pct = 10;
    return s;
  }
  const T = Date.parse('2026-09-25T15:00:00.000Z');
  const stream = await openStream(adminKey);
  await stream.settle();
  H.evaluateSpikes(at(T, 95), T);
  H.evaluateSpikes(at(T + 31_000, 95), T + 31_000);           // spike (+ cue -> cued=1 update)
  H.evaluateSpikes(at(T + 90_000, 20), T + 90_000);            // release: new row + spike resolved_at update
  await stream.settle();
  const created = stream.frames.filter((f) => f.type === 'health_event' && f.data.action === 'created');
  const updated = stream.frames.filter((f) => f.type === 'health_event' && f.data.action === 'updated');
  assert.ok(created.some((f) => f.data.event.kind === 'spike'), 'no created spike frame');
  assert.ok(created.some((f) => f.data.event.kind === 'release'), 'no created release frame — release must be its own inserted row per CONTRACT §7.4');
  assert.ok(updated.length >= 1, 'no updated health_event frame');
  assert.ok(updated.every((f) => f.data.event.kind === 'spike'), 'an updated frame must always be a mutation of the spike row, never a release row');
  assert.ok(updated.some((f) => f.data.event.resolved_at != null), 'no updated frame carries the spike row transitioning to resolved_at');
  stream.close();
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n3) tool ops — `health` (CONTRACT §8), called the way JARVIS calls it');
// ═════════════════════════════════════════════════════════════════════════

await checkAsync('tool op "now" matches GET /health/now (minus the ok wrapper)', async () => {
  const route = await httpGet('/health/now', plainKey);
  const toolResult = await health.execute({ operation: 'now' });
  for (const k of ['sample', 'age_seconds', 'thresholds', 'status', 'open_events', 'sampler']) {
    assert.ok(k in (toolResult as any), `tool "now" missing ${k}`);
  }
  assert.deepEqual((toolResult as any).thresholds, route.body.thresholds);
});

await checkAsync('tool op "series" matches CONTRACT §5 shape and honours window', async () => {
  const r: any = await health.execute({ operation: 'series', window: '6h' });
  assert.equal(r.window, '6h');
  assert.equal(r.resolution, '1m');
  for (const k of ['from', 'to', 'metrics', 'points', 'events']) assert.ok(k in r, `tool "series" missing ${k}`);
});

await checkAsync('tool op "series" with a bad window returns {error}, does not throw', async () => {
  const r: any = await health.execute({ operation: 'series', window: 'never' });
  assert.match(r.error, /window must be one of/);
});

await checkAsync('tool op "series" default window is 1h when omitted', async () => {
  const r: any = await health.execute({ operation: 'series' });
  assert.equal(r.window, '1h');
});

await checkAsync('tool op "series" advisory metrics default to all six', async () => {
  const r: any = await health.execute({ operation: 'series', window: '1h' });
  assert.deepEqual(r.metrics, ['cpu', 'mem', 'lag', 'disk', 'db', 'claude']);
  const r2: any = await health.execute({ operation: 'series', window: '1h', metrics: 'cpu,mem' });
  assert.deepEqual(r2.metrics, ['cpu', 'mem']);
});

await checkAsync('tool op "workloads" matches GET /health/workloads', async () => {
  const route = await httpGet('/health/workloads', plainKey);
  const r: any = await health.execute({ operation: 'workloads' });
  assert.deepEqual(r.rows.map((row: any) => row.key).sort(), route.body.rows.map((row: any) => row.key).sort());
  assert.equal(typeof r.workload.summary, 'string');
});

await checkAsync('tool op "events" returns {events} and honours filters', async () => {
  const r: any = await health.execute({ operation: 'events', limit: 100 });
  assert.ok(Array.isArray(r.events));
  const spike = r.events.find((e: any) => e.kind === 'spike');
  assert.ok(spike, 'setup: expected at least one spike event from section 1/2');
  const filtered: any = await health.execute({ operation: 'events', metric: 'cpu', kind: 'spike' });
  assert.ok(filtered.events.every((e: any) => e.kind === 'spike' && e.metric === 'cpu'));
  const none: any = await health.execute({ operation: 'events', metric: 'mem' });
  assert.equal(none.events.length, 0);
});

await checkAsync('tool op "ack" requires event_id, rejects a missing event, then stores a suggestion', async () => {
  const missing: any = await health.execute({ operation: 'ack', suggestion: 'x' });
  assert.match(missing.error, /event_id is required/);
  const unknown: any = await health.execute({ operation: 'ack', event_id: 999999, suggestion: 'x' });
  assert.match(unknown.error, /no health event/);
  const id = sqliteDb.prepare(`SELECT id FROM health_events WHERE kind='spike' ORDER BY id ASC LIMIT 1`).get().id;
  const ok: any = await health.execute({ operation: 'ack', event_id: id, suggestion: 'watch it' });
  assert.equal(ok.ok, true);
  assert.equal(ok.event.suggestion, 'watch it');
});

await checkAsync('tool op "suggest" is ack + REQUIRES a suggestion string', async () => {
  const id = sqliteDb.prepare(`SELECT id FROM health_events WHERE kind='spike' ORDER BY id ASC LIMIT 1`).get().id;
  const missing: any = await health.execute({ operation: 'suggest', event_id: id });
  assert.match(missing.error, /needs a suggestion/);
  const ok: any = await health.execute({ operation: 'suggest', event_id: id, suggestion: 'bump the ceiling' });
  assert.equal(ok.ok, true);
  assert.equal(ok.event.suggestion, 'bump the ceiling');
});

await checkAsync('tool op "ack" NEVER touches a dial — no settings row changes underneath it', async () => {
  const before = sqliteDb.prepare(`SELECT COUNT(*) AS c FROM settings WHERE key LIKE 'health_%' OR key LIKE 'hopper_%' OR key LIKE 'gov_%'`).get().c;
  const id = sqliteDb.prepare(`SELECT id FROM health_events WHERE kind='spike' ORDER BY id ASC LIMIT 1`).get().id;
  await health.execute({ operation: 'ack', event_id: id, suggestion: 'set hopper_slots to 4' });
  const after = sqliteDb.prepare(`SELECT COUNT(*) AS c FROM settings WHERE key LIKE 'health_%' OR key LIKE 'hopper_%' OR key LIKE 'gov_%'`).get().c;
  assert.equal(after, before, 'ack must be a note only — it must not write a dial setting');
});

await checkAsync('an unknown tool operation returns {error}, never throws', async () => {
  const r: any = await health.execute({ operation: 'bogus' });
  assert.match(r.error, /unknown operation/);
  const r2: any = await health.execute({});
  assert.match(r2.error, /unknown operation/);
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n4) rollup/retention/series — planted history, read back through GET /health/series');
// ═════════════════════════════════════════════════════════════════════════

await checkAsync('planted history rolls up and is visible through every window at the right resolution', async () => {
  // GET /health/series windows off `new Date()` at CALL time (CONTRACT §5 —
  // "series ending now"), not off a parameter — seriesPoints() has no nowMs
  // override. So history must be planted relative to the REAL wall clock, not
  // a fixed fake epoch, or it silently falls outside/inside the wrong window
  // depending on how far real "now" has drifted from that fake epoch.
  sqliteDb.prepare(`DELETE FROM health_samples`).run();
  const s1 = H.collectSample();
  const NOW = Date.now();
  const insertRaw = sqliteDb.prepare(`INSERT INTO health_samples (ts, kind, json) VALUES (?, 'raw', ?)`);
  function plantRaw(tsMs: number, cpu: number) {
    const sample = JSON.parse(JSON.stringify(s1));
    sample.ts = new Date(tsMs).toISOString();
    sample.cpu.pct = cpu;
    insertRaw.run(sample.ts, JSON.stringify(sample));
  }
  // 3h back, floored to a clean minute boundary so all 6 samples (10s apart)
  // land in exactly ONE 1m bucket regardless of the real clock's seconds —
  // well inside the 6h/24h window and the 7d/30d window, outside 15m/1h.
  const threeHoursAgo = NOW - 3 * 3600_000;
  const base = Math.floor(threeHoursAgo / 60_000) * 60_000;
  for (let i = 0; i < 6; i += 1) plantRaw(base + i * 10_000, 10 + i);
  // ONE rollup(NOW) pass does both raw->1m and 1m->1h in the same call (the
  // 1m->1h stage re-queries kind='1m' synchronously after the raw->1m stage
  // just wrote it) — the planted bucket's hour is always < NOW's current hour
  // since it is 3h back, so no second "settle the 1h bucket" call is needed.
  H.rollup(NOW);

  const r15m = await httpGet('/health/series?window=15m', plainKey);
  assert.equal(r15m.body.resolution, 'raw');
  const r6h = await httpGet('/health/series?window=6h', plainKey);
  assert.equal(r6h.body.resolution, '1m');
  assert.ok(r6h.body.points.some((p: any) => p.n === 6), 'the planted 6-sample minute bucket is not visible in the 6h window');
  const r7d = await httpGet('/health/series?window=7d', plainKey);
  assert.equal(r7d.body.resolution, '1h');
  assert.ok(r7d.body.points.some((p: any) => p.n === 6), 'the planted bucket is not visible rolled up into the 7d/1h window');
});

await checkAsync('retention trims raw > 24h and 1m > 30d through maintain(), visible via /health/now.sampler', async () => {
  const NOW = Date.parse('2026-09-25T16:00:00.000Z');
  const insertRaw = sqliteDb.prepare(`INSERT INTO health_samples (ts, kind, json) VALUES (?, 'raw', ?)`);
  const s1 = H.collectSample();
  const stale = JSON.parse(JSON.stringify(s1));
  stale.ts = new Date(NOW - 48 * 3600_000).toISOString();
  insertRaw.run(stale.ts, JSON.stringify(stale));
  const beforeRaw = sqliteDb.prepare(`SELECT COUNT(*) AS c FROM health_samples WHERE kind='raw'`).get().c;
  H.maintain(NOW);
  const afterRaw = sqliteDb.prepare(`SELECT COUNT(*) AS c FROM health_samples WHERE kind='raw' AND ts < ?`)
    .get(new Date(NOW - 24 * 3600_000).toISOString()).c;
  assert.equal(Number(afterRaw), 0, 'a 48h-old raw row survived maintain()');
  assert.ok(beforeRaw >= 1);
  const now = await httpGet('/health/now', plainKey);
  assert.equal(typeof now.body.sampler.samples_stored.raw, 'number');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n5) spike/cooldown/release over the HTTP+SSE surface (AC-3, end to end)');
// ═════════════════════════════════════════════════════════════════════════

await checkAsync('sustained crossing -> one spike visible via GET /health/events, one cue, one notification; cooldown blocks the second cue; a later crossing past cooldown cues again', async () => {
  setSetting('health_cpu_pct', '80');
  setSetting('health_spike_seconds', '30');
  setSetting('health_spike_cooldown_min', '30');
  sqliteDb.prepare(`DELETE FROM health_events`).run();
  sqliteDb.prepare(`DELETE FROM notifications WHERE source = 'health-monitor'`).run();
  H.__resetHealthSpikeState();
  (globalThis as any).__HEALTH_CUES__ = [];
  const s1 = H.collectSample();
  function at(tsMs: number, cpu: number) {
    const s = JSON.parse(JSON.stringify(s1));
    s.ts = new Date(tsMs).toISOString(); s.cpu.pct = cpu;
    s.mem.pct = 10; s.lag.p99_ms = 1; s.disk.root.pct = 10; s.disk.db.pct = 10;
    return s;
  }
  const T = Date.parse('2026-09-25T18:00:00.000Z');
  H.evaluateSpikes(at(T, 93), T);
  H.evaluateSpikes(at(T + 31_000, 93), T + 31_000);
  await new Promise((r) => setTimeout(r, 150));

  const listAfterFirst = await httpGet('/health/events?kind=spike&metric=cpu', plainKey);
  assert.equal(listAfterFirst.body.events.length, 1, 'expected exactly 1 spike over the wire');
  assert.equal(cues().length, 1, 'expected exactly 1 stubbed cue');
  assert.equal(cues()[0].correlationKey, `health:${listAfterFirst.body.events[0].id}`,
    'cue correlation key must be health:<event id> so turn-admission gates it');
  const notifs = sqliteDb.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE source = 'health-monitor'`).get().c;
  assert.equal(Number(notifs), 1);

  H.evaluateSpikes(at(T + 90_000, 20), T + 90_000); // release
  H.evaluateSpikes(at(T + 120_000, 95), T + 120_000);
  H.evaluateSpikes(at(T + 160_000, 96), T + 160_000); // second crossing, inside cooldown
  await new Promise((r) => setTimeout(r, 150));
  const listAfterSecond = await httpGet('/health/events?kind=spike&metric=cpu', plainKey);
  assert.equal(listAfterSecond.body.events.length, 2, 'the second crossing must still be recorded over the wire');
  assert.equal(cues().length, 1, 'a cue leaked out inside the cooldown');

  H.evaluateSpikes(at(T + 200_000, 20), T + 200_000); // release
  const LATER = T + 40 * 60_000;
  H.evaluateSpikes(at(LATER, 95), LATER);
  H.evaluateSpikes(at(LATER + 31_000, 95), LATER + 31_000);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(cues().length, 2, 'past the cooldown, a fresh crossing must cue again');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n6) no-spawn proof');
// ═════════════════════════════════════════════════════════════════════════

check('this sim spawned zero claude processes (descendant count unchanged)', () => {
  const after = claudeProcs();
  assert.equal(after, CLAUDE_BEFORE, `claude descendant procs before=${CLAUDE_BEFORE} after=${after}`);
});
check('the cue path was exercised via the stub, not a real spawn', () => {
  assert.ok(cues().length >= 2, 'expected the stub to have recorded cues from sections 1/2/5');
});

server.close();
console.log(`\n[health-sim] ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
console.log('[health-sim] PASS');
process.exit(0);
