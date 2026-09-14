# Hopper Governor v2 Contract

Branch: `hopper/governor-v2`

Recon date: 2026-09-12

Source tips studied:

- Live base: `autogroup/auto-thread-grouping` at `52854bbd6b507d7cd2f677892ddd56d1fccd5ef1`
- Backend donor branch: `hopper/provider-daytime` at `9ab5769bd021136ca8dc025293d55789d4705af3`
- Cockpit donor branch: `hopper/provider-daytime-ui` at `adc5294efd53336a3119f708efcb6bb22e8bf314`

## Goal

Governor v2 reconciles the never-deployed provider-daytime work onto the current Hopper/Foundry base. Do not merge `hopper/provider-daytime` wholesale. It predates the Foundry v0.1 and Spawn-Tree Mission Control fixes and would regress current files.

The implementation must:

- Keep the live provider-aware dispatch behavior: each ready node is checked against the governor by its own `adapter`.
- Add real per-pool ceilings for Codex and Auggie, with stale-meter protection.
- Let Claude workers run while Kevin is active only while Claude's 5h utilization is below a configurable threshold.
- Move governor knobs into uncached settings-KV with env fallbacks.
- Preserve current Foundry auto-retry and Spawn-Tree grouping fixes.
- Add hardening for the parent-id deadlock and Codex finish-POST gap.

## As-Built Operator Doc

This file is the reconciliation contract and review checklist. The as-built
operator guide lives at `docs/hopper/GOVERNOR.md` and should be kept current
with runtime defaults, API shape, recovery behavior, verification commands, and
rollback notes.

## Current Live Anchors

The current branch already has the correct per-node dispatch seam. `dispatchTick()` walks ready leaves and calls `governorCheck(node.adapter ?? WORKER_ADAPTER)` before each claim in `darwin-assistant/src/hopper-engine.ts:613-623`.

The leaf rule that caused the foundation deadlock is explicit: ready nodes must have no children, via `NOT EXISTS (SELECT 1 FROM hopper_nodes c WHERE c.parent_id = n.id)` in `darwin-assistant/src/hopper-engine.ts:173-181`.

The bad planting seam is also explicit: `createHopperTree()` maps `parent_index` into `parent_id` during insertion at `darwin-assistant/src/hopper-engine.ts:310-345`, while `agreeHopperTree()` blindly flips drafts to pending at `darwin-assistant/src/hopper-engine.ts:352-361`.

The worker finish route is the only HTTP write path for completed nodes: `POST /hopper-nodes/:id/finish` in `darwin-assistant/src/handlers/api-v1.ts:1689-1720`, backed by `finishHopperNode()` in `darwin-assistant/src/hopper-engine.ts:504-555`.

Settings-KV is available and uncached. The `settings` table and `getSetting`/`setSetting`/`deleteSetting` live in `darwin-assistant/src/conversation-db.ts:816-858`. Existing runtime settings already read this way, e.g. `defaultWorkerModel()` in `darwin-assistant/src/hopper-engine.ts:69-75` and Foundry's helper in `darwin-assistant/src/foundry-settings.ts:14-23`.

Provider usage files are already exposed by the API layer: Codex reads `/tmp/codex-usage-live.json` at `darwin-assistant/src/handlers/api-v1.ts:583-624`, Auggie reads `/tmp/auggie-usage-live.json` at `darwin-assistant/src/handlers/api-v1.ts:626-670`, and `/provider-usage` returns Claude/Codex/Auggie at `darwin-assistant/src/handlers/api-v1.ts:900-914`.

Foundry v0.1 must be preserved. `foundry_auto_retries` is a current hopper node column in `darwin-assistant/src/hopper-engine.ts:61` and `darwin-assistant/src/hopper-engine.ts:121-130`. The atomic auto-retry compare-and-swap lives at `darwin-assistant/src/hopper-engine.ts:237-267`. Foundry injects the Contract Resolution Rule and retries at `darwin-assistant/src/foundry.ts:1478-1550`; integration retry hooks are exposed at `darwin-assistant/src/handlers/api-v1.ts:1505-1524`.

