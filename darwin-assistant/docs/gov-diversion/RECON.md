# Governor Cross-Pool Diversion — Recon

Branch: `hopper/gov-diversion` (based on `hopper/gov-overrides`)

Recon date: 2026-09-16 (node #298, tree `tree-6ecf478c`)

## Verbatim ask

> I see an active perclickity zoom 3 that is stopped because a dependency
> can't be created cuz it's on codex. So that setup needs to be edited have
> a secondary drop level or something to move the work to another place
> (claude probably), and the new level is a level in which that's ok. So if
> we are stopping work now at 75%, and something needs unsticking, then
> divert execution until it's at like 85% getting around the block.

Real incident: `tree-616aa8c4` "Perclickity Zoom 3" node `n266` was routed
to `codex/gpt-5.5` and sat `pending` because Codex was at 91% ≥ its 90%
ceiling. Nothing diverted it — the whole tree stalled until JARVIS
hand-rerouted it to `claude/claude-sonnet-5` and bridge-dispatched. This
build makes that automatic.

## 1. Ready-leaf loop + governor gate (the diversion seam)

File: `darwin-assistant/src/hopper-engine.ts`

- Dispatcher entry point: `dispatchTick()` at **line 672**.
- Ready-leaf query `readyLeavesStmt` at **lines 232–238** — a node is
  dispatchable only if it's `pending`, in an `active` tree, and has no
  children (leaf rule).
- The loop itself is **lines 729–757**. The exact gate:
  ```ts
  const adapter = node.adapter ?? WORKER_ADAPTER;
  let allowed = verdicts.get(adapter);
  if (allowed === undefined) {
    allowed = governorCheck(adapter).allow;
    verdicts.set(adapter, allowed);
  }
  if (!allowed) continue;   // <-- line 738: node stays 'pending' forever, no diversion today
  ```
  `verdicts` (**line 728**) is a per-tick `Map<string, boolean>` cache keyed
  by adapter string — **only the boolean is cached today, not the reason**.
  Diversion needs the `reason` to decide eligibility (see §3), so this map's
  value type must widen to the full `GovernorVerdict` (or a second
  `Map<string, GovernorVerdict>` alongside it) so the reason is available
  without a second `governorCheck()` call.
- Claim: `claimStmt` (**lines 240–245**) — `UPDATE hopper_nodes SET status =
  'running', attempts = attempts + 1, worker_thread_ext = ?, lease_expires_at
  = ? WHERE id = ? AND status = 'pending'`. **It does not touch `adapter` or
  `model` columns.** After claiming, the loop re-reads the row fresh:
  `const fresh = getNodeStmt.get(node.id)!;` (**line 750**) and dispatches
  `fresh` — so if a diverted loadout is not persisted before this re-read,
  `fresh.adapter`/`fresh.model` still show the ORIGINAL (blocked) pool and
  the diversion has no effect on what actually spawns.
- Model/adapter are read at spawn time in `spawnWorker()` (**lines
  529–550**):
  ```ts
  const model = node.model ?? defaultWorkerModel();                       // line 535
  if (model) setThreadModelOverride(conv.id, node.adapter ?? WORKER_ADAPTER, model); // line 536
  ```
  This is the only place a node's stored loadout becomes an actual model
  override on the spawned thread.
- `WorkerLoadout` type: **lines 93–96** (`{ adapter, model }`).
  `loadoutLabel()` (tier/pool label helper): **lines 118–120**.
  `escalateModel()` (Claude tier-bump ladder): **lines 80–85**, walking
  `MODEL_LADDER` (**line 79**:
  `['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5']`).
  `retryRouteFor()` (existing cross-provider retry-on-lease-expiry
  precedent — **lines 123–139**) already restamps `node.adapter`/`node.model`
  on a failed attempt (see §3, this is the direct precedent for diversion's
  restamp-vs-transient decision).

## 2. `governorCheck` — exact reason codes + where ceilings live

File: `darwin-assistant/src/hopper-governor.ts`

- `GovernorVerdict['reason']` union (**lines 140–149**), confirmed exact set:
  `'ok' | 'disabled' | 'override_on' | 'override_off' | 'five_hour_ceiling'
  | 'weekly_ceiling' | 'usage_stale' | 'kevin_active' | 'provider_ceiling'`.
- `governorCheck(adapter?)` (**line 268**) → `evaluate(providerFor(adapter))`
  (**line 297**) is the single evaluation function; `governorStatus(adapter?)`
  (**line 284**) is the same evaluator with no logging (used for read-only
  checks — this is what a diversion-candidate probe should call, mirroring
  the existing retry-ladder's `governorStatus(candidate.adapter).allow` at
  **line 136**).
- Per-pool ceilings, all uncached settings-KV with env fallback via
  `getGovernorSetting()`/`numSetting()` (**lines 53–71**):
  - `fiveHourCeiling()` **line 94** → `gov_5h_ceiling`, default 90.
  - `weeklyCeiling()` **line 97** → `gov_weekly_ceiling`, default 30.
  - `codexCeiling()` **line 101** → `gov_codex_ceiling`, default 90.
  - `auggieCeiling()` **line 104** → `gov_auggie_ceiling`, default 85.
  - `kevinActiveClaudeMax5h()` **line 91** → `gov_kevin_active_claude_max_5h`,
    default 50 — the waiver threshold, not a ceiling on its own, but it's
    what `kevin_active` compares against (see below).
  - `providerMeters()` (**lines 244–250**) maps `codex`/`auggie`/`devin` →
    `{file, ceiling}`; `devin` has no meter file and no ceiling (`() => 100`,
    always open until a meter ships).
- Non-Claude branch (**lines 327–378**): holds with `usage_stale` if the
  meter file is missing/stale, else holds with `provider_ceiling` if
  `used >= ceiling`, else `ok`.
- Claude branch (**lines 380–472**): `usage_stale` → `weekly_ceiling`
  (skippable in `soft` mode, **lines 406–426**) → `five_hour_ceiling`
  (**lines 428–439**, hard stop, no waiver) → `kevin_active` (**lines
  441–461**: only fires when `kevinActive()` is true AND
  `fiveHour >= kevinActiveClaudeMax5h()` — note `fiveHour == null` also
  holds, "never waive on an unknown reading").
- Override gate (**lines 85–88, 299–321**) runs before everything else,
  per-provider, KV-only exact match (`gov_override_{provider}` = literal
  `'on'`/`'off'`, anything else reads as `'auto'`). `override_on` bypasses
  every other gate for that provider; `override_off` holds regardless of
  usage. **Diversion must never route work onto a provider whose override is
  `off`** — that's an explicit Kevin hold, not a capacity problem (see §3).
- `GOVERNOR_SETTING_SPECS` (single source of truth for the settings API):
  `darwin-assistant/src/handlers/api-v1.ts` **lines 300–312**, consumed by
  `GET/PATCH /hopper-engine/settings` at **lines 1956–1998**. Currently only
  `'number'` and `'enum'` value types exist — a new `gov_diversion_pool_order`
  setting (a CSV like `claude,codex,auggie`) needs either a new `'string'`
  type added to this spec union, or ship as a fixed-order constant for v0
  and defer the setting (see §4 open question).
- Reference doc `docs/hopper/GOVERNOR-V2-CONTRACT.md` (present in `HEAD`'s
  git tree per `git show HEAD:docs/hopper/GOVERNOR-V2-CONTRACT.md`, though
  oddly absent from a plain `ls`/`git ls-tree` on this worktree — a checkout
  quirk, not a code issue) is the as-built contract for the override work
  this branches from; read via `git show HEAD:docs/hopper/GOVERNOR.md` too
  if the decide/build node wants the operator-doc conventions to match.

## 3. DECISION — transient loadout vs. restamping `node.adapter`/`node.model`

**Decision: restamp.** When diversion fires, persist the diverted
`adapter`/`model` onto the node's stored row (same `setNode()` mechanism
already used, e.g. via the `claimStmt` UPDATE or an immediate follow-up
`setNode()` call) rather than threading a transient override through
`spawnWorker()`.

