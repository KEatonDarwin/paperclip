# Goals Autopilot v0.4 — adversarial review (tree-a2a9e6b2, node #541)

**Branches reviewed:** `hopper/goals-autopilot` (darwin-assistant, base `bf07e8c70`, build commits `2412ef308` + `ccc4493e8`) and `hopper/goals-ui-autopilot` (jarvis-command-center, base `c78ae04`, build commit `9561a8f`).
**Against:** `skills/goals/CONTRACT.md` §15 + `skills/goals/AUTOPILOT.md`.
**Verdict: PASS-with-fixes** — two real driver defects fixed on-branch (one made `parallel>1` inert, one was an unbounded unblock loop), two UI gaps fixed, nothing blocking.

## What was run

| Check | Result |
|---|---|
| `tsc` (darwin-assistant) | clean |
| `goals:autopilot-sim` (AP-1…AP-14 + review AP-7b/AP-15) | **51/51** (48 before the review; AP-7b rewritten, AP-15a–c added) |
| `goals:autopilot-check` | 57/57 |
| `goals:sim` (v0–v0.3 regression) | 136/136 |
| `goals:review-checks` | 14/14 |
| `goals:guards-check` | 23/23 |
| `tree-cue:check` | pass |
| `persona-mcp:review-checks` / `persona-mcp:sim` | 4/4 / 11/11 |
| Live-DB copy boot (`cp jarvis.db /tmp/ap-review.db`, `GOALS_AUTOPILOT_DRIVER=0`) | additive columns land on `goals` + `goal_nodes`; all 3 existing goals read; `autopilot=0` renders **no** autopilot attrs in the snapshot (byte-identical v0.3); report route → `404 no_autopilot_run`; nothing written to the vault |
| Night report over every sim goal (parked / human / blocked / zero-log / never-on) | renders, no throw |
| cockpit `tsc` | only pre-existing errors in untouched files (`routes/index.tsx`, `intel-desk`, `notifications`, `dash.*`, `settings-nav`) |
| cockpit `eslint` on the autopilot files | clean (remaining prettier errors in `GoalTreePanel.tsx` / `cockpit-api.ts` / `markdown-text.tsx` pre-date this branch) |
| cockpit `bun run build` (not the deploy script) | clean |

## Hunt list (from the node spec) — findings