Spawn-Tree Mission Control must be preserved. The current spawn ledger stamps attempts with `hopper_tree_id` and `hopper_node_id` in `darwin-assistant/src/spawn-tasks.ts:65-78`, matches attempts back to nodes in `darwin-assistant/src/spawn-monitor.ts:145-194`, and feeds `/spawn-monitor` at `darwin-assistant/src/handlers/api-v1.ts:1759-1774`.

## Provider-Daytime Reconciliation

Valid to port from `hopper/provider-daytime`:

- Provider classification: `providerFor(adapter)` maps adapter strings to `claude`, `codex`, `auggie`, or `devin` at `hopper/provider-daytime:darwin-assistant/src/hopper-governor.ts:44-53`. Keep this idea, but make it the v2 provider type, not the old `'claude' | 'non-claude'` union currently at `darwin-assistant/src/hopper-governor.ts:34-50`.
- Per-provider status: `governorStatusAll()` returns all lane verdicts at `hopper/provider-daytime:darwin-assistant/src/hopper-governor.ts:212-219`. Keep, and use it in `GET /hopper-engine/governor`.
- Per-pool meters and ceilings: `readProviderUsage()` plus `PROVIDER_METERS` are at `hopper/provider-daytime:darwin-assistant/src/hopper-governor.ts:154-178`, and the non-Claude gate is at `hopper/provider-daytime:darwin-assistant/src/hopper-governor.ts:227-276`. Keep the concept, but read ceilings from settings-KV before env.
- Dispatch-time daytime cap: old `DAYTIME_MAX_WORKERS` is at `hopper/provider-daytime:darwin-assistant/src/hopper-engine.ts:65-74`, and its use in dispatch is at `hopper/provider-daytime:darwin-assistant/src/hopper-engine.ts:657-701`. Keep the cap, but rename to the settings-backed `gov_concurrency_cap`.
- Cross-provider retry ladder: old `retryRouteFor()` is at `hopper/provider-daytime:darwin-assistant/src/hopper-engine.ts:83-146`, and expired-lease rerouting is at `hopper/provider-daytime:darwin-assistant/src/hopper-engine.ts:628-655`. Keep it, but preserve the current Foundry notification suppression and spawn-monitor ledger stamps.
- Finish-payload recovery: old `jarvis-spawn-reconcile.py` scans the last assistant turn for a finish JSON at `hopper/provider-daytime:darwin-assistant/scripts/jarvis-spawn-reconcile.py:64-130` and calls it after a worker goes idle at `hopper/provider-daytime:darwin-assistant/scripts/jarvis-spawn-reconcile.py:153-158`. Keep this as one recovery path, but add the stronger Codex commit-aware path described below.
- UI seed only: `hopper/provider-daytime-ui` adds `getHopperDaytime()`/`setHopperDaytime()` at `hopper/provider-daytime-ui:src/lib/cockpit-api.ts:970-984`, a `/spawn-tree` toggle at `hopper/provider-daytime-ui:src/routes/spawn-tree.tsx:50-126`, and a provider-panel toggle at `hopper/provider-daytime-ui:src/routes/threads.tsx:4633-4781`. Treat these as prior art for wiring calls, not the target UI. Governor v2 needs an editable settings panel, not just an on/off toggle.

Superseded or unsafe to port:

- The old branch assumes a `hopper_daytime_mode` kill-switch at `hopper/provider-daytime:darwin-assistant/src/hopper-governor.ts:55-64`. V2 replaces this with explicit settings values. A global kill-switch can remain as `gov_daytime_enabled` only if the implementer wants it, but it is not part of the required schema.
- The old branch predates Foundry v0.1's atomic retry and notification rules. It does not contain current `prepareFoundryAutoRetry()` behavior from `darwin-assistant/src/hopper-engine.ts:237-267`; do not overwrite those sections.
- The old branch removes the current Spawn-Tree Monitor and drops hopper stamp columns from `spawn_tasks`. Current `darwin-assistant/src/spawn-tasks.ts:65-78` and `darwin-assistant/src/spawn-monitor.ts:145-194` are authoritative.
- The old branch allows dependency release on `split` in `depsSatisfied()` at `hopper/provider-daytime:darwin-assistant/src/hopper-engine.ts:412-419`. The current branch deliberately requires `done` only at `darwin-assistant/src/hopper-engine.ts:365-379` because Foundry split parents are still in progress until children bubble complete.
- The old branch always opens non-Claude lanes when their own meters allow. V2 must add Kevin's new Auggie cool-down policy and the configurable active-window concurrency cap.

