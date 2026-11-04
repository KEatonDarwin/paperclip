# GOALS → GUARDS — every done_means is a win condition, so it can become an Overwatch rule (Kevin, 2026-09-19)

**Kevin, verbatim:** *"All of the leaves/branches in the goal system have a 'done' reasoning. Basically it's win condition. That is absolutely positively primed for reliable automation into a coded overwatch rule. Something that is checked with overwatch to make sure that it's still working (in the case that it makes sense that is)… I think that's one hell of a thing if it works like I hope it will."*

## The idea in one line
A node's `done_means` is written so a stranger can verify it. Overwatch's **query mode** rule is exactly that sentence turned into `{one read-only SELECT, comparator, threshold}` and checked on a cadence with zero model calls. So: **done once → guarded forever.** A node that is `done` can carry a **Guard**; if the Guard starts failing, the goal tree shows it and the goal chat gets a cue so the fix gets proposed where the work was born.

## Why this is cheap (the substrate already exists)
- Overwatch rules API: `POST/GET/PATCH/DELETE https://health.thedarwinhub.com/api/v1/overwatch/rules[/{key}]` (bearer `OVERWATCH_API_KEY`, live — answers 401 unauthenticated). Query-mode fields (`docs/overwatch/sql/005-add-rule-modes.sql` in darwin-dashboard): `mode=query`, `sql`, `comparator` gte|lte|gt|lt|eq, `threshold`, `value_column`, `sample_columns`; `agent` mode = `check_prompt` + `failure_prompt` for the ones that can't reduce to one query. All writes go through `PromptRuleWriter` (same as the dashboard drawer — no drift). Per-rule notify channels (`ow_checks.notify_channels`, Mail/Slack/Log/Teams).
- Overwatch's own key insight applies verbatim: **don't re-derive the SQL, capture it.** The query that proved a machine leaf's done_means during verify (the `check → done` step) IS the guard query.
- The Goals Shape approval already exists: a Guard is proposed as a ghost, Kevin ✓s, then it is written to Overwatch. Same muscle, same UI pattern as the Plan card.

## The objects
- `goal_guards` (jarvis.db): `id, goal_id, node_id, state ghost|set|discarded, mode query|agent, title, sql, comparator, threshold, value_column, sample_columns(json), check_prompt, failure_prompt, cadence, severity, overwatch_key, overwatch_rule_id, health unknown|passing|failing|error, last_checked_at, last_value, last_summary, authored_by, created_at, updated_at`.
- One Guard per node (v0). A Guard may only be proposed on a node whose `state ∈ {check, done}` (the win condition has to be real before we monitor it) — or on the goal root itself when all nodes are done.
- **Guardable** is a judgment JARVIS makes at verify time, not a rule: the done_means must be a measurable condition over data Overwatch can query (Hub DB) and worth checking on a cadence ("every paid lead gets its first send inside the window" = yes; "Kevin agreed the brand list" = no; a one-off deliverable = no).

## The loop
1. **Verify → propose.** When a node passes `verify` (or Kevin marks a human leaf done and it's measurable), the goal chat proposes a Guard ghost: `goals` op `propose_guard {node_id, mode, sql|check_prompt, comparator, threshold, cadence, severity, title}`. The proposal shows the SQL and the threshold in plain words ("fails when any paid lead in the last 24h has no first send within 4h").
2. **Kevin ✓ (Shape).** `POST /goals/:id/guards/:gid/accept` → server writes the rule to Overwatch (`key = goal-<goalId>-node-<nodeId>`), stores `overwatch_key`, `state=set`, event `guard_set`. ✕ discards. Kevin can edit the SQL/threshold inline exactly like a ghost node (v0.1 expand-and-edit), same last-edited gate.
3. **Watch.** A poller (every N minutes, settings-KV `goal_guard_poll_min`, default 10) reads each set Guard's latest result from Overwatch (`GET /rules/{key}` — recon confirms which field carries the last run; if none, the fallback is a `webhook` notify channel added to darwin-dashboard that POSTs results to `POST /api/v1/goals/guards/webhook`). Health flips `passing|failing|error`; `last_value`/`last_summary` stored; SSE `goal_guard`.
4. **Fail → cue.** On `passing → failing` (state CHANGE only, never every poll): goal event `guard_failed`, the node gets a red ring + "guard failing" chip in the tree, the goal root card shows a shield badge with the failing count, and a cue lands in the goal chat (`[goal #N — guard on #<node> "<title>" is FAILING: <summary>]`) so JARVIS proposes the fix under that node (a new child or a Plan) — the tree grows where it broke. `failing → passing` writes `guard_recovered` + a one-line cue.
5. **Done means done — and stays done.** The goal card's progress ring gets a second signal: how many done nodes are guarded and green. That's the "make sure it's still working" Kevin asked for.

## Non-goals (v0)
Editing Overwatch rules that Goals didn't create · guards on ghosts/set nodes · multiple guards per node · Overwatch-side UI changes beyond (maybe) the webhook channel · automatic fix dispatch (JARVIS proposes; Kevin still ✓s the Plan).

## What Kevin has to supply once
`OVERWATCH_API_URL` (https://health.thedarwinhub.com) + `OVERWATCH_API_KEY` in darwin-assistant `.env`. Until set, the Guards UI shows "Overwatch not connected" and proposals stay ghosts (nothing is lost — they get written the moment the key lands).
