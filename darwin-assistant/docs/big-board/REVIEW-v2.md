# Big Board v2 — adversarial review (tree-e1c07f73, node #535)

Reviewed: `hopper/big-board-v2` (darwin-assistant, base `1ec1f2f46`) and `hopper/big-board-ui-v2`
(jarvis-command-center, base `4e9ecfd`), against the agreed design in the node #532 spec and
`CONTRACT.md` Part 5.

## Verdict: **PASS-with-fixes**

Both branches implement the agreed design correctly. No auth regression, no N+1, no
double-counting, no wrong-tree filtering, no `/spawn-tree` regression from the shared-card
extraction. Three defects were found and **fixed directly on the branches**; seven lower-severity
observations are written up below for a follow-up rather than changed here.

---

## Fixed on-branch

### F1 — TV readability: the shared tree card renders below the board's 11px floor *(UI)*

`TreeCardBody` is a byte-faithful lift of `/spawn-tree`'s desktop card, and its type scale bottoms
out at Tailwind `text-[10px]` — used for the **status pill** (`TreeStatusPill`), the **model chips**
(`Chip`), the "done" caption under the done/total counter, and the `#id` prefix on every
running/attention row. Those are precisely the at-a-glance elements Kevin asked to put on the
board. The Big Board's own CSS never goes below **11px** (verified: the smallest `font-size` in
`big-board.tsx` is 11px), and the board renders at a 19px base for 10-foot viewing.

**Fix:** a board-scoped lift inside `.bb .tree-card-wrap` only — `text-[10px] → 11px`,
`text-[11px] → 12px`. Specificity `0,3,0` beats Tailwind's `0,1,0` regardless of stylesheet order,
and `/spawn-tree` (which renders the same component outside `.bb`) is untouched.

Two escaping traps were hit and resolved while landing this, both verified in the built bundle:
the CSS lives inside a JSX template literal, so (a) a backtick in a CSS comment terminated the
literal and broke the whole `<style>` block, and (b) `\[` collapses to a bare `[` at runtime,
which would have emitted an invalid attribute selector and silently killed the rule *and the ones
after it* — the source needs `\\[`. Confirmed the emitted chunk carries `.text-\\[10px\\]` and that
`tsc --noEmit` + the `node-server` vite build are clean.

### F2 — SSR crash surface on a partial `trees` block *(UI)*

`grow={(snapshot?.trees?.active.length ?? 0) === 0}` and `TreeNodeList`'s `if (nodes.length === 0)`
optional-chain only as far as `trees`, so a payload carrying `trees: {}` or a tree without `nodes`
throws during SSR. The true v1 payload (no `trees` key at all) was already safe — node #534 proved
that against the real live v1 server — but the partial-shape case was not. Optional-chained both.

### F3 — fixture coverage gap: foundry clustering + draft/archived exclusion *(backend)*

`trees.active` resolves each tree's summary out of `buildSpawnMonitorSnapshot`'s **clusters**, and
a tree whose topic matches `foundry:<project>/<module>` is clustered separately from `single`
trees. Nothing in the test suite proved an active foundry tree survives that lookup — a plausible
way to silently drop the exact trees Kevin watches most. Only `done` exclusion was covered;
`draft` and `archived` were not.

**Fix:** 5 new assertions in `scripts/big-board-v2-fixture-check.mjs` (section 3b) — active foundry
tree reaches `trees.active` with its reused counts and full node list, draft excluded, archived
excluded. Suite goes **23 → 29 assertions, all passing**. Behaviour independently probed against
the compiled aggregator before writing the test: `active ids: ['tree-foundry']`, draft/done/archived
all excluded, counts and node list intact.

---

## Verified clean — no change needed

