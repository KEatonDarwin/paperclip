# Big Board — office-TV kiosk display — Build Contract

**Status: AUTHORITATIVE.** Builders implement against this doc. If reality contradicts it,
verify and append a dated note to **Corrections** at the bottom — the contract is amended,
never silently deviated from.

## Why this build exists

Kevin's ask (2026-09-21, verbatim intent): an always-on dashboard for the office TV (old pi
running as a dumb kiosk browser) showing everything about JARVIS at a glance — what's
running, what's been running, what's next, what's completed, the active chat list with
abbreviated topics + last-touch, and the goal tree with auto-zoom + pulsing rows on whatever
is being worked right now. He removed the Flight-Deck "Your turn" zone (not trusted yet for
this surface) and asked for a Monitors widget sourced from the existing `/monitors` system
instead of anything new.

**The approved visual spec is `outbox/big-board-design.html`** (wiki, mockup, static HTML —
read it before building the UI). This contract defines the data contract that mockup implies:
one aggregate JSON endpoint, a live-update strategy, kiosk auth, and TV display notes.

## Ground truth (verified 2026-09-21, this recon pass)

Everything the board needs already exists as a data source — **no new tables.** This build is
purely an aggregation layer + a UI.

- DB: `/home/kevin/paperclip/darwin-assistant/jarvis.db` (live). Workers on this project must
  NEVER touch `/home/kevin/paperclip` live checkouts or restart `jarvis.service` — build and
  verify in the worktree only.
- API base: `src/handlers/api-v1.ts`, bearer `JARVIS_COCKPIT_KEY`, mounted at `/api/v1`.
- Zone → existing source map (mockup zone names in **bold**):

  | Mockup zone | Existing source | Notes |
  |---|---|---|
  | **🛰 Monitors** | `src/monitors.ts` `listMonitors('open')` + `getMonitorDigest()`; route `GET /monitors`, `GET /monitors/:id`, `GET /monitors/:id/runs` | Query-mode Overwatch-style checks (e.g. "AR suppression gate"). `last_outcome`, `consecutive_fails`, `last_run_at` already on `MonitorRow`. A FAIL row is the one that should jump to the top / ring red per the mockup. |
  | **🛡 Watchdog sentinels** | `/tmp/jarvis-watchdog-heartbeat.json` (written every 60s by `scripts/jarvis-watchdog.py`) | Shape: `{ran_at, errors: string[], sentinels: string[]}`. `sentinels` is the fixed list `["foreman","dead_turn","commitments","services","hopper_stall"]`. A sentinel is RED only if some entry in `errors` starts with `"<name>: "` — the watchdog process itself still running (this file existing and fresh) is the "watchdog is alive" signal; a stale/missing file (>~90s old) means the watchdog itself died. No HTTP route reads this file today — this build's aggregator must read it directly (same pattern as `hopper-governor.ts`'s `readUsage()` reading `/tmp/claude-usage-live.json`). |
  | **🤝 Commitments open** | `src/commitments.ts` `listCommitments({status})`; route `GET /commitments` | `CommitmentRow` has `subject, thread_ext, due_at, status ('open'|'breached'|'done'|...), resolved_at`. Board wants open+breached at top, then a few most-recent resolved for "landed" context. |
  | **⚡ In motion right now** | Two things merged: (1) running hopper nodes via `src/spawn-monitor.ts` `buildSpawnMonitorSnapshot({trees, nodes, spawnTasks, governor})` → walk `clusters[].trees[].running_nodes` (each `{id, title, lease_expires_at}`); node's own `updated_at` (from `getHopperNode`/`listTreeNodes`, `hopper-engine.ts`) is when it flipped to `running`, so elapsed = `now - updated_at`. (2) running cockpit threads via `listAllConversations()` filtered to `running: true` (same signal `threadDescriptor()` uses: `getInFlightMessageId(conv.id) != null`) — this is what surfaces "Big Board design (this conversation)" in the mockup. |
  | **🎯 Goal spotlight** | `src/goals.ts` `listGoals()` + `getGoalTree(goalId)` + `getGoalFocus(goalId)` | "Auto-zoomed" = pick whichever open goal has the most-recently-updated `goal_events` row (`listGoalEvents`) or the most-recent `goal_focus.updated_at` — i.e. the goal Kevin/JARVIS touched last — then render its focus node's siblings/children (same shape the `/goals` UI already renders from `GoalTree.nodes` + `GoalTree.focus`). A node in state `'working'` (`GoalNodeState`) is the pulsing row; `tree_id` set + `tree_status_cache` gives the "in tree" chip; `leaf_kind:'human'` is the amber "human · your list" row. |
  | **📡 Conversation radar** | `listAllConversations()` (already imported by `api-v1.ts` for `GET /threads`) sorted by `updated_at` desc, same filters `GET /threads` already applies (skip `ephemeral:`/`checkin:` prefixes) | Reuse `threadDescriptor()`'s fields directly: `title`/`headline`, `runtime` (model), `updated_at`, `running`, `latest_summary`. "hot/warm/cool" fade in the mockup is a client-side function of `now - updated_at`, not a server field. |
  | **✅ Landed — last 48h** | Union of: `hopper_trees` with `status='done'` and `updated_at` in the last 48h (`listAllHopperTrees()` — unbounded, per its own doc comment, exactly for a use like this); `watch_commitments` with `status='done'` and `resolved_at` in the last 48h (`listCommitments({status:'done'})`, filter client-or-server side by `resolved_at`); optionally `notifications` with `severity:'success'` in the window (`listNotifications()`) for one-off wins that aren't tree- or commitment-shaped. | Cap at ~8 most recent, newest first. |
  | **Header meters (Claude A/B, Codex, Auggie)** | `GET /provider-usage` → `{claude, claude_accounts, openai_codex, augment}` (`readClaudeLiveUsage`, `readClaudeAccountsUsage`, `readCodexUsage`, `readAugmentUsage` in `api-v1.ts`) | `claude_accounts` is the per-account (A/B) breakdown the mockup's two Claude meters need. |
  | **Governor pill** | `src/hopper-governor.ts` `governorStatusAll()` (already wrapped by route `GET /hopper-engine/governor` as `{...governorStatus(), providers: governorStatusAll()}`) | `GovernorVerdict.allow/reason/detail` per provider; `config.concurrency_cap` for the "concurrency N" text. |
  | **Event ticker** | `/events` SSE stream, NOT a poll — see Part 2. | The FORWARD set in the existing `/events` handler already includes every event type the ticker needs: `hopper_node`, `goal`, `goal_node`, `goal_focus`, `monitor`, `monitor_run`, `notification`, `dispatch`, `dispatch_cue`, `workstream`, `conversation_updated`. |

