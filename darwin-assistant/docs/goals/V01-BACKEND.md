# GOALS v0.1 — BACKEND (node #468): Kevin-edit tracking + agreement gate + push_back

Implements CONTRACT §11.1–§11.2 (+ the §11.3 cue seam) — "a ghost solidifies only
when the party who did NOT make the last edit approves it." Additive-only; every v0
route/op/type keeps its exact shape. `tsc` clean.

## `src/goals.ts`

| What | Anchor | Notes |
|---|---|---|
| `ReviewState` type | `src/goals.ts:41` | `'none'\|'awaiting_jarvis'\|'pushed_back'` |
| `GoalNodeDbRow` +4 fields | `src/goals.ts` (interface, ~`last_edited_by`/`kevin_edit_original`/`review_state`/`review_note`) | flow through `GoalNodeRow` (extends) + `deriveSingleNode` (spreads `...n`, SELECT *) |
| `GoalCounts.awaiting_jarvis` | `src/goals.ts:87` | count of ghosts with `review_state='awaiting_jarvis'` |
| §11.1 DDL `ensureGoalNodeColumn` + 4 guarded ALTERs | `src/goals.ts:253`, `:259`–`:262` | PRAGMA table_info guard; migrates live jarvis.db in place on restart |
| `countsStmt` + `computeCounts` gain `awaiting_jarvis` | `src/goals.ts:395` | new `SUM(CASE WHEN review_state='awaiting_jarvis'…)` column |
| `patchGoalNode` §11.2 kevin/jarvis rows | `src/goals.ts:1120` | Kevin edit of a ghost → `last_edited_by='kevin'`, snapshot `kevin_edit_original` once, reset review, event `ghost_edited_by_kevin`; JARVIS edit → `last_edited_by='jarvis'`, review reset, event `node_updated`. Non-ghost/other paths unchanged |
| `setGhostToSet` helper | `src/goals.ts:893` | ghost→set; clears batch + all four review fields (§11.2 "ghost→set clears") |
| `applyAcceptToNode` — the gate | `src/goals.ts:912` | Kevin+`last_edited_by='kevin'` → `awaiting_jarvis` + `kevin_okd_edit` (NOT set); Kevin re-click while awaiting → `409 awaiting_jarvis`; Kevin from `pushed_back` → re-ask (note kept); JARVIS + review≠none → set + `node_agreed`; else v0 |
| `acceptGoalNode` | `src/goals.ts:950` | single; fires ONE cue if it went awaiting |
| `acceptRows` (batch + all) | `src/goals.ts:959` | Kevin skips already-`awaiting_jarvis` rows (no whole-batch 409); returns full rows so UI splits set/awaiting; fires ONE cue for all awaiting |
| `pushBackGhost` (NEW) | `src/goals.ts:1010` | jarvis-only, note required; `awaiting_jarvis`/(`none`+kevin-last) → `pushed_back` + event `jarvis_pushed_back` |
| `fireGoalReviewCue` (NEW, §11.3) | `src/goals.ts:1042` | posts ONE cue into `cockpit:goal-<id>` via the dispatch-gate seam (dynamic `import('./agent.js')` avoids the static cycle); enqueues if in-flight/busy; `goal-cue:<goalId>:<eventId>` correlation key |
| `discardGoalNode` / `discardGoalBatch` clear review fields | `src/goals.ts:1086`, `:1100` | ghost→discarded now also nulls the four fields |

Exports (`export function`): `pushBackGhost`, `fireGoalReviewCue` (in addition to the existing `acceptGoalNode`).

## `src/handlers/api-v1.ts`

| What | Anchor |
|---|---|
| import `pushBackGhost` | `src/handlers/api-v1.ts:92` |
| `POST /goals/:id/nodes/:nodeId/push_back` | `src/handlers/api-v1.ts:2412` (defaults actor to `jarvis`) |

Accept routes are unchanged in shape (`{ node }` / `{ nodes }`) — the rows now carry
`review_state`, so the UI splits `set` vs `awaiting_jarvis` from the response.

## `src/tools/goals-tool.ts`

| What | Anchor |
|---|---|
| import `pushBackGhost` | `src/tools/goals-tool.ts:12` |
| `push_back` in op enum | `:99` |
| `push_back` op handler (jarvis, note required) | `:199` |
| `note` param doc (required for push_back) | `:121` |
| §11 rule sentence in tool description | `:88`–`:91` |
| review fields added to `TRIMMED_NODE_KEYS` (so `list` shows the weigh-in state) | `:64` |

## `docs/goals/CONTRACT.md`
§3.0 `GoalCounts` (+`awaiting_jarvis`) and `GoalNodeRow` (+4 fields) updated; §1.3 closed
list gains the four new event kinds (`ghost_edited_by_kevin`, `kevin_okd_edit`,
`node_agreed`, `jarvis_pushed_back`).

## Out of scope for this node (owned elsewhere)
- §11.3 cue *body*: implemented here fully (compose + post). §11.4 focus-injection markers
  (`✎K`, `AWAITING YOUR TAKE`, `awaiting_you`) and §11.5 cockpit UI are separate nodes.
