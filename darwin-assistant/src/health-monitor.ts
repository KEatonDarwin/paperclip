// 🩺 COCKPIT HEALTH — the box monitor, and the record of what was running during a spike.
//
// WHY THIS EXISTS (Kevin, 2026-09-25): he gets lag spikes while everything is
// running, looks at the box, and sees nothing obvious. The root cause the same
// hour was jarvis.db at 1.5 GB of debug capture — the single Node event loop
// stalling on synchronous better-sqlite3 reads of 400 KB rows. So this file
// treats EVENT-LOOP LAG as a first-class metric, not an afterthought: it is the
// number that actually explains "the cockpit feels laggy", and no amount of
// staring at `top` would ever have shown it.
//
// Two halves, one file:
//   1. A plain-code sampler (zero model calls) that writes one row every
//      `health_sample_seconds` and rolls raw → 1m → 1h so 30 days of history
//      costs kilobytes.
//   2. A spike state machine that, when a metric stays over threshold, records
//      WHAT WAS RUNNING at that moment and asks JARVIS — once per cooldown — for
//      a suggestion. It never turns a dial. Suggestions only; the dials are
//      Kevin's (see throttle.ts for why that line is drawn hard).
//
// RAILS (DESIGN.md §2, enforced here):
//   - A failed sample is logged and skipped. Nothing in this file may throw into
//     the event loop; a monitor that crashes the process it monitors is worse
//     than no monitor.
//   - The tick must stay under ~5 ms. That is why `pgrep` runs ASYNCHRONOUSLY
//     out of band and the tick reads a cached count (at most one interval
//     stale): spawning a child synchronously to measure event-loop lag would
//     itself be a lag spike.
//   - Every settings read is uncached, so a dial change lands on the next tick
//     with no restart.
//
// Wire shapes are frozen in docs/health/CONTRACT.md — the cockpit builds
// against that file.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { sqliteDb, getSetting, getConversation, getOrCreateConversation, renameConversation, setThreadModelOverride } from './conversation-db.js';
import { sseBus } from './sse-bus.js';
import { createNotification } from './notifications.js';
import { fullThrottleStatus } from './throttle-status.js';
import { activeAutomatedTurns } from './turn-admission.js';
import { getActiveRuns } from './agent.js';
import { activeNightRun, listNightItems } from './night-shift.js';

// ---------------------------------------------------------------------------
// Types (docs/health/CONTRACT.md §2–§4)
// ---------------------------------------------------------------------------

export interface DiskView { path: string; total_mb: number; used_mb: number; free_mb: number; pct: number }

export interface WorkloadWorkerNode {
  node_id: number; tree_id: string; tree_topic: string | null;
  goal_id: number | null; title: string;
  adapter: string | null; model: string | null; account: string | null;
  elapsed_min: number | null; worker_thread_ext: string | null;
}

export interface WorkloadSnapshot {
  workers: {
    total: number; slots: number; free: number;
    nodes: WorkloadWorkerNode[];
    by_goal: { goal_id: number; title: string | null; n: number; cap: number; at_cap: boolean }[];
    by_tree: { tree_id: string; topic: string | null; goal_id: number | null; n: number; cap: number; at_cap: boolean }[];
  };
  turns: {
    active: number; automated: number; kevin: number; admission_cap: number;
    threads: { conversation_id: number; external_id: string; title: string | null; automated: boolean; elapsed_min: number }[];
  };
  night: null | {
    run_id: number; status: string; mode: string; label: string | null;
    thread_ext: string | null; lanes: number;
    items_total: number; items_done: number; items_failed: number; items_running: number;
    running_titles: string[];
  };
  autopilot: { goals: { goal_id: number; title: string; working_nodes: number }[]; total: number };
  providers: Record<string, { allow: boolean; reason: string; detail: string; usage: number | null; ceiling: number | null; override: string }>;
  accounts: {
    key: string; label: string; enabled: boolean;
    five_hour: number | null; weekly: number | null; stale: boolean;
    eligible: boolean; active: boolean;
    five_hour_resets_at: string | null; weekly_resets_at: string | null;
  }[];
  throttle: {
    hopper_slots: number; max_per_goal: number; max_per_tree: number;
    claude_mode: string; claude_order: string;
    hold: { dispatching: boolean; reason: string; detail: string };
  };
  summary: string;
  /** When this snapshot was composed. It can lag the sample's own `ts` by up to
   *  `health_workload_ttl_seconds` — see workloadSnapshot(). */
  as_of: string;
  age_seconds: number;
}

export interface HealthSample {
  ts: string;
  interval_ms: number;
  tick_ms: number;
  cpu: { pct: number | null; load1: number; load5: number; load15: number; cores: number };
  mem: { total_mb: number; used_mb: number; free_mb: number; pct: number; rss_mb: number; heap_used_mb: number; heap_total_mb: number };
  lag: { p50_ms: number; p99_ms: number; max_ms: number };
  disk: { root: DiskView; db: DiskView };
  db: {
    bytes: number; wal_bytes: number; total_bytes: number;
    page_count: number; page_size: number; freelist_count: number; freelist_pct: number;
    turns_written: number; writes: number; writes_per_min: number;
    api_requests: number; api_requests_per_min: number;
  };
  claude: { processes: number; source: 'pgrep' | 'active_runs' };
  workload: WorkloadSnapshot;
}

export interface HealthPoint {
  ts: string; n: number;
  cpu_pct: number | null; cpu_pct_max: number | null; load1: number | null;
  mem_pct: number | null; mem_pct_max: number | null; rss_mb: number | null; rss_mb_max: number | null;
  lag_p50_ms: number | null; lag_p99_ms: number | null; lag_p99_ms_max: number | null; lag_max_ms: number | null;
  disk_root_pct: number | null; disk_db_pct: number | null;
  db_bytes: number | null; db_wal_bytes: number | null; db_freelist_pct: number | null;
  db_writes_per_min: number | null; db_writes_per_min_max: number | null;
  api_per_min: number | null; api_per_min_max: number | null;
  claude_procs: number | null; claude_procs_max: number | null;
  workers: number | null; workers_max: number | null;
  turns_active: number | null; turns_active_max: number | null;
}

export type HealthMetric = 'cpu' | 'mem' | 'lag' | 'disk';
export type HealthEventKind = 'spike' | 'release' | 'note';

export interface HealthEvent {
  id: number; ts: string;
  kind: HealthEventKind;
  metric: string;
  value: number | null; threshold: number | null;
  snapshot: WorkloadSnapshot | null;
  suggestion: string | null;
  cued: boolean;
  resolved_at: string | null;
  acknowledged_at: string | null;
  summary: string;
}

export type HealthWindow = '15m' | '1h' | '6h' | '24h' | '7d' | '30d';
export type HealthResolution = 'raw' | '1m' | '1h';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS health_samples (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    ts   TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('raw','1m','1h')),
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_health_samples_kind_ts ON health_samples(kind, ts);
  -- Makes the rollup idempotent: re-running it can never duplicate a bucket.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_health_samples_bucket
    ON health_samples(kind, ts) WHERE kind != 'raw';

  CREATE TABLE IF NOT EXISTS health_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('spike','release','note')),
    metric TEXT NOT NULL,
    value REAL,
    threshold REAL,
    snapshot_json TEXT,
    suggestion TEXT,
    cued INTEGER NOT NULL DEFAULT 0,
    resolved_at TEXT,
    acknowledged_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_health_events_ts ON health_events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_health_events_metric ON health_events(metric, kind, ts DESC);