**Kiosk auth (no regression).** `BIG_BOARD_KIOSK_EVENT_TYPES` is comment-only in the diff — the set
itself is byte-identical. The `handlers/api-v1.ts` diff contains **zero** kiosk-touching lines; the
only change is threading `radarHours` into the existing call. No new route became kiosk-eligible,
and the UI still passes `?kiosk=` and nothing else — no cockpit bearer key appears in any URL.
Note that v2 strictly *reduces* what a kiosk token can read: v1's `radar` was uncapped and
windowless (every eligible thread), v2 caps it at 8 within a 6h window, and `?radar_hours=` cannot
widen that past the 8-row cap.

**Performance (600MB-class DB).** Measured against the real 923MB `jarvis.db` (read-only, 8 warm
runs of the exact function the route delegates to): **median 27.5ms**, min 23.1ms, max 33.0ms, for
a **37.9KB** payload. Comfortable for a 60s TV poll plus a per-`hopper_node` refetch.
- `fetchWaitingOnMap` is **one** query for the whole candidate set, not per-thread.
  `EXPLAIN QUERY PLAN` confirms both the co-routine and the outer lookup use
  `idx_turns_conversation(conversation_id, turn_index)` — no scan, no N+1.
- `listAllSpawnTasks()` is 535 rows / ~1.03MB of text columns total — not a concern.
- `hopperNodesByTree` still skips `done`/`archived` trees (v1 optimisation preserved).

**Active-tree filtering.** Probed directly against the compiled aggregator, not just read:
`status === 'active'` only; `draft`/`done`/`archived` excluded; an active **foundry** tree included
with correct counts, `running_nodes` and node list. Trees holding `blocked`/`blocked_question`
nodes stay `active` and surface through the card's `attention` list — a genuine plus for the board.

**`waiting_on` derivation.** `running → 'jarvis'`; otherwise last `user` turn → `'jarvis'` owes a
reply, last `assistant` turn → `'kevin'` owes a reply, no turns → `null`. Roles are filtered to
`('user','assistant')` so tool rows can't win the `MAX(turn_index)`. All four branches are fixture-
covered and were observed correct against live data.

**Density edge cases.** `0 → none`, `1–2 → expanded`, `≥3 → compact`. Exactly-2 and exactly-3 are
both fixture-asserted. The UI recomputes the same rule as a fallback when `density` is absent, and
its client-side re-sort matches the server's (running-first, then `updated_at` desc).

**No double-counting.** `in_motion.threads` excludes `^cockpit:hopper-node-` worker threads (all
hopper workers use that ext, foundry included), and the In Motion card no longer renders
`in_motion.hopper_nodes` at all — a running node now appears only inside its tree's card. Confirmed
live: `running_hopper_nodes=1, running_threads=0`.

**Shared-card extraction / `/spawn-tree` regression.** The JSX moved verbatim; `/spawn-tree`'s local
`TreeCard` keeps its `<Link>` wrapper and still forwards `action` + `onRefresh`, and the kiosk's
`interactive={false}` suppresses the inline `RetryButton` (correct — the board is read-only and the
kiosk token can't write anyway). The now-unused `Chip` import was correctly dropped from
`spawn-tree.tsx` (0 remaining uses); every other shared import is still referenced. Tailwind classes
in the new `components/spawn-tree/` directory **are** generated — `styles.css` uses
`@import "tailwindcss" source(none)` with `@source "../src"`, which covers it — so neither page
renders unstyled. `<html className="dark">` is hard-coded, so the card's theme colours resolve dark
on the board's dark surfaces.

**Dead code from the removed Commitments card.** `CommitmentsCard`, `COMMITMENTS_ROWS` and the
`BigBoardHopperNodeInMotion` import are all fully removed; `fmtWhen` is still used by Radar and
Landed. Nothing orphaned. The payload keeps `commitments` and `in_motion.hopper_nodes` deliberately
for API compatibility, as CONTRACT Part 5 states.

**Column layout matches the agreed design.** Grid is `29% 1fr 27%` (centre widest). Left = Monitors
+ sentinels then ⚡ In motion (threads only); centre = 🌳 Active trees then 🎯 Goal spotlight;
right = 📡 Radar then ✅ Landed. `grow` correctly moves to Goal spotlight when there are 0 trees, so
Spotlight takes the column exactly as specified.

---

## Observations — written up, not changed

- **O1 (low, cross-branch inconsistency).** The UI added `hopper_tree` to `TICKER_EVENT_TYPES`,
  `TICKER_ICON`, `describeTickerEvent` and the 500ms debounce branch — but **no `hopper_tree` SSE
  event type exists anywhere in the codebase** (the backend branch documents this explicitly and
  deliberately declined to invent one), and it is in neither `BIG_BOARD_KIOSK_EVENT_TYPES` nor the
  server `/events` FORWARD set. It is a dead listener: harmless and forward-compatible, but the two
  branches state opposite positions. Follow-up: either emit the event server-side or drop the
  listener. Left as-is because removing it is cosmetic and adding it is out of this node's scope.
- **O2 (low).** `.bb` redefines `--surface`, which shadows the cockpit theme's `--surface` for
  Tailwind's `bg-surface/*` inside the board (`SegmentedBar`'s track). `#1a1a19` vs
  `oklch(0.19 0.009 260)` are near-identical dark values, so it is cosmetically benign — flagged so
  nobody burns time debugging it later.
