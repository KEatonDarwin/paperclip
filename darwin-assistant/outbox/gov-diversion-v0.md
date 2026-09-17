# Governor Cross-Pool Diversion — v0

Branch `hopper/gov-diversion` (based on `hopper/gov-overrides`). Tree
`tree-6ecf478c`. Status: **built, simmed, adversarially reviewed (PASS with
2 fixes) — awaiting JARVIS deploy.**

## What it is

A ceiling-blocked **ready** hopper node no longer just sits `pending`
forever waiting for its own pool to free up. Each dispatch tick, if a
node's own pool is held for a **capacity** reason (not a hard denial), the
engine now checks whether an *equivalent-tier* loadout on another pool has
headroom under a **raised** ceiling band. If so, it restamps the node onto
that pool/model, labels the spawn `[DIVERTED …]` for the audit trail, and
dispatches — instead of leaving the tree stalled.

**The incident that prompted it:** `tree-616aa8c4` "Perclickity Zoom 3"
node `n266` was routed to `codex/gpt-5.5` and sat `pending` because Codex
was at 91% ≥ its 90% ceiling. Nothing diverted it; the whole tree stalled
until JARVIS hand-rerouted it to `claude/claude-sonnet-5` and
bridge-dispatched by hand. This build automates exactly that judgment call.

Kevin's framing (verbatim, 2026-09-16): *"if we are stopping work now at
75%, and something needs unsticking, then divert execution until it's at
like 85% getting around the block."*

## The two knobs, together

This is genuinely two small features wired through one gate:

1. **Cross-pool diversion** — a blocked ready node may run on a *different*
   pool instead of its planner-assigned one, when that alternate pool has
   headroom.
2. **Raised ceiling for the diversion probe only** — the alternate pool is
   evaluated against a *higher* ceiling (default 85%) than its normal
   dispatch ceiling, so diversion catches nodes in the 75–85% band that
   would otherwise still be denied even on a healthy-looking pool. This
   raised band applies **only** inside the diversion probe
   (`governorCheckDiversionTarget`) — every other governor caller
   (`governorCheck`, `governorStatus`, the retry ladder, `/hopper-engine/
   governor`) is unaffected; `evaluate()`'s `raiseCeiling()` is the identity
   when called with no `ceilingFloor`.

## Settings-KV knobs (all uncached, env-fallback, live-tunable)

| Setting (settings-KV key) | Env fallback | Default | Meaning |
|---|---|---|---|
| `gov_diversion_enabled` | `GOV_DIVERSION_ENABLED` | `true` | Master switch. `false`/`0`/`off`/`no` disables diversion entirely — dispatch behaves byte-identical to pre-diversion code. |
| `gov_diversion_ceiling_5h` | `GOV_DIVERSION_CEILING_5H` | `85` | The raised ceiling band a candidate pool is probed against (also raises the `kevin_active` claude waiver threshold — see below). |
| `gov_diversion_pool_order` | `GOV_DIVERSION_POOL_ORDER` | `claude,codex,auggie` | CSV preference order tried, in order, for a diversion target. Invalid/unknown tokens are dropped silently. `devin` is accepted as a token but is currently always inert (see Fix B below — no meter, so it can never legitimately be a sink). |

Reads go through `govDivSetting()` (`gov_<bareKey>` in settings-KV, falling
back to `GOV_<BAREKEY>` env) — same uncached-read pattern as every other
governor knob, so Kevin can retune any of these live without a restart.

**Not a setting (fixed in code, deliberately):** which governor *reasons*
are divertible at all. See below.

## Which denials are divertible

```
DIVERTIBLE_REASONS = { provider_ceiling, five_hour_ceiling, kevin_active }
```

Only a true **capacity** denial is divertible. Explicitly **excluded**:

- `weekly_ceiling` — a hard weekly budget denial; diverting would just move
  the spend, not respect the intent of the cap.
- `usage_stale` — the usage signal itself is broken; routing blind onto
  another pool on a broken read is unsafe.
- `override_off` — Kevin explicitly held that pool by hand
  ([[Governor manual override toggles]]); diversion must never route work
  *onto* a pool Kevin turned off, and a node held *because* its own pool is
  `override_off` is not diverted either — that's a deliberate human hold,
  not a capacity problem.

## Tier-equivalence map (what a diverted loadout actually runs)

A diverted node keeps its **tier** (standard vs. frontier) — it does not
get upgraded or downgraded, it gets moved sideways to the equivalent-weight
worker on a different pool:

