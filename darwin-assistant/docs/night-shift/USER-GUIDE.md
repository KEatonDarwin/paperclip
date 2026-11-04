# Shifts — user guide

Where: `/night` (also reachable at `/shifts`, which just redirects there). A **Shift** is one
session of work — one ordered list, one orchestrator chat, one row in the **Sessions** table.
"Night Shift" is the overnight flavor of a Shift; a focused daytime push ("turn it back on,
focus in on goal 6, use Claude A") is the exact same machinery, just started while you're
awake. Every table/route/tool name still says `night_*` — only what you see is renamed.

## Shifts any time of day

This is the recipe for Kevin's own words: *"turn it back on, focus in on goal 6, get as much
done as you can, use Claude A for most of it."*

1. **Set the throttle first, if you're pushing hard.** `/settings/governor` → ⚡ Throttle — pick
   a preset (`Turned up` to spend headroom, `Normal` for the everyday baseline) and, if you want
   one account carrying the work, set Claude mode to `A only` or `Ordered A→B`. Shifts do not
   duplicate this — the plan sheet only *links* to it and shows a one-line readout
   (`Throttle: <preset> · claude <mode>`) so you know what's actually going to run before you
   commit to a plan. The throttle's per-goal cap always wins at dispatch, even if the shift plan
   asks for more lanes on that goal than the cap allows — the plan sheet flags that case in
   amber inline.
2. **Open `/night` → "Plan a shift."** Fill in:
   - **Label** (optional, ≤80 chars) — a short name, e.g. `Focus goal 6, Claude A`. Shows on the
     board header and in the Sessions table.
   - **Brief** (optional, ≤2000 chars) — Kevin's instruction, **verbatim**. This is injected into
     the orchestrator's context on every single turn of the shift, and shown on the board — it
     is the one thing that makes "why did it do that" answerable days later.
   - **Mode** — `Till I say stop` or `Till out of tokens`.
   - **Lanes** (1–4) and **Per-goal parallel** (1–3).
   - Optional build/light/verify model overrides (Claude-only; Fable and frontier variants are
     filtered off the list on purpose — a shift leaf is worker-tier work, never planner-tier).
   - Which goals to include — defaults to every goal in `status='set'`.
   Click **Plan**.
3. **A per-shift orchestrator thread is created right then**, before you've even hit Start —
   `cockpit:shift-<id>`, seeded with the brief, the goal list, lanes/parallel, and the throttle
   snapshot. You can open it and talk to it immediately. The board's left pane shows this
   thread; JARVIS gets exactly one `PLAN READY` cue in it, reads the top of the list, and may
   reorder up to 3 items with stated reasons — this does not block Start.
4. **Read the list** — the right rail is the frozen execution order for this shift, top to
   bottom, with an estimate and a `why` per row.
5. **Click ▶ Start.** This is the moment `dials_at_start` gets written — a full snapshot of the
   throttle preset, slots, per-goal/per-tree caps, Claude mode/order, and every account's live
   5h/weekly % — permanently attached to this session's row. From here the driver runs on its
   own 30-second tick; lanes fill, cues land in the shift's own thread (never the old shared
   `cockpit:night-shift` lobby — that thread is now only a fallback for sessions planned before
   this build), the board updates live.