## Settings-KV Schema

Budget and ceiling governor knobs must be read via `getSetting()` with env fallback. Reads are deliberately uncached so the cockpit settings panel can take effect live; `getSetting()` is a direct prepared `SELECT` at `darwin-assistant/src/conversation-db.ts:842-844`.

Create a helper in `darwin-assistant/src/hopper-governor.ts`, similar to Foundry's `getFoundrySetting()` at `darwin-assistant/src/foundry-settings.ts:14-23`:

```ts
function getGovernorSetting(name: string): string | null {
  const key = name.startsWith('gov_') ? name : `gov_${name}`;
  const kv = getSetting(key)?.trim();
  if (kv) return kv;
  const envKey = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return process.env[envKey]?.trim() || null;
}
```

Manual provider override keys are the explicit exception to that helper: read
`gov_override_{claude,codex,auggie,devin}` from settings-KV directly with no env
fallback, no trim, and no case-folding. Only exact `on` and exact `off` count;
unset, `auto`, padded values, and case variants all mean normal `auto` behavior.

Required keys:

| Setting key | Env fallback | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `gov_kevin_active_claude_max_5h` | `GOV_KEVIN_ACTIVE_CLAUDE_MAX_5H` | number percent | `50` | Claude-routed workers are allowed while Kevin is active when Claude five-hour utilization is below this threshold. At or above it, the existing Kevin-active hold applies. |
| `gov_5h_ceiling` | `GOV_5H_CEILING` | number percent | `90` | Claude five-hour hard ceiling for new Claude claims. For backward compatibility, also accept current `HOPPER_GOV_5H_CEILING` if the new env var is unset. |
| `gov_weekly_ceiling` | `GOV_WEEKLY_CEILING` | number percent | `30` | Claude weekly/seven-day worker ceiling. This replaces the live default `40` at `darwin-assistant/src/hopper-governor.ts:21` per Kevin's 2026-09-12 upgrade instruction. Also accept `HOPPER_GOV_WEEKLY_CEILING` if the new env var is unset. |
| `gov_weekly_mode` | `GOV_WEEKLY_MODE` | enum `soft` or `hard` | `soft` | In `soft`, notify and continue past weekly ceiling; in `hard`, hold new Claude claims. Also accept `HOPPER_GOV_WEEKLY_MODE` if new env var is unset. |
| `gov_codex_ceiling` | `GOV_CODEX_CEILING` | number percent | `90` | Codex plan ceiling. Also accept `HOPPER_GOV_CODEX_CEILING` from the donor branch. |
| `gov_auggie_ceiling` | `GOV_AUGGIE_CEILING` | number percent | `85` | Auggie credit burn ceiling. Default must stop new Auggie claims at or above 85 percent burned because Augment is already around 80 percent tonight. Also accept `HOPPER_GOV_AUGGIE_CEILING` from the donor branch. |
| `gov_concurrency_cap` | `GOV_CONCURRENCY_CAP` | integer workers | `2` | Max non-Claude workers to claim while Kevin is active. This ports old `HOPPER_DAYTIME_MAX_WORKERS` behavior from `hopper/provider-daytime:darwin-assistant/src/hopper-engine.ts:65-74`; accept the old env var as a fallback. |
| `gov_override_claude` | none; KV-only | enum `auto`, `on`, or `off` | `auto` | Manual Claude override. `auto` follows normal gates; exact `on` forces new Claude claims open; exact `off` holds new Claude claims. |
| `gov_override_codex` | none; KV-only | enum `auto`, `on`, or `off` | `auto` | Manual Codex override. `auto` follows normal gates; exact `on` forces new Codex claims open; exact `off` holds new Codex claims. |
| `gov_override_auggie` | none; KV-only | enum `auto`, `on`, or `off` | `auto` | Manual Auggie override. `auto` follows normal gates; exact `on` forces new Auggie claims open; exact `off` holds new Auggie claims. |
| `gov_override_devin` | none; KV-only | enum `auto`, `on`, or `off` | `auto` | Manual Devin override. `auto` follows normal behavior; exact `on` forces new Devin claims open; exact `off` holds new Devin claims. |