- `listAllHopperTrees()` (`hopper-engine.ts`) is already documented as unbounded/"every tree,"
  in contrast to `listHopperTrees()`'s implicit recency cap for other (unrelated) callers —
  safe to use directly for the Landed union without adding a new query.
- `buildSpawnMonitorSnapshot` is a **pure function over injected rows** (trees/nodes/spawnTasks
  fetched by the caller) — mirror that pattern for the big-board aggregator itself: keep
  `buildBigBoardSnapshot(inputs)` pure and unit-testable, with a thin route that gathers the
  live rows and calls it. Same reasoning as `docs/SPAWN-MONITOR-CONTRACT.md`.

## Part 1 — `GET /api/v1/big-board`

One aggregate JSON. No new tables; every field is sourced from an existing store per the map
above. Route lives in `api-v1.ts` next to the other read-only aggregate routes
(`/hopper-engine/history`, `/hopper-engine/governor`).

```jsonc
GET /api/v1/big-board
{
  "generated_at": "2026-09-21T19:49:00.000Z",

  "monitors": {
    "open": [ /* MonitorRow[] from listMonitors('open'), only status in (active,paused) */ ],
    "summary": { "active": 1, "failing": 0 }
  },

  "sentinels": {
    "ran_at": "2026-09-21T19:49:12.676Z",
    "fresh": true,                 // (now - ran_at) < ~90s; false ⇒ watchdog itself may be dead
    "sentinels": [
      { "name": "foreman", "ok": true },
      { "name": "dead_turn", "ok": true },
      { "name": "commitments", "ok": true },
      { "name": "services", "ok": true },
      { "name": "hopper_stall", "ok": true }
    ]
  },

  "commitments": {
    "open": [ /* CommitmentRow[] status in (open,breached), listCommitments */ ]
  },

  "in_motion": {
    "hopper_nodes": [
      // one entry per node with status='running', across ALL active trees
      { "tree_id": "tree-...", "tree_topic": "...", "node_id": 512, "title": "...",
        "adapter": "claude", "model": "claude-sonnet-5",
        "claude_account": "b",             // best-effort; null if not resolvable
        "started_at": "...",                 // node's updated_at at the running transition
        "lease_expires_at": "..." }
    ],
    "threads": [
      // running: true cockpit/slack threads, from listAllConversations()
      { "thread_id": "cockpit:...", "title": "...", "adapter": "...", "model": "...",
        "updated_at": "..." }
    ]
  },

  "goal_spotlight": {
    "goal": { /* GoalSummary for the auto-zoomed goal */ },
    "focus_node_id": 7,
    "nodes": [ /* GoalNodeRow[] — the focus node's siblings + children, same slice /goals renders */ ]
  },

  "radar": [
    // sorted by updated_at desc, same shape as GET /threads entries (subset of fields)
    { "thread_id": "...", "title": "...", "model": "...", "updated_at": "...", "running": false, "latest_summary": "..." }
  ],

  "landed": [
    // union of done trees / done commitments / success notifications, last 48h, newest first, capped ~8
    { "kind": "tree" | "commitment" | "notification", "text": "...", "at": "..." }
  ],

  "providers": { /* same shape as GET /provider-usage: claude, claude_accounts, openai_codex, augment */ },

  "governor": { /* same shape as GET /hopper-engine/governor */ }
}
```

Query params: none required. Optional `?landed_hours=48` to override the Landed window (for
manual debugging from a browser, not used by the kiosk itself).

## Part 2 — live-update strategy