`);

// ---------------------------------------------------------------------------
// Settings (uncached on purpose — a dial change lands on the next tick)
// ---------------------------------------------------------------------------

function num(key: string, fallback: number, lo: number, hi: number): number {
  const raw = getSetting(key);
  const n = raw != null && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
function flag(key: string, fallback: boolean): boolean {
  const raw = getSetting(key);
  if (raw == null || raw.trim() === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

export function healthEnabled(): boolean { return flag('health_monitor_enabled', true); }
export function sampleSeconds(): number { return num('health_sample_seconds', 5, 1, 300); }
export function rollupMinutes(): number { return num('health_rollup_minutes', 5, 1, 1440); }
export function retainRawHours(): number { return num('health_retain_raw_hours', 24, 1, 720); }
export function retain1mDays(): number { return num('health_retain_1m_days', 30, 1, 3650); }
export function spikeSeconds(): number { return num('health_spike_seconds', 30, 1, 3600); }
export function cooldownMinutes(): number { return num('health_spike_cooldown_min', 30, 0, 1440); }
export function cueEnabled(): boolean { return flag('health_cue_enabled', true); }
export function workloadTtlSeconds(): number { return num('health_workload_ttl_seconds', 60, 0, 3600); }
export function monitorModel(): string { return (getSetting('health_monitor_model') ?? '').trim() || 'claude-sonnet-5'; }

export interface HealthThresholds { cpu_pct: number; mem_pct: number; lag_ms: number; disk_pct: number; spike_seconds: number; cooldown_min: number }
export function thresholds(): HealthThresholds {
  return {
    cpu_pct: num('health_cpu_pct', 80, 1, 100),
    mem_pct: num('health_mem_pct', 85, 1, 100),
    lag_ms: num('health_lag_ms', 500, 1, 600_000),
    disk_pct: num('health_disk_pct', 90, 1, 100),
    spike_seconds: spikeSeconds(),
    cooldown_min: cooldownMinutes(),
  };
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;
function mb(bytes: number): number { return Math.round((bytes / MB) * 10) / 10; }
function pct(part: number, whole: number): number {
  if (!(whole > 0)) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// -- CPU: delta of os.cpus() times between samples --------------------------
interface CpuTotals { idle: number; total: number }
function cpuTotals(): CpuTotals {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}
let prevCpu: CpuTotals | null = null;
function cpuPct(): number | null {
  const now = cpuTotals();
  const prev = prevCpu;
  prevCpu = now;
  if (!prev) return null;                       // first sample after boot has no delta
  const dTotal = now.total - prev.total;
  const dIdle = now.idle - prev.idle;
  if (dTotal <= 0) return null;
  return round(Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100)), 1);
}

// -- Event-loop lag: the number that explains a laggy cockpit ---------------
// One histogram, reset every sample, so p50/p99/max describe THIS interval.
let histogram: IntervalHistogram | null = null;
function ensureHistogram(): IntervalHistogram {
  if (!histogram) {
    histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
  }
  return histogram;
}
function lagSnapshot(): { p50_ms: number; p99_ms: number; max_ms: number } {
  const h = ensureHistogram();
  // node reports nanoseconds; `max` is Infinity before any measurement lands.
  const ns = (v: number): number => (Number.isFinite(v) ? round(v / 1e6, 2) : 0);
  const out = { p50_ms: ns(h.percentile(50)), p99_ms: ns(h.percentile(99)), max_ms: ns(h.max) };
  h.reset();
  return out;
}

// -- Disk ------------------------------------------------------------------
function diskFor(target: string): DiskView {
  try {
    const st = fs.statfsSync(target);
    const bsize = Number(st.bsize) || 4096;
    const total = Number(st.blocks) * bsize;
    const free = Number(st.bavail) * bsize;
    const used = total - Number(st.bfree) * bsize;
    return { path: target, total_mb: mb(total), used_mb: mb(used), free_mb: mb(free), pct: pct(used, total) };
  } catch {
    return { path: target, total_mb: 0, used_mb: 0, free_mb: 0, pct: 0 };
  }
}

// -- The database itself ---------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Same resolution better-sqlite3 got in conversation-db.ts. */
export const DB_FILE = process.env.JARVIS_DB_PATH ?? path.join(HERE, '..', 'jarvis.db');
const DB_DIR = path.dirname(path.resolve(DB_FILE));

function fileBytes(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}
function pragmaNumber(name: string): number {
  try {
    const v = sqliteDb.pragma(name, { simple: true }) as unknown;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

// Write proxy: MAX(id) deltas are O(1) on the rowid index — a COUNT(*) on a
// 14k-row `turns` table every 5 s would itself be part of the problem.
const ROWID_TABLES = ['turns', 'night_events', 'goal_events', 'health_samples'] as const;
type MaxIdStmt = ReturnType<typeof sqliteDb.prepare<[], { m: number | null }>>;
const maxIdStmts = new Map<string, MaxIdStmt | null>();
function maxRowId(table: string): number {
  let stmt = maxIdStmts.get(table);
  if (stmt === undefined) {
    // Table names come from the ROWID_TABLES literal tuple, never from input.
    try { stmt = sqliteDb.prepare<[], { m: number | null }>(`SELECT MAX(id) AS m FROM ${table}`); }
    catch { stmt = null; }
    maxIdStmts.set(table, stmt);
  }
  if (!stmt) return 0;
  try { return Number(stmt.get()?.m ?? 0); } catch { return 0; }
}
let prevMaxIds: Record<string, number> | null = null;

let hopperTouchedStmt: ReturnType<typeof sqliteDb.prepare<[string], { c: number }>> | null | undefined;
function hopperRowsTouchedSince(sinceIso: string | null): number {
  if (!sinceIso) return 0;
  if (hopperTouchedStmt === undefined) {
    try { hopperTouchedStmt = sqliteDb.prepare<[string], { c: number }>(`SELECT COUNT(*) AS c FROM hopper_nodes WHERE updated_at >= ?`); }
    catch { hopperTouchedStmt = null; }
  }
  if (!hopperTouchedStmt) return 0;
  try {
    // hopper_nodes stores `datetime('now')` (UTC, space-separated, no ms).
    const sqlTs = sinceIso.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
    return Number(hopperTouchedStmt.get(sqlTs)?.c ?? 0);
  } catch { return 0; }
}

// -- API request counter (db_reads = "/api/v1 requests", said plainly) ------
let apiRequests = 0;
/** Called by the tiny counting middleware at the top of createApiV1Router(). */
export function noteApiRequest(): void { apiRequests += 1; }
function drainApiRequests(): number { const n = apiRequests; apiRequests = 0; return n; }

// -- claude CLI process count, refreshed OUT OF BAND -----------------------
// Spawning pgrep inside the tick would add ~10 ms of child-process work to the
// very measurement that exists to detect ~10 ms of blocking. So: kick pgrep
// after each sample, read the cached answer on the next one.
let claudeProcs = 0;
let claudeSource: 'pgrep' | 'active_runs' = 'active_runs';
let pgrepInFlight = false;
function refreshClaudeProcs(): void {
  if (pgrepInFlight) return;
  pgrepInFlight = true;
  execFile('pgrep', ['-c', '-f', 'claude'], { timeout: 4000 }, (err, stdout) => {
    pgrepInFlight = false;
    const n = parseInt(String(stdout ?? '').trim(), 10);
    if (Number.isFinite(n)) {
      // pgrep exits 1 with "0" when nothing matched — that is a successful count.
      claudeProcs = n;
      claudeSource = 'pgrep';
      return;
    }
    if (err) {
      // pgrep missing/unusable → fall back to the harness's own in-flight runs.
      claudeProcs = getActiveRuns().length;
      claudeSource = 'active_runs';
    }
  });
}

// ---------------------------------------------------------------------------
// Workload snapshot
// ---------------------------------------------------------------------------

function minutesSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round(((Date.now() - t) / 60000) * 10) / 10);
}

function safeQuery<T>(sql: string, fallback: T[]): T[] {
  try { return sqliteDb.prepare(sql).all() as T[]; } catch { return fallback; }
}

function autopilotSnapshot(): WorkloadSnapshot['autopilot'] {
  const goals = safeQuery<{ id: number; title: string }>(
    `SELECT id, title FROM goals WHERE autopilot = 1 AND archived = 0 ORDER BY id ASC`, [],
  );
  if (!goals.length) return { goals: [], total: 0 };
  const working = new Map<number, number>();
  for (const r of safeQuery<{ goal_id: number; n: number }>(
    `SELECT goal_id, COUNT(*) AS n FROM goal_nodes WHERE state = 'working' GROUP BY goal_id`, [],
  )) working.set(r.goal_id, r.n);
  return {
    goals: goals.map((g) => ({ goal_id: g.id, title: g.title, working_nodes: working.get(g.id) ?? 0 })),
    total: goals.length,
  };
}

function nightSnapshot(): WorkloadSnapshot['night'] {
  try {
    const run = activeNightRun();
    if (!run) return null;
    const items = listNightItems(run.id);
    const running = items.filter((i) => i.status === 'running');
    return {
      run_id: run.id,
      status: run.status,
      mode: run.mode,
      label: run.label,
      thread_ext: run.thread_ext,
      lanes: run.config?.lanes ?? 0,
      items_total: items.length,
      items_done: items.filter((i) => i.status === 'done').length,
      items_failed: items.filter((i) => i.status === 'failed').length,
      items_running: running.length,
      running_titles: running.map((i) => i.title).slice(0, 8),
    };
  } catch { return null; }
}

function turnsSnapshot(): WorkloadSnapshot['turns'] {
  let runs: { conversationId: number; startedAt: number }[] = [];
  try { runs = getActiveRuns(); } catch { runs = []; }
  const automated = (() => { try { return activeAutomatedTurns(); } catch { return 0; } })();
  const cap = num('max_concurrent_auto_turns', 4, 1, 64);
  const threads = runs.map((r) => {
    let external_id = `conversation:${r.conversationId}`;
    let title: string | null = null;
    try {
      const row = sqliteDb.prepare(`SELECT external_id, title FROM conversations WHERE id = ?`)
        .get(r.conversationId) as { external_id: string; title: string | null } | undefined;
      if (row) { external_id = row.external_id; title = row.title; }
    } catch { /* leave the fallback label */ }
    return {
      conversation_id: r.conversationId,
      external_id,
      title,
      // A spawned worker thread is unambiguously automated; a cue-driven turn on
      // a normal thread is not distinguishable here (the correlation key is not
      // exposed), so the aggregate `automated` count above is the honest total.
      automated: external_id.startsWith('cockpit:hopper-node-'),
      elapsed_min: Math.max(0, Math.round(((Date.now() - r.startedAt) / 60000) * 10) / 10),
    };
  });
  return { active: runs.length, automated, kevin: Math.max(0, runs.length - automated), admission_cap: cap, threads };
}

/** One line for a chart-marker hover / notification body. */
function summarize(w: WorkloadSnapshot): string {
  const bits: string[] = [];
  bits.push(`${w.workers.total}/${w.workers.slots} workers`);
  if (w.turns.active) bits.push(`${w.turns.active} turn${w.turns.active === 1 ? '' : 's'}`);
  if (w.night) bits.push(`shift #${w.night.run_id} ${w.night.status}`);
  if (w.autopilot.total) bits.push(`${w.autopilot.total} autopilot goal${w.autopilot.total === 1 ? '' : 's'}`);
  for (const a of w.accounts) {
    if (a.five_hour != null) bits.push(`${a.key.toUpperCase()} 5h ${Math.round(a.five_hour)}%`);
  }
  if (!w.throttle.hold.dispatching) bits.push(`hold: ${w.throttle.hold.reason}`);
  return bits.join(' · ');
}

