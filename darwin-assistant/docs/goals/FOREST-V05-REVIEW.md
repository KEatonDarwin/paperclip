# Goals v0.5 — Forest dashboard: adversarial review (node #602, tree-883ebd6f)

**Verdict: PASS with fixes (applied on-branch).**
Branches reviewed: `hopper/goals-v05` (backend, commits `f9d5e0e29` + `fb904d14b`) and
`hopper/goals-ui-v05` (cockpit, commit `cb4ad8d`). Six defects found, six fixed here;
none blocking. Deploy-ready.

Kevin's ask: *"the /goals page design is laughable, improve it"* — recency sort,
per-goal context, expandable subtrees, general visual overhaul.

---

## 1. Payload regression hunt (the spec's #1 concern) — CLEAN

`last_activity` and `hot_nodes` are optional and written **only** inside `listGoals()`,
after `toGoalSummary()` has already produced the row. Verified by reading every consumer:

| Consumer | Path | Result |
|---|---|---|
| Goal-thread persona flow (focus injection, `goals` tool snapshot) | `toGoalSummary` / `getGoalTree` | untouched — never calls `listGoals()` |
| Autopilot driver | `src/goals-autopilot.ts` | `grep listGoals\|last_activity\|hot_nodes` → **0 hits** |
| Hand-run heartbeat | `scripts/goals-autopilot-heartbeat.py` | **0 hits** |
| `/goals/$goalId` page | `getGoal()` → `getGoalTree` → `toGoalSummary` | fields simply `undefined`; the one UI reader (`GoalCard`) already falls back `last_activity ?? last_event_at ?? updated_at` |
| SSE `goal` emits | `toGoalSummary` | byte-identical |
| `/big-board` | `big-board.ts:539` `listGoals()` | additive; payload grows by ≤3 nodes/goal (see §2 for cost) |
| `goals` tool `list` op | `goals-tool.ts:291` | additive; ≤3 short titles per goal added to the model-visible result |

The sim's additive-shape guard (V05-6) asserts every pre-v0.5 `GoalSummary` field is still
present with its original type. **The additive claim holds.**

One behavioural note worth stating plainly rather than "fixing": the forest page's SSE
handler is `onGoal: () => reload()` — a full `listGoals()` refetch, not a client-side patch
of the cached row. That is *why* there is no partial-payload hazard here: the enriched
fields are never absent on a card. It also means they can't go stale.

## 2. Query cost — CLEAN (fixed statement count, measured)

The enrichment is 3 prepared statements for the **whole list**, not per goal — no N+1.
Measured on the live `jarvis.db` (1.0 GB, 5 goals / 47 goal_nodes / 1,902 conversations),
read-only:

```
goal-thread activity join      0.000s (5 rows)
node-chat MAX join             0.000s (1 row)
hot-node candidate scan+sort   0.000s (7 rows)
```

Both joins land on `conversations.external_id` (`UNIQUE`, indexed). The hot-node statement
is a filtered scan + sort of `goal_nodes`, which is bounded by the tree size Kevin can
plausibly build — sub-millisecond at 47 nodes, and even a 100× larger tree stays trivial.
Acceptable for a polled endpoint. **No change needed.**

## 3. Sort stability on ties — FIXED (finding #1)

