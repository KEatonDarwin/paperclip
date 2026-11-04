# Cockpit Health — user guide (`/health`)

The page that answers "wtf is going on with the actual working computer" — the
low-level box (CPU/RAM/disk/the DB) side by side with what was actually
running at that instant, so a spike and its cause show up on the same screen.

## Why this exists

You'd get lag spikes while a bunch of work was running, glance at the box, and
see nothing obviously wrong. The day this was designed, the actual cause was
`jarvis.db` sitting at 1.5 GB of debug capture — reading a 400 KB row froze the
one Node event loop for a moment. **Event-loop lag** is the metric that
explains "the cockpit feels laggy" — CPU% alone wouldn't have shown it. That's
why it gets its own tile and its own chart here, not just a line inside "CPU."

## The top row — 8 tiles

Each tile is the current value + a small sparkline for the selected window.
Amber = over its threshold right now.

| Tile | What it is | Goes amber when |
|---|---|---|
| **CPU** | % of the whole box, plus the 1-minute load average | over `health_cpu_pct` (default 80%) |
| **Memory** | % of system RAM used, plus JARVIS's own process RSS | over `health_mem_pct` (default 85%) |
| **Lag p99** | event-loop lag, 99th percentile, in ms — **the laggy-cockpit number** | over `health_lag_ms` (default 500 ms) |
| **Disk** | % used on `/`, plus free space | over `health_disk_pct` (default 90%) — root or the DB's disk, whichever is worse |
| **jarvis.db** | the database file size, plus its WAL file size | — (no threshold, just a size to watch grow) |
| **Claude procs** | how many `claude` CLI processes are running right now | — |
| **Active turns** | automated turns in flight, "+N kevin" for the ones that are you typing | — |
| **Running workers** | hopper-tree workers running right now, "of N slots" | — |

A tile can read blank/"—" for a moment right after a restart (the sampler's
first tick has no previous reading to diff against for CPU%).

## The charts — six panels, one shared time axis

All six share the same x-axis, so if CPU jumps at 3:14pm you can look straight
down and see what lag/disk/workload were doing at that same moment.

1. **CPU + load** — box-wide CPU% and the load average.
2. **Memory (system % + jarvis rss)** — system RAM% next to JARVIS's own
   memory footprint, so you can tell "the box is under memory pressure" apart
   from "JARVIS itself is bloating."
3. **Event-loop lag (p50 / p99)** — the headline metric. p50 is the normal
   case; p99 is what a spike shows up as first.
4. **Disk (root % + db dir %)** — usually the same disk, split out in case
   `jarvis.db` ever lives somewhere else.
5. **DB size + writes/min + API req/min** — the database's growth rate and how
   busy it's being kept. "API req/min" is requests hitting `/api/v1`, not raw
   sqlite reads — there's no cheap way to count actual disk reads, so this is
   the honest proxy. Same idea for "writes/min": it's new rows across the
   busiest tables (turns, hopper nodes, goal/night events), not a literal
   sqlite write counter.
6. **Workload (claude procs + workers + turns)** — this is the "what was
   running" chart, drawn on the same axis as the box metrics on purpose. If
   CPU climbs at the same moment this chart shows 4 workers, that's your
   answer without having to go dig through separate pages.

**Spike/release markers**: a vertical line drops onto every chart when a spike
starts and another when it clears, so you can see exactly when a threshold was
crossed relative to the metric.

**Window selector**: 15m / 1h / 6h / 24h / 7d / 30d. Shorter windows show
every 5-second sample; 6h/24h show 1-minute averages; 7d/30d show hourly
averages (with a `_max` peak value preserved under the hood so a real spike
never gets smoothed away, even when you're looking at a month of hourly data).

**Live updates**: the page streams over the same SSE connection as the rest of
the cockpit. If that connection drops, it falls back to polling every 5
seconds — you won't notice anything except slightly less-smooth updates. The
pause button (top right) freezes the live feed if you want to study one
moment without it scrolling away.

## The status rows — click any row for the drawer

Below the charts, one row per "thing we employ": **Workers, Night/Shifts,
Autopilot, Chats, Providers, Throttle, Watchdog, Retention.** Each row shows a
one-line summary and a status pill (ok / busy / warn / idle / error). Click a
row to open a drawer with the full detail and links straight to the relevant
page (a tree's spawn page, a thread, `/night`, a goal, `/settings/governor`).

**One thing worth knowing**: the Workers/Chats/Night/Autopilot rows are live
every tick. The Providers/Accounts/Throttle row (account %, governor verdict,
dial values) is refreshed at most once a minute, because the meters
underneath it are themselves only polled once a minute — refreshing it faster
would just show you the same stale number sooner, not a fresher one. When
that half is more than ~10 seconds old, the drawer header shows a small "dials
Ns old" chip so you're never looking at a cached number thinking it's live.

## Spikes panel — what happened, and what JARVIS thinks about it

A running list of past spikes: which metric, how far over threshold, for how
long, and what was running at that instant (the same snapshot the workload
chart would have shown). For most spikes, JARVIS writes a short suggestion —
e.g. "CPU held over 80% for 2 min with 4 claude workers running; suggest
dropping hopper_slots to 4 until the 5h window resets" — visible right on the
spike's row, with a link that opens the dedicated **🩺 Health monitor** chat
(`cockpit:health-monitor`) if you want to talk it through.

**JARVIS never changes a dial on its own because of a spike.** It only
suggests — you (or JARVIS in that conversation) still have to actually turn
the dial. That suggestion also only fires once per metric per 30 minutes
(`health_spike_cooldown_min`), so a spike that stays hot doesn't spam the
chat — the spike/release history keeps recording either way.

## Settings you can tune (settings-KV — ask JARVIS to change these, don't hand-edit the DB)

| Setting | Default | What it does |
|---|---|---|
| `health_monitor_enabled` | `1` | `0` stops new sampling; history you already have still shows on the page |
| `health_sample_seconds` | `5` | how often a sample is taken |
| `health_cpu_pct` / `health_mem_pct` / `health_lag_ms` / `health_disk_pct` | `80` / `85` / `500` / `90` | the thresholds that turn a tile amber and can trigger a spike |
| `health_spike_seconds` | `30` | a metric has to stay over threshold this long before it counts as a real spike (so a one-second blip doesn't fire anything) |
| `health_spike_cooldown_min` | `30` | minimum time between JARVIS suggestions for the same metric |
| `health_cue_enabled` | `1` | `0` = spikes still get recorded and you still get a notification, JARVIS just doesn't write a suggestion |
| `health_retain_raw_hours` / `health_retain_1m_days` | `24` / `30` | how long full-resolution vs. minute-level history is kept (hourly history is kept forever — it's tiny) |

Turning the whole thing off entirely (rare — e.g. isolating a perf problem):
set `HEALTH_MONITOR=0` in the environment before `jarvis.service` starts.

## Talking to it from any chat

Ask JARVIS anything health-related in any conversation — it reaches this
through the native `health` tool (`now` / `series` / `workloads` / `events`),
no need to have the page open. Example: "what's the CPU doing right now" or
"any spikes today."
