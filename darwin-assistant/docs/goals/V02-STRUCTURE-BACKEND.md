# GOALS v0.2 — structure backend (tree-cd2c6735, node #480)

**Contract:** `docs/goals/CONTRACT.md` §13 (identical text appended to `skills/goals/CONTRACT.md` §13 in the wiki; §12 untouched — it belongs to the Guards tree). Branch `hopper/goals-v02`, worktree `/home/kevin/paperclip-worktrees/goals-v02/darwin-assistant`. Additive on v0 / v0.1: every existing route, op, type and event keeps its shape. Sim: `npm run goals:sim` → **90/90** (80 v0/v0.1 + 10 `V02-*`).

**What it does in one breath:** Kevin adds a row / edits a set row / drags a row under a new parent → the tree changes **immediately** and the node is flagged `review_state='awaiting_jarvis'` (`last_edited_by='kevin'`, plus `kevin_moved_at`/`kevin_move_from` for a move) → ONE debounced (20 s per goal) cue lands in the goal chat → JARVIS `accept` (flag clears, node stays set) or `push_back` (flag becomes `pushed_back`; the node is **never** un-set). JARVIS moves its own ghosts directly; moving a set node is a **pending move** (`pending_parent_id`) Kevin ✓s via `resolve_pending`.

## `src/goals.ts`

| What | Where | Notes |
|---|---|---|
| `GoalNodeDbRow` gains `kevin_moved_at`, `kevin_move_from`, `pending_parent_id` | L124–126 | returned on every read (derived `GoalNodeRow` extends it) |
| Guarded `ALTER TABLE` for the three columns | L268–270 (`ensureGoalNodeColumn`, same PRAGMA-guarded helper as v0.1) | live jarvis.db migrates in place on restart |
| `maybeSettleParent` → thin wrapper over new `settleParentIfComplete(parentId)` | L555 / L563 | §2.4(1) keyed by parent id so a move can settle the **old** parent |
| `createGoalNode`: `actor='kevin' && authored_by='kevin'` → `flagKevinStructureChange(…,'added')` | L863 | tool `set_from_kevin` (actor jarvis) is NOT flagged |
| `setGhostToSet` also clears `kevin_moved_at/kevin_move_from` | L914 | ghost Kevin moved → JARVIS accept → set + clean |
| `applyAcceptToNode`: non-ghost + `review_state ∈ {awaiting_jarvis, pushed_back}` + actor≠kevin → `clearReviewRound` + `node_agreed`, **state unchanged** | L934–945 | Kevin actor / no open round → unchanged v0 `409 invalid_transition` |
| `pushBackGhost` accepts non-ghost nodes (terminal → 409); same `allowed` rule | L1047 | §13.4 — pushing back on a set node is a conversation flag only |
| `discardGoalNode` / `discardGoalBatch` clear `kevin_moved_*` | L1144 / L1159 | |
| `patchGoalNode`: `setEdit` (set node, text changed, actor kevin) → `awaiting_jarvis`, `last_edited_by='kevin'`, snapshot `kevin_edit_original` if NULL, `review_note=NULL`; schedules digest kind `edited` | L1218 (flag), L1256 (schedule) | no-op / `sort_order`-only PATCH still not an edit (v0.1 rule) |
| `proposeRemoval` clears `pending_parent_id` | L1289 | removal supersedes a pending move |
| `resolvePending` rewritten: `hasMove` (`pending_parent_id != null`, −1 = root); re-validates the move **before** any write; accept applies edit (if any) **and** performs the move via `applyMove(actor kevin)` with **no** review flag, then `clearReviewRound`; reject clears `pending_parent_id`; events `move_accepted` / `move_rejected` alongside the edit/removal ones | L1305–1360 | |
| `clearReviewRound(nodeId)` | L1372 | state untouched |
| `collectDescendantIds(goalId, nodeId)` | L1382 | for SSE fan-out |
| `validateMoveTarget(goalId, node, newParentId)` — terminal → `409 invalid_transition`; parent via `validateParentForNewChild` (`400 parent_goal_mismatch` / `409 parent_not_set` / `409 goal_not_set`); self or descendant → `409 move_cycle` | L1403 | shared by move / propose_move / resolve_pending |
| `applyMove(goalId, node, newParentId, sortOrder, actor)` — the re-parent: no-op when nothing changes; `resetParentLeafIfNeeded(newParent)` on parent change; `node_moved` event `{old_parent_id,new_parent_id,old_sort_order,new_sort_order,actor}`; `settleParentIfComplete(oldParent)`; `goal_node` SSE for the node **and every descendant**; `goal_focus` re-emit (no `focus_set` event) if focus is inside the moved subtree | L1423–1468 | no review flag here — callers decide |
| **`moveGoalNode`** (route 31) — jarvis on non-ghost → `403 jarvis_must_propose`; kevin → `applyMove` + `flagKevinStructureChange('moved', oldParent ?? -1, newParent)` | L1470 | exported (sim hook) |
| **`proposeMove`** (route 32) — `working` → `409 leaf_already_dispatched`; state ∉ {set,planned,check,parked} → `409 invalid_transition`; same parent → `409 nothing_to_move`; validates target; sets `pending_parent_id` (−1 = root), `pending_removal=0`, `pending_by='jarvis'`; event `move_proposed` | L1486 | coexists with a pending text edit |
| `StructureChangeKind` / `StructureChangeEntry` types, `structureBursts` map, `STRUCTURE_DEBOUNCE_MS` (env `GOALS_STRUCTURE_DEBOUNCE_MS`, default 20000) | L1512–1529 | burst is process memory (documented in §13.5) |
| `flagKevinStructureChange(goalId, nodeId, kind, from, to)` — writes the flag (+ `kevin_moved_at/from` for `moved`), emits `goal_node`, schedules the digest | L1533 | |
| `scheduleStructureDigest(goalId, entry)` — per-goal timer reset on every change; latest entry per node wins; `unref()` | L1550 | |
| `parentLabel(goal, parentId)` | L1562 | `"<goal> (root)"` or the `pathForNode` chain joined by ` › ` |
| **`fireGoalStructureCue(goalId)`** — drops nodes no longer awaiting; writes ONE `kevin_restructured` event (data.entries) + emits `goal`; posts ONE cue via the §11.3 seam (`processMessage` / `enqueueMessage`, correlation `goal-structure:<goalId>:<lastEventId>`); text per §13.5 | L1572–1640 | exported (explicit flush / tests) |
| `hasPendingStructureDigest(goalId)` | L1642 | test/ops helper |
| `verifyGoalNode` passed → also clears review round + `kevin_moved_*` | L1666 | terminal |
| `nodeMarker` → wrapper adding ` ↕K` (moved, awaiting) / ` ✎K` (non-ghost added/edited, awaiting) over `baseMarker`; `baseMarker` renders `set ✎pending ↕pending` combos | L2121 / L2131 | §13.7 |
| `reviewLineSuffix`: `(was: "…")` → `(moved from: "<old parent title \| root>")` → `(Kevin added this)` | L2157 | |
| `pendingLabel`: adds `move` / `edit+move` | L2178 | `<goal_focus pending="…">` |

