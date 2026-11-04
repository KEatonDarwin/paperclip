# Cockpit Health — BINDING backend contract (v1)

Authored by node #858 (CONTRACT+BACKEND) of tree `tree-2a693306`, from
`skills/cockpit-health/DESIGN.md` (which wins on intent; this file is the exact
wire shape). **The UI node builds against THIS file.** Branch `hopper/health`,
worktree `/home/kevin/paperclip-worktrees/health`.

Everything below is served by `src/health-monitor.ts` + routes in
`src/handlers/api-v1.ts`, all under `/api/v1` with the normal bearer auth.
Zero model calls anywhere except the one spike cue (§6).

---

## 0. Vocabulary + honesty notes (put these in the UI, verbatim in spirit)

| Field | What it actually is | Say this in the UI |
|---|---|---|
| `db.api_requests_per_min` | count of `/api/v1` HTTP requests served in the interval | **"API requests/min"** — NOT sqlite reads |
| `db.writes_per_min` | new rows in `turns` + `night_events` + `goal_events` + `health_samples`, plus `hopper_nodes` rows whose `updated_at` moved, extrapolated to a minute | **"row writes/min (sampled tables)"** — a proxy, not a sqlite write counter |
| `claude.processes` | `pgrep -c -f claude` refreshed **asynchronously**, so it is at most one interval stale (`claude.source='pgrep'`); falls back to the harness's own in-flight run count (`claude.source='active_runs'`) when pgrep is missing or errors | "claude CLI processes" |
| `lag.*` | `perf_hooks.monitorEventLoopDelay` over the interval, in **ms** | "event-loop lag — the number that explains a laggy cockpit" |
| `cpu.pct` | delta of `os.cpus()` times since the previous sample, whole box, 0–100 | "CPU (box)" |
| `db.freelist_pct` | `freelist_count / page_count` | "free space inside the DB file — high = wants a VACUUM" |

`cpu.pct` is `null` on the very first sample after boot (no previous delta).

---

## 1. Settings-KV keys + defaults

A fresh box with none of these rows set behaves exactly as the defaults.
All are read **uncached** on every use, so a change lands on the next tick.

| key | default | meaning |
|---|---|---|
| `health_monitor_enabled` | `1` | `0` stops the sampler (already-stored history still serves) |
| `health_sample_seconds` | `5` | sampler cadence, clamped 1–300 |
| `health_rollup_minutes` | `5` | rollup + retention cadence, clamped 1–1440 |
| `health_retain_raw_hours` | `24` | raw samples trimmed past this, clamped 1–720 |
| `health_retain_1m_days` | `30` | 1-minute rollups trimmed past this, clamped 1–3650 (1h rollups are kept forever) |
| `health_cpu_pct` | `80` | spike threshold, % |
| `health_mem_pct` | `85` | spike threshold, % |
| `health_lag_ms` | `500` | spike threshold on **lag p99**, ms |
| `health_disk_pct` | `90` | spike threshold, % — max of root and db-dir |
| `health_spike_seconds` | `30` | must stay over for this long before a `spike` row is written |
| `health_spike_cooldown_min` | `30` | at most one **cue** per metric per this window (events still fire) |
| `health_monitor_model` | `claude-sonnet-5` | model override applied ONCE when `cockpit:health-monitor` is created |
| `health_cue_enabled` | `1` | `0` = spike events + notifications still fire, no cue (kill switch) |
| `health_workload_ttl_seconds` | `60` | how long the **cached half** of the workload snapshot (throttle dials, governor verdicts, account meters) is reused before recomposing; `0` disables the cache. See §3. |

Thresholds are also echoed on `GET /health/now` as `thresholds`, so the UI never
has to read settings itself.

---

## 2. `HealthSample` — the raw row (`GET /health/now.sample`)

