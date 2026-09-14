# Hopper Governor

As built on branch `hopper/governor-v2` during the 2026-09-12/13 overnight run,
with manual provider overrides added on branch `hopper/gov-overrides` on
2026-09-14.
This is the operator-facing companion to `docs/hopper/GOVERNOR-V2-CONTRACT.md`.

The governor is the Hopper Engine's claim-time throttle. It does not interrupt
running workers. Every new claim passes through `dispatchTick()` in
`darwin-assistant/src/hopper-engine.ts`, which calls
`governorCheck(node.adapter ?? HOPPER_WORKER_ADAPTER)` before spawning a worker.

## What v2 Changed

- Provider-aware budgets: Claude, Codex, Auggie, and Devin are evaluated as
  separate lanes instead of treating every worker like Claude usage.
- Settings-KV knobs: governor settings are read uncached from the `settings`
  table with env/default fallbacks, so cockpit changes take effect on the next
  dispatch tick without a restart.
- Manual provider overrides: each provider has a cockpit toggle for `auto`,
  `on`, and `off`. These are Kevin's explicit override levers for when the
  machine's normal budget logic is too conservative or he wants a pool paused.
- Claude while active: Claude workers can run while Kevin is active only when
  the Claude 5h window is below `gov_kevin_active_claude_max_5h`.
- Pool ceilings: Codex and Auggie now have their own usage-file stale checks
  and usage ceilings. Devin remains open until a usage meter exists.
- Active-window concurrency cap: while Kevin is active, non-Claude providers
  still run, but new non-Claude claims are capped by `gov_concurrency_cap`.
- Cross-provider retry ladder: expired non-Claude attempts retry on a different
  provider when possible, and the candidate provider is governor-checked before
  the retry target is chosen.
- Parent-id deadlock hardening: initial planner DAGs ignore `parent_index` and
  use `depends_on_indexes`; `agreeHopperTree()` also sanitizes stale initial
  parent ids before activating a tree.
- Finish-POST recovery: the spawn reconciler can recover a completed hopper
  node from a valid final finish JSON or from strong post-claim commit evidence.
  Recovery is attempt-pinned with `worker_thread_ext` so a stale attempt cannot
  complete a re-leased node.

## Provider Rules

Manual override keys are evaluated first, before `HOPPER_GOV_ENABLED` and
before every usage, ceiling, and Kevin-active gate:

| Override value | Reason | Meaning |
| --- | --- | --- |
| `auto` | normal governor reason | Default. The provider follows the normal governor logic below. |
| `on` | `override_on` | Force the provider open for new claims, bypassing Kevin-active, ceilings, and usage-staleness. Kevin is accepting the meter risk for that pool. |
| `off` | `override_off` | Hold all new claims for that provider. Running workers are not interrupted. |

Overrides are per-provider and isolated. For example, `gov_override_auggie=off`
does not affect Claude, Codex, or Devin.

Provider classification lives in `providerFor(adapter)`:

| Adapter contains | Provider lane |
| --- | --- |
| `codex` or `openai` | `codex` |
| `auggie` or `augment` | `auggie` |
| `devin` | `devin` |
| anything else/null | `claude` |

Claude evaluates, in order:

1. Claude usage file staleness.
2. Weekly/seven-day ceiling and `gov_weekly_mode`.
3. Five-hour ceiling.
4. Kevin-active gate, waived only when 5h utilization is known and below
   `gov_kevin_active_claude_max_5h`.

Codex and Auggie evaluate only their own usage-file staleness and provider
ceiling. They bypass Claude weekly, Claude 5h, and Kevin-active gates.

Devin has no meter yet, so it remains open. It still counts against the
active-window non-Claude concurrency cap.

## Settings and Defaults

All `gov_*` keys are settings-KV rows read by `hopper-governor.ts`. The cockpit
editor is `/settings/governor` on branch `hopper/gov-overrides-ui`.

Budget/ceiling keys below use env/default fallbacks. Manual override keys are
the deliberate exception: they are KV-only, exact-match reads with no env
fallback, no trimming, and no case-folding. Only literal `on` and `off` activate
an override; unset, `auto`, `ON`, `on `, and any other hand-edited variant all
read as `auto`. This keeps the UI and governor from disagreeing.