The board does **not** need sub-second precision (it's a glance-at-a-TV surface), so don't
build bespoke incremental-merge logic for nine differently-shaped sections. Two-layer refresh,
both already-proven patterns in this codebase:

1. **Reuse the existing `/events` SSE feed as-is** (no new event types, no new route). The
   kiosk client subscribes and, on receiving any event whose `type` is one of
   `hopper_node, goal, goal_node, goal_focus, goal_guard, monitor, monitor_run, notification,
   dispatch, dispatch_cue, workstream, conversation_updated, status`, does two things:
   - appends a line to the on-screen ticker immediately (client-side render, using the event's
     own payload — no extra fetch needed for the ticker itself), and
   - schedules a **debounced refetch** of `GET /api/v1/big-board` (e.g. 1.5s trailing debounce,
     so a burst of events collapses into one refetch) to keep every other section correct.
2. **Unconditional 60s full refetch** of `GET /api/v1/big-board` regardless of SSE activity —
   the safety net for a dropped SSE connection or a section this pass didn't wire an event
   for (e.g. sentinel heartbeat freshness, which has no SSE event at all and is only ever
   correct via a refetch).

This mirrors the cockpit's own existing pattern (SSE for immediacy + periodic poll as the
correctness backstop — see Foreman Eye's documented React Query polling and the cockpit
`sse-worker.ts` reconnect behavior) rather than inventing a new one.

The kiosk browser should also auto-reload the whole page once a day (e.g. 4am local) as a
crude but effective defense against long-running-tab memory creep — a kiosk pi is not
rebooted often; this is a client-side `setTimeout` to the next 4am, not a server concern.

## Part 3 — kiosk auth

**Never** put `JARVIS_COCKPIT_KEY` (or any admin bearer key) in a URL — it is long-lived and
grants full write access; a TV browser's address bar / history / any proxy log is not a place
for it to live.

Instead: a dedicated, narrow, revocable token —

- Settings-KV key **`big_board_kiosk_token`** (`getSetting`/`setSetting`, same store the
  governor-v2 knobs use). Empty/unset by default.
- Accepted as **`?kiosk=<token>`** query param on exactly two routes: `GET /api/v1/big-board`
  and `GET /api/v1/events` (GET only — never on any POST/PATCH/DELETE route, and never as a
  generic bearer-header replacement).
- **Fails closed**, same posture as the Guards webhook (`docs/goals/CONTRACT.md` §12.4): if
  `big_board_kiosk_token` is unset or empty, kiosk-token auth is entirely disabled — any
  `?kiosk=` value on those routes 401s exactly like a missing bearer header does today. Kevin
  must explicitly mint a token (a small admin-scoped route, e.g.
  `POST /big-board/kiosk-token` → generates + stores a fresh random token and returns it once,
  mirroring `mintApiKey`) before the kiosk URL works at all.
- Implementation shape in `bearerAuth` (`api-v1.ts`): before requiring the `Authorization`
  header, check `req.method === 'GET' && (req.path === '/big-board' || req.path === '/events')
  && typeof req.query.kiosk === 'string'`; if so, compare against the stored token (constant-
  time compare) and, on match, synthesize a **read-only, admin-scope** `req.apiKey` for this
  request only (needed because `/events`'s existing admin-scope check gates which threads a
  caller sees, and the board's Conversation Radar needs to see all of them) — do **not** reuse
  or alias a real `ApiKeyRow` from the `api_keys` table for this; it is a distinct, log-
  visible, single-purpose credential.
- Never log the token value. Never echo it back except at mint time.
- **Open item for Kevin, not blocking this contract:** this grants the kiosk full read
  visibility into every cockpit thread's title/summary (Conversation Radar shows real thread
  topics). That's almost certainly fine for a TV physically sitting in Kevin's own office on
  his own LAN, but flag it explicitly at deploy time rather than assuming — if the kiosk pi is
  ever reachable off the LAN, the token should be treated as sensitive, not "just a read-only
  toy."

## Part 4 — TV / kiosk display notes

- **Overscan / safe area:** most TVs (and some pi-HDMI-to-TV chains) crop a few percent of the
  edges. This is a client/CSS concern, not a server one, but bake in the hook now: the kiosk
  URL accepts an optional `?overscan=<px>` query param (client-side only, ignored by the
  server) that the UI wraps the whole layout in as a fixed padding (`body { padding: <px>px }`)
  so Kevin can tune it once per physical TV without a rebuild. Recommend defaulting to `24`
  (matches the mockup's own `14px` grid gap plus a margin) if the param is absent — most
  consumer TVs overscan by roughly 2-5% of screen height, and 24px reads as a sane default at
  the mockup's 10-foot-UI 19px base font size.
- The mockup is already dark, high-contrast, big-text (10-foot UI) — keep it exactly as
  designed; don't reflow for mobile/narrow viewports, this surface has exactly one target
  (a TV in landscape).
- No interactivity is required (no click targets) — this is a passive display. If a future
  rev wants "tap to open the goal chat" that's a v1.1, not this build.

## Corrections

*(append dated notes here if reality contradicts anything above — do not silently deviate)*
