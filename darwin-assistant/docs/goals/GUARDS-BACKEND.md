# GUARDS — BACKEND (v0.2, node #476) — what shipped on `hopper/goals-guards`

Implements CONTRACT §12 (binding). Additive-only on Goals v0/v0.1. `tsc` clean;
23/23 scratch-DB checks pass (`npm run goals:guards-check`).

## Files

| file | role |
|---|---|
| `src/goals-overwatch.ts` | the ONLY place guard traffic reaches Overwatch. `isConfigured()`, `createRule/getRule/patchRule/deleteRule`, `dashboardUrl()`. Fetch-based, 10 s timeout, **never throws** — returns `{ok:true,…}` / `{ok:false,status,error}`. Reads `OVERWATCH_API_URL`/`OVERWATCH_API_KEY` from `process.env` on **every** call (no caching → the key can land without a code change; the sim points the URL at a fake server per-request). |
| `src/goals-guards.ts` | the store + logic: CRUD (`proposeGuard`/`patchGuard`/`acceptGuard`/`discardGuard`/`listGuards`/`getGuard`), health (`applyGuardHealth`, `applyGuardHealthByKey`), the poller (`pollGuardsOnce`/`startGuardPoller`/`stopGuardPoller`), the cue (`fireGuardCue`), the webhook secret gate (`checkWebhookSecret`). Imports FROM `goals.ts` only. |
| `src/goals.ts` | +`goal_guards` DDL (§12.1), +`GoalCounts.guards`/`guards_failing`, + the `🛡`/`🛡✗ "<summary>"` node suffix and `guards_failing="N"` attribute in `buildGoalThreadContext` (§12.11). |
| `src/sse-bus.ts` | +`GoalGuardEvent` interface + union member. |
| `src/handlers/api-v1.ts` | +the 6 guard routes + the webhook, +`'goal_guard'` in the `/events` FORWARD set, +the `AUTH_EXEMPT_PATHS` bypass for the webhook. |
| `src/tools/goals-tool.ts` | +`list_guards`/`propose_guard`/`discard_guard` ops + params + guidance in the tool description. |
| `scripts/goals-guards-check.mjs` (+ `.hooks.mjs`) | the scratch-DB check with a FAKE Overwatch HTTP server. |

## Two recon facts baked in (GUARDS-RECON.md)

1. **The Overwatch key is server-generated** (`prompt.<slug>-<rand4>`). We put the
   goal/node identity in the rule **`name`** (`Goal <g> · node <n> — <title>` / `Goal <g> — <title>` for a root guard) and store the returned `key` in `goal_guards.overwatch_key`. `overwatch_rule_id` stays NULL.
2. **Polling is primary** — `GET /rules/{key}` returns `last_result{status,value,summary,at}`. The webhook (route 35) is an optional lower-latency mirror onto the SAME `applyGuardHealth` path.

## The one shared health path

`applyGuardHealth(guardId, {status,value,summary,at})` → `computeHealth` (RECON §5
mapping: ok→passing, fail/warn→failing, error→error, null→unknown, `at` older than
`max(3×cadence,60m)`→error) → `setHealth`. `setHealth` stores `last_*` **always**,
flips `health` + emits `goal_guard` + writes a `guard_*` event + fires the cue **only
on a change**. Both the poller and the webhook (`applyGuardHealthByKey`) call it, so
push and poll can never diverge. `unknown→passing` is a silent SSE-only flip (a guard
first going green is not a "recovered" — no cue). Cue transitions: `→failing`
(`guard_failed`), `failing/error→passing` (`guard_recovered`), `→error` (`guard_error`).

## Degrade (no OVERWATCH_API_KEY yet — the current state)

- `accept` → `503 overwatch_not_connected`; the guard **stays a ghost** and writes the
  moment the key lands (nothing lost).
- poller → no-op.
- `dashboard_url` derives to `null`.
Everything else (propose/edit/list/discard-of-a-ghost) works offline.

## Decisions / additive deviations (flagged per the CONTRACT preamble)

- **Module name:** `src/goals-overwatch.ts` (matches the CONTRACT §12 namespace
  "one module-internal client `src/goals-overwatch.ts`"). The node-spec's loose
  "overwatch-client.ts" is the same thing.
- **`goal_guards` table is declared in `goals.ts`'s DDL block**, per §12.1's literal
  "in `src/goals.ts`" — required because `goals.ts` references the table in
  `computeCounts` / `buildGoalThreadContext` (its prepared statements compile at
  module load). The store/CRUD/poller/cue all live in `goals-guards.ts`, which imports
  helpers from `goals.ts` (one direction only — no import cycle; `goals.ts` reads the
  `goal_guards` table with its own SQL).
- **Webhook auth bypass:** the whole `/api/v1` router is behind `router.use(bearerAuth)`.
  Route 35 must be reachable WITHOUT a bearer, so `bearerAuth` now early-returns for
  `POST` + `req.path ∈ AUTH_EXEMPT_PATHS` (`/goals/guards/webhook`). The handler then
  does its own constant-time `X-Goals-Guard-Secret` check (`checkWebhookSecret`): unset
  → `503 webhook_secret_unset`, wrong → `401`, unknown key → `404 no_guard_for_key`.
  The route is registered before the `/goals/:id/…` param routes so it can't be shadowed.
- **Poller** is a self-rescheduling `setTimeout` (unref'd so it never keeps the process
  alive) that re-reads `getSetting('goal_guard_poll_min')` (default 10, floor 1) each
  tick → a live setting change takes effect on the next tick. Auto-starts at module
  load unless `GOAL_GUARD_POLLER=0` (the check sets that and drives `pollGuardsOnce()`).

## Handoff to the UI lane (node #478, `hopper/goals-guards-ui`)

Add `'goal_guard'` to `sse-worker.ts` `EVENT_TYPES`, the `GoalGuardRow`/`GoalGuardEvent`
types + `onGoalGuard` handler + guard client fns to `cockpit-api.ts`, and the guard
affordances (propose/✓/✕ card, red shield on a failing node, goal-card failing count)
per §9/§12. The backend shapes are all in CONTRACT §12.4 (`GoalGuardRow`) and §12.9
(`GoalGuardEvent`).

## Kevin supplies once (then guards go live end-to-end)

`OVERWATCH_API_URL` + `OVERWATCH_API_KEY` in darwin-assistant `.env` (a MONITORING
key — never a model call; the allowed read/write-a-rule exception). Optional:
`GOALS_GUARD_WEBHOOK_SECRET` + a `webhook` notify channel on the darwin-dashboard box
(GUARDS-OVERWATCH-WEBHOOK.md) for lower-latency pushes; polling covers health fully
without it.