| Setting key | Env fallback(s) | Default | Meaning |
| --- | --- | ---: | --- |
| `gov_kevin_active_claude_max_5h` | `GOV_KEVIN_ACTIVE_CLAUDE_MAX_5H` | `50` | Claude may run while Kevin is active only below this 5h utilization percent. Unknown 5h usage never waives the active gate. |
| `gov_5h_ceiling` | `GOV_5H_CEILING`, `HOPPER_GOV_5H_CEILING` | `90` | Claude five-hour hard ceiling for new claims. |
| `gov_weekly_ceiling` | `GOV_WEEKLY_CEILING`, `HOPPER_GOV_WEEKLY_CEILING` | `30` | Claude weekly/seven-day worker ceiling. |
| `gov_weekly_mode` | `GOV_WEEKLY_MODE`, `HOPPER_GOV_WEEKLY_MODE` | `soft` | `soft` sends one notification and continues; `hard` holds new Claude claims. |
| `gov_codex_ceiling` | `GOV_CODEX_CEILING`, `HOPPER_GOV_CODEX_CEILING` | `90` | Codex usage ceiling. |
| `gov_auggie_ceiling` | `GOV_AUGGIE_CEILING`, `HOPPER_GOV_AUGGIE_CEILING` | `85` | Auggie credit-burn ceiling. |
| `gov_concurrency_cap` | `GOV_CONCURRENCY_CAP`, `HOPPER_DAYTIME_MAX_WORKERS` | `2` | Max non-Claude workers claimed while Kevin is active. |
| `gov_override_claude` | none, KV-only | `auto` | `auto` follows normal Claude gates; `on` forces Claude open; `off` holds new Claude claims. |
| `gov_override_codex` | none, KV-only | `auto` | `auto` follows normal Codex gates; `on` forces Codex open; `off` holds new Codex claims. |
| `gov_override_auggie` | none, KV-only | `auto` | `auto` follows normal Auggie gates; `on` forces Auggie open; `off` holds new Auggie claims. |
| `gov_override_devin` | none, KV-only | `auto` | `auto` follows normal Devin behavior; `on` forces Devin open; `off` holds new Devin claims. |

Environment-only governor knobs:

| Env var | Default | Meaning |
| --- | ---: | --- |
| `HOPPER_GOV_ENABLED` | enabled | Set to `0` to disable governor holds. |
| `HOPPER_GOV_IDLE_MIN` | `15` | Lookback window for Kevin-active detection. |
| `HOPPER_GOV_STALE_MIN` | `10` | Max age in minutes for usage files before that provider holds. |
| `CLAUDE_USAGE_FILE` | `/tmp/claude-usage-live.json` | Claude usage snapshot path. |
| `CODEX_USAGE_FILE` | `/tmp/codex-usage-live.json` | Codex usage snapshot path. |
| `AUGGIE_USAGE_FILE` | `/tmp/auggie-usage-live.json` | Auggie usage snapshot path. |

Engine-adjacent knobs that still matter to dispatch:

| Key/env | Default | Meaning |
| --- | ---: | --- |
| `HOPPER_ENGINE_SLOTS` | `2` | Global max running hopper nodes. |
| `HOPPER_ENGINE_LEASE_MIN` | `30` | Worker lease duration, minimum 5 minutes. |
| `HOPPER_WORKER_ADAPTER` | `claude` | Adapter used when a node has no explicit adapter. |
| `hopper_worker_model` / `HOPPER_WORKER_MODEL` | none | Model used when a node has no explicit model. Settings-KV wins. |

Spawn reconciler recovery constants in `scripts/jarvis-spawn-reconcile.py`:

| Constant/env | Default | Meaning |
| --- | ---: | --- |
| `JARVIS_DB_PATH` | `/home/kevin/paperclip/darwin-assistant/jarvis.db` | SQLite DB inspected by the reconciler. |
| `JARVIS_COCKPIT_API_BASE` | `http://localhost:3201/api/v1` | Local cockpit/JARVIS API used for descriptors and finish POSTs. |
| `STALE_MINUTES` | `25` | Running worker with no progress becomes `stuck`. |
| `DISPATCH_TIMEOUT_MIN` | `15` | Never-processed worker becomes `failed`. |
| `RECOVERY_GRACE_MINUTES` | `5` | Commit-evidence recovery opens five minutes before lease expiry. |