Keep existing non-governor env defaults:

- `HOPPER_GOV_ENABLED`, default enabled, remains the emergency off switch.
- `HOPPER_GOV_IDLE_MIN`, default `15`, controls Kevin-active lookback.
- `HOPPER_GOV_STALE_MIN`, default `10`, controls stale usage-file holds.
- `CLAUDE_USAGE_FILE`, `CODEX_USAGE_FILE`, and `AUGGIE_USAGE_FILE` keep their current file defaults.
- `HOPPER_ENGINE_SLOTS`, `HOPPER_ENGINE_LEASE_MIN`, `HOPPER_WORKER_ADAPTER`, and `hopper_worker_model` stay in the engine layer.

The `config` object returned in every governor verdict must report the effective budget/ceiling values above, including which values came from KV/env/default if cheap to include. The verdict itself must also report `override: auto|on|off`. The API must not require a restart for KV changes.

## Governor Behavior

Manual provider overrides run before every other gate, including
`HOPPER_GOV_ENABLED`:

- `auto`: no override. Continue through the normal provider-specific logic.
- `on`: allow new claims for that provider with reason `override_on`, bypassing
  Kevin-active, 5h/weekly/provider ceilings, and usage-file staleness. This is a
  true manual "go" lever, and Kevin is accepting the meter risk for that pool.
- `off`: hold new claims for that provider with reason `override_off`. Running
  workers are never interrupted.

Overrides are per-provider and isolated; `gov_override_auggie=off` must not hold
Claude, Codex, or Devin.

Provider lanes:

- Claude: evaluates Claude stale meter, weekly ceiling/mode, five-hour ceiling, and Kevin-active gate.
- Codex: evaluates Codex stale meter and `gov_codex_ceiling`; it bypasses Claude 5h/weekly/Kevin-active gates.
- Auggie: evaluates Auggie stale meter and `gov_auggie_ceiling`; it bypasses Claude 5h/weekly/Kevin-active gates.
- Devin: remains open unless a usage meter is later added. It should still count toward `gov_concurrency_cap` while Kevin is active.

Claude while Kevin is active:

- Read Claude five-hour utilization from the same usage file used by the existing `readUsage()` in `darwin-assistant/src/hopper-governor.ts:78-93`.
- If Kevin is not active, behave normally.
- If Kevin is active and five-hour utilization is known and `< gov_kevin_active_claude_max_5h`, allow the Claude claim.
- If Kevin is active and five-hour utilization is `>= gov_kevin_active_claude_max_5h`, hold with reason `kevin_active`.
- If Kevin is active and five-hour utilization is unknown, hold with reason `kevin_active` after stale-meter handling has run. Unknown should never become permission to burn Claude.
- Weekly ceiling still runs before the Kevin-active exception. If `gov_weekly_mode=hard` and weekly is at/above ceiling, hold. If `soft`, notify and continue as current live code does at `darwin-assistant/src/hopper-governor.ts:172-194`.

Non-Claude pool ceilings:

- A configured meter file that is missing or older than `HOPPER_GOV_STALE_MIN` must hold that provider only with reason `usage_stale`.
- Use the worst reported `windows[].used_percentage` as the provider burn percent, same as donor branch `readProviderUsage()` at `hopper/provider-daytime:darwin-assistant/src/hopper-governor.ts:154-172`.
- Auggie's percent is burned-credit percent from `/tmp/auggie-usage-live.json`; empty bar is full tank. The governor reads the normalized `used_percentage`, not raw remaining credits.

Dispatch:

- Keep the current per-node skip-and-continue loop. If one provider is held, later ready leaves for other providers still get a chance, as current `dispatchTick()` already does at `darwin-assistant/src/hopper-engine.ts:620-633`.
- Add `kevinActive()` and `providerFor()` exports from `hopper-governor.ts`, ported from `hopper/provider-daytime:darwin-assistant/src/hopper-governor.ts:120-131` and `hopper/provider-daytime:darwin-assistant/src/hopper-governor.ts:44-53`.
- In `dispatchTick()`, when Kevin is active, count currently running non-Claude nodes and stop claiming more once `gov_concurrency_cap` is reached. The donor branch implementation at `hopper/provider-daytime:darwin-assistant/src/hopper-engine.ts:664-690` is the template.
- Running workers are never interrupted by setting changes.

