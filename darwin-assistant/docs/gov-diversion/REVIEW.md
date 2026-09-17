# Governor Cross-Pool Diversion — Adversarial Review (node #302)

Branch `hopper/gov-diversion` (base `hopper/gov-overrides` @ `e3db62745`), reviewed at
`8de8e52c2` (nodes 298–301), 2026-09-16. Reviewer: opus-5 hopper worker.

## Verdict: **PASS — with two fixes applied on this branch**

Two real issues were found by adversarial probing, both confirmed failing against `8de8e52c2`
and both fixed in this commit (small, contained, engine-only). Neither is a design-level
problem; nothing escalated. Full regression harness: **21/21** (19 pre-existing + the 2 new
review checks 12a/12b), `tsc` 0 errors.

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| B | A **frontier** claude leaf (`claude-opus-5`, e.g. an adversarial-review node) held for `kevin_active` diverted onto **codex `gpt-6-astra`** — the exact leaf-work misroute the router rubric forbids after the 2026-09-14 codex burn (1%→64% in ~2h). `kevin_active` is the ordinary daytime state, so this would fire routinely, not in an edge case. | **runaway** | **fixed** |
| A | The diverted loadout was restamped onto the node **before** the daytime concurrency-cap check and before the claim. A cap-held (or claim-raced) node was silently re-homed to the alternate pool while still `pending`: it lost the `[DIVERTED]` audit trail, never returned to its planner-assigned pool once that pool freed up, and could chain-divert from the new pool next tick. | bookkeeping | **fixed** |

### Fix B — no leaf-eligible codex frontier target (`src/hopper-engine.ts`)
`DIVERSION_LOADOUTS` now types each cell as `WorkerLoadout | null`; `codex.frontier = null` and
`devin.{standard,frontier} = null`. `tryDivert` skips a candidate whose cell is null **before**
probing the governor. Effects:
- A frontier-tier node can still divert to `auggie/opus4.8` or (inbound) to `claude/claude-opus-5`;
  it simply cannot land on `gpt-6-astra`. With auggie also blocked it **holds exactly as today**.
- The inbound direction (`gpt-6-astra` source → `claude-opus-5`) is unchanged (`tierOf()` still
  recognises astra/gpt-6 as frontier).
- Devin is excluded as a sink because it has **no usage meter** (`providerMeters().devin.ceiling`
  is a constant 100 → it would clear every band forever = unbounded runaway if someone put
  `devin` in `gov_diversion_pool_order`) and its CLI is demoted to one-shots only.

### Fix A — decide, cap-check, claim, THEN restamp (`src/hopper-engine.ts` dispatchTick)
Order is now: `tryDivert` (decision only) → daytime concurrency cap check on the *diverted*
adapter → `claimStmt` → **only if the claim succeeded** `setNode({adapter, model})` → re-read
`fresh` → `spawnWorker(fresh, tree, diversion?.labelPrefix)`. A held/raced node keeps its original
loadout and is re-evaluated from its own pool next tick.

## Spec checklist

### 1. Diversion cannot cascade normal throughput onto claude — guard verified
- The diversion branch is reachable **only** when `!verdict.allow` for the node's own pool
  (`hopper-engine.ts` dispatchTick), and `tryDivert` returns null unless
  `verdict.reason ∈ {provider_ceiling, five_hour_ceiling, kevin_active}`. A node whose own pool has
  headroom never enters it (sim 11c: no restamp, no `[DIVERTED]` label).
- A candidate must clear `governorCheckDiversionTarget(candidate, band)`; the band is a raised
  ceiling (`Math.max`) applied only to the 5h/provider ceiling + the kevin-active waiver threshold.
  `weekly_ceiling`, `usage_stale`, and `override_off` return **before** the floor is consulted
  (sim 10c/10d; probe E).
- Burst bound: within one tick all stuck nodes share one cached probe per candidate, so N stuck
  codex nodes can all divert in one tick — but total dispatch is bounded by `free = MAX_SLOTS −
  running` (prod `HOPPER_ENGINE_SLOTS` default **2**). The next tick re-reads the 60s usage poll.
- Master switch `gov_diversion_enabled=false` short-circuits before `tryDivert` (sim 10e/11d).

### 2. Raised ceiling applies ONLY to the diversion path
`evaluate(provider, opts?)` — `raiseCeiling` is the identity when `opts` is undefined. Every
pre-existing caller (`governorCheck`, `governorStatus`, `governorStatusAll`, the retry ladder,
`/hopper-engine/governor`) still calls with one arg. Only `governorCheckDiversionTarget` passes
`{ceilingFloor}`. Verified by reading the diff (`hopper-governor.ts`) and by sim 2a/2b/3a/3b/1
(normal-band verdicts unchanged with diversion ON, plus probe E: 5h 91% ≥ 90 still
`five_hour_ceiling` on the normal band while diversion is enabled).