## API

`GET /api/v1/hopper-engine/governor`

- Returns the back-compatible top-level verdict for Claude, or for `?adapter=`
  when supplied.
- Also returns `providers.claude`, `providers.codex`, `providers.auggie`, and
  `providers.devin` with each lane's allow/hold reason, `override`, detail,
  usage, and effective config. Manual overrides surface as `override_on` or
  `override_off`.

`GET /api/v1/hopper-engine/settings`

- Returns `{ effective, raw }`.
- `effective` is the config currently used by the governor.
- `raw` is the settings-KV value for each editable `gov_*` key, or `null`.

`PATCH /api/v1/hopper-engine/settings`

- Admin-scoped.
- Accepts only the `gov_*` keys listed above, including the four manual
  override keys.
- Numeric values are parsed, bounded to `0..100000`, truncated to integers, and
  stored as integer strings so the panel and the gate compare the same value.
- Triggers `dispatchTick('governor_settings_changed')`.

## Retry and Recovery

Claude retries stay on Claude and climb the model ladder:

`haiku -> sonnet -> opus -> fable`

Non-Claude retries hop provider:

- Codex -> Auggie default if Auggie is open, else Claude Sonnet.
- Auggie -> Codex `gpt-5.5` if Codex is open, else Claude Sonnet.
- Devin -> Claude Sonnet.

Expired-attempt reroutes are logged into the old attempt's `spawn_tasks.error`
with `HOPPER_RETRY_REROUTE:`.

The reconciler is allowed to complete a running node only from:

- A valid final `{"outcome": ...}` payload that is not one of the worker prompt's
  placeholder examples.
- Strong commit evidence: final worker text names a commit, the node/task text
  names a `/home/kevin/...` git repo and branch, and that branch contains a
  post-claim commit.

Every recovery finish POST includes `worker_thread_ext`; the finish route returns
`409 hopper_node_attempt_mismatch` if the node is now leased to another attempt.

## Verification

Backend simulation:

```bash
cd /home/kevin/paperclip-worktrees/gov-overrides/darwin-assistant
npm run build
npm run governor-v2:sim
npm run gov-overrides:sim
node scripts/gov-overrides-review.mjs
```

The simulation uses a scratch SQLite DB and scratch usage files. It verifies:

- Auggie ceiling holds Auggie while Claude/Codex continue.
- Claude active-window waiver allows below 50 and holds at/above 50.
- Weekly soft mode notifies and continues; hard mode holds.
- Cross-provider retry skips a held candidate pool.
- Initial DAGs do not carry `parent_id`, and agree-time sanitization fixes stale
  parent ids.
- Reconciler commit-evidence recovery completes a running node.
- Stale-attempt recovery cannot complete a re-leased node.

Frontend validation:

```bash
cd /home/kevin/worktrees/gov-overrides-ui
NODE_ENV=production SERVER_PRESET=node-server NITRO_PRESET=node-server bun run build
```

The panel lives at `/settings/governor`. Manual override controls are the
three-state segmented buttons near the top of that page. The Provider Usage
widget shows compact `Override on` / `Paused` pills for any non-`auto` provider.
Do not use a bare `bun run build` for cockpit validation; without the explicit
preset it can emit a Cloudflare-module bundle, which is not the systemd-serving
shape.

## Rollback

No merge or deploy is part of this branch. Rollback before deployment is simply
not deploying:

- Backend branch: `hopper/gov-overrides`.
- Cockpit branch: `hopper/gov-overrides-ui`.

After deployment, rollback is to return the live checkouts to the currently live
branches/commits that these worktrees were based on and restart through the
normal JARVIS-owned deploy path:

- Backend base studied by review: `6b94550f0`.
- UI base studied by review: `095835c`.

Do not merge to main from the worker. JARVIS deploys reviewed branches and keeps
the final rollback call outside the leaf worker path.