let cachedThrottle: ReturnType<typeof fullThrottleStatus> | null = null;
let cachedThrottleAtMs = 0;

/**
 * WHAT IS CACHED HERE, AND WHY IT IS THE HONEST SPLIT.
 *
 * Measured on a copy of the real 1.5 GB jarvis.db (14,301 turns / 866 hopper
 * nodes / 173 trees), per call:
 *
 *     fullThrottleStatus()        17.9 ms     <- the entire cost
 *     running hopper_nodes         0.009 ms
 *     activeNightRun()             0.015 ms
 *     activeAutomatedTurns()       0.001 ms
 *     every pragma + MAX(id)      <0.01 ms
 *     os.cpus() + statfs + memory  0.2 ms
 *
 * So one composite is ~95 % of the tick, and this module exists to MEASURE
 * synchronous blocking — sampling it every 5 s would write a self-inflicted
 * ~0.4 % duty cycle of stall straight into the lag histogram it reports, over
 * DESIGN.md §2's < 5 ms rail.
 *
 * What does NOT work: deferring it with setImmediate the way refreshClaudeProcs()
 * does. pgrep is a CHILD PROCESS, genuinely off-loop; fullThrottleStatus() is
 * synchronous sqlite + file reads, so deferring it would only stop tick_ms being
 * CHARGED for a stall that still happens — a monitor lying about its own cost.
 * The fix has to be doing it less often.
 *
 * So the split follows how fast each half can actually change:
 *   - LIVE every tick: the running workers, turns in flight, the shift, autopilot
 *     goals. All microseconds, and all things Kevin watches move.
 *   - CACHED `health_workload_ttl_seconds` (60): the throttle dials, governor
 *     verdicts and account meters. A shorter TTL buys nothing real — the usage
 *     files underneath are themselves polled once a minute, so those numbers
 *     cannot be fresher than 60 s no matter how often we recompose them.
 *
 * Every snapshot carries `as_of`/`age_seconds` for the cached half so the UI can
 * never imply it is more current than it is, and evaluateSpikes() forces a full
 * recompose when it freezes evidence onto a spike row. TTL 0 disables the cache.
 */
function throttleStatusCached(force = false): ReturnType<typeof fullThrottleStatus> | null {
  const ttlMs = workloadTtlSeconds() * 1000;
  const nowMs = Date.now();
  if (!force && cachedThrottle && ttlMs > 0 && nowMs - cachedThrottleAtMs < ttlMs) return cachedThrottle;
  try {
    cachedThrottle = fullThrottleStatus();
    cachedThrottleAtMs = nowMs;
  } catch (err) {
    console.warn('[health] throttle status unavailable for the workload snapshot', err);
    if (!cachedThrottle) return null;
  }
  return cachedThrottle;
}

export function workloadSnapshot(opts: { force?: boolean } = {}): WorkloadSnapshot {
  return composeWorkloadSnapshot(throttleStatusCached(opts.force === true), opts.force === true);
}

/** Test seam only — drop the cached throttle composite. */
export function __resetWorkloadCache(): void { cachedThrottle = null; cachedThrottleAtMs = 0; }

function composeWorkloadSnapshot(
  t: ReturnType<typeof fullThrottleStatus> | null,
  forced: boolean,
): WorkloadSnapshot {
  // `t` carries the governor verdicts, account meters and dials — reused rather
  // than re-derived (one source of truth), and cached per throttleStatusCached().

  const treeTopics = new Map<string, string | null>();
  for (const r of safeQuery<{ tree_id: string; topic: string | null }>(
    `SELECT id AS tree_id, topic FROM hopper_trees`, [],
  )) treeTopics.set(r.tree_id, r.topic);

  const leases = new Map<number, string | null>();
  const workerExts = new Map<number, string | null>();
  for (const r of safeQuery<{ id: number; lease_expires_at: string | null; worker_thread_ext: string | null }>(
    `SELECT id, lease_expires_at, worker_thread_ext FROM hopper_nodes WHERE status = 'running'`, [],
  )) { leases.set(r.id, r.lease_expires_at); workerExts.set(r.id, r.worker_thread_ext); }

  const leaseMinutes = Math.max(5, parseInt(process.env.HOPPER_ENGINE_LEASE_MIN ?? '30', 10) || 30);
  // Live every tick (0.009 ms): the cached throttle composite may be up to a
  // minute old, and "which workers are running right now" is the one thing on
  // this page that must not be.
  const liveRunning = safeQuery<{
    id: number; tree_id: string; title: string; adapter: string | null; model: string | null;
  }>(`SELECT id, tree_id, title, adapter, model FROM hopper_nodes WHERE status = 'running'`, []);
  const throttleById = new Map((t?.running.nodes ?? []).map((n) => [n.node_id, n]));

  const nodes: WorkloadWorkerNode[] = liveRunning.map((live) => {
    const n = throttleById.get(live.id) ?? {
      node_id: live.id, tree_id: live.tree_id, goal_id: null as number | null,
      title: live.title, adapter: live.adapter, model: live.model,
      lease_expires_at: null as string | null,
    };
    // A node has no started_at column; the lease is issued at claim time for a
    // fixed window, so elapsed = leaseMinutes - remaining. Honest and free.
    const leftMin = minutesSince(leases.get(n.node_id) ?? n.lease_expires_at);
    const elapsed = leftMin == null ? null : Math.max(0, round(leaseMinutes + leftMin, 1));
    return {
      node_id: n.node_id,
      tree_id: n.tree_id,
      tree_topic: treeTopics.get(n.tree_id) ?? null,
      goal_id: n.goal_id,
      title: n.title,
      adapter: n.adapter,
      model: n.model,
      account: t?.accounts.find((a) => a.active)?.key ?? null,
      elapsed_min: elapsed,
      worker_thread_ext: workerExts.get(n.node_id) ?? null,
    };
  });

  const providers: WorkloadSnapshot['providers'] = {};
  for (const [name, v] of Object.entries(t?.providers ?? {})) {
    if (!v) continue;
    providers[name] = {
      allow: v.allow, reason: v.reason, detail: v.detail,
      usage: v.usage ?? null, ceiling: v.ceiling ?? null, override: v.override ?? 'auto',
    };
  }

  const snap: WorkloadSnapshot = {
    workers: {
      total: nodes.length,                      // live count, not the cached one
      slots: t?.running.slots ?? 0,
      free: Math.max(0, (t?.running.slots ?? 0) - nodes.length),
      nodes,
      by_goal: t?.running.by_goal ?? [],
      by_tree: t?.running.by_tree ?? [],
    },
    turns: turnsSnapshot(),
    night: nightSnapshot(),
    autopilot: autopilotSnapshot(),
    providers,
    accounts: (t?.accounts ?? []).map((a) => ({
      key: a.key, label: a.label, enabled: a.enabled,
      five_hour: a.five_hour, weekly: a.weekly, stale: a.stale,
      eligible: a.eligible, active: a.active,
      five_hour_resets_at: a.five_hour_resets_at ?? null,
      weekly_resets_at: a.weekly_resets_at ?? null,
    })),
    throttle: {
      hopper_slots: t?.dials.hopper_slots ?? 0,
      max_per_goal: t?.dials.throttle_max_per_goal ?? 0,
      max_per_tree: t?.dials.throttle_max_per_tree ?? 0,
      claude_mode: t?.dials.throttle_claude_mode ?? 'auto',
      claude_order: (t?.dials.throttle_claude_order ?? []).join(','),
      hold: {
        dispatching: t?.hold.dispatching ?? true,
        reason: t?.hold.reason ?? 'ok',
        detail: t?.hold.detail ?? '',
      },
    },
    summary: '',
    // as_of describes the CACHED half (dials/accounts/governor); workers, turns,
    // the shift and autopilot above are always from this tick.
    as_of: new Date(cachedThrottleAtMs || Date.now()).toISOString(),
    age_seconds: forced || !cachedThrottleAtMs ? 0 : round((Date.now() - cachedThrottleAtMs) / 1000, 1),
  };
  snap.summary = summarize(snap);
  return snap;
}