## API Contract

`GET /api/v1/hopper-engine/governor` must return:

- A back-compatible top-level verdict for Claude by default, or for the requested `?adapter=` if present.
- `providers.claude`, `providers.codex`, `providers.auggie`, and `providers.devin`, each with `allow`, `reason`, `override`, `detail`, `provider_usage` or `five_hour`/`weekly`, and `config`.
- `config` with effective values for every required settings key.

The reason enum must include `override_on` and `override_off`.

Current route is top-level Claude only at `darwin-assistant/src/handlers/api-v1.ts:1748-1751`. The donor branch already has the correct shape at `hopper/provider-daytime:darwin-assistant/src/handlers/api-v1.ts:1323-1329`; port that shape, not the old `/hopper-engine/daytime` toggle as the primary interface.

Settings mutation should live under a small explicit route rather than overloading global `/settings`:

- `GET /api/v1/hopper-engine/settings` returns the effective config and raw KV values.
- `PATCH /api/v1/hopper-engine/settings` accepts only the required keys, validates numbers/enums, writes settings-KV, and triggers `dispatchTick('governor_settings_changed')`.
- Override values must be validated exactly as `auto`, `on`, or `off`; invalid values return 400 and must not persist.
- Writes require admin scope, matching the global settings route at `darwin-assistant/src/handlers/api-v1.ts:3853-3872`.

## Engine Hardening 1: Parent-ID Deadlock

Incident to prevent: tree `tree-53a87489` froze on 2026-09-12 because nodes were planted with a dependency chain and also with `parent_id` set from `parent_index`. The ready query only claims leaves, so the first recon parent had children and could never run.

Required fix:

- Dependency sequencing must use `depends_on`, not `parent_id`.
- `parent_id` is reserved for real split/container trees created by a worker's `outcome="split"` in `finishHopperNode()` at `darwin-assistant/src/hopper-engine.ts:517-530`.
- `createHopperTree()` must ignore or reject `parent_index` for ordinary planner/agree-created DAGs. Prefer ignore-and-log for backward compatibility: insert all initial nodes with `parent_id = null`, then preserve ordering with `depends_on_indexes`.
- Keep `parent_index` available only for a deliberate future API mode like `{ tree_shape: 'nested' }`. No current caller needs it for normal chain trees.

Agree-time sanitizer:

- Before flipping drafts to pending, `agreeHopperTree()` must sanitize chain/DAG trees: for any draft/pending/running tree whose nodes have both a root/dependency-chain shape and `parent_id IS NOT NULL`, set all initial-tree `parent_id` values to null, preserving `depends_on`.
- Safe default: if any node in the tree has `status IN ('draft','pending')` and any node has `parent_id IS NOT NULL`, null every `parent_id` in that tree before the status flip, unless the tree already contains a `split` parent in status `split`.
- This sanitizer is intentionally redundant with the planter fix. It catches bad rows already persisted by older code and makes the agree path self-healing.

Regression check:

- Plant a three-node chain where node 2 has `depends_on_indexes: [0]` and node 3 has `depends_on_indexes: [1]`, agree it, and assert node 1 is a pending leaf/dispatchable while nodes 2 and 3 wait on deps.
- Assert `SELECT COUNT(*) FROM hopper_nodes WHERE tree_id=? AND parent_id IS NOT NULL` is `0` for initial DAG planting.
- Assert split children still get `parent_id = split_parent_id` through `finishHopperNode()`.

## Engine Hardening 2: Codex Finish-POST Gap

Failure class: Codex workers sometimes complete the code work and commit, but do not successfully send the mandatory `POST /hopper-nodes/:id/finish`. The current engine only recovers by lease expiry at `darwin-assistant/src/hopper-engine.ts:591-610`, which can waste a second attempt redoing work that already exists.

Worker-template guidance:

