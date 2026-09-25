// HEALTH ROUTE CHECK (tree-2a693306, node #858) — AC-1 and AC-2 over real HTTP.
//
// Mounts the REAL createApiV1Router() on a throwaway express app against a
// SCRATCH database on a temp port, takes two real samples off this box, plants a
// little history, and prints every field of GET /health/now plus the resolution
// each window resolves to. Nothing here touches the live DB or the live server.
//
//   npm run health:route-check
import path from 'node:path';
import fs from 'node:fs';

const DB = '/tmp/health-route-probe.db';
for (const p of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(p, { force: true });
process.env.JARVIS_DB_PATH = DB;
process.env.JARVIS_SIM = '1';
process.env.HEALTH_MONITOR = '0';
const PORT = Number(process.env.HEALTH_PROBE_PORT ?? 3999);

const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(dist, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(dist, 'api-keys.js'));
const H = await import(path.join(dist, 'health-monitor.js'));

const { plaintext } = mintApiKey('health-route-probe', 'admin');
const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = app.listen(PORT);
await new Promise((r) => server.once('listening', r));

// Two samples so cpu has a real delta, plus a planted rollup for the 7d window.
H.takeSample();
await new Promise((r) => setTimeout(r, 1100));
H.takeSample();
const { sqliteDb } = await import(path.join(dist, 'conversation-db.js'));
const old = Date.now() - 3 * 3600_000;
for (let i = 0; i < 4; i += 1) {
  const s = H.collectSample();
  s.ts = new Date(old + i * 15_000).toISOString();
  sqliteDb.prepare(`INSERT INTO health_samples (ts, kind, json) VALUES (?, 'raw', ?)`).run(s.ts, JSON.stringify(s));
}
H.rollup(Date.now());

const hdr = { Authorization: `Bearer ${plaintext}` };
const get = async (p) => {
  const r = await fetch(`http://localhost:${PORT}/api/v1${p}`, { headers: hdr });
  return { status: r.status, body: await r.json() };
};

const out = {};
out.now = await get('/health/now');
out.series1h = await get('/health/series?window=1h');
out.series7d = await get('/health/series?window=7d');
out.series24h = await get('/health/series?window=24h');
out.bad = await get('/health/series?window=99y');
out.workloads = await get('/health/workloads');
out.events = await get('/health/events?limit=5');
out.noauth = await (async () => {
  const r = await fetch(`http://localhost:${PORT}/api/v1/health/now`);
  return { status: r.status };
})();

const s = out.now.body.sample;
console.log('--- AC-1  GET /health/now ---');
console.log('  http', out.now.status, '| age_s', out.now.body.age_seconds, '| status', JSON.stringify(out.now.body.status));
console.log('  cpu     ', JSON.stringify(s.cpu));
console.log('  mem     ', `pct ${s.mem.pct}% used ${s.mem.used_mb}/${s.mem.total_mb}MB | jarvis rss ${s.mem.rss_mb}MB heap ${s.mem.heap_used_mb}/${s.mem.heap_total_mb}MB`);
console.log('  lag     ', JSON.stringify(s.lag));
console.log('  disk    ', `root ${s.disk.root.pct}% (${s.disk.root.free_mb}MB free) | db dir ${s.disk.db.path} ${s.disk.db.pct}%`);
console.log('  db      ', `bytes ${s.db.bytes} wal ${s.db.wal_bytes} pages ${s.db.page_count}@${s.db.page_size} freelist ${s.db.freelist_count} (${s.db.freelist_pct}%) turns ${s.db.turns_written} writes/min ${s.db.writes_per_min} api/min ${s.db.api_requests_per_min}`);
console.log('  claude  ', JSON.stringify(s.claude));
console.log('  workload', s.workload.summary);
console.log('  workload keys', Object.keys(s.workload).join(','));
console.log('  thresholds', JSON.stringify(out.now.body.thresholds));
console.log('  sampler  ', JSON.stringify(out.now.body.sampler));
console.log('  tick_ms  ', s.tick_ms);

console.log('--- AC-2  GET /health/series ---');
for (const [k, r] of [['1h', out.series1h], ['24h', out.series24h], ['7d', out.series7d]]) {
  console.log(`  ${k.padEnd(4)} http ${r.status} resolution=${r.body.resolution} points=${r.body.points.length} events=${r.body.events.length} metrics=${JSON.stringify(r.body.metrics)}`);
}
console.log('  bad window →', out.bad.status, out.bad.body.error?.code ?? JSON.stringify(out.bad.body).slice(0, 80));

console.log('--- GET /health/workloads ---');
console.log('  http', out.workloads.status, '| rows', out.workloads.body.rows.map((r) => `${r.key}:${r.status}`).join(' '));
console.log('--- GET /health/events ---');
console.log('  http', out.events.status, '| events', out.events.body.events.length);
console.log('--- auth ---');
console.log('  unauthenticated /health/now →', out.noauth.status);

server.close();
process.exit(0);