6. **It keeps going, not just draining.** If the list empties but a goal still has open work
   (an un-decomposed branch, a sibling that was waiting on a parent that's since finished), the
   driver re-plans a fresh tail in place and keeps running — it only stops `complete` when a
   fresh simulate pass genuinely finds nothing left across every included goal. A run that looks
   "done" because its list happened to drain is exactly the bug this build closed; you should
   never see a shift call itself complete while a goal you asked for still has real work queued.
7. **Pause/Resume any time** — one click, instant, total. Kevin can work at the same time;
   nothing auto-pauses when he shows up. Stop ends the session cleanly (running items skip —
   their trees keep running under the goal; prior per-goal autopilot flags restore; the report
   writes and posts into the shift's thread).

## Never locks up

A shift used to die with hours of budget left when a single parked item never re-queued, or
when per-goal work was capped to one node at a time because every node shared the same
checkout. `docs/hopper/PARALLEL-CONTRACT.md` (tree-383bb55b) closed both:

- **Parks self-clear.** A park can now carry a condition (`node_done`, `tree_done`,
  `branch_pushed`, `file_exists`, or plain `manual`) instead of being one-way. The driver
  re-checks every live condition on this run's items and goal nodes at the top of every tick —
  the moment the thing it was waiting on actually happens, the item re-queues on the very next
  tick, no idle wait.
- **Per-node branches on integration trees.** A tree opted into per-node worktrees (it has a
  `repo_path` + `integration_branch`) is no longer limited to one node in flight at a time: each
  node gets its own worktree and branch, cut from the integration branch's current head at the
  moment it's claimed. A finished node merges back (`--no-ff`, then the tree's build gate) before
  its dependents are released — so a node cut *after* that merge always contains the work it
  depends on, and a node cut *before* it never does. A conflicting or red-gate merge becomes a
  visible `integrate nX` repair node instead of silently corrupting the branch; the original
  dependents stay blocked until the repair lands, then release automatically.
- **Serial fallback, not a stop.** If a re-plan and a full unpark re-check both find nothing to
  run, the driver looks for the oldest item that's blocked ONLY by a throttle-shaped reason (dep
  ordering, same-branch, or a parallel cap) and force-runs it alone, one worker, no parallelism —
  Kevin's own "even if it's much slower, wouldn't that keep us moving?" A `serial_fallback` event
  names the item it picked.
- **Honest stop reasons.** The driver may only call a run `stuck` once a re-plan, an unpark
  re-check, AND the serial fallback have all found nothing. The stop event and the morning report
  then name every remaining item, one line each, with why it's stuck (human-gated, parked on a
  named condition, waiting on another item) — never a bare "nothing runnable."

## Reading Sessions

Click **Sessions** in the header (top right, clock-with-arrow icon) to open the full history —
every shift ever run, newest first:

- **Row**: when it was planned, `Session #N · <label>`, goal count, `lanes×per-goal`, duration,
  `✓done ✗failed ⏭skipped`, and a status pill (PLANNED / RUNNING / PAUSED / STOPPED / COMPLETE).
  A `CURRENT` badge marks whichever session the board's left pane is currently showing.
- **Click a row to expand it in place** — the brief (if one was given), the stop reason, and two
  buttons:
  - **Open orchestrator chat** — opens `/thread/cockpit:shift-<id>` in a new window, so you can
    go talk to that exact session's orchestrator days later. Pre-Shifts sessions (planned before
    this build, no `thread_ext` of their own) fall back to the shared `cockpit:night-shift`
    lobby thread instead.
  - **Report** — the same report drawer the board uses, opened for this specific session.
  Below the buttons: the full item timeline (position, kind, node, started→finished, minutes,
  result) and the event log for that session.
- **Clicking a row also swaps the board's left-pane chat** to that session's thread — so you can
  browse Sessions and land straight in the conversation for whichever one you picked, without
  leaving `/night`.

This is also the answer to **"how long did you work on goal 5 two days ago?"** — find the
session (or ask `night_shift run {run_id}` in any chat, or `night_shift runs` to list them),
and read `summary.goals[]` for exact per-goal minutes, or the row's own `duration_min`/
`items.done` if you just need the shape of the session at a glance.

## Talking to a past session's orchestrator

Every `cockpit:shift-<id>` thread answers about **its own run, forever** — even a session that
ended days ago. Ask it what it did, why an item ranked where it did, what it decided at a
branch point; it reads its own list and events, not "whatever is running right now." You cannot
restart a finished session from its own thread — `move`/`skip`/`add` on an ended shift return a
clear "this shift has ended" error rather than silently doing nothing or reaching into whatever
IS currently running. To pick the work back up, plan a new shift (optionally reusing the same
goals) from `/night`.

## Kill switches

- `/tmp/night-shift.stop` or settings-KV `night_shift_enabled=0` — the driver gate holds
  globally; the run stays `running`/`paused` in the DB and resumes cleanly once cleared.
- `POST /night/runs/:id/stop` (or the board's Stop button, or `night_shift stop` in the
  session's own thread) — the normal, clean way to end a session.