| Candidate pool | standard tier | frontier tier |
|---|---|---|
| `claude` | `claude-sonnet-5` | `claude-opus-5` |
| `codex` | `gpt-5.5` | **null — never a diversion target** |
| `auggie` | `auggie default` | `opus4.8` |
| `devin` | **null** | **null** |

Tier is inferred from the node's *current* (blocked) loadout via `tierOf()`
— claude opus/fable, codex astra/gpt-6, auggie opus → `frontier`; anything
else (incl. devin) → `standard`.

**Codex frontier (`gpt-6-astra`) is deliberately excluded as a diversion
target** (added in the adversarial-review fix, see below) — this follows
the per-pool tier rule in `skills/jarvis-router/SKILL.md` written after the
2026-09-14 codex burn (a frontier variant is planner-facing only, never leaf
work). A frontier-tier node blocked on `kevin_active` can still divert to
`auggie/opus4.8` or receive diversions *from* other pools onto
`claude-opus-5`; it simply cannot land on `gpt-6-astra`. If auggie is also
unavailable, it holds — exactly as before this feature existed.

**Devin is null at both tiers** — it has no usage meter (`providerMeters()`
reports a constant ceiling of 100, i.e. always "open"), so treating it as a
diversion sink would make it an unbounded runaway target the moment
anything else got tight. Its CLI is also one-shot-only (`--print` mode
stalls mid-response), which independently rules it out as a spawnable
leaf-worker sink today.

## Worked example — the actual n266 case

Codex is at 91% (≥ its normal 90% ceiling → `provider_ceiling` hold).
Claude is at 61% (well under its normal ceiling, and under the 85% band
too). Pool order is the default `claude,codex,auggie`.

1. Node `n266` (adapter `codex`, model `gpt-5.5`, tier `standard`) comes up
   ready; `governorCheck('codex')` → `{allow:false, reason:'provider_ceiling'}`.
2. `provider_ceiling` is in `DIVERTIBLE_REASONS` → `tryDivert()` runs.
3. First candidate in pool order: `claude` (≠ own pool `codex`). Loadout at
   `standard` tier on claude = `{adapter:'claude', model:'claude-sonnet-5'}`.
4. Probe: `governorCheckDiversionTarget('claude', 85)` → claude at 61% <
   85% band → `{allow:true}`.
5. Diversion accepted: node is restamped to `claude/claude-sonnet-5`,
   label prefixed `[DIVERTED codex/gpt-5.5→claude/claude-sonnet-5:
   provider_ceiling …]`, claimed, and dispatched this tick — no more manual
   bridge-dispatch.

If claude had *also* been over the 85% band (or `override_off`, or its own
governor gate otherwise denied it), the loop tries `codex` next (skipped —
own pool), then `auggie` — and if nothing clears, the node holds exactly as
it did before this feature existed. Nothing is force-dispatched.

## Where it lives in the dispatch loop

`src/hopper-engine.ts` `dispatchTick()`: the per-tick verdict cache widened
from `Map<string, boolean>` to `Map<string, GovernorVerdict>` (reason is
needed for eligibility, not just allow/deny). On a denied verdict:
`tryDivert(node, verdict, poolOrder, ceiling, divVerdicts)` returns either a
`DiversionResult` (loadout + label) or `null`. **Order matters and was a
review fix:** decide (`tryDivert`) → daytime concurrency-cap check on the
*diverted* adapter → `claimStmt` → **only on a successful claim** restamp
`{adapter, model}` onto the node → re-read `fresh` → `spawnWorker(fresh,
tree, diversion?.labelPrefix)`. A cap-held or claim-raced node is never
mutated — it keeps its original loadout and is re-evaluated from its own
pool next tick.

Read-only visibility: `diversionState()` → `GET /hopper-engine/governor`
now includes `enabled`, `ceiling_5h`, `pool_order`, `divertible_reasons`,
`active` (diverted spawns still `running`), and `recent` (last 20 diverted
`spawn_tasks` rows, by the `[DIVERTED` label prefix) — no new table, reads
off the existing durable `spawn_tasks` ledger.

## Guarantees verified (sim + adversarial review, 21/21 passing)

- **Normal dispatch path is byte-identical** when a node's own pool has
  headroom — no diversion probe, no restamp, no label change.
- **Single-pool / diversion-off behaves exactly like pre-diversion code**
  (`gov_diversion_enabled=false` — sim `10e`/`11d`, same usage numbers that
  *would* clear a target with diversion on, node still holds).