// ---------------------------------------------------------------------------
// The sample itself
// ---------------------------------------------------------------------------

const insertSampleStmt = sqliteDb.prepare<[string, string, string]>(
  `INSERT INTO health_samples (ts, kind, json) VALUES (?, ?, ?)`,
);

let lastSample: HealthSample | null = null;
let lastSampleAtMs: number | null = null;
let tickMsTotal = 0;
let tickCount = 0;

export function lastHealthSample(): HealthSample | null { return lastSample; }
export function samplerStats(): { last_tick_ms: number | null; avg_tick_ms: number | null; ticks: number } {
  return {
    last_tick_ms: lastSample?.tick_ms ?? null,
    avg_tick_ms: tickCount ? round(tickMsTotal / tickCount, 3) : null,
    ticks: tickCount,
  };
}

export function toPoint(s: HealthSample): HealthPoint {
  return {
    ts: s.ts, n: 1,
    cpu_pct: s.cpu.pct, cpu_pct_max: s.cpu.pct, load1: s.cpu.load1,
    mem_pct: s.mem.pct, mem_pct_max: s.mem.pct, rss_mb: s.mem.rss_mb, rss_mb_max: s.mem.rss_mb,
    lag_p50_ms: s.lag.p50_ms, lag_p99_ms: s.lag.p99_ms, lag_p99_ms_max: s.lag.p99_ms, lag_max_ms: s.lag.max_ms,
    disk_root_pct: s.disk.root.pct, disk_db_pct: s.disk.db.pct,
    db_bytes: s.db.bytes, db_wal_bytes: s.db.wal_bytes, db_freelist_pct: s.db.freelist_pct,
    db_writes_per_min: s.db.writes_per_min, db_writes_per_min_max: s.db.writes_per_min,
    api_per_min: s.db.api_requests_per_min, api_per_min_max: s.db.api_requests_per_min,
    claude_procs: s.claude.processes, claude_procs_max: s.claude.processes,
    workers: s.workload.workers.total, workers_max: s.workload.workers.total,
    turns_active: s.workload.turns.active, turns_active_max: s.workload.turns.active,
  };
}

/** Collect one sample. Never throws — returns null and logs on failure. */
export function collectSample(): HealthSample | null {
  const t0 = performance.now();
  try {
    const nowMs = Date.now();
    const intervalMs = lastSampleAtMs ? Math.max(1, nowMs - lastSampleAtMs) : sampleSeconds() * 1000;
    // Rates are extrapolated from the interval, so a sample taken moments after
    // another one (POST /health/sample landing right behind a scheduled tick)
    // would divide by ~1 ms and report a number like 60,000 writes/min. Floor the
    // extrapolation window at one second: the tile may under-state a burst on a
    // forced sample, which is the harmless direction — a monitor that invents a
    // 60k spike is worse than useless, it is the thing you would then chase.
    const perMin = 60000 / Math.max(intervalMs, 1000);

    const load = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memUsage = process.memoryUsage();

    const dbBytes = fileBytes(DB_FILE);
    const walBytes = fileBytes(`${DB_FILE}-wal`);
    const pageCount = pragmaNumber('page_count');
    const pageSize = pragmaNumber('page_size');
    const freelist = pragmaNumber('freelist_count');

    // Row-write proxy.
    const nextMaxIds: Record<string, number> = {};
    for (const table of ROWID_TABLES) nextMaxIds[table] = maxRowId(table);
    let rowWrites = 0;
    let turnsWritten = 0;
    if (prevMaxIds) {
      for (const table of ROWID_TABLES) {
        const d = Math.max(0, (nextMaxIds[table] ?? 0) - (prevMaxIds[table] ?? 0));
        rowWrites += d;
        if (table === 'turns') turnsWritten = d;
      }
    }
    prevMaxIds = nextMaxIds;
    rowWrites += hopperRowsTouchedSince(lastSample?.ts ?? null);

    const apiReqs = drainApiRequests();

    const sample: HealthSample = {
      ts: new Date(nowMs).toISOString(),
      interval_ms: intervalMs,
      tick_ms: 0,
      cpu: {
        pct: cpuPct(),
        load1: round(load[0] ?? 0), load5: round(load[1] ?? 0), load15: round(load[2] ?? 0),
        cores: os.cpus().length,
      },
      mem: {
        total_mb: mb(totalMem), used_mb: mb(totalMem - freeMem), free_mb: mb(freeMem),
        pct: pct(totalMem - freeMem, totalMem),
        rss_mb: mb(memUsage.rss), heap_used_mb: mb(memUsage.heapUsed), heap_total_mb: mb(memUsage.heapTotal),
      },
      lag: lagSnapshot(),
      disk: { root: diskFor('/'), db: diskFor(DB_DIR) },
      db: {
        bytes: dbBytes, wal_bytes: walBytes, total_bytes: dbBytes + walBytes,
        page_count: pageCount, page_size: pageSize,
        freelist_count: freelist, freelist_pct: pct(freelist, pageCount),
        turns_written: turnsWritten,
        writes: rowWrites, writes_per_min: Math.round(rowWrites * perMin * 10) / 10,
        api_requests: apiReqs, api_requests_per_min: Math.round(apiReqs * perMin * 10) / 10,
      },
      claude: { processes: claudeProcs, source: claudeSource },
      workload: workloadSnapshot(),
    };
    sample.tick_ms = round(performance.now() - t0, 3);
    lastSample = sample;
    lastSampleAtMs = nowMs;
    tickMsTotal += sample.tick_ms;
    tickCount += 1;
    return sample;
  } catch (err) {
    console.error('[health] sample failed (skipped, sampler continues)', err);
    return null;
  }
}

/** Collect + persist + emit + evaluate spikes. Never throws. */
export function takeSample(): HealthSample | null {
  const sample = collectSample();
  if (!sample) return null;
  try {
    insertSampleStmt.run(sample.ts, 'raw', JSON.stringify(sample));
  } catch (err) {
    console.error('[health] could not store sample', err);
  }
  try {
    sseBus.emit('sse', { type: 'health_sample', sample, point: toPoint(sample) });
  } catch (err) {
    console.error('[health] SSE emit failed', err);
  }
  try { evaluateSpikes(sample); } catch (err) { console.error('[health] spike evaluation failed', err); }
  // Refresh the process count for the NEXT tick, out of band (see the note on
  // refreshClaudeProcs — a synchronous pgrep would be its own lag spike).
  try { refreshClaudeProcs(); } catch { /* non-fatal */ }
  return sample;
}

// ---------------------------------------------------------------------------
// Series + rollup + retention
// ---------------------------------------------------------------------------

const WINDOW_MS: Record<HealthWindow, number> = {
  '15m': 15 * 60_000, '1h': 60 * 60_000, '6h': 6 * 3600_000,
  '24h': 24 * 3600_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000,
};
const WINDOW_RESOLUTION: Record<HealthWindow, HealthResolution> = {
  '15m': 'raw', '1h': 'raw', '6h': '1m', '24h': '1m', '7d': '1h', '30d': '1h',
};
export const HEALTH_WINDOWS = Object.keys(WINDOW_MS) as HealthWindow[];
export function isHealthWindow(v: unknown): v is HealthWindow {
  return typeof v === 'string' && v in WINDOW_MS;
}
export function resolutionFor(window: HealthWindow): HealthResolution { return WINDOW_RESOLUTION[window]; }

const rowsStmt = sqliteDb.prepare<[string, string], { ts: string; json: string }>(
  `SELECT ts, json FROM health_samples WHERE kind = ? AND ts >= ? ORDER BY ts ASC`,
);