- Update `composeWorkerPrompt()` at `darwin-assistant/src/hopper-engine.ts:394-427` to add a short retry instruction immediately under the finish curl:
  - If the finish curl fails, retry the same exact curl up to three times with a few seconds between attempts.
  - If it still fails, print the exact JSON payload as the final assistant message so the reconciler can recover it.
  - Never invent a successful finish; either POST succeeds or the payload is visible for recovery.
- Mirror the same guidance in Foundry stage templates so module and integration workers see it inside their stage spec, not only in the generic Hopper wrapper.

Reconciler recovery:

- Port the donor branch's JSON-payload replay from `hopper/provider-daytime:darwin-assistant/scripts/jarvis-spawn-reconcile.py:64-130` and invocation at `hopper/provider-daytime:darwin-assistant/scripts/jarvis-spawn-reconcile.py:153-158`.
- Strengthen it for Codex completion without a JSON payload:
  - Candidate row: `spawn_tasks.status IN ('running','stuck')`, worker descriptor `running=false`, `turn_count >= 1`, matching `hopper_node_id` or `worker_thread_ext`, node still `running`, and the node lease is expired or within a small grace window after expiry.
  - Evidence: the worker thread's final summary or assistant turn names one or more commits, and the repo branch named in the node spec contains a new commit after the node's `created_at` or `updated_at`.
  - Action: if a well-formed finish JSON exists, POST it exactly, appending `[recovered by reconciler from worker output]`.
  - Action: if no JSON exists but commit evidence is strong, finish the node as `done` with a result that includes the recovered commit sha(s), worker thread ext, and an explicit reconciler note.
  - If evidence is incomplete, do not mark done. Leave normal lease recovery in place and add a precise `spawn_tasks.error` note so Mission Control shows why it was not recovered.
