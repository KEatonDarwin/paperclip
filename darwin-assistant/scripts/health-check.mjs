// COCKPIT HEALTH CHECK (tree-2a693306, node #858) — exercises src/health-monitor.ts
// against a SCRATCH sqlite DB. Deterministic, < 60 s, ZERO claude processes:
// dist/agent.js is swapped for a recorder by scripts/health-check.hooks.mjs, so
// the spike cue is OBSERVED rather than fired (a sim that isolates its database
// has not thereby isolated the model — see src/sim-guard.ts).
//
//   npm run health:check
//   == npm run build && JARVIS_DB_PATH=/tmp/health-check.db JARVIS_SIM=1 \
//        node --import ./scripts/health-check.hooks.mjs scripts/health-check.mjs
//
// Covers: sampler math · point projection · rollup (raw→1m→1h, idempotent) ·
// retention trim · window→resolution map · aggregate math (mean/max/last) ·
// the spike state machine incl. AC-3 (one spike, one cue, one notification, a
// release, and NO second cue inside the cooldown).

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const raw = process.env.JARVIS_DB_PATH ?? '/tmp/health-check.db';
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db. Use a /tmp scratch path.');
  process.exit(1);
}
process.env.JARVIS_DB_PATH = DB_PATH;
process.env.JARVIS_SIM = '1';
process.env.HEALTH_MONITOR = '0';        // never start the real interval here
delete process.env.ANTHROPIC_API_KEY;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[health-check] scratch DB: ${DB_PATH}`);

register(pathToFileURL(path.join(__dirname, 'health-check.hooks.mjs')), import.meta.url);

const distDir = path.join(repoRoot, 'dist');
const H = await import(path.join(distDir, 'health-monitor.js'));
const { sqliteDb, setSetting } = await import(path.join(distDir, 'conversation-db.js'));

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (err) { fails.push(name); console.log(`  FAIL ${name}\n       ${err.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (err) { fails.push(name); console.log(`  FAIL ${name}\n       ${err.message}`); }
}
const cues = () => globalThis.__HEALTH_CUES__ ?? [];
async function settle(ms = 250) { await new Promise((r) => setTimeout(r, ms)); }
const countEvents = (kind, metric) => Number(sqliteDb
  .prepare(`SELECT COUNT(*) AS c FROM health_events WHERE kind = ? AND metric = ?`)
  .get(kind, metric).c);