Rationale:

- It's the existing precedent. `retryRouteFor()` + the lease-expiry recovery
  branch (**hopper-engine.ts lines 690–708**) already permanently rewrites
  `node.adapter`/`node.model` when a node's situation changes (there: a
  failed attempt; here: a blocked pool) via `setNode(node.id, {..., adapter:
  retry.adapter, model: retry.model })`. Diversion is philosophically the
  same kind of "this node's loadout needs to change" event, just triggered
  pre-claim (ceiling block) instead of post-lease-expiry (worker failure).
- It's required for correctness, satisfying the ask's exception clause
  ("unless needed for retry correctness"). `spawnWorker()` and the
  re-fetched `fresh` row (**line 750**) both read `node.adapter`/`node.model`
  directly from the DB — a transient in-memory override would require
  threading a new parameter through `spawnWorker()`'s signature and would be
  invisible to `retryRouteFor()` if the diverted attempt later fails its
  lease: `retryRouteFor()` reads `node.adapter` to pick `provider` and the
  correct rung of `CROSS_PROVIDER_RETRY_LADDER`. If the stored value still
  said the ORIGINAL (blocked) pool, a lease-expiry retry after a diverted
  attempt would compute the wrong retry ladder.
- Implementation shape: extend `claimStmt` to accept optional
  `adapter`/`model` overrides (or do the restamp via a second `setNode()`
  call issued in the same synchronous pass, before `spawnWorker()` reads the
  row) so the diverted loadout is what `fresh` and `spawnWorker()` actually
  see.