- **O3 (low, doc).** Radar order is **pinned-first**, not strictly most-recent:
  `listAllConversations()` is `ORDER BY pinned DESC, pinned_at DESC, updated_at DESC LIMIT 100`.
  With 22 pinned threads and 24 conversations touched in the last 6h on the live DB, an in-window
  pinned thread can take a cap-8 slot ahead of a newer unpinned one. Probably desirable, but
  CONTRACT Part 5 describes radar as "the 8 most-recently-updated" — worth one clarifying sentence.
- **O4 (low, doc).** `fetchWaitingOnMap`'s 150-row bound is moot: its source
  `listAllConversations()` is itself `LIMIT 100`, so a shown radar row can never fall outside the
  map. The comment ("without querying every conversation ever") overstates what the bound does.
- **O5 (low, TV glance).** Expanded density renders both trees' full node lists (cap 40 each) inside
  a `.grow` card with `overflow-y: auto`. Nobody scrolls a kiosk, so two long trees could push the
  second card below the fold. Live trees are 5–15 nodes, so it does not bite today. If it ever does,
  cap the *rendered* rows per card (e.g. 12 + a "+N more nodes" tail) rather than growing the card.
- **O6 (informational).** `scripts/big-board-check.mjs`'s docblock claims zero writes, but v2's new
  `spawn-monitor.js` import runs `backfillHopperStamps()` (an `UPDATE`) at module load. Verified a
  genuine no-op against the live DB (0 candidate rows — the live service already ran it at startup),
  so nothing was written; the claim is simply no longer literally true.
- **O7 (informational).** The radar/landed timestamp parse (`updated_at.includes('T') ? raw :
  replace(' ','T')+'Z'`) would mis-parse an ISO-without-offset value as local time. All 1812
  `conversations` rows use the space-separated UTC form, so the wrong branch is unreachable, and
  this idiom is pre-existing v1 style used at four call sites — left alone rather than churned.

---

## How this was verified

| Check | Result |
|---|---|
| `npm run build` (tsc, backend) | clean |
| `npm run big-board:v2-fixture-check` | **29/29** (was 23; +5 from F3, +1 pre-existing recount) |
| `npm run big-board:check` (live `jarvis.db`, read-only) | **37/37** |
| Aggregate timing, real 923MB DB, 8 warm runs | median **27.5ms**, 37.9KB payload |
| `EXPLAIN QUERY PLAN` on the `waiting_on` join | uses `idx_turns_conversation` (no scan) |
| Direct probe: foundry / draft / done / archived filtering | correct |
| `npx tsc --noEmit` (UI, 4 touched files) | clean, no new errors |
| `NITRO_PRESET=node-server npx vite build` (UI) | succeeded, `preset: node-server` |
| Escaped Tailwind selector present in built SSR chunk | confirmed |

No live checkout, live service or production database was modified. All backend checks ran against
the worktree's own `dist/`; the live-DB check is read-only by construction.
