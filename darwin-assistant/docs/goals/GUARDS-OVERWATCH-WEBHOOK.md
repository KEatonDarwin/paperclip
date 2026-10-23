# GUARDS — OPTIONAL Overwatch → Goals webhook (push instead of poll)

**Status: OPTIONAL / NOT on the v0.2 critical path.** Recon (`GUARDS-RECON.md` §0.1) confirmed `GET /rules/{key}` already returns `last_result: {status, value, summary, at}`, so the guard poller (`GET /rules/{key}` every `goal_guard_poll_min`) fully covers health. This webhook is a **latency upgrade** only — it lets a failing win condition cue the goal chat within seconds of Overwatch's run instead of within one poll interval. Build it later, if ever. **This side lives in darwin-dashboard, which only Kevin deploys — do NOT build or deploy it from the Goals worker.**

## Why it might be worth it later
- Poll interval (default 10 min) is fine for "revenue slipped"; a same-minute cue matters more for tighter win conditions.
- It removes N `GET /rules/{key}` calls per interval once there are many guards.
- It reuses Overwatch's existing per-rule `notify_channels` (`ow_checks.notify_channels`, already Mail/Slack/Log/Teams) — this just adds a `webhook` channel type.

## The darwin-dashboard change (Kevin's box, additive)
1. **New notify channel `webhook`.** When a check finishes a run and its status is computed, if the rule carries a `webhook` notify channel, POST the result to the configured URL. Fire on **every** run (Goals' side dedups by state change), or — cheaper — only on status transitions Overwatch already tracks. Config: `OVERWATCH_GOALS_WEBHOOK_URL`, `OVERWATCH_GOALS_WEBHOOK_SECRET` in darwin-dashboard `.env`.
2. **Payload** (POST JSON to `OVERWATCH_GOALS_WEBHOOK_URL`):
   ```json
   { "key": "prompt.first-send-window-a1b2",
     "status": "fail",            // ok | warn | fail | error  (never stale — that's read-derived)
     "value": -7.4,
     "summary": "revenue -7.4% vs 7-day avg",
     "ran_at": "2026-09-19T18:40:11+00:00" }
   ```
3. **Auth:** header `X-Goals-Guard-Secret: <shared secret>` (constant-time compared on the Goals side). Keep it dumb — a shared secret, not OAuth.

## The Goals side (darwin-assistant — belongs to CONTRACT §12, safe to build now, dormant until pushed)
- Route **`POST /api/v1/goals/guards/webhook`** — **NOT** bearer `JARVIS_COCKPIT_KEY`; gated by `GOALS_GUARD_WEBHOOK_SECRET` (header `X-Goals-Guard-Secret`, constant-time). Missing/unset secret → `503` (fails closed, same posture as Overwatch's own gate). Wrong secret → `401`.
- Body: `{ key, status, value, summary, ran_at }`. Look up the `goal_guards` row by `overwatch_key = key` (`404 { "error": "no guard for key" }` if none — a stray push for a non-guard rule is ignored, not an error worth alarming).
- Apply the SAME `status → health` mapping as the poller (`GUARDS-RECON.md` §5) and the SAME state-change-only rule: update `last_value/last_summary/last_checked_at`, and on a `health` CHANGE emit the guard event + SSE + cue exactly as the poller would. **One code path** — the webhook handler and the poller both call the internal `applyGuardHealth(guardId, {status, value, summary, at})` so push and poll can never diverge. Idempotent: a duplicate push with unchanged health is a no-op (no event, no cue).
- The poller stays on as the safety net even when the webhook is live (a missed/failed push is caught on the next poll).

## Non-goals
No Overwatch dashboard UI for the webhook channel beyond wiring the channel type; no retry/queue on the darwin-dashboard side in v1 (a dropped push is recovered by the Goals poller); no per-guard webhook URLs (one global endpoint).