```ts
interface DiskView { path: string; total_mb: number; used_mb: number; free_mb: number; pct: number }

interface HealthSample {
  ts: string;                     // ISO-8601 UTC, e.g. "2026-09-25T18:31:05.412Z"
  interval_ms: number;            // wall ms since the previous sample (first sample: the configured interval)
  tick_ms: number;                // how long collecting THIS sample took (the §2 rail: < 5 ms)
  cpu:  { pct: number | null; load1: number; load5: number; load15: number; cores: number };
  mem:  { total_mb: number; used_mb: number; free_mb: number; pct: number;
          rss_mb: number; heap_used_mb: number; heap_total_mb: number };
  lag:  { p50_ms: number; p99_ms: number; max_ms: number };
  disk: { root: DiskView; db: DiskView };          // db = the dir holding jarvis.db
  db:   { bytes: number; wal_bytes: number; total_bytes: number;
          page_count: number; page_size: number; freelist_count: number; freelist_pct: number;
          turns_written: number;                    // new `turns` rows in THIS interval
          writes: number; writes_per_min: number;   // see §0
          api_requests: number; api_requests_per_min: number };
  claude: { processes: number; source: 'pgrep' | 'active_runs' };
  workload: WorkloadSnapshot;      // §3
}
```

## 3. `WorkloadSnapshot` — who is doing what, at that instant

```ts
interface WorkloadSnapshot {
  workers: {                        // running hopper nodes
    total: number;
    slots: number;                  // throttle hopper_slots
    free: number;
    nodes: Array<{
      node_id: number; tree_id: string; tree_topic: string | null;
      goal_id: number | null; title: string;
      adapter: string | null; model: string | null; account: string | null;
      elapsed_min: number | null;   // from lease_expires_at, null if unknown
      worker_thread_ext: string | null;
    }>;
    by_goal: Array<{ goal_id: number; title: string | null; n: number; cap: number; at_cap: boolean }>;
    by_tree: Array<{ tree_id: string; topic: string | null; goal_id: number | null; n: number; cap: number; at_cap: boolean }>;
  };
  turns: {
    active: number;                 // conversations with a turn in flight (agent.getActiveRunCount)
    automated: number;              // turn-admission's counter
    kevin: number;                  // active - automated, floored at 0
    admission_cap: number;          // max_concurrent_auto_turns
    threads: Array<{ conversation_id: number; external_id: string; title: string | null;
                     automated: boolean; elapsed_min: number }>;
  };
  night: null | {                   // the active SHIFT, if any
    run_id: number; status: string; mode: string; label: string | null;
    thread_ext: string | null; lanes: number;
    items_total: number; items_done: number; items_failed: number; items_running: number;
    running_titles: string[];
  };
  autopilot: {                      // goals with autopilot = 1
    goals: Array<{ goal_id: number; title: string; working_nodes: number }>;
    total: number;
  };
  providers: Record<string, {       // 'claude' | 'codex' | 'auggie' | 'devin'
    allow: boolean; reason: string; detail: string;
    usage: number | null; ceiling: number | null; override: string;
  }>;
  accounts: Array<{                 // claude A / B
    key: string; label: string; enabled: boolean;
    five_hour: number | null; weekly: number | null; stale: boolean;
    eligible: boolean; active: boolean;
    five_hour_resets_at: string | null; weekly_resets_at: string | null;
  }>;
  throttle: { hopper_slots: number; max_per_goal: number; max_per_tree: number;
              claude_mode: string; claude_order: string;
              hold: { dispatching: boolean; reason: string; detail: string } };
  summary: string;                  // one line, e.g. "4 workers · 2 turns · shift #4 · A 5h 62%"
  as_of: string;                    // when the CACHED half was composed (ISO-8601)
  age_seconds: number;              // how stale that half is; 0 = composed this tick
}
```
`summary` is what the chart-marker hover shows.

### Two halves, two freshnesses — the UI must not blur them

Measured on a copy of the real 1.5 GB `jarvis.db` (14,301 turns / 866 hopper
nodes): `fullThrottleStatus()` costs **~18–30 ms** while every other input to a
sample costs **< 0.25 ms combined**. This page exists to measure synchronous
event-loop blocking, so paying that on every 5 s tick would write a self-inflicted
stall into the very histogram it reports — over DESIGN.md §2's `< 5 ms` rail. It
cannot be fixed by deferring the call: unlike the `pgrep` child process, it is
synchronous work, so deferring only stops `tick_ms` being *charged* for a stall
that still happens.

So the snapshot has two halves:

| half | fields | freshness |
|---|---|---|
| **live** | `workers` (incl. `total` + `nodes`), `turns`, `night`, `autopilot` | recomposed **every tick** |
| **cached** | `providers`, `accounts`, `throttle` (dials + `hold`) | recomposed every `health_workload_ttl_seconds` (60) |

`as_of` / `age_seconds` describe the **cached** half only. A 60 s TTL costs
nothing real there: the provider usage files underneath are themselves polled once
a minute, so those meters cannot be fresher than 60 s however often we recompose.

