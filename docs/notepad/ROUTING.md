# Notepad — routing a line to its sink (goal 6, nodes #873/#874/#875)

This is the short version: given a notepad line and JARVIS's read of it
(node #62's "move"), where does it end up, and how does JARVIS know it
already handled it? The rule lives in `src/notepad-route-rule.ts`
(`routeNotepadLine`, pure function, no DB, no model call). Acting on the
rule's answer lives in `src/notepad-dispatch.ts` (`dispatchNotepadLine`).
The end-to-end proof is `scripts/notepad-route-check.mjs`
(`npm run notepad:route-check`).

## 1. The rule table

Checked in this order — first match wins:

| # | Condition | Sink |
|---|---|---|
| 1 | move kind is `question`, `already_done`, or `context` (not `take_it`) | `thread` |
| 2 | line is already annotated as created/done (e.g. trailing `(Created a goal)`) | `thread` — never re-routed |
| 3 | explicit goal cue (`goal:`, `new goal`), or the line sits under a `Potential Goals:`-shaped heading | `goal_proposal` |
| 4 | imperative build/fix/ship verb + a concrete artifact word (file ext, backtick, repo/branch/page/endpoint/script/api/file/component/service/dashboard/migration/worktree) | `hopper` |
| 5 | "waiting on" / "blocked on" / "following up" / a named external dependency | `workstream` |
| 6 | nothing above matched | `thread` (the safe default) |

Only a `take_it` line is ever eligible for rows 2–5 — a chat is always safe;
inventing a goal/build/workstream from conversation is not. An optional
model tie-break exists (`tieBreakRouteWithModel`, unwired) for genuinely
ambiguous lines, but it can only pick between sinks the table already found
eligible — it can never introduce a sink the table rejected.

## 2. The four sinks, and what each one actually does

- **`goal_proposal`** — `proposeGoalNodes` adds a **ghost** node under the
  goal/node node #107's dossier already named. **This never creates a
  goal.** Creating a new goal is Kevin's call by contract; this only ever
  proposes a child under an *existing* goal, and the proposal sits as a
  ghost awaiting his ✓ like any other goal-tree proposal. If the dossier
  names no goal (or the named parent rejects a new child), the line falls
  back to `thread` rather than guessing an attachment point.
- **`hopper`** — `createHopperItem` files a pending candidate card. A
  candidate, not started work — Kevin still clicks Yes/Yes-but/Dismiss.
- **`workstream`** — `jotWorkstream` finds-or-creates a workstream, then
  stamps `turn: 'jarvis'` and a `next_action` (a bare jot otherwise lands
  `parked` with no next step).
- **`thread`** — delegates to node #869's `openNotepadHandoff`, which
  finds-or-creates the line's cockpit conversation and seeds it with the
  dossier.

## 3. The `action_ref` scheme

One format per sink, defined once in `notepad-dispatch.ts`
(`buildActionRef`/`parseActionRef`):

| Sink | Format | Example |
|---|---|---|
| `goal_proposal` | `goal:<goal_id>:<node_id>` | `goal:6:142` |
| `hopper` | `hopper:<candidate_id>` | `hopper:57` |
| `workstream` | `workstream:<workstream_id>` | `workstream:9` |
| `thread` | `thread:<thread_ext>` | `thread:cockpit:notepad-line-42` |

`parseActionRef` returns `null` — never a guess — for anything that doesn't
match one of these four shapes (e.g. a stale ref written before this scheme
existed).

## 4. Idempotency

The idempotency key is the notepad line's **`line_id`**
(`notepad_line_state.action_ref`). Before acting on any sink,
`dispatchNotepadLine` checks whether that line already has an `action_ref`
on its ledger row; if it does, it returns the existing ref with
`created: false` and makes **no sink call and no write**. Dispatching the
same line any number of times creates exactly one row, ever — proven in
`notepad-route-check.mjs` by re-dispatching every seeded line a second time
and asserting zero row-count deltas in every sink table.

## 5. DAR / Paperclip is mothballed

DAR / Paperclip is **never a sink** for a notepad line, in any shape, under
any condition. There is no code path in `notepad-route-rule.ts` or
`notepad-dispatch.ts` that references it — `notepad-route-check.mjs` asserts
this statically by grepping the compiled sink modules for any reference to
Paperclip/DAR and requiring zero hits.
