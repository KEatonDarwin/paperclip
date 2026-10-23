# GOALS v0.3 — Node chats: backend (tree-af592404, node #489)

**Branch:** `hopper/goals-v03` (darwin-assistant), worktree `/home/kevin/paperclip-worktrees/goals-v03/darwin-assistant`, off live HEAD `99198ec3e` (already carries v0.1 §11, v0.2 §13 structure, guards §12).
**Contract:** `docs/goals/CONTRACT.md` **§14** (identical text appended to the wiki copy `skills/goals/CONTRACT.md`; §3.0 types gained `thread_ext` / `node_chats`). SKILL.md gained a "Node chats" section (the seed text points at it).
**Sim:** `npm run goals:sim` → **135/135** (121 prior + 14 new `V03-*`). `goals:review-checks` 14/14 (R7a's regex predated v0.2's ` ✎K` marker — fixed), `goals:guards-check` 23/23, `tree-cue:check` green.
**Not touched:** the live checkout, jarvis.service, the live jarvis.db, the cockpit (UI lane = `hopper/goals-ui-v03`).

## What a node chat is

The same goal machinery with the **focus pinned to one node**. Thread `cockpit:goal-<g>-node-<n>`, recorded on `goal_nodes.thread_ext`, find-or-create, opened only by an explicit Kevin action (route 36 from the UI, or the tool op when he asked in words). **Not a promotion** — the node stays in the same goal and the same server-owned tree; both chats read the same rows every turn. The node chat can only shape inside its subtree; anything above it is "say so — it happens in the goal chat". Cues route to the nearest chat, never both.

## What changed (all additive)