**UI rule:** render the account/governor/throttle tiles with the `age_seconds`
stamp (e.g. "dials as of 34 s ago") and the worker/turn/shift rows without one.
Never present a cached number as live.

`evaluateSpikes()` forces a full recompose when it freezes evidence onto a spike
row, so `HealthEvent.snapshot` is always `age_seconds: 0` — exact at the instant
that mattered.

## 4. `HealthPoint` — the uniform series point

Raw and rollup rows serve the **same** shape, so a chart never branches on
resolution. For a raw point `n = 1` and every `*_max` equals its base field.

```ts
interface HealthPoint {
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
```
Rollup semantics: base field = **mean** over the bucket, `*_max` = **peak**;
`db_bytes` / `db_wal_bytes` / `db_freelist_pct` / `disk_*_pct` are the **last**
value in the bucket (they are levels, not rates).

## 5. Routes

### `GET /health/now`
```ts
{
  ok: true,
  sample: HealthSample | null,          // null only before the first tick
  age_seconds: number | null,           // how stale `sample` is
  thresholds: { cpu_pct, mem_pct, lag_ms, disk_pct, spike_seconds, cooldown_min },
  status: { level: 'ok' | 'spike', metrics: string[] },   // metrics = names currently over
  open_events: HealthEvent[],           // unresolved spikes, newest first
  sampler: { enabled: boolean, interval_seconds: number, last_tick_ms: number | null,
             avg_tick_ms: number | null, samples_stored: { raw: number, m1: number, h1: number } }
}
```

### `GET /health/series?window=15m|1h|6h|24h|7d|30d&metrics=cpu,mem,lag,disk,db,claude`
`window` default `1h`; an unknown window → `400 invalid_window`.
`metrics` is an **advisory filter** echoed back; the server always returns full
points (they are small and the UI cross-plots them) — documented so the UI does
not wait on per-metric trimming.
```ts
{
  ok: true, window: string, resolution: 'raw' | '1m' | '1h',
  from: string, to: string, metrics: string[],
  points: HealthPoint[],                // ascending ts
  events: HealthEvent[]                 // spike/release/note rows in the window, for chart markers
}
```
Resolution map (fixed, not negotiable by the client): `15m`,`1h` → `raw`;
`6h`,`24h` → `1m`; `7d`,`30d` → `1h`.

### `GET /health/workloads`
The clickable status rows, already shaped for the table + drawer.
```ts
{
  ok: true, ts: string,
  rows: Array<{
    key: 'workers' | 'night' | 'autopilot' | 'chats' | 'providers' | 'throttle' | 'watchdog' | 'retention';
    label: string;
    status: 'ok' | 'busy' | 'warn' | 'idle' | 'error';
    value: string;                      // the one-line right-hand summary
    detail: string;                     // one sentence for the drawer header
    links: Array<{ label: string; href: string }>;
    items: Array<{ label: string; value: string; href?: string }>;   // drawer body rows
  }>,
  workload: WorkloadSnapshot            // the same object as now.sample.workload
}
```

### `GET /health/events?limit=&metric=&kind=`
`limit` default 50, max 500. `metric` / `kind` optional exact filters.
```ts
{ ok: true, events: HealthEvent[] }

interface HealthEvent {
  id: number; ts: string;
  kind: 'spike' | 'release' | 'note';
  metric: string;                       // 'cpu' | 'mem' | 'lag' | 'disk' | free text for 'note'
  value: number | null; threshold: number | null;
  snapshot: WorkloadSnapshot | null;
  suggestion: string | null;            // written by JARVIS via `health ack` / `health suggest`
  cued: boolean;                        // a cue was actually posted for this event
  resolved_at: string | null;           // set when the matching `release` fires
  acknowledged_at: string | null;
  summary: string;                      // "cpu 91% > 80% for 45s · 4 workers · shift #4"
}
```

### `POST /health/events/:id/ack`
Body `{ suggestion?: string }`. Marks `acknowledged_at` and, when
`suggestion` is present, stores it. → `{ ok: true, event: HealthEvent }`,
`404 event_not_found` otherwise. Admin scope NOT required (it is a note, not a dial).

### `POST /health/sample` (admin scope)
Forces one sample immediately; → `{ ok: true, sample: HealthSample }`. For the
UI's "refresh now" and for JARVIS deploy-time verification. Never changes a dial.