export function seriesPoints(window: HealthWindow): { resolution: HealthResolution; from: string; to: string; points: HealthPoint[] } {
  const resolution = resolutionFor(window);
  const to = new Date();
  const from = new Date(to.getTime() - WINDOW_MS[window]);
  const rows = rowsStmt.all(resolution, from.toISOString());
  const points: HealthPoint[] = [];
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.json) as HealthSample | HealthPoint;
      points.push(resolution === 'raw' ? toPoint(parsed as HealthSample) : (parsed as HealthPoint));
    } catch { /* a corrupt row is skipped, never fatal */ }
  }
  return { resolution, from: from.toISOString(), to: to.toISOString(), points };
}

export function sampleCounts(): { raw: number; m1: number; h1: number } {
  const get = (kind: string): number => {
    try {
      return Number((sqliteDb.prepare(`SELECT COUNT(*) AS c FROM health_samples WHERE kind = ?`).get(kind) as { c: number }).c);
    } catch { return 0; }
  };
  return { raw: get('raw'), m1: get('1m'), h1: get('1h') };
}

function meanOf(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  return round(nums.reduce((a, b) => a + b, 0) / nums.length, 2);
}
function maxOf(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  return round(Math.max(...nums), 2);
}
function lastOf(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** Aggregate a bucket of points into one point. Means for rates, peaks in
 *  `*_max`, LAST for levels (sizes and disk %) — a level's average is a lie. */
export function aggregatePoints(bucketTs: string, points: HealthPoint[]): HealthPoint {
  const col = (f: (p: HealthPoint) => number | null): (number | null)[] => points.map(f);
  const n = points.reduce((a, p) => a + (p.n || 1), 0);
  return {
    ts: bucketTs, n,
    cpu_pct: meanOf(col((p) => p.cpu_pct)), cpu_pct_max: maxOf(col((p) => p.cpu_pct_max ?? p.cpu_pct)),
    load1: meanOf(col((p) => p.load1)),
    mem_pct: meanOf(col((p) => p.mem_pct)), mem_pct_max: maxOf(col((p) => p.mem_pct_max ?? p.mem_pct)),
    rss_mb: meanOf(col((p) => p.rss_mb)), rss_mb_max: maxOf(col((p) => p.rss_mb_max ?? p.rss_mb)),
    lag_p50_ms: meanOf(col((p) => p.lag_p50_ms)),
    lag_p99_ms: meanOf(col((p) => p.lag_p99_ms)), lag_p99_ms_max: maxOf(col((p) => p.lag_p99_ms_max ?? p.lag_p99_ms)),
    lag_max_ms: maxOf(col((p) => p.lag_max_ms)),
    disk_root_pct: lastOf(col((p) => p.disk_root_pct)), disk_db_pct: lastOf(col((p) => p.disk_db_pct)),
    db_bytes: lastOf(col((p) => p.db_bytes)), db_wal_bytes: lastOf(col((p) => p.db_wal_bytes)),
    db_freelist_pct: lastOf(col((p) => p.db_freelist_pct)),
    db_writes_per_min: meanOf(col((p) => p.db_writes_per_min)),
    db_writes_per_min_max: maxOf(col((p) => p.db_writes_per_min_max ?? p.db_writes_per_min)),
    api_per_min: meanOf(col((p) => p.api_per_min)), api_per_min_max: maxOf(col((p) => p.api_per_min_max ?? p.api_per_min)),
    claude_procs: meanOf(col((p) => p.claude_procs)), claude_procs_max: maxOf(col((p) => p.claude_procs_max ?? p.claude_procs)),
    workers: meanOf(col((p) => p.workers)), workers_max: maxOf(col((p) => p.workers_max ?? p.workers)),
    turns_active: meanOf(col((p) => p.turns_active)), turns_active_max: maxOf(col((p) => p.turns_active_max ?? p.turns_active)),
  };
}

function bucketKey(iso: string, unit: '1m' | '1h'): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  d.setUTCSeconds(0, 0);
  if (unit === '1h') d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

// The bucket index is PARTIAL (`WHERE kind != 'raw'`), and SQLite only matches an
// upsert against a partial index when the conflict target repeats that predicate
// verbatim — a bare `ON CONFLICT(kind, ts)` raises "does not match any PRIMARY KEY
// or UNIQUE constraint" AT PREPARE TIME. Because this is a module-level prepare,
// that error would have thrown while importing health-monitor.js and taken the
// whole service down on boot. Caught by `npm run health:check` on a fresh DB.
const upsertBucketStmt = sqliteDb.prepare<[string, string, string]>(
  `INSERT INTO health_samples (ts, kind, json) VALUES (?, ?, ?)
   ON CONFLICT(kind, ts) WHERE kind != 'raw' DO UPDATE SET json = excluded.json`,
);

/**
 * Roll COMPLETE buckets forward: raw → 1m, 1m → 1h. Only buckets strictly
 * older than the current one are written, so a partial minute is never frozen.
 * Idempotent (the bucket unique index + upsert), so it is safe to run as often
 * as you like and safe to re-run after a crash mid-sweep.
 */
export function rollup(nowMs = Date.now()): { m1: number; h1: number } {
  let m1 = 0, h1 = 0;
  try {
    const currentMinute = bucketKey(new Date(nowMs).toISOString(), '1m');
    const rawRows = sqliteDb.prepare<[], { ts: string; json: string }>(
      `SELECT ts, json FROM health_samples WHERE kind = 'raw' ORDER BY ts ASC`,
    ).all();
    const byMinute = new Map<string, HealthPoint[]>();
    for (const r of rawRows) {
      const key = bucketKey(r.ts, '1m');
      if (key >= currentMinute) continue;                       // incomplete
      try {
        const p = toPoint(JSON.parse(r.json) as HealthSample);
        const list = byMinute.get(key); if (list) list.push(p); else byMinute.set(key, [p]);
      } catch { /* skip a corrupt row */ }
    }
    for (const [key, pts] of byMinute) {
      upsertBucketStmt.run(key, '1m', JSON.stringify(aggregatePoints(key, pts)));
      m1 += 1;
    }

    const currentHour = bucketKey(new Date(nowMs).toISOString(), '1h');
    const minuteRows = sqliteDb.prepare<[], { ts: string; json: string }>(
      `SELECT ts, json FROM health_samples WHERE kind = '1m' ORDER BY ts ASC`,
    ).all();
    const byHour = new Map<string, HealthPoint[]>();
    for (const r of minuteRows) {
      const key = bucketKey(r.ts, '1h');
      if (key >= currentHour) continue;
      try {
        const p = JSON.parse(r.json) as HealthPoint;
        const list = byHour.get(key); if (list) list.push(p); else byHour.set(key, [p]);
      } catch { /* skip */ }
    }
    for (const [key, pts] of byHour) {
      upsertBucketStmt.run(key, '1h', JSON.stringify(aggregatePoints(key, pts)));
      h1 += 1;
    }
  } catch (err) {
    console.error('[health] rollup failed', err);
  }
  return { m1, h1 };
}

/** Trim raw past `health_retain_raw_hours` and 1m past `health_retain_1m_days`.
 *  1h rollups are kept forever — ~8.8k rows/year, a rounding error. */
export function trimRetention(nowMs = Date.now()): { raw: number; m1: number } {
  let raw = 0, m1 = 0;
  try {
    const rawCutoff = new Date(nowMs - retainRawHours() * 3600_000).toISOString();
    raw = Number(sqliteDb.prepare(`DELETE FROM health_samples WHERE kind = 'raw' AND ts < ?`).run(rawCutoff).changes ?? 0);
    const m1Cutoff = new Date(nowMs - retain1mDays() * 86_400_000).toISOString();
    m1 = Number(sqliteDb.prepare(`DELETE FROM health_samples WHERE kind = '1m' AND ts < ?`).run(m1Cutoff).changes ?? 0);
  } catch (err) {
    console.error('[health] retention trim failed', err);
  }
  return { raw, m1 };
}

/** One maintenance pass: roll buckets forward, then trim. Cheap, runs on the
 *  slow cadence (health_rollup_minutes), never on the sample tick. */
export function maintain(nowMs = Date.now()): { rolled: { m1: number; h1: number }; trimmed: { raw: number; m1: number } } {
  const rolled = rollup(nowMs);
  const trimmed = trimRetention(nowMs);
  return { rolled, trimmed };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

interface HealthEventDbRow {
  id: number; ts: string; kind: HealthEventKind; metric: string;
  value: number | null; threshold: number | null;
  snapshot_json: string | null; suggestion: string | null;
  cued: number; resolved_at: string | null; acknowledged_at: string | null;
}

function eventSummary(row: HealthEventDbRow, snap: WorkloadSnapshot | null): string {
  const unit = row.metric === 'lag' ? 'ms' : '%';
  const head = row.kind === 'release'
    ? `${row.metric} back under ${row.threshold ?? '?'}${unit}`
    : row.kind === 'note'
      ? row.metric
      : `${row.metric} ${row.value ?? '?'}${unit} > ${row.threshold ?? '?'}${unit}`;
  return snap?.summary ? `${head} · ${snap.summary}` : head;
}

function hydrateEvent(row: HealthEventDbRow | undefined | null): HealthEvent | null {
  if (!row) return null;
  let snapshot: WorkloadSnapshot | null = null;
  if (row.snapshot_json) {
    try { snapshot = JSON.parse(row.snapshot_json) as WorkloadSnapshot; } catch { snapshot = null; }
  }
  return {
    id: row.id, ts: row.ts, kind: row.kind, metric: row.metric,
    value: row.value, threshold: row.threshold,
    snapshot, suggestion: row.suggestion,
    cued: !!row.cued, resolved_at: row.resolved_at, acknowledged_at: row.acknowledged_at,
    summary: eventSummary(row, snapshot),
  };
}

export function getHealthEvent(id: number): HealthEvent | null {
  return hydrateEvent(sqliteDb.prepare(`SELECT * FROM health_events WHERE id = ?`).get(id) as HealthEventDbRow | undefined);
}

export function listHealthEvents(opts: { limit?: number; metric?: string; kind?: string } = {}): HealthEvent[] {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 50), 500));
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.metric) { where.push('metric = ?'); args.push(opts.metric); }
  if (opts.kind) { where.push('kind = ?'); args.push(opts.kind); }
  const sql = `SELECT * FROM health_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC, id DESC LIMIT ?`;
  args.push(limit);
  const rows = sqliteDb.prepare(sql).all(...args) as HealthEventDbRow[];
  return rows.map((r) => hydrateEvent(r)).filter((e): e is HealthEvent => e !== null);
}