| Area | File | Change |
|---|---|---|
| DDL | `src/goals.ts` | `goal_nodes.thread_ext TEXT NULL` via the guarded `ensureGoalNodeColumn` + partial unique index `idx_goal_nodes_thread_ext`. |
| Types / counts | `src/goals.ts` | `GoalNodeDbRow.thread_ext`; `GoalCounts.node_chats` (non-discarded nodes with a chat). `need_you` unchanged. |
| Scope resolver | `src/goals.ts` | `resolveGoalScope(ext)` → `{goal_id, pinned_node_id}`; the NODE id is authoritative (a thread follows its node through a promotion; the `<g>` in the ext is a hint). `isNodeInSubtree(root, node)`. |
| Route 36 | `src/goals.ts` `getOrCreateNodeThread` + `src/handlers/api-v1.ts` | `GET|POST /goals/:id/nodes/:nodeId/thread` → `{ external_id, created, seed_text, node }`, same 2-step as route 8 (caller posts `seed_text` when `created=true`). Sets `thread_ext`, labels the conversation `💬 #<n> <title> · 🎯 <goal>`, event `node_thread_opened` (first time), `goal_node` updated + `goal` (counts). 409 `node_discarded` / `already_promoted`, 404 `node_not_found`. |
| Seed | `src/goals.ts` `composeNodeChatSeed` | §14.2 shape: goal + path + node + done_means + subtree counts + the 7 rules (1 = pinned scope, 7 = cues land here). |
| Labels | `src/goals.ts` | node title PATCH (route 16) and goal title PATCH (route 4) re-label node-chat conversations. |
| Cue routing | `src/goals.ts` `cueTargetForNode(goalId, nodeId)` / `cueTargetForTree(treeId)` | nearest ancestor-or-self with a live node chat, else the goal chat. Used by: `fireGoalReviewCue` (§11.3) and `fireGoalStructureCue` (§13.5) — both now **group nodes by target and post ONE cue per chat** (one `kevin_restructured` event per burst, `data.targets`); `fireGuardCue` in `src/goals-guards.ts` (§12.6, root guards → goal chat); `src/tree-cue.ts` — `cueTargetForTree(treeId) ?? tree.origin_thread_ext` (null for every non-goal tree, so nothing changes outside Goals; dedupe / kill switch / foundry rules untouched). A shared `postCue()` seam replaced the three copy-pasted processMessage/enqueue blocks in goals.ts. |
| Injection | `src/goals.ts` `buildGoalThreadContext` | **Node chat:** `<goal_focus … pinned="n"/>` (effective focus = the goal's focus row when inside the subtree, else `n`), `<goal_tree … pinned="n">`, goal root line, `↑ <path>   (above this chat — …)`, the pinned node at depth 0 (always expanded one layer) + subtree only. A promoted-stub pin renders one line pointing at the new goal's chat. **Goal chat:** ` 💬` on chatted node lines + `<node_chats goal_id count>` block, one line per chat with the latest assistant line (≤160 chars, `tool_name IS NULL`) and age. `agent.ts` needed no change — it already calls `buildGoalThreadContext(conv.external_id)` for every thread and the resolver now recognises node-chat ids. |
| Tool | `src/tools/goals-tool.ts` | `implicitGoalId` now goes through `resolveGoalScope`; inside a node chat every op that names a node/parent/batch/guard outside the pinned subtree returns `{ error, code:'outside_pinned_scope' }` with the plain "say so — it happens in the goal chat" message; implicit parent = focus-if-inside-branch else the pinned node (walk-up never climbs above the pin; a ghost pin → `parent_not_set` with a plain hint); `accept all:true` = every ghost in the subtree, grouped by batch so the review cue fires once per batch; `focus null` clamps to the pin; goal-level ops (`set_goal_done_means`, `verify {goal:true}`, goal park/unpark, promote/move of the pin itself, root guards) refused; `log` defaults to the pin; a node chat whose node is gone → `pinned_node_gone`. New op **`open_node_chat {node_id}`** (route 36 + tool-side seed post, like `promote`); `list` trims include `thread_ext`; description gained the node-chat sentence. |
| Sim | `scripts/goals-sim.ts` + hooks | Section [17] `V03-0…V03-8` (open twice = same thread; preconditions; scope 403s incl. goal-level ops; focus clamp + one pointer; both injection shapes incl. `(no replies yet)` → clipped latest line; cue routing for review / structure burst split across two chats / guard node vs root / tree-done via the real finish contract; `open_node_chat` op + counts with a discarded chatted ghost; labels follow renames). Two new loader hooks (`goals-tree-cue-sim.hooks.mjs`, `goals-tool-sim-seed.hooks.mjs`) stub the `import('./agent.js')` in `dist/tree-cue.js` and `dist/tools/goals-tool.js` so the tree cue and the tool's seed post are observed without a real model call. `dist/tree-cue.js` is imported lazily inside [17] so earlier sections' tree completions don't add cue calls. |

## Decisions made while building (additive, per the contract preamble)

1. **Scope lives in the tool layer, not the HTTP routes.** The cockpit is Kevin's hand and a node-chat window's tree pane still shows the whole goal; the discipline is JARVIS's. §14.3 says so explicitly.
2. **`accept all` in a node chat groups by batch** so it still fires ONE review cue per batch (the §11.2 "one cue per request" rule) rather than one per node.
3. **Structure bursts spanning both chats produce two cues with the same correlation key** and a single `kevin_restructured` event (`data.targets` lists both). The goal chat's cue never mentions the node chat's nodes and vice-versa.
4. **A node chat may open a chat for a descendant** (nesting) but never for its own pin (that IS the chat) or anything above/beside it.
5. **Label re-apply on rename** (node title / goal title) — cheap, and the §14.1 naming rule says the label carries both.
6. **`goals-review-checks` R7a** was failing on HEAD before this work (its regex predates v0.2's ` ✎K` marker on Kevin-created rows); the regex now tolerates the marker/suffix. No behaviour change.

## For the UI lane (`hopper/goals-ui-v03`) — §14.8 in one breath

`openGoalNodeThread(goalId, nodeId)` → `POST /goals/:id/nodes/:nodeId/thread` → when `created` post `seed_text` via `sendThreadMessage` → switch the left pane to `external_id`. Row chip `💬` when `node.thread_ext` (click = switch pane; `⧉` = `window.open('/thread/<ext>')`); `↑ back to goal chat` in the node-chat header; goal card `💬 N` from `counts.node_chats`; `goal_node` SSE carries `thread_ext`. Focus stays one pointer per goal.

## For JARVIS (deploy)

Merge `hopper/goals-v03` into the live checkout after review; `npm run build`; restart via the systemd transient unit (never nohup from inside a turn); verify `GET /api/v1/goals/1` returns `counts.node_chats` and every node has `thread_ext`. The column migrates in place on restart (guarded ALTER). Rollback = revert the merge commit.