Note on the band vs. claude's normal ceiling: prod `gov_5h_ceiling`=90 > band 85, so for a claude
**target with Kevin away** the effective ceiling stays 90 (the band only ever raises). The band's
practical effect for claude-as-target is the kevin-active waiver (50 → 85); for codex/auggie
targets it raises their per-pool ceilings (90/85 → 85 = no change today unless Kevin lowers them,
e.g. the "stop at 75, unstick to 85" he described).

### 3. Normal dispatch + normal-band governor byte-identical; single-pool unchanged; overrides honored
- Loop diff for the allowed path: `verdicts` cache widened from `boolean` to `GovernorVerdict`
  (same `.allow` gate); `diversion` stays null → identical cap check → identical claim → `if
  (diversion)` skipped → identical `fresh`/emit/spawn. `spawnWorker`'s label is
  `${labelPrefix ? labelPrefix + ' ' : ''}hopper #…` → byte-identical when undefined.
- `override_on` bypasses everything as before; `override_off` on the **source** pool is not a
  divertible reason (probe D: node holds), and `override_off` on a **target** pool is refused
  because the override branch runs before the floor (sim 10d).
- No-alternate path: `if (!diversion) continue;` == today's `if (!allowed) continue;`.

### 4. Attempt / retry / lease bookkeeping; no double-claim; no deadlock
- `claimStmt` (`… WHERE id=? AND status='pending'`, `attempts = attempts + 1`) is untouched; a
  diverted dispatch is one attempt (probe F: `attempts` 1 → lease expiry → retry → 2, two
  `spawn_tasks` rows, new `worker_thread_ext`).
- Because the restamp lands before `fresh` is re-read, a later lease-expiry `retryRouteFor` sees
  the diverted pool and walks the correct ladder (probe F: `codex/gpt-5.5` → diverted
  `claude/claude-sonnet-5` → retry `claude/claude-opus-5`). `spawnTaskMarkRerouted` marks the
  diverted row failed; the `[DIVERTED` label survives so `diversionState().recent` shows it.
- Double-claim: `ticking` guard + `changes !== 1` race check unchanged; restamp now happens only
  after a successful claim, so a raced node is never mutated.
- Deadlock: diversion touches `adapter`/`model` only — never `parent_id`/`depends_on`/status —
  so flat-tree dispatch semantics (`readyLeavesStmt`, `depsSatisfied`) are unaffected.

### 5. NO API KEYS
`git diff e3db62745..HEAD -- src` has zero hits for `API_KEY`, `@anthropic-ai/sdk`, `openai`.
The branch adds no model calls at all — governor + dispatcher plumbing only.

## Observations (not blocking — accepted design, flagged for JARVIS at deploy)
1. **Diverted work runs on claude while Kevin is at the keyboard up to the 85 band**, whereas
   planner-routed claude work still holds at the 50 waiver. This is per the plant-time DESIGN
   ("for claude also the kevin_active waiver") and Kevin's verbatim "divert execution until it's
   at like 85%". It is bounded by `MAX_SLOTS` (2), but note the daytime concurrency cap
   (`gov_concurrency_cap`) counts **non-claude** workers only, so diverted-to-claude workers are
   not under it. Fast-follow if it ever bites: count diverted dispatches under the daytime cap
   regardless of target pool.
2. Standard claude nodes held for `kevin_active` now flow outward to `codex/gpt-5.5` during the
   day when codex has headroom (probe C / sim 12b). This is the reverse of the n266 case and is
   consistent with the daytime multi-provider greenlight, but it means JARVIS's plan-time
   claude routing is overridden on an ordinary afternoon. If that's unwanted, set
   `gov_diversion_pool_order=claude` (claude-only sink) — no code change needed.
3. `gov_diversion_pool_order` still validates `devin` as a token; with Fix B it is now inert
   (skipped) rather than a runaway sink.

## Evidence
- `scripts/governor-v2-sim.mjs` — permanent harness, **21/21** after fixes (new: 12a cap-held
  keeps loadout, 12b frontier never → gpt-6-astra while standard still → gpt-5.5). Run:
  `JARVIS_DB_PATH=/tmp/x.db node scripts/governor-v2-sim.mjs`.
- Pre-fix reproduction (probes A/B against `8de8e52c2`): A → `adapter mutated to auggie without a
  dispatch`; B → `[DIVERTED claude/claude-opus-5→codex/gpt-6-astra: kevin_active …]`.
- `npx tsc -p .` → 0 errors (requires `npm install --include=dev` in darwin-assistant, see
  SIM-RESULTS.md).