export function listHealthEventsInWindow(fromIso: string, toIso: string): HealthEvent[] {
  const rows = sqliteDb.prepare(
    `SELECT * FROM health_events WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`,
  ).all(fromIso, toIso) as HealthEventDbRow[];
  return rows.map((r) => hydrateEvent(r)).filter((e): e is HealthEvent => e !== null);
}

export function openHealthEvents(): HealthEvent[] {
  const rows = sqliteDb.prepare(
    `SELECT * FROM health_events WHERE kind = 'spike' AND resolved_at IS NULL ORDER BY ts DESC, id DESC LIMIT 50`,
  ).all() as HealthEventDbRow[];
  return rows.map((r) => hydrateEvent(r)).filter((e): e is HealthEvent => e !== null);
}

function emitEvent(action: 'created' | 'updated', event: HealthEvent): void {
  try { sseBus.emit('sse', { type: 'health_event', action, event }); }
  catch (err) { console.error('[health] event SSE emit failed', err); }
}

function insertEvent(args: {
  kind: HealthEventKind; metric: string; value?: number | null; threshold?: number | null;
  snapshot?: WorkloadSnapshot | null; cued?: boolean; ts?: string;
}): HealthEvent | null {
  try {
    const info = sqliteDb.prepare(
      `INSERT INTO health_events (ts, kind, metric, value, threshold, snapshot_json, cued) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.ts ?? new Date().toISOString(), args.kind, args.metric,
      args.value ?? null, args.threshold ?? null,
      args.snapshot ? JSON.stringify(args.snapshot) : null,
      args.cued ? 1 : 0,
    );
    const created = getHealthEvent(Number(info.lastInsertRowid));
    if (created) emitEvent('created', created);
    return created;
  } catch (err) {
    console.error('[health] could not record event', err);
    return null;
  }
}

/** JARVIS writes its suggestion back here (`health ack` / `health suggest`). */
export function ackHealthEvent(id: number, suggestion?: string | null): HealthEvent | null {
  const existing = getHealthEvent(id);
  if (!existing) return null;
  try {
    if (suggestion != null && suggestion.trim() !== '') {
      sqliteDb.prepare(`UPDATE health_events SET suggestion = ?, acknowledged_at = ? WHERE id = ?`)
        .run(suggestion.trim(), new Date().toISOString(), id);
    } else {
      sqliteDb.prepare(`UPDATE health_events SET acknowledged_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), id);
    }
  } catch (err) {
    console.error('[health] ack failed', err);
    return existing;
  }
  const updated = getHealthEvent(id);
  if (updated) emitEvent('updated', updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Spike state machine (CONTRACT §7)
// ---------------------------------------------------------------------------

const METRICS: HealthMetric[] = ['cpu', 'mem', 'lag', 'disk'];

interface MetricState { over_since: number | null; event_id: number | null }
const metricState = new Map<HealthMetric, MetricState>();
function stateFor(m: HealthMetric): MetricState {
  let s = metricState.get(m);
  if (!s) { s = { over_since: null, event_id: null }; metricState.set(m, s); }
  return s;
}
/** Test seam only — reset the in-memory state machine between scenarios. */
export function __resetHealthSpikeState(): void { metricState.clear(); }

export function metricValue(sample: HealthSample, m: HealthMetric): number | null {
  switch (m) {
    case 'cpu': return sample.cpu.pct;
    case 'mem': return sample.mem.pct;
    case 'lag': return sample.lag.p99_ms;
    case 'disk': return Math.max(sample.disk.root.pct, sample.disk.db.pct);
  }
}
function thresholdFor(t: HealthThresholds, m: HealthMetric): number {
  switch (m) {
    case 'cpu': return t.cpu_pct;
    case 'mem': return t.mem_pct;
    case 'lag': return t.lag_ms;
    case 'disk': return t.disk_pct;
  }
}

/** Metrics currently over threshold, per the latest sample. */
export function metricsOverThreshold(sample: HealthSample): HealthMetric[] {
  const t = thresholds();
  return METRICS.filter((m) => {
    const v = metricValue(sample, m);
    return v != null && v > thresholdFor(t, m);
  });
}

function cuedRecently(metric: HealthMetric, nowMs: number, cooldownMin: number): boolean {
  if (cooldownMin <= 0) return false;
  try {
    const row = sqliteDb.prepare(
      `SELECT ts FROM health_events WHERE metric = ? AND kind = 'spike' AND cued = 1 ORDER BY ts DESC LIMIT 1`,
    ).get(metric) as { ts: string } | undefined;
    if (!row) return false;
    const t = Date.parse(row.ts);
    if (!Number.isFinite(t)) return false;
    return nowMs - t < cooldownMin * 60_000;
  } catch { return false; }
}

export const HEALTH_THREAD_EXT = 'cockpit:health-monitor';

/** Find-or-create the 🩺 thread. Model override applied ONCE, at creation —
 *  after that the picker in the window header is Kevin's. */
export function ensureHealthThread(): { external_id: string; created: boolean } {
  const existed = !!getConversation(HEALTH_THREAD_EXT);
  const conv = getOrCreateConversation(HEALTH_THREAD_EXT);
  if (!existed) {
    try { renameConversation(conv.id, '🩺 Health monitor'); }
    catch (err) { console.warn('[health] could not label the monitor thread', err); }
    try { setThreadModelOverride(conv.id, 'claude', monitorModel()); }
    catch (err) { console.warn('[health] could not set the monitor thread model', err); }
  }
  return { external_id: HEALTH_THREAD_EXT, created: !existed };
}

export function composeSpikeCue(event: HealthEvent, sample: HealthSample): string {
  const w = event.snapshot ?? sample.workload;
  const unit = event.metric === 'lag' ? 'ms' : '%';
  const recent = seriesPoints('15m').points.slice(-30);
  const spark = recent
    .map((p) => `${p.ts.slice(11, 19)} cpu ${p.cpu_pct ?? '-'}% mem ${p.mem_pct ?? '-'}% lag ${p.lag_p99_ms ?? '-'}ms workers ${p.workers ?? '-'} claude ${p.claude_procs ?? '-'}`)
    .join('\n');
  return [
    `[health spike #${event.id}] ${event.metric} ${event.value}${unit} stayed over ${event.threshold}${unit} for ${thresholds().spike_seconds}s.`,
    '',
    `WHAT WAS RUNNING: ${w.summary}`,
    `- workers ${w.workers.total}/${w.workers.slots} (${w.workers.nodes.map((n) => `#${n.node_id} ${n.adapter ?? '?'}/${n.model ?? '?'}`).join(', ') || 'none'})`,
    `- turns: ${w.turns.active} active (${w.turns.automated} automated, cap ${w.turns.admission_cap}), claude procs ${sample.claude.processes}`,
    w.night ? `- shift #${w.night.run_id} ${w.night.status}: ${w.night.items_running} running of ${w.night.items_total}` : '- no shift running',
    w.autopilot.total ? `- autopilot goals: ${w.autopilot.goals.map((g) => `#${g.goal_id} ${g.title}`).join(', ')}` : '- no autopilot goals',
    `- throttle: slots ${w.throttle.hopper_slots}, per-goal ${w.throttle.max_per_goal}, claude mode ${w.throttle.claude_mode}; hold ${w.throttle.hold.reason}`,
    `- accounts: ${w.accounts.map((a) => `${a.key} 5h ${a.five_hour ?? '?'}% / weekly ${a.weekly ?? '?'}%`).join(' · ') || 'unknown'}`,
    `- box: cpu ${sample.cpu.pct}% load ${sample.cpu.load1}, mem ${sample.mem.pct}% (jarvis rss ${sample.mem.rss_mb}MB), lag p99 ${sample.lag.p99_ms}ms, disk ${sample.disk.root.pct}% / db dir ${sample.disk.db.pct}%, jarvis.db ${Math.round(sample.db.total_bytes / MB)}MB (${sample.db.freelist_pct}% free pages)`,
    '',
    'LAST 15 MINUTES:',
    spark || '(no points yet)',
    '',
    'Write Kevin a 3–5 line suggestion: what is most likely causing this, and the ONE dial or action you would change (naming the exact setting and value). Then store it with:',
    `  health ack {"event_id": ${event.id}, "suggestion": "<your 3-5 lines>"}`,
    '',
    'Do NOT change any dial yourself — this surface is suggestions only; Kevin turns the dials. Reply in ≤5 lines.',
  ].join('\n');
}

/** Same shape as goals.postCue, kept local so a monitor never statically pulls
 *  in the goals module graph and can never wedge on an import cycle. */
function postHealthCue(text: string, correlationKey: string): void {
  const ext = ensureHealthThread().external_id;
  const conv = getConversation(ext);
  if (!conv) { console.warn('[health] cue skipped — no conversation for the monitor thread'); return; }
  const convId = conv.id;
  Promise.all([import('./agent.js'), import('./thread-message-queue.js')])
    .then(([agent, queue]) => {
      if (agent.getInFlightMessageId(convId)) { queue.enqueueMessage(convId, text); return; }
      agent.processMessage(text, ext, correlationKey).catch((err: unknown) => {
        if (err instanceof agent.ConversationBusyError) queue.enqueueMessage(convId, text);
        else console.error('[health] cue post failed', err);
      });
    })
    .catch((err) => console.error('[health] cue import failed', err));
}

/**
 * The state machine. Called on every sample; writes at most one spike row per
 * metric per crossing, at most one cue per metric per cooldown, and one release
 * row when the metric comes back under.
 */
export function evaluateSpikes(sample: HealthSample, nowMs = Date.parse(sample.ts)): {
  spikes: HealthEvent[]; releases: HealthEvent[]; cues: number;
} {
  const t = thresholds();
  const out = { spikes: [] as HealthEvent[], releases: [] as HealthEvent[], cues: 0 };
  const sustainMs = t.spike_seconds * 1000;

  for (const metric of METRICS) {
    const value = metricValue(sample, metric);
    const threshold = thresholdFor(t, metric);
    const state = stateFor(metric);
    const over = value != null && value > threshold;

    if (over) {
      if (state.over_since == null) state.over_since = nowMs;
      if (state.event_id != null) continue;                     // already reported
      if (nowMs - state.over_since < sustainMs) continue;        // not sustained yet

      // The evidence frozen onto a spike row is the one place staleness would
      // actually mislead, so pay the full compose here — once per spike.
      let evidence = sample.workload;
      try { evidence = workloadSnapshot({ force: true }); }
      catch (err) { console.warn('[health] could not refresh the spike snapshot, using the sampled one', err); }
      const event = insertEvent({
        kind: 'spike', metric, value, threshold,
        snapshot: evidence, ts: sample.ts,
        cued: false,
      });
      if (!event) continue;
      state.event_id = event.id;
      out.spikes.push(event);

      try {
        createNotification({
          severity: 'warning',
          title: `🩺 ${metric} spike — ${value}${metric === 'lag' ? 'ms' : '%'} over ${threshold}`,
          body: sample.workload.summary,
          source: 'health-monitor',
          link: '/health',
        });
      } catch (err) { console.error('[health] notification failed', err); }

      // The cue is the ONLY model call this file makes, and it is rate-limited.
      if (cueEnabled() && !cuedRecently(metric, nowMs, t.cooldown_min)) {
        try {
          sqliteDb.prepare(`UPDATE health_events SET cued = 1 WHERE id = ?`).run(event.id);
          const cued = getHealthEvent(event.id);
          if (cued) { emitEvent('updated', cued); out.spikes[out.spikes.length - 1] = cued; }
          postHealthCue(composeSpikeCue(cued ?? event, sample), `health:${event.id}`);
          out.cues += 1;
        } catch (err) { console.error('[health] cue failed', err); }
      }
      continue;
    }

    // Back under threshold.
    if (state.event_id != null) {
      const release = insertEvent({ kind: 'release', metric, value, threshold, ts: sample.ts });
      if (release) out.releases.push(release);
      try {
        sqliteDb.prepare(`UPDATE health_events SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL`)
          .run(sample.ts, state.event_id);
        const resolved = getHealthEvent(state.event_id);
        if (resolved) emitEvent('updated', resolved);
      } catch (err) { console.error('[health] could not resolve the spike row', err); }
    }
    state.over_since = null;
    state.event_id = null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Status rows for /health/workloads (§1.4 — the clickable rows)
// ---------------------------------------------------------------------------

export interface WorkloadRow {
  key: 'workers' | 'night' | 'autopilot' | 'chats' | 'providers' | 'throttle' | 'watchdog' | 'retention';
  label: string;
  status: 'ok' | 'busy' | 'warn' | 'idle' | 'error';
  value: string;
  detail: string;
  links: { label: string; href: string }[];
  items: { label: string; value: string; href?: string }[];
}

function watchdogRow(): WorkloadRow {
  let heartbeat: { ts?: string; checked?: number } | null = null;
  try { heartbeat = JSON.parse(fs.readFileSync('/tmp/jarvis-watchdog-heartbeat.json', 'utf8')) as { ts?: string; checked?: number }; }
  catch { heartbeat = null; }
  const open = safeQuery<{ id: number; promise: string; status: string; due_at: string | null }>(
    `SELECT id, promise, status, due_at FROM watch_commitments WHERE status IN ('open','breached') ORDER BY id DESC LIMIT 20`, [],
  );
  const breached = open.filter((c) => c.status === 'breached').length;
  const ageMin = minutesSince(heartbeat?.ts ?? null);
  const stale = ageMin == null || ageMin > 5;
  return {
    key: 'watchdog',
    label: 'Watchdog',
    status: stale ? 'warn' : breached ? 'warn' : 'ok',
    value: `${open.length} open${breached ? `, ${breached} breached` : ''}${stale ? ' · heartbeat stale' : ''}`,
    detail: heartbeat?.ts
      ? `Last tick ${ageMin}m ago${stale ? ' — the 60s timer may be dead.' : '.'}`
      : 'No heartbeat file at /tmp/jarvis-watchdog-heartbeat.json — the watchdog timer may not be running.',
    links: [{ label: 'Flight Deck', href: '/flight-deck' }],
    items: open.map((c) => ({ label: `#${c.id} ${c.promise}`, value: `${c.status}${c.due_at ? ` · due ${c.due_at}` : ''}` })),
  };
}

function retentionRow(sample: HealthSample | null): WorkloadRow {
  const bytes = sample?.db.total_bytes ?? 0;
  const freePct = sample?.db.freelist_pct ?? 0;
  const gb = round(bytes / (1024 * MB), 2);
  // The 1.5 GB incident: a high freelist % means the retention sweep ran but the
  // pages were never reclaimed — the file stays huge until a VACUUM.
  const status: WorkloadRow['status'] = gb >= 1 ? 'warn' : 'ok';
  return {
    key: 'retention',
    label: 'DB retention',
    status,
    value: `${gb} GB · ${freePct}% free pages`,
    detail: freePct >= 30
      ? `${freePct}% of the file is free pages — the nightly sweep is nulling rows but nothing has VACUUMed them back.`
      : 'Database size and free-page share, straight off the file + PRAGMA.',
    links: [],
    items: [
      { label: 'jarvis.db', value: `${round((sample?.db.bytes ?? 0) / MB, 1)} MB` },
      { label: 'WAL', value: `${round((sample?.db.wal_bytes ?? 0) / MB, 1)} MB` },
      { label: 'pages', value: `${sample?.db.page_count ?? 0} × ${sample?.db.page_size ?? 0}B` },
      { label: 'free pages', value: `${sample?.db.freelist_count ?? 0} (${freePct}%)` },
      { label: 'row writes/min', value: String(sample?.db.writes_per_min ?? 0) },
      { label: 'API requests/min', value: String(sample?.db.api_requests_per_min ?? 0) },
    ],
  };
}

export function workloadRows(snapshot?: WorkloadSnapshot, sample?: HealthSample | null): { ts: string; rows: WorkloadRow[]; workload: WorkloadSnapshot } {
  const s = sample !== undefined ? sample : lastSample;
  const w = snapshot ?? s?.workload ?? workloadSnapshot();
  const rows: WorkloadRow[] = [];

  rows.push({
    key: 'workers',
    label: 'Hopper trees',
    status: w.workers.total >= w.workers.slots && w.workers.slots > 0 ? 'busy' : w.workers.total ? 'ok' : 'idle',
    value: `${w.workers.total}/${w.workers.slots} workers`,
    detail: w.workers.total
      ? `${w.workers.total} running node(s) across ${w.workers.by_tree.length} tree(s).`
      : 'No hopper nodes running.',
    links: [{ label: 'Governor settings', href: '/settings/governor' }],
    items: w.workers.nodes.map((n) => ({
      label: `#${n.node_id} ${n.title}`,
      value: `${n.adapter ?? '?'}/${n.model ?? '?'}${n.elapsed_min != null ? ` · ${n.elapsed_min}m` : ''}`,
      href: `/spawn-tree/${n.tree_id}`,
    })),
  });

  rows.push({
    key: 'night',
    label: 'Shifts / Night shift',
    status: w.night ? (w.night.status === 'running' ? 'busy' : w.night.status === 'paused' ? 'warn' : 'ok') : 'idle',
    value: w.night
      ? `#${w.night.run_id} ${w.night.status} · ${w.night.items_done}/${w.night.items_total} done`
      : 'no session running',
    detail: w.night
      ? `${w.night.items_running} item(s) running in ${w.night.lanes} lane(s); ${w.night.items_failed} failed.`
      : 'No shift planned or running.',
    links: w.night
      ? [{ label: 'Shifts board', href: '/night' }, ...(w.night.thread_ext ? [{ label: 'Orchestrator chat', href: `/thread/${w.night.thread_ext}` }] : [])]
      : [{ label: 'Shifts board', href: '/night' }],
    items: (w.night?.running_titles ?? []).map((tl) => ({ label: tl, value: 'running' })),
  });

  rows.push({
    key: 'autopilot',
    label: 'Goals autopilot',
    status: w.autopilot.total ? 'busy' : 'idle',
    value: w.autopilot.total ? `${w.autopilot.total} goal(s) ticking` : 'off',
    detail: w.autopilot.total ? 'Goals whose driver is running itself.' : 'No goal is on autopilot.',
    links: [{ label: 'Goals', href: '/goals' }],
    items: w.autopilot.goals.map((g) => ({
      label: `#${g.goal_id} ${g.title}`,
      value: `${g.working_nodes} working node(s)`,
      href: `/goals/${g.goal_id}`,
    })),
  });

  rows.push({
    key: 'chats',
    label: 'Chats (turns in flight)',
    status: w.turns.active >= w.turns.admission_cap ? 'busy' : w.turns.active ? 'ok' : 'idle',
    value: `${w.turns.active} running · ${w.turns.automated}/${w.turns.admission_cap} automated`,
    detail: `${w.turns.kevin} of these are not spawned workers. ${s ? `${s.claude.processes} claude CLI process(es) on the box (${s.claude.source}).` : ''}`.trim(),
    links: [],
    items: w.turns.threads.map((th) => ({
      label: th.title ?? th.external_id,
      value: `${th.elapsed_min}m${th.automated ? ' · worker' : ''}`,
      href: `/thread/${th.external_id}`,
    })),
  });

  const heldProviders = Object.entries(w.providers).filter(([, v]) => !v.allow).map(([k]) => k);
  rows.push({
    key: 'providers',
    label: 'Providers',
    status: heldProviders.length === Object.keys(w.providers).length && heldProviders.length > 0 ? 'warn' : 'ok',
    value: heldProviders.length ? `holding: ${heldProviders.join(', ')}` : 'all open',
    detail: w.throttle.hold.detail || 'Governor verdict per pool, plus the Claude account meters.',
    links: [{ label: 'Governor settings', href: '/settings/governor' }],
    items: [
      ...Object.entries(w.providers).map(([k, v]) => ({
        label: k,
        value: `${v.allow ? 'open' : `hold: ${v.reason}`}${v.usage != null ? ` · ${Math.round(v.usage)}%${v.ceiling != null ? `/${v.ceiling}%` : ''}` : ''}${v.override && v.override !== 'auto' ? ` · override ${v.override}` : ''}`,
      })),
      ...w.accounts.map((a) => ({
        label: `claude ${a.key}${a.active ? ' (active)' : ''}`,
        value: `5h ${a.five_hour ?? '?'}% · weekly ${a.weekly ?? '?'}%${a.stale ? ' · STALE' : ''}${a.enabled ? '' : ' · disabled'}`,
      })),
    ],
  });

  rows.push({
    key: 'throttle',
    label: 'Throttle dials',
    status: w.throttle.hold.dispatching ? 'ok' : 'warn',
    value: `slots ${w.throttle.hopper_slots} · per-goal ${w.throttle.max_per_goal} · claude ${w.throttle.claude_mode}`,
    detail: w.throttle.hold.dispatching
      ? 'Dispatching normally.'
      : `Holding — ${w.throttle.hold.reason}: ${w.throttle.hold.detail}`,
    links: [{ label: 'Governor settings', href: '/settings/governor' }],
    items: [
      { label: 'hopper_slots', value: String(w.throttle.hopper_slots) },
      { label: 'max per goal', value: String(w.throttle.max_per_goal) },
      { label: 'max per tree', value: String(w.throttle.max_per_tree) },
      { label: 'claude mode', value: `${w.throttle.claude_mode}${w.throttle.claude_order ? ` (${w.throttle.claude_order})` : ''}` },
      { label: 'admission cap', value: String(w.turns.admission_cap) },
      { label: 'hold', value: `${w.throttle.hold.reason}` },
    ],
  });

  rows.push(watchdogRow());
  rows.push(retentionRow(s));

  return { ts: s?.ts ?? new Date().toISOString(), rows, workload: w };
}

// ---------------------------------------------------------------------------
// The composed /health/now payload
// ---------------------------------------------------------------------------

export function healthNow(): {
  sample: HealthSample | null; age_seconds: number | null;
  thresholds: HealthThresholds;
  status: { level: 'ok' | 'spike'; metrics: string[] };
  open_events: HealthEvent[];
  sampler: { enabled: boolean; interval_seconds: number; last_tick_ms: number | null; avg_tick_ms: number | null; samples_stored: { raw: number; m1: number; h1: number } };
} {
  const sample = lastSample;
  const over = sample ? metricsOverThreshold(sample) : [];
  const stats = samplerStats();
  return {
    sample,
    age_seconds: lastSampleAtMs ? round((Date.now() - lastSampleAtMs) / 1000, 1) : null,
    thresholds: thresholds(),
    status: { level: over.length ? 'spike' : 'ok', metrics: over },
    open_events: openHealthEvents(),
    sampler: {
      enabled: healthEnabled(),
      interval_seconds: sampleSeconds(),
      last_tick_ms: stats.last_tick_ms,
      avg_tick_ms: stats.avg_tick_ms,
      samples_stored: sampleCounts(),
    },
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

let sampleTimer: NodeJS.Timeout | null = null;
let maintainTimer: NodeJS.Timeout | null = null;
let currentIntervalMs = 0;

function armSampleTimer(): void {
  const ms = sampleSeconds() * 1000;
  if (sampleTimer && ms === currentIntervalMs) return;
  if (sampleTimer) clearInterval(sampleTimer);
  currentIntervalMs = ms;
  sampleTimer = setInterval(() => {
    try {
      if (!healthEnabled()) return;       // history still serves; sampling pauses
      takeSample();
      armSampleTimer();                   // pick up a cadence change with no restart
    } catch (err) {
      console.error('[health] sampler tick failed', err);
    }
  }, ms);
  sampleTimer.unref?.();
}

export function startHealthMonitor(): void {
  if (sampleTimer) return;
  ensureHistogram();
  prevCpu = cpuTotals();                  // prime the delta so sample #2 has CPU
  try { refreshClaudeProcs(); } catch { /* non-fatal */ }
  armSampleTimer();
  maintainTimer = setInterval(() => {
    try { maintain(); } catch (err) { console.error('[health] maintenance failed', err); }
  }, rollupMinutes() * 60_000);
  maintainTimer.unref?.();
  console.log(`[health] sampler started — every ${sampleSeconds()}s, rollup every ${rollupMinutes()}m`);
}

export function stopHealthMonitor(): void {
  if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; currentIntervalMs = 0; }
  if (maintainTimer) { clearInterval(maintainTimer); maintainTimer = null; }
}