- Audit trail: there is **no dedicated hopper node event/timeline table**
  (unlike Flight Deck's `workstream_events`) — grepped, none exists. The
  existing precedent for recording a reroute decision is (a) a
  `console.log` line matching the retry pattern at **line 700**
  (`console.log(\`[hopper-engine] node ${node.id} ${retry.note}\`)`), and (b)
  `spawnTaskInsert`'s `label` field (**lines 518–521, 541**) — the
  `spawn_tasks` table is explicitly documented as "the ATTEMPT ledger"
  (file header, lines 11–14), so a diversion note belongs in the spawned
  attempt's `label`/`task_prompt`, e.g. prefixing with `[DIVERTED from
  codex→claude: codex ceiling 91%≥90%]`. This mirrors
  `spawnTaskMarkRerouted` (**lines 525–527**) which does the equivalent for
  lease-expiry reroutes, except diversion has no prior `spawn_tasks` row to
  mark (first attempt), so the note goes on the INSERT, not an UPDATE.
- Trade-off accepted: once diverted, the node's original planner-assigned
  pool is not separately remembered anywhere (same as today's retry-reroute
  behavior — an auggie node whose retry escalates to claude stays
  claude-labeled going forward, with no "reset to original" mechanism
  either). Not a new gap; consistent with existing behavior.

## Tier-equivalence map (explicit, for the diversion loadout lookup)

Confirmed live model ids in `agent.ts`/`hopper-engine.ts`:

- Codex standard: `gpt-5.5` (agent.ts:283, hopper-engine.ts:103).
- Codex frontier: `gpt-6-astra` — **not in any static catalog in this repo**;
  it only appears live via `refreshCodexModels()`'s `model/list` RPC
  (agent.ts:279–281 comment) and is documented in JARVIS memory as a real,
  currently-existing tier (the 2026-09-14 misroute incident). Router rubric
  treats any pool's frontier variant as planner-only, never leaf work — so
  in practice `gpt-6-astra` should rarely if ever be a diversion SOURCE for
  ordinary leaf work, but the map still needs an entry for correctness if a
  frontier-routed node is ever diverted.
- Auggie: model ids come from `auggie model list` (its own catalog, e.g.
  `opus4.8`), not `claude-*` ids (hopper-engine.ts:107–112 comment).
  `'default'` is Auggie's/agent.ts's no-op model flag (agent.ts:326,
  343/393 — `if (model && model !== 'default') args.push(...)`).
- Devin: no per-tier model catalog referenced in the retry ladder; existing
  `CROSS_PROVIDER_RETRY_LADDER.devin` just falls back straight to
  `CLAUDE_FALLBACK` (hopper-engine.ts:115).

Recommended `TIER_EQUIVALENCE` table (bidirectional, for use by both
"divert FROM this pool" and "divert TO this pool" lookups):

| Pool / tier            | Claude equivalent      |
| ----------------------- | ----------------------- |
| `codex` standard (`gpt-5.5`) | `claude` / `claude-sonnet-5` |
| `codex` frontier (`gpt-6-astra`) | `claude` / `claude-opus-5` |
| `auggie` standard (`opus4.8`, treated as Auggie's default) | `claude` / `claude-opus-5` |
| `auggie`/`devin` other/default | `claude` / `claude-sonnet-5` |

This matches the ask's explicit map verbatim (codex gpt-5.5↔sonnet-5, codex
gpt-6-astra↔opus-5, auggie opus4.8↔opus-5, auggie/devin standard↔sonnet-5)
and slots in next to the existing `CLAUDE_FALLBACK` constant
(hopper-engine.ts:100: `{ adapter: 'claude', model: 'claude-sonnet-5' }`) —
i.e. `CLAUDE_FALLBACK` is already exactly the "standard" row of this table;
only the opus-5 (frontier) row and the reverse (claude→other-pool) direction
are new. Diversion in the reported incident only needs one direction
(non-claude → claude, since the pool order default is `claude,codex,auggie`
— claude first), but the table should stay bidirectional so a
claude-ceilinged node can also be diverted outward if `gov_diversion_pool_order`
is ever reordered.

## 4. DECISION — raised diversion ceiling without changing the normal-band answer

**Decision: add an optional second parameter to `evaluate()` (and thread it
through a new exported wrapper), never mutate settings-KV or the normal call
path.**

Concretely:

```ts
// hopper-governor.ts
export function governorCheckDiversionTarget(
  adapter: string | null,
  diversionCeiling: number,
): GovernorVerdict {
  return evaluate(providerFor(adapter), { ceilingFloor: diversionCeiling });
}