- Non-destructive rule: the reconciler never edits repos, never rolls back, never fabricates commits, and never finishes a node without either valid payload JSON or commit evidence on the node branch.
- Attempt pin (added by the adversarial review, node #158): a ledger row is evidence for ONE attempt. The reconciler only recovers when `hopper_nodes.worker_thread_ext` still equals the row's `thread_ext`; if the node has expired its lease and been re-leased to a new worker, the stale row is reconciled to `done` with a log line and touches nothing. Every recovery POST carries `worker_thread_ext`, and `POST /hopper-nodes/:id/finish` returns `409 hopper_node_attempt_mismatch` when that field is present and does not match the node's current lease — so neither the reconciler nor a late worker POST can complete a node out from under the live attempt. Sim check 7 covers this.
- Template guard: the worker prompt's own finish-contract examples are valid JSON (`{"outcome":"done","result":"<what you did …>"}`); payload replay rejects placeholder-shaped results/questions so a worker that merely restates the contract is never "recovered" with a template.
- Deferral is live, not terminal: when the commit-evidence window (lease expiry − 5m) has not opened yet, the ledger row KEEPS its prior status (`HOPPER_FINISH_RECOVERY_PENDING:` note) so the next 5-minute tick re-evaluates it. Marking it `done` at that point would make the deferral permanent, because the reconciler only revisits `running`/`stuck` rows.

Spawn ledger details:

- Preserve and use current `hopper_tree_id`/`hopper_node_id` stamps from `darwin-assistant/src/spawn-tasks.ts:65-78` and current spawn insertion at `darwin-assistant/src/hopper-engine.ts:439-457`.
- Add `adapter TEXT` to `spawn_tasks` only if the retry ladder needs attempt-provider history, but do not remove the current stamp columns.
- If adding adapter to the ledger, update `SpawnTaskRow`, `listAllSpawnTasks()`, and Mission Control types in `darwin-assistant/src/spawn-monitor.ts`.

## Retry Ladder

Keep live Claude tier escalation from `darwin-assistant/src/hopper-engine.ts:77-85`.

Add provider-aware rerouting from the donor branch:

- Claude: stay on Claude, bump tier one step.
- Codex: retry to Auggie default if Auggie is open, else Claude Sonnet.
- Auggie: retry to Codex `gpt-5.5` if Codex is open, else Claude Sonnet.
- Devin: retry to Claude Sonnet.

Before choosing a non-Claude retry target, call `governorStatus(candidate.adapter).allow` so a capped Auggie pool does not receive a Codex retry. This is the donor behavior at `hopper/provider-daytime:darwin-assistant/src/hopper-engine.ts:138-145`.

Log retry reroutes into `spawn_tasks.error` using a stable prefix like `HOPPER_RETRY_REROUTE:` so history can surface it. The donor branch prepared this at `hopper/provider-daytime:darwin-assistant/src/hopper-engine.ts:236-249` and writes it during lease recovery at `hopper/provider-daytime:darwin-assistant/src/hopper-engine.ts:639-645`.

## Cockpit Surface

Do not ship only the old Daytime Engine toggle.

Governor v2 cockpit work should add a settings surface reachable from Spawn-Tree/Mission Control or Settings:

- Editable fields for `gov_kevin_active_claude_max_5h`, `gov_5h_ceiling`, `gov_weekly_ceiling`, `gov_weekly_mode`, `gov_codex_ceiling`, `gov_auggie_ceiling`, and `gov_concurrency_cap`.
- Three-state controls for `gov_override_claude`, `gov_override_codex`, `gov_override_auggie`, and `gov_override_devin`: `auto` = governor logic decides, `on` = force open despite Kevin-active/ceilings/staleness, `off` = hold new workers on that provider.
- Read-only per-pool state from `GET /hopper-engine/governor`: allow/hold reason, current usage percent, stale status, and effective ceiling.
- The provider usage widget can link into this panel and show compact override
  pills for non-`auto` providers, but the canonical editor should be the
  settings panel.

UI donor branch useful anchors:

- API client pattern: `hopper/provider-daytime-ui:src/lib/cockpit-api.ts:970-984`
- Spawn-tree header button pattern: `hopper/provider-daytime-ui:src/routes/spawn-tree.tsx:50-126`
- Provider panel placement: `hopper/provider-daytime-ui:src/routes/threads.tsx:4633-4781`

## Acceptance Checks

Backend:

- With Claude 5h below `gov_kevin_active_claude_max_5h`, Kevin active, and stale/weekly checks passing, `governorCheck('claude')` allows.
- With Claude 5h at or above `gov_kevin_active_claude_max_5h`, Kevin active, `governorCheck('claude')` holds with `kevin_active`.
- With Auggie usage at `85`, `governorCheck('auggie')` holds with `provider_ceiling` by default.
- With Codex meter stale, `governorCheck('codex')` holds with `usage_stale` without holding Claude or Auggie.
- `GET /hopper-engine/governor` includes top-level verdict and `providers.{claude,codex,auggie,devin}` with effective config values.
- Default/unset override state reports `override: "auto"` with no behavioral drift from the pre-override governor.
- Setting `gov_override_claude=on` allows Claude with reason `override_on` even while Kevin is active and Claude usage is above normal ceilings.
- Setting `gov_override_auggie=off` holds only Auggie with reason `override_off`; other providers remain governed by their own settings.
- Invalid override values such as `ON`, `on `, or `maybe` do not activate an override. The PATCH route rejects invalid values; hand-edited KV variants read as `auto`.
- Chain-planted trees have no initial `parent_id` values and dispatch the first dependency node.
- Split-created children still have `parent_id` and still bubble completion.
- Reconciler can replay a valid finish JSON from a completed worker thread.
- Reconciler can complete a Codex node from strong commit evidence when JSON is missing.

Frontend:

- The settings panel loads raw/effective governor values.
- Manual provider overrides render as `Auto`, `On`, or `Off`, normalizing unset or hand-edited non-literals to `Auto` just like the governor.
- Invalid settings are rejected visibly.
- Saving settings updates the panel and subsequent governor API reads without a JARVIS restart.
- Spawn-Tree still renders current Mission Control data; do not regress the current `/spawn-monitor` aggregate route.

## Deployment Notes

- Set live `.env` `HOPPER_GOV_WEEKLY_CEILING=30` on the next JARVIS restart if it is not already set. Runtime code should prefer KV `gov_weekly_ceiling`, but this env default keeps the service safe before Kevin opens the panel.
- Do not deploy from inside a worker synchronously. If a reviewed branch is deployed from a JARVIS turn, use the existing detached `systemd-run` restart pattern so the active turn is not killed mid-report.
- No production databases, no merges to main, and no external sends are part of this contract.