## 6. SSE

Two new event types, both in `GLOBAL_STREAM_EVENT_TYPES` (`src/sse-bus.ts`) —
the cockpit MUST also add both to `src/lib/sse-worker.ts` `EVENT_TYPES` or they
are silently dropped for every tab.

```ts
{ type: 'health_sample', sample: HealthSample, point: HealthPoint }   // every tick
{ type: 'health_event',  action: 'created' | 'updated', event: HealthEvent }
```
`health_sample` carries both the full sample (tiles + status rows) and its
`HealthPoint` (append straight onto the chart series, no transform).

**Poll fallback:** if the stream drops, `GET /health/now` every 5 s gives the
same tiles, and `GET /health/series?window=15m` re-seeds the charts.

## 7. Spike → suggestion state machine

Per metric in `cpu | mem | lag | disk`, evaluated on every sample:

1. value over threshold and not previously over → remember `over_since`.
2. still over and `now - over_since >= health_spike_seconds` and no open spike →
   write ONE `health_events` row `kind='spike'` with the full workload snapshot,
   emit `health_event`, and create ONE cockpit notification (`severity: 'warning'`,
   source `health-monitor`, link `/health`).
3. A **cue** is posted only if no `cued` spike for that metric exists inside
   `health_spike_cooldown_min` and `health_cue_enabled != 0`. The cue goes to
   thread **`cockpit:health-monitor`** ("🩺 Health monitor", model =
   `health_monitor_model`, created on first use) through the normal
   `processMessage` path with correlation key **`health:<event_id>`** — so
   turn-admission gates it (`health:` is registered in
   `src/turn-admission.ts`) and `src/sim-guard.ts` blocks it in a scratch env.
   The event's `cued` flag records whether a cue actually went out.
4. Value back under threshold with an open spike → write a `release` row and set
   the spike's `resolved_at`. No cue, no notification.

**No dial is ever changed automatically.** The cue asks JARVIS for 3–5 lines and
tells it to store them with `health ack {event_id, suggestion}`.

## 8. Persona tool `health` (native `mcp__jarvis__health`)

| op | args | returns |
|---|---|---|
| `now` | — | the `GET /health/now` body |
| `series` | `window?`, `metrics?` | the `GET /health/series` body |
| `workloads` | — | the `GET /health/workloads` body |
| `events` | `limit?`, `metric?`, `kind?` | `{ events }` |
| `ack` | `event_id`, `suggestion?` | `{ ok, event }` |
| `suggest` | `event_id`, `suggestion` | alias of `ack` with a required suggestion |

Read ops are free to call any time. `ack`/`suggest` only write a note — they
never touch a dial, and the tool has no op that can.

## 9. Storage

```sql
CREATE TABLE health_samples (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts   TEXT NOT NULL,                     -- ISO-8601 UTC
  kind TEXT NOT NULL CHECK (kind IN ('raw','1m','1h')),
  json TEXT NOT NULL                      -- raw → HealthSample; 1m/1h → HealthPoint
);
CREATE INDEX idx_health_samples_kind_ts ON health_samples(kind, ts);
CREATE UNIQUE INDEX idx_health_samples_bucket ON health_samples(kind, ts) WHERE kind != 'raw';

CREATE TABLE health_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('spike','release','note')),
  metric TEXT NOT NULL,
  value REAL, threshold REAL,
  snapshot_json TEXT, suggestion TEXT,
  cued INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT, acknowledged_at TEXT
);
CREATE INDEX idx_health_events_ts ON health_events(ts DESC);
CREATE INDEX idx_health_events_metric ON health_events(metric, kind, ts DESC);
```
The bucket unique index makes the rollup idempotent (re-running it never
duplicates a minute or an hour).

## 10. npm script

`npm run health:check` — deterministic, scratch-DB, `JARVIS_SIM=1`, no claude
processes: sampler math, point conversion, rate-extrapolation floor, the workload
cache split, rollup idempotency, retention trim, the full spike/cooldown/release
state machine, settings defaults + clamping, and two boot-crash regressions (the
partial-index upsert and the circular-import TDZ in the tool). 45 checks, ~10 s.

`npm run health:route-check` — mounts the REAL `createApiV1Router()` on a scratch
DB on a temp port and prints every field of `GET /health/now` plus the resolution
each window resolves to. This is the deploy-time proof for AC-1/AC-2; it never
touches the live database or the live server.
