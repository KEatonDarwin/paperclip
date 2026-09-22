# GOALS v0.6 COMMAND DECK — adversarial review

**Tree** `tree-d22bdf40` · **node #607** · reviewed 2026-09-22
**Branches** `hopper/goals-v06` (darwin-assistant) + `hopper/goals-ui-v06` (jarvis-command-center)
**Under review** backend `ba5e35b86` + `24755924e` · UI `6539db4`
**Against** Kevin's ask ("*like the big board we built for my TV in the office… use the real estate… where I work from the whole day*") + the node specs + `skills/goals/CONTRACT.md` §17.

## Verdict

**PASS with fixes — deploy-ready.** The architecture is right: one polled aggregate endpoint behind all three zones, zero new tables, additive to `GET /goals` / `GET /goals/:id`. Eight findings; **six fixed on-branch**, two recorded as accepted risk. No finding was unfixable, so this finishes `done`, not `blocked`.

The two highest-value findings were not in the new code's shape but in its *semantics under time*: a failing guard's age reset on every poll (so the thing that had been broken longest sorted last in Kevin's queue), and an expanded card's subtree silently froze for the rest of the session — a regression of v0.5's own review fix.

---

## Findings

### F1 — `guard_failing.since` was LAST-CHECKED, not FAILING-SINCE (correctness, fixed)

`attentionGuardFailingStmt` used `COALESCE(gg.last_checked_at, gg.updated_at)`, per CONTRACT §17.3(d) as originally written.

`goals-guards.ts setHealth()` rewrites **both** `last_checked_at` and `updated_at` on *every* cadence poll, including the no-change path (`if (!changed) return;` happens *after* the UPDATE). `attention` is sorted **oldest-first**. Net effect: a guard that had been red for three days rendered as "1m" and sank to the **bottom** of the "🟡 Your turn" rail on every poll, permanently below a ghost Kevin created ten minutes ago. The one item on the board that most needed the top slot was structurally pinned to the last one.

**Fix** (`src/goals-board.ts`): `since` now reads the `created_at` of the newest `guard_failed`/`guard_error` `goal_events` row for that guard (`json_extract(ge.data,'$.guard_id') = gg.id`) — `setHealth` writes that event *only* on a meaningful transition — falling back to `last_checked_at` then `updated_at` for a guard seeded red without ever transitioning. Same shape as the existing `autopilot_parked` treatment.
**Test** new sim check **V06-17**: a 3-day-old `guard_failed` event ⇒ `since` is 3 days old; a no-change re-poll leaves `since` byte-identical; an eventless guard still surfaces via the fallback.
**Contract** §17.3(d) amended; §17.6 gained item 17.

### F2 — an expanded card's subtree never refreshed (regression, fixed)

v0.5 node #602's own review fix made the expanded subtree **live** — it refetched whenever that goal's activity stamp moved. Moving expansion to a persisted per-card map dropped that:

```ts
if (subtrees[id]?.nodes || subtrees[id]?.loading) continue;   // fetched once, never again
```

The effect still re-ran every poll, but the guard made it a no-op after the first fetch. An open card showed a frozen tree for the rest of the session — on the surface Kevin is meant to leave open all day, while autopilot moves nodes underneath it. Exactly the defect #602 fixed, reintroduced.

**Fix** (`src/routes/goals.tsx`): the fetch is keyed on `(goal id, last_activity)`. Open → fetch; stamp moves → refetch; nothing moved → no request. Cached nodes stay on screen while it refreshes (no blink), a refresh failure on an already-rendered tree is silent, and a superseded response is discarded rather than clobbering a newer one. Collapsing drops the key so reopening refetches.

### F3 — duplicated label on goal-level queue rows (UI defect, fixed)

`CommandDeckQueue` rendered `{a.node_title ? a.goal_title : meta.label} · {meta.label}`. A goal-level item (`goal_check` root, a guard with `node_id = null`) has no `node_title`, so the subtitle read **"ready to verify · ready to verify"** under a headline that was already the goal title. Fixed to print `goal_title · label` when node-scoped and the bare label otherwise.

### F4 — the mini-map re-rendered every row on every scroll tick (perf, fixed)

`buildRows()` was called inside the `goals.map()` **render body**, and the deck's parent re-renders on every `IntersectionObserver` callback while Kevin scrolls (`setVisibleGoalId`). At the spec's target scale — 10 goals × 50+ nodes — that re-derived the parent/child index and re-reconciled **600+ buttons** per scroll tick, on the page he scrolls all day.

**Fix**: the per-goal block is now a `memo`'d `MiniMapGoal` with `rows` memoized on its own node slice, so a scroll tick re-renders only the two goals whose highlight actually flipped. `CommandDeckQueue` is `memo`'d for the same reason (its props are stable `useCallback`s + the 8s payload). A stable `EMPTY_NODES` identity keeps a node-less goal from busting its own memo.

Related, fixed in the same pass: `board?.goals ?? []` minted a fresh array identity every render while `board` was null, busting every downstream `useMemo` (and flagged by `react-hooks/exhaustive-deps`) — replaced with module-level stable empties.

### F5 — the 8s poll re-sorted the stack under the card Kevin was reading (product, fixed)

The stack sorts by `last_activity`, newest first — correct for a glanceable v0.5 grid, hostile in a full-width stack you read down. Any goal JARVIS touches (a chat turn, a tree tick, an autopilot verify) jumps to the top and shoves the card under the cursor down the page, every 8 seconds. Kevin's stated requirement for this page is *"keeps me pushing forward without losing my spot."*

**Fix**: the order is free to change while he is **at the top** of the board (identical to v0.5 behaviour, and where a reorder is both visible and wanted) and **freezes** the moment he scrolls down; scrolling back to the top — or changing the filter — re-sorts. Goals that appear while frozen land at the end rather than shoving the page, and take their real position on the next unfreeze. The queue rail is never frozen, so anything urgent still surfaces instantly.

**This is the one finding that changes behaviour Kevin has already seen.** It is one `onScroll` handler plus a memo; to revert, delete the `atTop`/`orderRef` block and return `sortedActive` directly. Documented in CONTRACT §18.

### F6 — 4K left ~2000px of dead gutter (product, fixed)

Fixed `240 + max-w-[1300px] + 320`. At 1280 and 1920 that reads well. On the actual office TV at 3840 it left ~1000px of empty background on **each** side — the literal opposite of "use the real estate," which is the sentence that produced this page. Added a `>=2400px` tier: map rail 340px, queue rail 420px, centre stack `max-w-[2000px]`. CONTRACT §18 records all four breakpoints.

### F7 — `reduceFlag` and the attention query disagree on priority (accepted, documented)

`reduceFlag` checks `hasPending` *before* `review_state='awaiting_jarvis'` (CONTRACT §17.2's stated order); `attentionGhostAwaitingYouStmt` excludes `awaiting_jarvis` *first*. A node that was both would render `flag='pending_edit'` in the map (looks like Kevin's ✓) while being absent from his rail. **Unreachable in the current write paths** — §11/§13.4's Kevin-edit sets `review_state` without touching `pending_*`, and a JARVIS `propose_*` sets `pending_*` without `awaiting_jarvis` — so this is a latent inconsistency, not a live bug. Left alone rather than contradicting the contract's stated priority order for a state nothing can produce. If a future write path can create both, align the attention query to `reduceFlag`, not the reverse.

### F8 — `listGoals()` is still 5 queries per goal inside an 8s-polled endpoint (accepted, measured)

The board's own eight statements are genuinely cross-goal (no N+1), as claimed. But `goals` is `listGoals()` verbatim, and `toGoalSummary()` runs `getFocusRaw` + `lastEventAtStmt` + `computeCounts` (×2) + `autopilotPreview` **per goal**. Pre-existing (`GET /goals` has always done this), not a v0.6 regression, and measurement says it does not matter at any plausible scale — see below. Recorded so a future goal-count explosion has a named first suspect.

---

## Verification

Everything below was run after the fixes, on the merged branch state.

### Performance — measured, not asserted

| Fixture | Shape | `buildGoalsBoard()` |
|---|---|---|
| **Real `jarvis.db`** (1.06 GB copy, 1,907 conversations) | 5 goals · 42 map nodes · 7 attention · 0 in-flight | **0.37 ms** |
| **Scaled** (same DB + 10 synthetic goals) | 15 goals · 642 map nodes · 90 guards · 1,030 events · 337 attention · 80 in-flight | **3.57 ms** |

30-iteration warm loop each. Against an 8s poll that is a **~2,200×** margin at the scaled fixture. The F1 fix costs ~0.75 ms at that fixture (the correlated event lookup); it plans as `SEARCH ge USING INDEX idx_goal_events_goal`, bounded per failing guard. If `goal_events` ever grows to five figures *per goal* with long-standing red guards, add `idx_goal_events_kind(kind, id)` — not warranted at today's 1,030 rows.

No N+1 was found in the board's own queries. The endpoint is registered **before** `/goals/:id`, so `board` is never swallowed as an `:id` param (verified in `handlers/api-v1.ts`; `parseInt('board')` is `NaN`).

### Attention semantics

- **Nothing in Kevin's queue that is JARVIS's turn.** `review_state='awaiting_jarvis'` is excluded from every kind (sim **V06-3**), and the rail's own header says so.
- **No same-kind duplicates.** Each kind is one row per node — the `ghost_awaiting_you` OR-set collapses to a single row, and `goal_guards` enforces one active guard per node in code (`guard_exists`, 409). React keys are `kind:goal_id:node_id`, collision-free.
- **Cross-kind overlap is intentional, not a duplicate**: a blocked working leaf is `need_you` *and* `in_flight` (§17.3(b), sim **V06-6**).
- **`since` correctness** is now the transition timestamp for every kind (F1 was the last one that wasn't).

### Deep links

`nodeChatExt()` builds `cockpit:goal-<g>-node-<n>`, matching `goals.ts` (`src/goals.ts:2758`, regex at `:2656`). TanStack's serializer was exercised directly: `{chat:'cockpit:goal-1-node-7'}` → `?chat=cockpit%3Agoal-1-node-7` → `URLSearchParams.get('chat')` → `cockpit:goal-1-node-7`, which is exactly what `goals_.$goalId.tsx`'s `readChatParam()` reads and matches against `n.thread_ext`. A stale ext falls back to the goal chat rather than blanking the pane (existing §14.8 behaviour).

### New-goal 2-step seed (the v0 regression, explicitly re-checked)

Intact. `create()` still does `createGoal()` → `if (thread.created && thread.seed_text) sendMessage(thread.external_id, thread.seed_text)` → navigate, with the seed failure surfaced as its own toast rather than swallowed into the create error. This is the regression that bit v0; it survives v0.6.

### Poll / SSE races

Two real hazards, both closed (`src/routes/goals.tsx`):
- **Out-of-order** — a slow board fetch landing after a newer one used to clobber it with stale data. A request sequence counter now discards any response that is not the newest.
- **SSE storms** — a dispatch or autopilot burst fires many `goal` events in a row, each of which used to trigger its own full board fetch. They now coalesce into one trailing fetch ~250 ms after the burst settles. The 8s poll is unchanged.

The same superseded-response guard was applied to the per-card subtree fetches in F2.

### Layout

| Width | Result |
|---|---|
| **<1100** | both rails collapse into Sheet drawers; header gets the toggles, queue toggle carries an unread badge |
| **1280** | 240 + ~688 centre + 320 — tight but workable; map collapses to a 44px icon strip if Kevin wants more |
| **1920** | 240 + 1300 + 320, balanced |
| **3840** | **was** ~1000px dead gutter each side → **now** 340 + 2000 + 420 (F6) |

### Suites (all green, post-fix)

| Suite | Result |
|---|---|
| `npm run goals:sim` | **161/161** (was 160; **V06-17** added) |
| `npm run goals:review-checks` | 14/14 |
| `npm run goals:guards-check` | 23/23 |
| `npm run goals:autopilot-check` | 57/57 |
| `npm run goals:autopilot-sim` | all PASS, 0 FAIL |
| `npx tsc --noEmit` (darwin-assistant) | 0 errors |
| `npx tsc --noEmit` (cockpit) | 11 errors — **identical to the pre-v0.6 baseline**, none in goals/CommandDeck files |
| `bun run build` (cockpit) | green, `.output/nitro.json` preset `node-server` ✅ |
| `eslint` (goals + CommandDeck files) | **0 problems** (branch arrived with 26 prettier errors; fixed) |

> The UI worktree shipped with **no `node_modules`**, so node #605's claimed typecheck could not have run there as stated. Installed (`bun install --frozen-lockfile`, 613 packages) and re-verified from scratch; the 11-error baseline claim turned out to be accurate.

---

## Deploy notes

- Backend: fast-forward `hopper/goals-v06` into the live darwin-assistant checkout, `npm run build`, restart **only** via a systemd transient unit (`systemd-run --unit=jarvis-idle-restart-…`), never `nohup` from inside a turn.
- Cockpit: deploy `hopper/goals-ui-v06` through `jarvis-cockpit-deploy.sh` — **never** a bare `bun run build` on the live checkout.
- Additive: no migration, no new table, no new setting. `GET /goals` and `GET /goals/:id` are unchanged (proved by sim **V06-15**), so a cockpit release can land before the backend restart — `/goals/board` simply 404s until the restart, and the page shows its loading skeleton rather than breaking.
- Rollback: revert the two merge commits and redeploy the prior cockpit release.
- One-line smoke after the restart: `curl -s -H "Authorization: Bearer $KEY" localhost:3201/api/v1/goals/board | jq '{goals:(.goals|length),map:(.map|length),attention:(.attention|length),in_flight:(.in_flight|length)}'`.

## Not fixed, on purpose

- **F7** (latent flag/attention priority disagreement) and **F8** (`listGoals` per-goal queries) — see above.
- **Unbounded "🟡 Your turn" rail.** It scrolls; at the synthetic 337-item fixture it is a wall, but Kevin's real count is single digits (7 today). Capping it would hide work. Revisit only if it stops being scannable.
- **`registerCardRef` observer churn.** The inline ref callback re-registers each card with the `IntersectionObserver` on every render. Measurable only as a few `observe`/`unobserve` calls per poll, invisible next to F4's fix; not worth the indirection of a stable ref factory.
