# 🌙 Night Shift — adversarial review (tree-37015f83 node #682)

Reviewed: `hopper/night-shift` (darwin-assistant) + `hopper/night-shift-ui` (jarvis-command-center)
against `skills/night-shift/DESIGN.md` §0 (Kevin's ask, verbatim) and `skills/night-shift/CONTRACT.md`.

**Verdict: PASS-with-fixes.** Ten defects found, **nine fixed on the branches**, one accepted and
documented. Two of them would have ended the night silently; both are now pinned by new sim checks
that fail against the pre-fix code.

The frame for the whole review: this ships tonight and runs unattended until morning with Kevin
asleep. So the bar is not "is it correct" but "**what happens at 3AM when a step doesn't go the way
the happy path assumes**" — a dropped turn, a paused run, an inserted row, a spent budget.

---

## Findings

| # | Sev | Finding | Status |
|---|---|---|---|
| 1 | **CRITICAL** | A model cue was posted exactly once — an unanswered cue held its lane until morning | FIXED |
| 2 | **CRITICAL** | Night cue turns ran outside the concurrent-automated-turn ceiling | FIXED |
| 3 | HIGH | `tree-cue` ran a second, un-briefed JARVIS turn in the goal chat for every night tree | FIXED |
| 4 | HIGH | `planNight`/`startNightRun` created the orchestrator thread without seeding it | FIXED |
| 5 | MEDIUM | The cue turn's `<goal_tree>` snapshot was resolved by a MUTABLE item position | FIXED |
| 6 | MEDIUM | A locked row did not keep its absolute position through a colliding insertion (§12.12) | FIXED |
| 7 | MEDIUM | `until_budget` could not end on a single-account governor | FIXED |
| 8 | MEDIUM | A plan item whose node reached `planned` (tree never planted) held its lane forever | FIXED |
| 9 | LOW | `needs_you` listed a node twice; `runnable()` asserted a goal row non-null | FIXED |
| 10 | LOW | A Kevin `move` re-packs the list, so other locked rows shift | ACCEPTED |

---

### 1 · CRITICAL — an ignored cue held its lane until morning

`fillLanes` picks only `status === 'queued'` rows (`night-shift.ts` pre-fix :1731 → the single
`runModelItem` call at :1742). A model item therefore went `running` **once** and was never cued
again. Two consequences, both invisible:

- `secondAsk` (`item.status === 'running' && cueCount >= 1`) could never be true.
- `failIfIgnored`'s `if (cueCount(item.id) < 2) return;` therefore always returned, so the
  CONTRACT §4.1 transition *"cue posted twice and still no proof → item failed + park"* was
  **unreachable dead code**, and §2.2's `running→failed` row could never fire for that reason.

So an orchestrator turn that died, was dropped by the queue, or simply didn't do the step left its
item `running` forever. Nothing times it out: `syncItems`' plan branch falls through to
`continue; // still working`, and the `stuck` detector explicitly doesn't count a tick with running
items (`if (!running.length && !started)`). Three such items and every lane is dead while
`GET /night/board` still reports a healthy run in flight — the failure Kevin would only discover at
breakfast.

**Fix:** new config knob `recue_minutes` (default 10, range 1–120, mirroring autopilot's
`tick_minutes` re-ask window) and `nagOrFail()` replacing `failIfIgnored()`: no proof after the
window → **re-ask once** (`secondAsk` now genuinely true, same lane, same item, distinct
correlation key); still nothing after another window → **fail the item and park the node**, which
releases the lane and surfaces it under "Needs you" in the morning report.

Scope is deliberate: `finish` items are a running tree and are never nagged, and `plan`/`replan`
are nagged **only** while their node is still an untouched `set` leaf with `plan_state='none'` — the
moment a tree exists, the tree is the proof and the item waits as long as it takes.

**A race the fix itself introduced, then closed:** `syncItems` runs on every tick *"held or paused
or not"*, so the first cut would have re-asked (and parked) during a pause or a governor hold — new
work starting while paused is precisely what §4.4 forbids. The gate is now evaluated **before** P0
and passed in as `canCue`: facts still reconcile while paused/held, but the nag/park half doesn't.

Pinned by **NS-24** (asserts: no nag before the window · none while paused · none while the
governor holds · exactly one second ask with `(second ask)` on the autopilot header and the same
lane · then `failed` + `result_summary` "ignored twice" + node `parked` + `lane` released + no
third cue).

### 2 · CRITICAL — night turns bypassed the turn-admission ceiling

`turn-admission.ts` exists because of the 2026-09-23 OOM (33 kills), and it caps concurrent
**automated** turns at `max_concurrent_auto_turns` (default 4). Its prefix list carried
`'nightshift:'` — but Night Shift mints `night:<run_id>:<item_id>:<n>` (CONTRACT §4.3 spells this
key out) and `'night:'` never matched `'nightshift:'`. So every lane's cue, the PLAN-READY cue and
the wrap cue ran **ungated**, on top of autopilot/guard/tree cues, all night. Added `'night:'` to
`AUTOMATED_KEY_PREFIXES`. Gated turns wait for a slot rather than being dropped, so nothing is
lost — only paced.

### 3 · HIGH — tree-cue double-drove every night tree

Kevin's ask is explicit that **every cue goes to ONE thread**. But a tree planted from a goal node
carries the goal chat as its origin, and `tree-cue.ts` wakes that origin on `done`/`blocked`. So
each night tree that finished ran a **second** JARVIS turn — in the goal chat, with no night
briefing — saying *"review the deliverables against the original ask, then deploy/merge per your
standing rules"*, and on a block *"any node tagged [needs Kevin] is his call — surface it"*. Two
drivers on one node (the night's P0 sync settles the same fact and kicks on the same event), cues
outside the orchestrator thread, tokens and admission slots spent twice, and a Kevin-facing prompt
at 3AM.

Suppressed while a night run owns the goal (`nightShiftOwnsGoal`, the probe night-shift.ts already
registers into goals-autopilot; exported for this). The dedupe guard is still written so the tree
doesn't re-cue later, and the predicate returns false for every non-night tree — nothing outside a
live run changes. `tree-cue:check` still passes.

### 4 · HIGH — the orchestrator thread could exist un-seeded

`ensureNightThread()` only *returns* `seed_text`; the cockpit posts it on first open (`night.tsx`
:323). But `planNight` and `startNightRun` create the thread too. Plan a night from the
`night_shift` tool or a curl with no `/night` tab open and the PLAN-READY cue lands in a thread with
**no persona at all** — and the UI, seeing `created:false` later, never seeds it. Identical to the
un-seeded goal-1 chat. `seedNightThreadIfNew()` now posts the seed from the server on the one turn
the conversation is born; `CHK-thread` (created/seed on first call, not on the second) still passes.

### 5 · MEDIUM — the cue turn could be handed the wrong goal's tree

`nightCueItem` matched the `[night item #P of N · lane L]` header's **position**, and `position` is
mutable: any insert re-packs the list, and lanes run concurrently so a *running* item at a higher
position genuinely shifts. A cue can also sit in the thread queue behind another turn. Between post
and execution the position could therefore resolve to a different item — and
`nightShiftContextBlock` uses it to pick which goal's `<goal_tree>` to inject, so the orchestrator
would read goal B's tree while its cue named goal A's node. Now resolved from the **immutable**
`[autopilot goal #g — …]` header on line 2, with position as a fallback; the snapshot always
describes the goal the cue names. Cue text is unchanged (NS-6a still passes).

### 6 · MEDIUM — locked rows moved anyway (§12.12)

`makeRoom` bumped `position + count` on unlocked rows at/after the target and left locked rows
alone — which **collides** a shifted row onto a locked row further down (two rows, one position) —
and then `renumber()` re-packed the whole list by `(position, id)`, which moved the locked row
regardless and ordered the collided pair by rowid. Rewritten as an in-memory slot assignment:
locked rows keep their absolute slot, unlocked rows flow around them in order, holes for the new
rows are returned to the caller, the list stays contiguous 1..N, and `renumber()` is gone.

Pinned by **NS-25** (lock position 5, insert two rows after position 2 → locked row still at 5, new
rows at 3 and 4, positions contiguous, no duplicates). It fails on the pre-fix code with exactly
*"the locked row did not keep its absolute position through the insertion"*.

### 7 · MEDIUM — `until_budget` couldn't end on a single-account governor

The stop test was `hold.reason === 'governor:claude_all_accounts_full'`, which is the **multi**-account
verdict only (`hopper-governor.ts` :507/:612). With one enabled Claude account — exactly the state
of the night of 9/23, when B was disabled for the weekly wall — `evaluateClaudeLegacy` says
`weekly_ceiling` instead and an `until_budget` night would have run to morning anyway. Now a small
explicit set: `claude_all_accounts_full` + `weekly_ceiling`. `five_hour_ceiling` is deliberately
**not** in it (that window resets — it is the pacing loop, not the end of the budget), and neither
are `usage_stale` or `kevin_active`, which are transient. This directly answers the review brief's
"`until_budget` must NOT end on a transient staleness hold": it doesn't, and it now does end when
the subscription is genuinely spent. NS-11 (multi-account) still passes.

### 8 · MEDIUM — `planned` was a dead end mid-run

The planner has a rule for a node in state `planned` (plan approved, tree never planted → `replant`),
but `syncItems` had no branch for it: a plan item whose node landed there fell through to
`continue; // still working` and held its lane forever. It now settles the item and inserts a
`replant` server item immediately after it.

### 9 · LOW — two small ones

`needs_you` pushed a node twice when it was both parked and awaiting a weigh-in (one row per node
now, weigh-in first). `runnable()` used `getRawGoal(item.goal_id)!` — a missing goal row would have
thrown inside `fillLanes` and killed the whole tick; it returns "goal is gone" instead.

### 10 · LOW — ACCEPTED: a Kevin `move` re-packs the list

`moveNightItem` splices and renumbers every row, so a *different* locked row can shift. Left as is:
§12.12's absolute-position guarantee is scoped to (b) expansion and (c) follow-up insertion, and
this is (a) — Kevin's own explicit drag, where his intent for the list right now should win over a
lock he set earlier. Worth knowing, not worth surprising him with an insertion-shaped refusal at
3AM. (`onMoveDown` on the last row also clamps to N and locks it for no movement — cosmetic.)

---

## Checked and found correct (no change needed)

- **Double-driving** — `goals-autopilot.tickGoal` stands down for owned goals (NS-14) and ticks
  again after the wrap (NS-14b). No path parses a verdict twice: `runServerItem` re-reads node
  state and skips a node that is no longer `check`.
- **Pause** — `dispatchTick` skips the run's pending nodes while a non-run tree still dispatches
  (NS-10); the paused-tree set is invalidated on every run/item write. Its TTL was cut 5s → 1s,
  since the one window it leaves open (a cue turn already in flight when Pause lands plants a tree)
  is closed only by the clock — the write happens on the goal node, not on us. Resume never
  re-picks a running item (`fillLanes` takes `queued` only).
- **Frozen order** — nothing re-sorts after `planned`; `listNightItems` is `ORDER BY position, id`;
  every mutation re-runs `resimulateEtas`. Plan determinism is proven byte-for-byte on a copy of
  the live DB (NS-1) and the minute-resolution anchor makes two plans in the same minute identical.
- **kevin_active** — bypassed for run work only via `governorCheck(adapter, {ignoreKevinActive})`,
  which skips that one gate; ceilings, staleness, weekly and provider overrides are untouched.
  There is no auto-pause when Kevin shows up, per §0.
- **Restart recovery + heartbeat** — NS-13; `night_shift_heartbeat` written every tick, before any
  gate, so a held run still proves it is alive. `prior_autopilot` is persisted at Start, so a crash
  mid-run still restores correctly at the next wrap (NS-12 asserts byte-for-byte).
- **Kiosk auth** — `/night/board` is GET-only, exact-path, constant-time-compared, fails closed
  when the token is unset, and no mutating route is eligible (NS-15, CHK-board). The payload is the
  same class of content the big board already exposes.
- **SSE** — `night_run`/`night_item` are in the `/events` forward set, the kiosk event filter and
  the cockpit `sse-worker` EVENT_TYPES; the worker's missing `notification`/`hopper_node` drift was
  fixed by node #680.
- **Orchestrator context** — the injected list is capped at 12 rows and windows to the first open
  item; the autopilot header is preserved as line 2 so the `goals` tool lights up, and the seed
  states the explicit-`goal_id` rule.
- **No 3AM questions** — the seed and `composeCueText`'s preamble both say Kevin is asleep, never
  ask, `park` instead; the `unblock` cue says never to answer a question only Kevin can answer.
  Finding 3 closed the one remaining path that could have prompted him.

## Known-and-left

- `driver.holdLog` and `lastWaiting` are in-memory, so after a restart the board shows no hold
  until the next hold *change*. The `night_events` trail and the report are unaffected.
- `fillLanes` reads each goal tree once per tick, so an inline server action later in the same pass
  sees a slightly stale tree. Only ever conservative (an under-settled tree picks fewer items), and
  self-corrects on the next 30s tick.
- `nightHoldReason(run, logging)` ignores `logging` (`void logging`).
- Pre-existing, NOT from this branch: `goals:sim` V03-6d is flaky (160/161). Verified by re-running
  it with `src/tree-cue.ts` reverted to HEAD~1 — it fails identically, so it is not caused by the
  tree-cue change.
- UI: the 3-column shell is percentage-width with `shrink-0`, so a phone-width viewport degrades to
  three very narrow columns rather than stacking. Functional, not pretty — which is the bar the
  review brief set.

## Commands run

| command | result |
|---|---|
| `npm run build` (tsc) | clean |
| `npm run night:sim` | **28/28** (was 26/26; NS-24 + NS-25 added) |
| `npm run night:check` (live-DB copy, temp port) | **6/6** |
| `npm run goals:sim` | 160/161 — pre-existing V03-6d flake, reproduced with tree-cue reverted |
| `npm run goals:autopilot-check` | 57/57 |
| `npm run goals:autopilot-sim` | all PASS |
| `npm run goals:review-checks` | 14/14 |
| `npm run goals:guards-check` | 23/23 |
| `npm run tree-cue:check` | ALL PASS |
| UI `bun run build` | succeeds (`_ssr/night-*.mjs` emitted) |
| UI `npx tsc --noEmit` | 0 errors in any file this tree touched; 9 pre-existing `to="/threads"` search-param errors elsewhere |

Regression proof: with `src/night-shift.ts` reverted to HEAD~1 the suite reports **26/28** —
NS-24 and NS-25 both fail — then returns to 28/28 when restored.

## Files touched by this review

`src/night-shift.ts` · `src/turn-admission.ts` · `src/tree-cue.ts` · `src/goals-autopilot.ts`
(export only) · `scripts/night-shift-sim.mjs` · `docs/night-shift/REVIEW.md`
