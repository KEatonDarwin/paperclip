# SIM-RESULTS — governor cross-pool diversion (node #301, tree-6ecf478c)

Dry-runs the 5 acceptance scenarios from the node #301 spec against the real
compiled `hopper-governor.ts`/`hopper-engine.ts` diversion code (nodes #299 +
#300), on a scratch SQLite DB + scratch usage-meter JSON files, with
**no restart of jarvis.service** and no writes to the live DB.

## Method

Extended the existing permanent regression script
`darwin-assistant/scripts/governor-v2-sim.mjs` (already the canonical
scratch-DB harness for the whole governor-v2 + diversion feature set — it
already carried checks `10a`–`10e` covering the diversion *mechanism* from
nodes #299/#300) with 4 new checks, `11a`–`11d`, that reproduce the 5 scenarios
from this node's spec verbatim:

1. `npm run build` (`tsc`, 0 errors).
2. `npm run governor-v2:sim` — sets `JARVIS_DB_PATH=/tmp/governor-v2-sim.db`
   (guarded: the script refuses to run if pointed at the live `jarvis.db`),
   imports the compiled `dist/hopper-engine.js` / `dist/hopper-governor.js` /
   `dist/conversation-db.js` directly (no HTTP layer), and drives
   `dispatchTick()` against scratch usage files
   (`CLAUDE_USAGE_FILE`/`CODEX_USAGE_FILE`/`AUGGIE_USAGE_FILE` in a
   `mkdtemp` scratch dir) it fully controls. `startHopperEngine()` is booted
   with a fake `processMessage` that just records what would have been
   dispatched — no real worker process, no cockpit thread, no network call
   ever leaves the script. Kevin-active state is simulated by inserting a
   `turns` row into the scratch DB via the real `getOrCreateConversation`/
   `addTurn` helpers (exercises the actual `kevinActive()` SQL probe, not a
   stub). Governor settings are set via the real `setSetting()` writer
   (settings-KV), so the exact uncached read path the live governor uses is
   what's under test.
3. Each scenario: `resetHopperState()` (wipe hopper/spawn/turns tables) →
   `setUsage(...)` (write the scratch usage JSON) → `setGovernorSettings(...)`
   (write the diversion + ceiling knobs) → `createActiveTree(...)` (plant +
   agree a one-node tree, which triggers a real `dispatchTick`) → assert on
   the resulting node row + governor verdicts + the `spawn_tasks` label.

No live system was touched: scratch DB path (`/tmp/governor-v2-sim.db`),
scratch usage files (`mkdtemp` under `/tmp`), no `systemctl` call, no edit to
`/home/kevin/paperclip`. This worktree (`/home/kevin/paperclip-worktrees/gov-diversion`)
required its own `npm install` (darwin-assistant is a standalone npm package,
not part of the repo's pnpm workspace, and the ambient npm config on this box
has `omit=dev` — `npm install --include=dev` was needed to pull in
`typescript`/`@types/*`/`tsx`; noted here in case a future worker in this
worktree hits the same "`tsc`: command not found" surprise).

## Scenario → check mapping

| Spec requirement | Check(s) | Result |
|---|---|---|
| 1. Primary pool codex 91% + claude 61% (under 85 band) → diverts to claude/sonnet-5, dispatches | `11a` (also generically `10a`, `10b`) | PASS |
| 2. Reproduce the ACTUAL case: codex/gpt-5.5 ready node, codex over ceiling → diverts to claude-sonnet-5 | `11a` (same scenario, explicit "actual case" framing + label-format assertion) | PASS |
| 3. All candidate pools over the diversion band → node holds (no dispatch) | `11b` | PASS |
| 4. Normal ready node whose own pool has headroom → claimed normally, NO diversion (throughput not inflated) | `11c` | PASS |
| 5. `gov_diversion_enabled=false` → behaves exactly like today | `10e` (pre-existing, different provider) + `11d` (paired with the 11a "actual case" numbers, proving the switch — not just band math — is what held it) | PASS |

`11d` is the sharpest proof of requirement 5: it reuses the **exact same
usage numbers as `11a`** (codex 91%, claude 61%) but with
`gov_diversion_enabled=false`. A target (claude) would clear if diversion were
on, yet the node holds pending with its original `codex/gpt-5.5` loadout
untouched — so the flag is a genuine kill-switch on the whole diversion path,
not something that only happens to matter when no target would clear anyway.

## Real output (final run)

```
$ npm run build && npm run governor-v2:sim
...
[hopper-governor] codex: HOLD (provider_ceiling) — codex usage 91% ≥ 90%
[hopper-engine] node 18 diverted (provider_ceiling): codex/gpt-5.5 -> claude/claude-sonnet-5 @ diversion band 85%
[hopper-engine] dispatch node 18 (sim:gov-diversion: n266 reproduction) → cockpit:hopper-node-18-438e2878
[hopper-governor] codex: OPEN (ok) — codex usage 20% (ceiling 90%), clear to dispatch — Claude ceilings do not apply
[hopper-engine] dispatch node 20 (sim:gov-diversion: healthy pool no-op) → cockpit:hopper-node-20-41e830b8
[hopper-governor] codex: HOLD (provider_ceiling) — codex usage 91% ≥ 90%
PASS 1 - Auggie claims block above gov_auggie_ceiling while Codex and Claude continue
PASS 2a - Claude dispatches while Kevin is active when 5h=20 < threshold 50
PASS 2b - Claude holds while Kevin is active when 5h=60 >= threshold 50
PASS 3a - weekly>=30 in soft mode emits a budget notification and continues
PASS 3b - weekly>=30 in hard mode holds Claude dispatch
PASS 4 - cross-provider retry ladder picks Claude when Auggie is held
PASS 5a - chain-tree planting produces zero parent_ids while preserving depends_on DAG links
PASS 5b - agreeHopperTree sanitizer nulls a poisoned initial parent_id
PASS 6 - finish-POST recovery completes a running node whose idle worker committed work
PASS 7 - stale-attempt ledger row cannot finish a re-leased node (attempt pin)
PASS 10a - Auggie node over ceiling diverts to Claude (frontier→opus-5), loadout restamped + labeled
PASS 10b - Codex node diverts to Claude under the raised band even while Kevin is active
PASS 10c - A weekly_ceiling denial is NOT divertible — node holds even with clear pools
PASS 10d - override_off pool is refused as a diversion target — node holds
PASS 10e - gov_diversion_enabled=false ⇒ blocked node holds (no diversion)
PASS 11a - THE ACTUAL CASE — codex 91% + claude 61% (no kevin_active) diverts to claude-sonnet-5 and dispatches
PASS 11b - all candidate pools over the diversion band ⇒ node holds (no dispatch)
PASS 11c - own-pool-has-headroom node dispatches normally with NO diversion (loadout + label untouched)
PASS 11d - gov_diversion_enabled=false ⇒ the actual-case node holds exactly like pre-diversion today, even though a target (claude 61%) would have cleared
[governor-v2-sim] 19/19 checks passed
```

19/19 checks pass (10 pre-existing governor-v2 checks + 5 pre-existing
diversion-mechanism checks `10a`–`10e` + 4 new acceptance checks `11a`–`11d`
added by this node). Also re-verified `10a`–`10e` still pass unchanged
alongside the new checks — no regression from the additions.

## Bugs found

None. The diversion implementation from nodes #299/#300 (raised-ceiling
governor probe + per-tick tier-equivalent restamping in `dispatchTick`)
already satisfies all 5 acceptance scenarios exactly as specified; this node
added coverage (`11a`–`11d`) rather than fixing anything.

## How to re-run

```
cd darwin-assistant
npm install --include=dev   # only needed once per fresh worktree checkout
npm run build
npm run governor-v2:sim
```

## Addendum — adversarial review (node #302, 2026-09-16)

Two review fixes landed on the branch (see `REVIEW.md`): (A) diverted loadout is restamped only
after a successful claim, and (B) codex has no leaf-eligible frontier diversion target
(`gpt-6-astra` is never a diversion sink; devin excluded as unmetered). Harness extended with
checks 12a/12b; full run now **21/21**.