`last_activity` sources are all SQLite `datetime()` — `"YYYY-MM-DD HH:MM:SS"`, fixed width,
UTC. Verified directly against the live DB that `goals.updated_at`, `goal_events.created_at`
and `conversations.updated_at` all use that one format (a mixed ISO-`T`/space corpus would
have silently mis-sorted; it isn't one). Backend string `MAX` is therefore correct.

The UI comparator used `localeCompare`, which is ICU-collation dependent (spaces and
punctuation are variable-weight under some collations) and ~100× slower than `<`. Replaced
with a plain lexicographic comparator returning `0` on ties; `Array#sort` is
spec-stable (ES2019+), so equal-activity goals now keep the server's `sort_order, id`
order instead of being free to shuffle between the 8-second polls.

## 4. Stale subtree cache — FIXED (finding #2, the spec called this one)

`toggleExpand` did `if (subtrees[id]) return;` — the subtree was fetched **once, ever**.
Expand a goal, let a node flip `working → check` or a plan dispatch land, and the inline
tree showed the original snapshot indefinitely (collapse/re-expand didn't help either).

Replaced the cache-once fetch with an effect keyed on `[expandedId, expandedStamp]`, where
`expandedStamp` is that goal's `last_activity`. Every goal mutation writes a `goal_event`
(62 log sites in `goals.ts`), which moves `last_event_at` → `last_activity` → the effect
refires. Cached nodes stay rendered while the refetch is in flight and a refetch error is
swallowed when stale nodes exist, so an open tree never flashes empty or red.

## 5. Autopilot "stopped" pill was permanent — FIXED (finding #3)

`AutopilotBadge` rendered `🌙 stopped — <reason>` whenever `autopilot !== 1` and
`autopilot_config.stop_reason` was set. The code comment claimed "it ran recently", but
there was no recency bound and `autopilot_config` persists forever — so a goal that
completed one clean autopilot night would carry a "stopped — complete" pill **for months**,
on a card whose whole point is showing what is live now.

Bounded to `stopped_at` within 24h (the field already exists on `AutopilotConfig`), and
mapped the raw reasons to card-legible text (`kevin` → "you stopped it", `complete` →
"finished the night"). `stuck` still reads `stuck` — that one should shout.

## 6. Card looked clickable but mostly wasn't — FIXED (finding #4)

v0.5 converted the card's outer `<button>` to a `<div>` and moved `onClick` onto the title
block alone — while keeping `hover:border-primary/50 hover:bg-accent/30` on the whole card.
Result: the entire card highlights on hover, but clicking the badge row, the progress ring,
the hot-nodes line or any padding did nothing. That is a straight usability regression from
v0.4's whole-card button.

Restored the full-surface click target on the outer element (`role="button"`, `tabIndex`,
Enter/Space) and reverted the inner title back to a plain `<div>` so there is no nested
button and no double-fire. The keydown handler early-returns when `e.target !== e.currentTarget`
so child buttons keep their own keys, and the expanded mini-tree panel is wrapped in a
`stopPropagation` container so scrolling/clicking inside the tree doesn't navigate.

## 7. The "Done" section was dead code — FIXED (finding #5)

The commit message claims *"done/archived collapsed at the bottom"*. The page calls
`listGoals()` with no args → `include_done=0`, so `goals` never contains a done goal, so the
`done` array is always empty and the `✅ Done (N)` `<details>` never renders. v0.5 added a
`.sort()` to that dead branch without noticing it was dead. Changed the fetch to
`listGoals({ includeDone: true })`, which makes the existing (already-written, already-correct)
Done section real. Archived goals stay excluded — that is deliberate and unchanged.

Side effect, and a good one: a board whose only goals are done no longer shows
"No goals yet — describe one above to start."

## 8. Backend doc-comment accuracy — FIXED (finding #6, cosmetic)

`hotNodeCandidatesStmt`'s comment said "Parked/done/set non-human nodes never qualify". A
**parked** node with `pending_title` / `pending_done_means` / `pending_removal` *does*
qualify — correctly so, it's still waiting on Kevin. Comment corrected to match the SQL;
no behaviour change.

## 9. UI state matrix — walked, no further defects

| State | Behaviour |
|---|---|
| 0 goals | skeleton (4 pulse cards) until `loaded`, then the empty-state line. No crash. |
| 1 goal | single card, grid handles it. |
| archived-only | still reads as empty (archived is intentionally not fetched) — pre-existing, unchanged. |
| done-only | **now** renders the collapsed Done section (was: false "no goals yet") — see §7. |
| autopilot running | live `🌙 <next action>` pill from `autopilot_next`, SSE-fed. |
| autopilot stopped-stuck | `🌙 stopped — stuck` for 24h, then the card goes quiet — see §5. |
| goal with 50+ nodes expanded | `GoalMiniTree` is `max-h-64 overflow-y-auto`; grouping + DFS is O(n) with an O(n log n) sibling sort, rendered once per expand and memoised on `nodes`. One card expands at a time (`expandedId` is a scalar), so worst case is one tree in the DOM. Fine. |
| tree changes while expanded | now refetches — see §4. |

`GoalMiniTree` skips `state === "discarded"`, which is belt-and-braces: `getGoalTree(id)`
defaults `includeDiscarded=false`, so the API never ships them. Its parent-grouping walk
mirrors `GoalTreePanel`'s exactly, so a preview and the full tree can't disagree about shape.

Blast radius of the changed components is contained: `GoalCard` and `AutopilotBadge` are
imported by `src/routes/goals.tsx` and `GoalCard` only.

## 10. Verification after fixes

Backend (`/home/kevin/paperclip-worktrees/goals-v05/darwin-assistant`):
```
npm run build            tsc, 0 errors
goals:sim                144/144 ✅
goals:review-checks       14/14  ✅
goals:guards-check        23/23  ✅
goals:autopilot-check     57/57  ✅   (238 checks total)
```

Cockpit (`/home/kevin/paperclip-worktrees/goals-ui-v05`):
```
npx tsc --noEmit         11 errors — ALL pre-existing, 0 in any goals file
                         (confirmed identical count at parent commit 2c79157
                          in the live checkout: index.tsx / intel-desk.tsx /
                          notifications.tsx, TanStack `search` prop + Notification.actions)
vite build               success
```

⚠️ **Build-hygiene note for whoever deploys:** the bare `vite build` I ran for verification
emitted a **Cloudflare-preset** bundle (`.wrangler/deploy/config.json`) — the known cockpit
gremlin. It landed in the *worktree*, never the live checkout; I deleted
`.output/`, `.wrangler/` and `node_modules/.nitro` from the worktree afterwards, and
confirmed the live cockpit still has `"preset": "node-server"` (09:22 artifact, untouched)
and `/goals` still returns 200. **Deploy via `/usr/local/bin/jarvis-cockpit-deploy.sh`, never
a bare build.**

## 11. Deferred (deliberately not done — no defect, just next rungs)

- A mini-tree row click opens the goal but does not **focus** the node it clicked, even
  though the row shows `#N`. Wiring `?focus=` through would be a nice follow-up; out of
  scope for a review pass.
- `onGoal: () => reload()` does a full refetch per SSE goal event. Pre-existing, cheap at
  this scale, but it is the obvious next optimisation if the forest ever gets big.
- Archived goals remain unreachable from the forest page. Unchanged by v0.5; worth a
  "show archived" toggle someday.