function evaluate(provider: GovernorProvider, opts?: { ceilingFloor?: number }): GovernorVerdict {
  ...
  // wherever a ceiling constant is read, raise it (never lower it) to the floor:
  const effectiveProviderCeiling = opts?.ceilingFloor != null
    ? Math.max(ceiling, opts.ceilingFloor)
    : ceiling;
  ...
}
```

- `governorCheck(adapter)` and `governorStatus(adapter)` keep their existing
  1-arg signatures/behavior unchanged (opts defaults to `undefined` → zero
  behavioral drift for every existing caller — dispatch's own-pool gate,
  the retry ladder, the API routes). This is what "without changing the
  normal-band answer" requires.
- The floor should apply to **exactly the ceiling-shaped comparisons**,
  each raised independently with `Math.max(normal, floor)` so a pool whose
  normal ceiling is already above the floor is unaffected:
  - Non-claude `provider_ceiling` check (**line 352**: `used >= ceiling`) —
    apply floor to `ceiling`.
  - Claude `five_hour_ceiling` check (**line 428**: `fiveHour >=
    FIVE_HOUR_CEILING`) — apply floor to `FIVE_HOUR_CEILING`.
  - Claude `kevin_active` waiver threshold (**line 445**: `maxActive =
    CONFIG.kevin_active_claude_max_5h`) — apply floor to `maxActive` too,
    **or diverting non-claude work onto claude while Kevin is active would
    immediately re-fail the ordinary waiver check** (the reported scenario's
    preferred target, `claude`, is Kevin-active-gated most of the working
    day — without raising this threshold too, diversion-to-claude would
    silently never fire whenever Kevin is at the keyboard, which is a
    likely-common case, not an edge case).
  - **Do NOT apply the floor to `weekly_ceiling`.** The existing contract
    note (lines 404–405) already treats weekly as "the hard
    overnight/workweek budget and isn't waived by the 5h waiver" — diversion
    raising the 5h/provider ceiling shouldn't also waive the hard weekly
    budget. Diversion candidates still get correctly excluded if weekly is
    maxed.
  - **Do NOT apply the floor to `usage_stale`.** A stale/dead meter is a
    broken-signal problem, not a capacity problem — diverting around a
    meter we can't trust is unsafe, not an unstick.
  - **Do NOT bypass `override_off`.** An explicit `gov_override_<provider>=off`
    is a deliberate Kevin hold; diversion must exclude that pool as a
    candidate outright (check `override !== 'off'` before even attempting
    the floor-raised eval, or just note that `evaluate()`'s override branch
    already runs first and returns `override_off` regardless of any floor —
    confirm the floor param is only consulted AFTER the override branch, so
    this falls out for free from the existing code order at lines 299–321
    vs. 327+).

## 5. Eligible denial reasons for diversion (flagged ambiguity + recommendation)

The ask's literal wording only names two reasons as diversion-eligible:
`provider_ceiling` (non-claude) and, "for claude also," the `kevin_active`
waiver. It does not explicitly mention `five_hour_ceiling`, even though
that's Claude's own literal ceiling reason.

**Recommendation for the decide/build node:** treat the eligible set as
`{provider_ceiling, five_hour_ceiling, kevin_active}` — i.e. read the ask's
parenthetical as clarifying that `kevin_active` counts too (since it isn't
named "ceiling" but functions as one via a threshold comparison), not as
excluding `five_hour_ceiling` (which is uncontroversially a ceiling by
name). Explicitly **excluded** from diversion eligibility: `weekly_ceiling`
(hard budget, see §4), `usage_stale` (broken meter, not a capacity signal),
`override_off` (explicit human hold), `disabled`/`override_on`/`ok` (not
denials). This is a judgment call, not settled fact — flag it to Kevin or
the build node if they want to diverge; it doesn't require a new decision
from Kevin to proceed since it's conservative (a smaller eligible set just
means fewer nodes get diverted, never an unsafe expansion).

## 6. Settings-KV additions needed (mirrors `GOVERNOR_SETTING_SPECS` pattern)

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `gov_diversion_enabled` | enum `true`/`false` (or number 0/1, match existing style) | `true` | Master on/off for the whole diversion path. |
| `gov_diversion_ceiling_5h` | number | `85` | The raised band a diversion CANDIDATE pool may run up to (never applied to the node's own/source pool, never applied to `weekly_ceiling`). |
| `gov_diversion_pool_order` | new type needed (CSV string) — not covered by today's `'number'`/`'enum'` spec union | `claude,codex,auggie` | Preference order tried, in order, excluding the node's own (blocked) pool. |

Add these three keys to `GOVERNOR_SETTING_SPECS` (api-v1.ts:300–312) and to
`docs/hopper/GOVERNOR-V2-CONTRACT.md`'s settings table for consistency with
how `gov_override_*`/`gov_*_ceiling` were documented and shipped.

## 7. Bounding — "one diversion decision per ready node per tick"

Falls out naturally from the existing loop structure: the diversion check
sits inline inside the single `for (const node of readyLeavesStmt.all())`
pass (**line 729**), evaluated once per node per `dispatchTick()` call. No
separate/recursive diversion pass is needed. Cache diversion-candidate
verdicts the same way `verdicts` already caches own-pool verdicts (a second
`Map<string, GovernorVerdict>` keyed by candidate adapter, populated lazily)
so multiple nodes needing the same candidate pool in one tick only pay for
one extra `governorCheckDiversionTarget()` call per candidate, not one per
node.

## Summary for the decide/build node

1. Widen the `verdicts` cache to store full `GovernorVerdict` (not just
   `boolean`) so `.reason` is available when `!allowed`.
2. When `!allowed` and `gov_diversion_enabled` and `reason` is in the
   eligible set (§5): walk `gov_diversion_pool_order` (excluding the node's
   own pool), and for each candidate call
   `governorCheckDiversionTarget(candidateAdapter, gov_diversion_ceiling_5h)`.
   First candidate that returns `allow: true` wins.
3. On a winning candidate: look up the tier-equivalence loadout (§3 table),
   restamp `node.adapter`/`node.model` to that loadout (via `setNode()` or
   an extended `claimStmt`) BEFORE `spawnWorker()` reads the row, log via
   `console.log` + a `[DIVERTED ...]` prefix on the `spawn_tasks` insert
   label (§3), then proceed with the normal claim/dispatch flow.
4. If no candidate clears the diversion band, `continue` exactly as today —
   diversion is a best-effort unstick, not a guarantee.
5. Add the three new settings keys (§6) to `GOVERNOR_SETTING_SPECS` and the
   contract doc.
6. New exported function in `hopper-governor.ts`:
   `governorCheckDiversionTarget(adapter, diversionCeiling)`, implemented via
   an optional `opts.ceilingFloor` param on the internal `evaluate()`, raising
   (never lowering) `provider_ceiling`/`five_hour_ceiling`/`kevin_active`
   comparisons only — `weekly_ceiling`, `usage_stale`, and `override_off`
   are never waived by the floor.