const countNotifications = () => {
  try {
    return Number(sqliteDb.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE source = 'health-monitor'`).get().c);
  } catch { return -1; }
};

// ── 1) SAMPLER: one real collection, every §1.1 field, cheap ────────────────
console.log('\n1) sampler');
const s0 = H.collectSample();
check('collectSample returns a sample', () => assert.ok(s0, 'collectSample returned null'));
check('cpu block (pct null on the first delta, load + cores real)', () => {
  assert.equal(typeof s0.cpu.load1, 'number');
  assert.ok(s0.cpu.cores > 0, 'cores must be > 0');
});
check('mem block has system + jarvis rss/heap', () => {
  assert.ok(s0.mem.total_mb > 0 && s0.mem.pct > 0 && s0.mem.pct <= 100);
  assert.ok(s0.mem.rss_mb > 0 && s0.mem.heap_used_mb > 0 && s0.mem.heap_total_mb > 0);
});
check('lag block p50/p99/max are finite ms', () => {
  for (const k of ['p50_ms', 'p99_ms', 'max_ms']) assert.ok(Number.isFinite(s0.lag[k]), `${k} not finite`);
});
check('disk block covers / and the db dir', () => {
  assert.equal(s0.disk.root.path, '/');
  assert.ok(s0.disk.root.total_mb > 0 && s0.disk.root.pct > 0);
  assert.ok(s0.disk.db.total_mb > 0);
});
check('db block: bytes/wal/pages/freelist/writes/api', () => {
  for (const k of ['bytes', 'wal_bytes', 'total_bytes', 'page_count', 'page_size',
                   'freelist_count', 'freelist_pct', 'turns_written', 'writes',
                   'writes_per_min', 'api_requests', 'api_requests_per_min']) {
    assert.equal(typeof s0.db[k], 'number', `db.${k} missing`);
  }
  assert.ok(s0.db.bytes > 0, 'scratch db should have a size on disk');
  assert.equal(s0.db.total_bytes, s0.db.bytes + s0.db.wal_bytes);
});
check('claude block counts processes with a named source', () => {
  assert.ok(Number.isFinite(s0.claude.processes));
  assert.ok(['pgrep', 'active_runs'].includes(s0.claude.source));
});
check('workload snapshot has workers/turns/night/autopilot/providers/accounts/throttle/summary', () => {
  const w = s0.workload;
  for (const k of ['workers', 'turns', 'autopilot', 'providers', 'accounts', 'throttle', 'summary']) {
    assert.ok(k in w, `workload.${k} missing`);
  }
  assert.ok('night' in w, 'workload.night missing');
  assert.equal(typeof w.summary, 'string');
  assert.ok(Array.isArray(w.workers.nodes));
});
// The second sample is the one with a real cpu delta.
const s1 = H.collectSample();
check('second sample yields a real cpu %', () => {
  assert.ok(s1.cpu.pct !== null, 'cpu.pct still null on the 2nd sample');
  assert.ok(s1.cpu.pct >= 0 && s1.cpu.pct <= 100, `cpu.pct out of range: ${s1.cpu.pct}`);
});
check('tick cost is recorded and under the 5 ms rail', () => {
  assert.ok(Number.isFinite(s1.tick_ms), 'tick_ms not recorded');
  assert.ok(s1.tick_ms < 25, `tick_ms ${s1.tick_ms} — wildly over budget`);
});
check('rates are not extrapolated from a sub-second interval', () => {
  // Two samples back to back => interval ~1 ms. Before the floor this reported
  // writes_per_min in the tens of thousands — a monitor inventing the very spike
  // it exists to explain. Found by scripts/health-route-check.mjs on the box.
  const a = H.collectSample();
  const b = H.collectSample();
  assert.ok(b.interval_ms < 1000, `expected a sub-second interval, got ${b.interval_ms}`);
  assert.ok(b.db.writes_per_min <= b.db.writes * 60 + 0.1,
    `writes_per_min ${b.db.writes_per_min} extrapolated from ${b.db.writes} writes in ${b.interval_ms}ms`);
  assert.ok(b.db.api_requests_per_min <= b.db.api_requests * 60 + 0.1,
    `api_requests_per_min ${b.db.api_requests_per_min} over-extrapolated`);
  assert.ok(a);
});
check('toPoint projects a sample onto the chart row', () => {
  const p = H.toPoint(s1);
  assert.equal(p.ts, s1.ts);
  assert.equal(p.n, 1);
  assert.equal(p.cpu_pct, s1.cpu.pct);
  assert.equal(p.lag_p99_ms, s1.lag.p99_ms);
  assert.equal(p.workers, s1.workload.workers.total);
});
console.log(`     tick_ms: first=${s0.tick_ms} second=${s1.tick_ms} avg=${H.samplerStats().avg_tick_ms}`);

check('workload snapshot stamps as_of/age_seconds', () => {
  const w = H.workloadSnapshot({ force: true });
  assert.equal(typeof w.as_of, 'string');
  assert.equal(w.age_seconds, 0, 'a forced compose is by definition zero-age');
  assert.ok(Date.parse(w.as_of) > 0, 'as_of must parse');
});
check('the throttle composite is cached but the worker list is LIVE', () => {
  setSetting('health_workload_ttl_seconds', '600');
  H.__resetWorkloadCache();
  const first = H.workloadSnapshot();
  assert.equal(first.age_seconds, 0, 'the first compose should be fresh');
  const second = H.workloadSnapshot();
  assert.ok(second.age_seconds >= 0, 'the second read should come off the cache');
  assert.equal(second.workers.total, second.workers.nodes.length,
    'workers.total must be the LIVE node count, never the cached one');
  setSetting('health_workload_ttl_seconds', '0');
  const uncached = H.workloadSnapshot();
  assert.equal(uncached.age_seconds, 0, 'ttl 0 must disable the cache entirely');
  sqliteDb.prepare(`DELETE FROM settings WHERE key = 'health_workload_ttl_seconds'`).run();
  H.__resetWorkloadCache();
});

// ── 2) AGGREGATE MATH: mean for rates, max in *_max, LAST for levels ────────
console.log('\n2) aggregate math');
check('aggregatePoints means rates, peaks *_max, takes the LAST level', () => {
  const mk = (ts, cpu, dbBytes, workers) => ({
    ts, n: 1, cpu_pct: cpu, cpu_pct_max: cpu, load1: 1,
    mem_pct: 50, mem_pct_max: 50, rss_mb: 100, rss_mb_max: 100,
    lag_p50_ms: 1, lag_p99_ms: 10, lag_p99_ms_max: 10, lag_max_ms: 12,
    disk_root_pct: 40, disk_db_pct: 41,
    db_bytes: dbBytes, db_wal_bytes: 0, db_freelist_pct: 0,
    db_writes_per_min: 10, db_writes_per_min_max: 10,
    api_per_min: 5, api_per_min_max: 5,
    claude_procs: 1, claude_procs_max: 1,
    workers, workers_max: workers, turns_active: 0, turns_active_max: 0,
  });
  const agg = H.aggregatePoints('2026-09-25T00:00:00.000Z', [
    mk('2026-09-25T00:00:10.000Z', 10, 1000, 2),
    mk('2026-09-25T00:00:20.000Z', 90, 2000, 6),
  ]);
  assert.equal(agg.n, 2, 'n must sum');
  assert.equal(agg.cpu_pct, 50, 'cpu mean');
  assert.equal(agg.cpu_pct_max, 90, 'cpu peak must survive the rollup');
  assert.equal(agg.db_bytes, 2000, 'db size is a LEVEL — take the last, never the mean');
  assert.equal(agg.disk_root_pct, 40, 'disk % is a level');
  assert.equal(agg.workers, 4, 'workers mean');
  assert.equal(agg.workers_max, 6, 'workers peak');
});
check('a bucket of all-null values aggregates to null, not NaN', () => {
  const empty = { ts: 'x', n: 1, cpu_pct: null, cpu_pct_max: null, load1: null,
    mem_pct: null, mem_pct_max: null, rss_mb: null, rss_mb_max: null,
    lag_p50_ms: null, lag_p99_ms: null, lag_p99_ms_max: null, lag_max_ms: null,
    disk_root_pct: null, disk_db_pct: null, db_bytes: null, db_wal_bytes: null,
    db_freelist_pct: null, db_writes_per_min: null, db_writes_per_min_max: null,
    api_per_min: null, api_per_min_max: null, claude_procs: null, claude_procs_max: null,
    workers: null, workers_max: null, turns_active: null, turns_active_max: null };
  const agg = H.aggregatePoints('2026-09-25T00:00:00.000Z', [empty, empty]);
  assert.equal(agg.cpu_pct, null);
  assert.equal(agg.db_bytes, null);
});

// ── 3) WINDOW → RESOLUTION ─────────────────────────────────────────────────
console.log('\n3) window → resolution');
check('15m/1h read raw; 6h/24h read 1m; 7d/30d read 1h (AC-2)', () => {
  assert.equal(H.resolutionFor('15m'), 'raw');
  assert.equal(H.resolutionFor('1h'), 'raw');
  assert.equal(H.resolutionFor('6h'), '1m');
  assert.equal(H.resolutionFor('24h'), '1m');
  assert.equal(H.resolutionFor('7d'), '1h');
  assert.equal(H.resolutionFor('30d'), '1h');
});
check('isHealthWindow rejects junk', () => {
  assert.equal(H.isHealthWindow('1h'), true);
  assert.equal(H.isHealthWindow('99y'), false);
  assert.equal(H.isHealthWindow(undefined), false);
});

// ── 4) ROLLUP + RETENTION on planted history ───────────────────────────────
console.log('\n4) rollup + retention');
const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const insertRaw = sqliteDb.prepare(`INSERT INTO health_samples (ts, kind, json) VALUES (?, 'raw', ?)`);
sqliteDb.prepare(`DELETE FROM health_samples`).run();
function plantRaw(tsMs, cpu) {
  const sample = JSON.parse(JSON.stringify(s1));
  sample.ts = new Date(tsMs).toISOString();
  sample.cpu.pct = cpu;
  insertRaw.run(sample.ts, JSON.stringify(sample));
}
// Two complete minutes inside one hour, 3 h back (so they are complete buckets),
// plus one raw row 48 h old (must be trimmed) and one 1m row 60 d old.
const base = Date.parse('2026-09-25T09:00:00.000Z');
for (let i = 0; i < 6; i += 1) plantRaw(base + i * 10_000, 10 + i);          // 09:00 bucket
for (let i = 0; i < 6; i += 1) plantRaw(base + 60_000 + i * 10_000, 70 + i); // 09:01 bucket
plantRaw(NOW - 48 * 3600_000, 5);                                            // stale raw
sqliteDb.prepare(`INSERT INTO health_samples (ts, kind, json) VALUES (?, '1m', ?)`)
  .run(new Date(NOW - 60 * 86_400_000).toISOString(), JSON.stringify(H.toPoint(s1)));

const rolled = H.rollup(NOW);
check('rollup writes the complete 1m buckets', () => {
  assert.ok(rolled.m1 >= 3, `expected >= 3 minute buckets, got ${rolled.m1}`);
  const m = sqliteDb.prepare(`SELECT ts, json FROM health_samples WHERE kind='1m' AND ts = ?`)
    .get('2026-09-25T09:00:00.000Z');
  assert.ok(m, 'the 09:00 minute bucket is missing');
  const p = JSON.parse(m.json);
  assert.equal(p.n, 6, 'bucket should carry 6 raw points');
  assert.equal(p.cpu_pct, 12.5, `mean of 10..15 should be 12.5, got ${p.cpu_pct}`);
  assert.equal(p.cpu_pct_max, 15, 'peak must be preserved');
});
check('rollup writes the complete 1h bucket from the 1m rows', () => {
  const h = sqliteDb.prepare(`SELECT json FROM health_samples WHERE kind='1h' AND ts = ?`)
    .get('2026-09-25T09:00:00.000Z');
  assert.ok(h, 'the 09:00 hour bucket is missing');
  const p = JSON.parse(h.json);
  assert.equal(p.n, 12, `hour bucket should carry 12 raw points, got ${p.n}`);
  assert.equal(p.cpu_pct_max, 75, 'the 09:01 peak must survive two rollup hops');
});
check('rollup is idempotent (re-running never duplicates a bucket)', () => {
  const before = H.sampleCounts();
  H.rollup(NOW);
  const after = H.sampleCounts();
  assert.deepEqual(after, before, `counts changed on a second rollup: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
});
check('an incomplete (current) minute is never frozen', () => {
  plantRaw(NOW - 5_000, 99);
  const n = H.rollup(NOW).m1;
  const cur = sqliteDb.prepare(`SELECT COUNT(*) AS c FROM health_samples WHERE kind='1m' AND ts >= ?`)
    .get('2026-09-25T12:00:00.000Z').c;
  assert.equal(Number(cur), 0, 'the in-progress minute must not be rolled up');
  assert.ok(n >= 0);
});
check('trimRetention drops raw > 24 h and 1m > 30 d, keeps 1h forever (AC-2)', () => {
  const beforeH1 = H.sampleCounts().h1;
  const trimmed = H.trimRetention(NOW);
  assert.ok(trimmed.raw >= 1, `expected the 48 h-old raw row to be trimmed, got ${trimmed.raw}`);
  assert.ok(trimmed.m1 >= 1, `expected the 60 d-old 1m row to be trimmed, got ${trimmed.m1}`);
  const stale = sqliteDb.prepare(`SELECT COUNT(*) AS c FROM health_samples WHERE kind='raw' AND ts < ?`)
    .get(new Date(NOW - 24 * 3600_000).toISOString()).c;
  assert.equal(Number(stale), 0, 'stale raw rows survived the trim');
  assert.equal(H.sampleCounts().h1, beforeH1, '1h rollups must never be trimmed');
});
check('maintain() = rollup + trim in one pass', () => {
  const r = H.maintain(NOW);
  assert.ok(r.rolled && r.trimmed, 'maintain must report both halves');
});
check('seriesPoints reads the right table per window', () => {
  const wide = H.seriesPoints('30d');            // → 1h
  assert.equal(wide.resolution, '1h');
  assert.ok(wide.points.length >= 1, 'the 1h bucket should be visible in a 30d window');
  const narrow = H.seriesPoints('1h');           // → raw
  assert.equal(narrow.resolution, 'raw');
});

// ── 5) SPIKE STATE MACHINE (AC-3) ──────────────────────────────────────────
console.log('\n5) spike state machine (AC-3)');
setSetting('health_cpu_pct', '80');
setSetting('health_spike_seconds', '30');
setSetting('health_spike_cooldown_min', '30');
sqliteDb.prepare(`DELETE FROM health_events`).run();
H.__resetHealthSpikeState();
globalThis.__HEALTH_CUES__ = [];

function sampleAt(tsMs, cpu) {
  const s = JSON.parse(JSON.stringify(s1));
  s.ts = new Date(tsMs).toISOString();
  s.cpu.pct = cpu;
  s.mem.pct = 10; s.lag.p99_ms = 1;
  s.disk.root.pct = 10; s.disk.db.pct = 10;
  return s;
}
const T = Date.parse('2026-09-25T10:00:00.000Z');

check('a single over-threshold sample does NOT fire (not sustained yet)', () => {
  const r = H.evaluateSpikes(sampleAt(T, 95), T);
  assert.equal(r.spikes.length, 0, 'fired before the sustain window elapsed');
  assert.equal(countEvents('spike', 'cpu'), 0);
});
check('still nothing at +20 s (< health_spike_seconds)', () => {
  const r = H.evaluateSpikes(sampleAt(T + 20_000, 92), T + 20_000);
  assert.equal(r.spikes.length, 0);
});
await checkAsync('sustained 30 s → exactly ONE spike + ONE cue + ONE notification', async () => {
  const r = H.evaluateSpikes(sampleAt(T + 31_000, 93), T + 31_000);
  assert.equal(r.spikes.length, 1, `expected 1 spike, got ${r.spikes.length}`);
  assert.equal(r.cues, 1, `expected 1 cue, got ${r.cues}`);
  assert.equal(countEvents('spike', 'cpu'), 1, 'more than one spike row written');
  assert.equal(countNotifications(), 1, `expected exactly 1 notification, got ${countNotifications()}`);
  await settle();
  assert.equal(cues().length, 1, `expected 1 stubbed cue, got ${cues().length}`);
  assert.equal(cues()[0].externalId, H.HEALTH_THREAD_EXT);
  assert.equal(cues()[0].correlationKey, `health:${r.spikes[0].id}`,
    'the cue must carry the health: correlation key so turn-admission gates it');
  assert.match(cues()[0].text, /health spike #\d+/);
  assert.match(cues()[0].text, /WHAT WAS RUNNING/);
  assert.match(cues()[0].text, /health ack/);
  assert.match(cues()[0].text, /Do NOT change any dial yourself/);
});
check('while still over, no SECOND spike row is written', () => {
  const r = H.evaluateSpikes(sampleAt(T + 60_000, 97), T + 60_000);
  assert.equal(r.spikes.length, 0, 'a second spike row was written for one crossing');
  assert.equal(countEvents('spike', 'cpu'), 1);
});
check('dropping under threshold writes a release and resolves the spike', () => {
  const r = H.evaluateSpikes(sampleAt(T + 90_000, 20), T + 90_000);
  assert.equal(r.releases.length, 1, `expected 1 release, got ${r.releases.length}`);
  const row = sqliteDb.prepare(`SELECT resolved_at FROM health_events WHERE kind='spike' AND metric='cpu'`).get();
  assert.ok(row.resolved_at, 'the spike row was never resolved');
});
await checkAsync('a SECOND crossing inside the cooldown writes an event but NO cue (AC-3)', async () => {
  const cuesBefore = cues().length;
  H.evaluateSpikes(sampleAt(T + 120_000, 95), T + 120_000);
  const r = H.evaluateSpikes(sampleAt(T + 160_000, 96), T + 160_000);
  assert.equal(r.spikes.length, 1, 'the second crossing must still be recorded');
  assert.equal(r.cues, 0, 'a cue fired inside the cooldown');
  assert.equal(countEvents('spike', 'cpu'), 2, 'the second spike row is missing');
  assert.equal(r.spikes[0].cued, false, 'the second spike must not be flagged cued');
  await settle();
  assert.equal(cues().length, cuesBefore, 'an extra cue leaked out inside the cooldown');
});
await checkAsync('past the cooldown, a fresh crossing cues again', async () => {
  H.evaluateSpikes(sampleAt(T + 200_000, 20), T + 200_000);          // release
  const LATER = T + 40 * 60_000;                                      // > 30 min
  H.evaluateSpikes(sampleAt(LATER, 95), LATER);
  const r = H.evaluateSpikes(sampleAt(LATER + 31_000, 95), LATER + 31_000);
  assert.equal(r.cues, 1, 'the cooldown never expired');
  await settle();
  assert.equal(cues().length, 2, `expected 2 cues total, got ${cues().length}`);
});
check('metricValue/metricsOverThreshold read the right fields', () => {
  const s = sampleAt(T, 95);
  s.lag.p99_ms = 900; s.disk.root.pct = 10; s.disk.db.pct = 95;
  assert.equal(H.metricValue(s, 'cpu'), 95);
  assert.equal(H.metricValue(s, 'lag'), 900);
  assert.equal(H.metricValue(s, 'disk'), 95, 'disk takes the WORSE of root and db dir');
  const over = H.metricsOverThreshold(s);
  assert.ok(over.includes('cpu') && over.includes('lag') && over.includes('disk'));
  assert.ok(!over.includes('mem'));
});
check('ack stores the suggestion on the event', () => {
  const id = sqliteDb.prepare(`SELECT id FROM health_events WHERE kind='spike' ORDER BY id ASC LIMIT 1`).get().id;
  const ev = H.ackHealthEvent(id, 'drop hopper_slots 6→4 until the 5h window resets');
  assert.ok(ev, 'ack returned null');
  assert.match(ev.suggestion, /hopper_slots/);
  assert.ok(ev.acknowledged_at, 'acknowledged_at not stamped');
  assert.equal(H.ackHealthEvent(999999, 'x'), null, 'ack of a missing event must return null');
});

// ── 6) READ SURFACES ───────────────────────────────────────────────────────
console.log('\n6) read surfaces');
check('healthNow() matches CONTRACT §6 (sample+age+thresholds+status+open_events+sampler)', () => {
  const now = H.healthNow();
  for (const k of ['sample', 'age_seconds', 'thresholds', 'status', 'open_events', 'sampler']) {
    assert.ok(k in now, `healthNow().${k} missing`);
  }
  // The workload snapshot rides INSIDE the sample (CONTRACT §2), not alongside it.
  assert.ok(now.sample && now.sample.workload, 'healthNow().sample.workload missing');
  assert.equal(now.thresholds.cpu_pct, 80);
  assert.equal(now.thresholds.spike_seconds, 30);
  assert.ok(['ok', 'spike'].includes(now.status.level));
  assert.ok(Array.isArray(now.open_events));
  assert.equal(typeof now.sampler.interval_seconds, 'number');
  assert.ok(now.sampler.samples_stored && typeof now.sampler.samples_stored.raw === 'number');
});
check('workloadRows() returns the eight clickable status rows', () => {
  const { rows } = H.workloadRows();
  const keys = rows.map((r) => r.key);
  for (const k of ['workers', 'night', 'autopilot', 'chats', 'providers', 'throttle', 'watchdog', 'retention']) {
    assert.ok(keys.includes(k), `status row "${k}" missing`);
  }
  for (const r of rows) {
    assert.ok(['ok', 'busy', 'warn', 'idle', 'error'].includes(r.status), `row ${r.key} has status ${r.status}`);
    assert.equal(typeof r.label, 'string');
  }
});
check('listHealthEvents filters by kind and metric', () => {
  assert.ok(H.listHealthEvents({ limit: 100 }).length >= 3);
  assert.ok(H.listHealthEvents({ kind: 'release' }).every((e) => e.kind === 'release'));
  assert.equal(H.listHealthEvents({ metric: 'mem' }).length, 0);
});
check('settings defaults match DESIGN.md on a fresh box', () => {
  sqliteDb.prepare(`DELETE FROM settings WHERE key LIKE 'health_%'`).run();
  const t = H.thresholds();
  assert.equal(t.cpu_pct, 80); assert.equal(t.mem_pct, 85);
  assert.equal(t.lag_ms, 500); assert.equal(t.disk_pct, 90);
  assert.equal(t.spike_seconds, 30); assert.equal(t.cooldown_min, 30);
  assert.equal(H.sampleSeconds(), 5);
  assert.equal(H.rollupMinutes(), 5);
  assert.equal(H.retainRawHours(), 24);
  assert.equal(H.retain1mDays(), 30);
  assert.equal(H.workloadTtlSeconds(), 60);
  assert.equal(H.monitorModel(), 'claude-sonnet-5');
  assert.equal(H.healthEnabled(), true);
  assert.equal(H.cueEnabled(), true);
});
check('out-of-range settings clamp instead of poisoning the sampler', () => {
  setSetting('health_sample_seconds', '-9');
  assert.equal(H.sampleSeconds(), 1, 'a negative cadence must clamp to the floor');
  setSetting('health_sample_seconds', 'banana');
  assert.equal(H.sampleSeconds(), 5, 'junk must fall back to the default');
  setSetting('health_cpu_pct', '9999');
  assert.equal(H.thresholds().cpu_pct, 100, 'a > 100 cpu threshold must clamp');
  sqliteDb.prepare(`DELETE FROM settings WHERE key LIKE 'health_%'`).run();
});

// ── 7) HERMETIC ────────────────────────────────────────────────────────────
console.log('\n7) hermetic');
check('SSE contract carries both health events', async () => {
  // Read the built contract rather than re-declaring it here.
  const busPath = path.join(distDir, 'sse-bus.js');
  const src = fs.readFileSync(busPath, 'utf8');
  assert.match(src, /'health_sample'/, 'health_sample missing from GLOBAL_STREAM_EVENT_TYPES');
  assert.match(src, /'health_event'/, 'health_event missing from GLOBAL_STREAM_EVENT_TYPES');
});
check('turn-admission gates the health: prefix', () => {
  const src = fs.readFileSync(path.join(distDir, 'turn-admission.js'), 'utf8');
  assert.match(src, /'health:'/, "the 'health:' prefix is not in AUTOMATED_KEY_PREFIXES");
});
check('the health tool is registered in ALL_TOOLS', () => {
  const src = fs.readFileSync(path.join(distDir, 'tools', 'index.js'), 'utf8');
  assert.match(src, /health/, 'health tool not registered');
});

await checkAsync('health-tool.js imports standalone (no circular-import TDZ)', async () => {
  // REGRESSION: the tool read HEALTH_WINDOWS from health-monitor.js at module
  // top level. tools/index.js is reachable from health-monitor's own graph via
  // agent.js, so on the real boot path the tool initialised while health-monitor
  // was still evaluating and threw "Cannot access 'HEALTH_WINDOWS' before
  // initialization" — at import time, killing the service. Importing the tool
  // FIRST, before health-monitor, reproduces that order.
  const url = pathToFileURL(path.join(distDir, 'tools', 'health-tool.js')).href + `?tdz=${Date.now()}`;
  const mod = await import(url);
  assert.ok(mod.health, 'the health tool did not load');
  assert.equal(mod.health.name, 'health');
});
check('the tool window enum matches isHealthWindow exactly', () => {
  const enumList = H.HEALTH_WINDOWS;
  const toolSrc = fs.readFileSync(path.join(distDir, 'tools', 'health-tool.js'), 'utf8');
  for (const w of enumList) assert.ok(toolSrc.includes(`'${w}'`), `tool enum is missing window ${w}`);
  const declared = (toolSrc.match(/WINDOW_ENUM = \[([^\]]+)\]/) ?? [])[1] ?? '';
  const parsed = declared.split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(parsed, [...enumList], 'WINDOW_ENUM has drifted from HEALTH_WINDOWS');
});
check('the bucket upsert prepares against the PARTIAL index', () => {
  // REGRESSION: `ON CONFLICT(kind, ts)` without the index predicate raises
  // "does not match any PRIMARY KEY or UNIQUE constraint" at PREPARE time, and
  // that prepare is module-level — every fresh DB would have failed to boot.
  const src = fs.readFileSync(path.join(distDir, 'health-monitor.js'), 'utf8');
  assert.match(src, /ON CONFLICT\(kind, ts\) WHERE kind != 'raw'/,
    'the upsert conflict target must repeat the partial index predicate');
});

console.log(`\n[health-check] ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
console.log('[health-check] PASS');
process.exit(0);