| # | Hunt | Finding | Severity | Status |
|---|---|---|---|---|
| a | driver model calls / double-cue while a turn is in flight or queued | Driver makes zero model calls (only `postCue`). Gate 4 checks in-flight + queued-prefix on BOTH the goal chat and the node-chat target; `activeRuns.set` happens synchronously inside `processMessage`, and the kick coalesce is ≥1 s, so the post→in-flight window is microtasks. Same-key re-cue is time-gated; a different key still waits on gate 4. The driver's own writes kick it (via `touchGoal`) but the re-tick is idempotent. | — | OK |
| b | auto-close leaking into non-autopilot goals | Every auto-close is gated on `autopilotConfigFor(goalId)` (null when `autopilot=0`) and `actor !== 'kevin'`. AP-14a proves a post-off `propose` is a ghost + `node_proposed`; AP-1/AP-14 prove `propose_plan` off-autopilot stays `proposed` with no tree/VERIFY. Live-DB copy: three real goals render byte-identical snapshots. | — | OK |
| c | VERIFY node able to fix / parser trusting a build node | Verdict is read ONLY from `plan.verify_hopper_node_id` (recorded from `created.nodes[verify_index]` at plant); a non-`done` VERIFY (split/blocked/missing) or a missing `VERDICT:` line is FAIL; PASS+gaps is downgraded. The template forbids fixes; a verifier that patches anyway cannot change the verdict path. | — | OK |
| d | FAIL loop that never parks | P1 increments `autopilot_attempts` on every FAIL and parks at `max_attempts` (AP-5); `runnable()` also requires `attempts < max`; "cue ignored twice" parks (AP-12e). **Found: the `unblock` path was unbounded** — a tree JARVIS re-pends that blocks again changes the node signature each cycle, so the ignored-twice guard never trips and each cycle costs a JARVIS turn + a worker attempt, all night. | **medium** | **FIXED** — `countUnblockCues()` caps `unblock` cues per node per run at `max_attempts`; the next re-block parks with `tree <id> blocked <n> times — unblock cues exhausted (<max>)`. AP-15a–c. CONTRACT §15.4 updated. |
| e | DFS runnable off-by-one | `earlierOf()` = preceding siblings + `earlier(parent)` recursively; AP-7a/AP-8/AP-9 hold. **Found: `parallel>1` was inert** — `working` was not "settled" for ordering, so once anything was working nothing later in DFS order could ever become runnable (the sim's own note flagged this; CONTRACT §15.12 AP-7's `parallel:2` example was unreachable). | **medium** | **FIXED** — `isSettled` counts `state='working'` for ORDERING; row 3's `parallel` cap alone limits concurrency. `parallel=1` is byte-identical (row 3 fires before the walk). AP-7b rewritten to assert the contract example both ways. CONTRACT §15.4 `settled(n)` updated. |
| f | gates missing on any path (incl. tree-status kick) | All entry points (`loop`, `kick` from `touchGoal`/route 37/tree-status listener, `tickAutopilot`) go through `tickGoal` → pre-pass → gates 1–4. Governor uses `governorCheck('claude')` on real ticks and side-effect-free `governorStatus` on previews. AP-10/11/12. | — | OK |
| g | report builder on parked/human/promoted/zero-event goals | Rendered every sim goal + the three live goals; `_none_` fallbacks present per section; never-on → 404, not a crash. | — | OK |
| h | additive-DDL regressions on a live `jarvis.db` copy | `ensureGoalColumn` / `ensureGoalNodeColumn` PRAGMA-guarded; verified on a 942 MB copy of the live DB — six columns added, existing goals/nodes/snapshots unaffected. | — | OK |
| i | UI toggle races / stale pill / markdown XSS | `saving` flag guards double-submits; pill is SSE-fed + 20 s poll + immediate re-poll on `autopilot_next` change. `MarkdownText` has no raw-HTML pass (verified: `<img onerror>` in a result renders escaped) → no XSS. **Found:** (1) the ON pill stopped autopilot on a bare click (contract: "click = confirm"); (2) the report's `<details>` block rendered as literal tags in the drawer and the contract's "Open in vault" link was missing. | low | **FIXED** (cockpit `ba71c9d`): `window.confirm` before `{on:false}`; drawer rewrites the details block to markdown + "Open in vault" button (`openVaultFile` exported). |
| j | tsc/eslint/build | see table above | — | OK |

## Open (not fixed, documented)

1. **Verdict chip = tooltip, not row expansion.** §15.11 says clicking the chip expands the row with evidence + gaps; the build shows them in the chip's `title`. Cosmetic; the v0.1 row click still shows the node detail.
2. **Driver hold log + plant-failure counter are in-memory.** A `jarvis.service` restart forgets gate-hold durations (report's "Where it stopped" loses holds ≥10 min from before the restart) and resets the P0 plant-retry count (so a persistently failing plant may be retried twice more per restart). The durable trail (`goal_events`) is intact either way.
3. **Archiving a goal with `autopilot=1`** leaves the flag on (the driver's query excludes archived goals so nothing runs, but the card would still show the pill if un-archived). Suggest flipping off with `stop_reason:'kevin'` on archive in a follow-up.
4. **A `set`+`none` parent whose children are all human/parked never settles**, so its later siblings never run and the night ends `stuck`. This is by design (it genuinely needs Kevin) and the report lists it — noting it so nobody reads "stuck" as a driver bug.

## Files changed by this review

- `src/goals-autopilot.ts` — `isSettled` counts `working`; `countUnblockCues()` + the unblock cap in `tickGoal`.
- `scripts/goals-autopilot-sim.ts` — AP-7b rewritten to the contract semantics; AP-15a–c added; sim-report note updated.
- `docs/goals/AUTOPILOT-REVIEW.md` — this file.
- wiki `skills/goals/CONTRACT.md` §15.4 — `settled(n)` includes `working` (ordering only); unblock cap documented.
- cockpit `src/components/goals/AutopilotPanel.tsx`, `NightReportDrawer.tsx`, `markdown-text.tsx` (`openVaultFile` export).