- **Manual overrides are honored** — `override_off` on the source pool is
  not divertible; `override_off` on a candidate target pool is refused as a
  diversion sink.
- **No deadlock / no double-claim** — diversion only ever touches
  `adapter`/`model`; it never touches `parent_id`/`depends_on`/status, so
  flat-tree dispatch semantics are untouched. Existing claim race guard
  (`changes !== 1`) is unaffected because restamp now happens strictly
  after a successful claim.
- **Retry ladder sees the diverted pool correctly** — a diverted node whose
  lease expires retries from its *new* (diverted) pool, not its original
  one, per `retryRouteFor()`.
- **NO API KEYS** — the diff is governor + dispatcher plumbing only; zero
  new model calls, zero `API_KEY`/SDK references.

## Adversarial review — 2 real fixes applied (both on this branch, `84281428c`)

1. **(runaway, fixed)** Before the fix, a frontier claude leaf (e.g. an
   adversarial-review node on `claude-opus-5`) held for `kevin_active`
   would divert onto codex `gpt-6-astra` — the exact leaf-work misroute the
   router rubric now forbids, and `kevin_active` is the *routine* daytime
   hold, not an edge case. Fixed by making codex's frontier cell (and both
   of devin's cells) `null` in `DIVERSION_LOADOUTS`, skipped before the
   governor is even probed.
2. **(bookkeeping, fixed)** Before the fix, the diverted loadout was
   restamped onto the node *before* the daytime concurrency-cap check and
   the claim — a cap-held or claim-raced node could be silently re-homed
   while still `pending`, losing its `[DIVERTED]` audit trail and never
   returning to its planner-assigned pool. Fixed by moving the restamp to
   strictly after a successful claim.

Full findings + spec-checklist walkthrough: `docs/gov-diversion/REVIEW.md`.
Sim harness + scenario-by-scenario results: `docs/gov-diversion/SIM-RESULTS.md`
(19 base checks + review checks `12a`/`12b` = 21/21).

## Deploy note — MUST reconcile with `hopper/gov-overrides`

This branch is based on `hopper/gov-overrides` (the per-provider manual
`auto`/`on`/`off` override toggles, tree-72a37228) and both touch
`src/hopper-governor.ts` / `src/hopper-engine.ts`. **They are not
independently mergeable into the live darwin-assistant checkout** — JARVIS
must merge both branches together (or merge this branch, which already
contains gov-overrides' commits as its base, and verify no divergent
gov-overrides-only commits landed on `hopper/gov-overrides` after this
branch forked) before restarting jarvis.service. Verify post-merge:
`override_off` on a pool still refuses it as *both* a normal dispatch
target and a diversion target (covered by sim `10d`, but re-check after any
merge-conflict resolution).

This node does **not** deploy or restart anything — JARVIS reviews +
merges + restarts per the guardrails above.

## Deferred (v1.1 — not built, offered as fast-follows)

1. **Cockpit visibility.** No UI surfaces diversion today beyond the raw
   `GET /hopper-engine/governor` JSON (`diversion` field: enabled, band,
   pool order, active/recent diverted spawns). Natural fast-follow: a small
   pill/badge on `/settings/governor` next to each pool showing "N diverted
   in" / "N diverted out" in the last hour, and a badge on the cockpit
   Provider Usage widget when a pool currently has an active diverted
   worker running on it (so Kevin can tell "this claude worker is actually
   diverted codex work" at a glance, not just from the `[DIVERTED]` label
   buried in a thread title).
2. **Diverted-work concurrency accounting.** Per review observation #1: the
   daytime concurrency cap (`gov_concurrency_cap`) counts non-claude
   workers only, so work diverted *onto* claude is not counted under it.
   Bounded today only by `MAX_SLOTS` (prod `HOPPER_ENGINE_SLOTS=2`). If this
   ever needs tightening, count diverted dispatches under the cap
   regardless of target pool.
3. **`gov_diversion_pool_order` UI control.** Today it's settings-KV/env
   only (no cockpit form field) — same rung as the `GOVERNOR_SETTING_SPECS`
   gap noted in `RECON.md` §2 for string-typed settings. If Kevin wants a
   claude-only sink (per review observation #2 — diverted-to-claude work
   flows outward to codex during the day too, the reverse of the n266 case)
   he can already set `gov_diversion_pool_order=claude` by hand; a proper
   settings-form control is the fast-follow.