New `goal_events.kind`s: `node_moved` · `move_proposed` · `move_accepted` · `move_rejected` · `kevin_restructured` (added to §1.3 in both CONTRACT copies).

## `src/handlers/api-v1.ts`

| What | Where |
|---|---|
| import `moveGoalNode`, `proposeMove` | L101–102 |
| **Route 31** `POST /goals/:id/nodes/:nodeId/move` `{ parent_id (required: number\|null), sort_order?, actor? }` → `{ node }`; `400 invalid_request` when `parent_id` missing | L2477 |
| **Route 32** `POST /goals/:id/nodes/:nodeId/propose_move` `{ parent_id, actor? (default jarvis) }` → `{ node }` | L2499 |

Route 19 `resolve_pending` needs no handler change (the store function grew). Errors flow through the existing `sendCaughtGoalError`.

## `src/tools/goals-tool.ts`

| What | Where |
|---|---|
| import `moveGoalNode`, `proposeMove` | L18–19 |
| `TRIMMED_NODE_KEYS` + `kevin_moved_at`, `kevin_move_from`, `pending_parent_id` | L69 |
| Tool description: one added sentence (Kevin's structure changes are real + flagged; `accept` / `push_back` on your next turn; `move` on a set node = pending move, own ghosts move directly) | L95–98 |
| `operation` enum + `move`; `parent_id` description mentions move | L107, L114 |
| `move` op: ghost → `moveGoalNode(actor jarvis)` → `{ node, moved:true }`; non-ghost → `proposeMove` → `{ node, proposed:true }` | L266–279 |

The persona-MCP server (`mcp__jarvis__goals`) exposes the new op automatically — it reads the same `ToolDef`.

## `scripts/goals-sim.ts`

- L49: `GOALS_STRUCTURE_DEBOUNCE_MS` defaults to `60` for the run (set before `dist/` is imported — the constant is read at module load).
- L1086–1400: section `[16]`, checks `V02-0…V02-9` = CONTRACT §13.9 items 1–9 (a fresh SSE capture is opened for the section because the earlier streams are closed after `[14]`). `GOALS_SIM_VERBOSE=1` prints the composed digest cue.
- The existing `scripts/goals-v01-cue-check.hooks.mjs` stub already intercepts `dist/goals.js`'s dynamic `import('./agent.js')`, so `fireGoalStructureCue` "sends" for real with zero model calls.

## Not in this node (by design)

- Cockpit UI (`hopper/goals-ui-v02`): add-row / Tab-indent / drag re-parent / set-row chips / pending-move diff line — §13.8 is the spec for it.
- `skills/goals/SKILL.md` persona wording for the structure round → the DOCS node.
- No `sse-bus.ts` / `agent.ts` changes were needed (existing `goal`/`goal_node`/`goal_focus` events + the §6 injection seam carry everything).

## Deploy notes for JARVIS

- Three guarded `ADD COLUMN`s run at module load — the live DB migrates on the first restart, no script.
- `GOALS_STRUCTURE_DEBOUNCE_MS` is optional (default 20 s); nothing to add to `.env`.
- Rollback = revert the branch merge; the added columns are inert for v0.1 code.
