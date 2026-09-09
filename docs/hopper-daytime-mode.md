# Hopper Daytime Mode

Daytime mode lets Hopper keep using non-Claude worker pools while Kevin is at
the keyboard, without relaxing the protections around Kevin's Claude
subscription. The dispatcher now evaluates the governor per node adapter instead
of once for the whole queue. A held Claude lane no longer parks Codex, Auggie, or
Devin nodes.

## Provider Gates

| Provider lane | Daytime mode ON | Daytime mode OFF |
| --- | --- | --- |
| Claude / unknown adapter | Full Claude gates: stale Claude meter, weekly ceiling, 5-hour ceiling, Kevin-active idle gate. | Same full Claude gates. |
| Codex / OpenAI adapter | Codex meter only: stale Codex meter and `HOPPER_GOV_CODEX_CEILING`. Bypasses Claude 5-hour, weekly, stale, and Kevin-active gates. | Full Claude gates. |
| Auggie / Augment adapter | Auggie meter only: stale Auggie meter and `HOPPER_GOV_AUGGIE_CEILING`. Bypasses Claude 5-hour, weekly, stale, and Kevin-active gates. | Full Claude gates. |
| Devin adapter | Open while daytime mode is on. Devin has no usage meter wired yet, so there is no provider ceiling to enforce. | Full Claude gates. |

Running workers are never interrupted by a governor change. The governor only
decides whether a new pending node can be claimed.

## Toggle

Daytime mode is on by default unless `HOPPER_GOV_DAYTIME=0` is set. The live
kill-switch is the `hopper_daytime_mode` settings row, exposed through both the
cockpit UI and the HTTP API.

Cockpit controls:

- `/spawn-tree` has a `Daytime engine: ON/OFF` button beside the refresh button.
- The provider usage panel also has a compact `Daytime engine: ON/OFF` button.

API controls:

```bash
KEY=$(grep -E '^JARVIS_COCKPIT_KEY=' /home/kevin/paperclip/jarvis-command-center/.env | head -1 | cut -d= -f2)

curl -s http://localhost:3201/api/v1/hopper-engine/daytime \
  -H "Authorization: Bearer $KEY"

curl -s -X POST http://localhost:3201/api/v1/hopper-engine/daytime \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```

## Governor Status

`GET /api/v1/hopper-engine/governor` keeps the back-compatible top-level Claude
verdict and now also returns `providers`, a per-provider verdict map for
`claude`, `codex`, `auggie`, and `devin`.

```bash
curl -s http://localhost:3201/api/v1/hopper-engine/governor \
  -H "Authorization: Bearer $KEY"
```

Use `?adapter=codex`, `?adapter=auggie`, or another adapter id to make the
top-level verdict reflect that adapter.

## Dispatch Behavior

`dispatchTick()` walks ready leaves in priority order and evaluates the governor
for the node's adapter. If one provider is held, the loop continues to later
ready nodes instead of stopping the whole queue. This prevents a saturated
Claude window from starving Codex or Auggie work.

While Kevin is active, non-Claude dispatch stays enabled but is capped by
`HOPPER_DAYTIME_MAX_WORKERS`. This keeps daytime background work useful without
letting the machine fill every worker slot behind Kevin's own session.

## Cross-Provider Retry Ladder

Lease recovery still runs before new dispatch. If a node's lease expires and it
has attempts remaining:

- Claude-routed nodes retry one Claude tier higher:
  `haiku -> sonnet -> opus -> fable`.
- Codex-routed nodes retry to Auggie default if Auggie is currently open, then
  fall back to Claude Sonnet.
- Auggie-routed nodes retry to Codex `gpt-5.5` if Codex is currently open, then
  fall back to Claude Sonnet.
- Devin-routed nodes fall back to Claude Sonnet.

The previous `spawn_tasks` row is marked failed with a
`HOPPER_RETRY_REROUTE` note so the attempt ledger shows why the next attempt
moved providers.

## Finish-JSON Recovery

The `jarvis-spawn-reconcile.py` watchdog can recover a worker that did the work
but ended before its finish curl landed. If a hopper worker thread is no longer
running while its node is still `running`, the reconciler scans the last
assistant turn for a valid finish JSON payload and posts it to
`/hopper-nodes/:id/finish`.

If no valid payload is present, the node is left to normal lease recovery.

## Environment Knobs

Core governor:

- `HOPPER_GOV_ENABLED` - set `0` to disable the governor.
- `HOPPER_GOV_5H_CEILING` - Claude 5-hour utilization ceiling, default `90`.
- `HOPPER_GOV_WEEKLY_CEILING` - Claude 7-day utilization ceiling, default `40`.
- `HOPPER_GOV_WEEKLY_MODE` - set `soft` to notify but continue past weekly ceiling.
- `HOPPER_GOV_IDLE_MIN` - Kevin-active lookback window, default `15`.
- `HOPPER_GOV_STALE_MIN` - usage file freshness threshold, default `10`.
- `CLAUDE_USAGE_FILE` - Claude usage snapshot, default `/tmp/claude-usage-live.json`.

Daytime/provider controls:

- `HOPPER_GOV_DAYTIME` - default daytime mode if settings KV is unset; set `0` to default off.
- `HOPPER_GOV_CODEX_CEILING` - Codex utilization ceiling, default `90`.
- `HOPPER_GOV_AUGGIE_CEILING` - Auggie utilization ceiling, default `90`.
- `CODEX_USAGE_FILE` - Codex usage snapshot, default `/tmp/codex-usage-live.json`.
- `AUGGIE_USAGE_FILE` - Auggie usage snapshot, default `/tmp/auggie-usage-live.json`.
- `HOPPER_DAYTIME_MAX_WORKERS` - max non-Claude workers while Kevin is active, default `2`; `0` disables active-window non-Claude dispatch.

Engine controls:

- `HOPPER_ENGINE_SLOTS` - total concurrent Hopper workers, default `2`.
- `HOPPER_ENGINE_LEASE_MIN` - worker lease duration, default `30`.
- `HOPPER_WORKER_ADAPTER` - default adapter for unrouted nodes, default `claude`.
- `HOPPER_WORKER_MODEL` - default model if settings KV `hopper_worker_model` is unset.

## Deploy Checklist For JARVIS

1. Build the backend worktree:

   ```bash
   cd /home/kevin/paperclip/darwin-assistant
   npm install
   npm run build
   npx tsc --noEmit
   ```

2. Build the cockpit worktree:

   ```bash
   cd /home/kevin/paperclip/jarvis-command-center
   /usr/local/bin/jarvis-cockpit-deploy.sh build
   ```

3. Verify env on the live JARVIS host:

   ```bash
   systemctl cat jarvis.service | grep -E 'HOPPER_GOV|HOPPER_DAYTIME|CODEX_USAGE_FILE|AUGGIE_USAGE_FILE'
   ls -l /tmp/claude-usage-live.json /tmp/codex-usage-live.json /tmp/auggie-usage-live.json
   ```

4. Restart JARVIS with a detached bounce so the current worker/session is not
   killed mid-turn:

   ```bash
   systemd-run --on-active=45s --unit=jarvis-provider-daytime-restart --collect \
     /bin/systemctl restart jarvis.service
   ```

5. Deploy/restart the cockpit through the deploy script:

   ```bash
   /usr/local/bin/jarvis-cockpit-deploy.sh restart
   /usr/local/bin/jarvis-cockpit-deploy.sh status
   ```

6. Smoke the governor API:

   ```bash
   KEY=$(grep -E '^JARVIS_COCKPIT_KEY=' /home/kevin/paperclip/jarvis-command-center/.env | head -1 | cut -d= -f2)
   curl -s http://localhost:3201/api/v1/hopper-engine/governor \
     -H "Authorization: Bearer $KEY"
   ```

   Confirm the response includes `providers.claude`, `providers.codex`,
   `providers.auggie`, and `providers.devin`, with Claude allowed/held
   independently from Codex and Auggie.

7. Smoke the toggle:

   ```bash
   curl -s -X POST http://localhost:3201/api/v1/hopper-engine/daytime \
     -H "Authorization: Bearer $KEY" \
     -H 'Content-Type: application/json' \
     -d '{"enabled":false}'

   curl -s -X POST http://localhost:3201/api/v1/hopper-engine/daytime \
     -H "Authorization: Bearer $KEY" \
     -H 'Content-Type: application/json' \
     -d '{"enabled":true}'
   ```

   Leave the toggle in the intended production state after the smoke.
