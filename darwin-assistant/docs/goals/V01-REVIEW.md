# GOALS v0.1 — adversarial review (tree-5a1062ec, node #472)

**Verdict: PASS with fixes.** Five defects found and closed in place; three more
were investigated and cleared as non-defects (documented below so the next
reviewer doesn't re-derive them). Sim **80/80** (was 77/77 — three new checks
added for the fixes). `tsc` clean in darwin-assistant; cockpit typecheck shows
the same 11 pre-existing unrelated errors as the base commit, **zero** in any
`goals` file; `vite build` succeeds.

Branches (pushed, NOT merged, NOT deployed):
- backend `hopper/goals-v01` — worktree `/home/kevin/paperclip-worktrees/goals-v01/darwin-assistant`
- cockpit `hopper/goals-ui-v01` — worktree `/home/kevin/paperclip-worktrees/goals-ui-v01`

---

## §11 row-by-row

### THE ONE RULE — *a ghost solidifies only when the party who did NOT make the last edit approves it*
**PASS.** `setGhostToSet()` is the **only** `ghost → set` write in the module
(verified by grepping every `state = 'set'` in `src/goals.ts`: the others are
`verify(false)` from `check`, and `unpark`, neither reachable from `ghost` —
`parkGoalNode` rejects any state outside `set|planned|check|working`). Every
call to it goes through `applyAcceptToNode`, which enforces the gate. There is
no `resolve_pending` / `promote` / plan-approval escape hatch: `pending_*` is
only written on `set` nodes, and `promoteNode` stubs the node in place without
touching `state`.

### §11.1 DDL
| Item | Result |
|---|---|
| 4 additive columns via guarded `ALTER TABLE` | **PASS** — `ensureGoalNodeColumn()` PRAGMA-checks each. Deliberately *not* added to `CREATE TABLE`, so the ALTER path is exercised on every fresh scratch DB — i.e. the sim proves the live-DB migration works (SQLite accepts `NOT NULL DEFAULT 'none'` + `CHECK` on `ADD COLUMN`). |
| returned on every `GoalNodeRow` read | **PASS** — `GoalNodeRow extends GoalNodeDbRow`, every read is `SELECT *`, `buildDerivedNodes` spreads `{...n}`. |
| `GoalCounts.awaiting_jarvis` | **PASS** — one extra `SUM(...)` in the existing `countsStmt` (no new query). Declared in the cockpit type too; §11 doesn't require rendering the number and it isn't rendered. |

### §11.2 semantics
| Row | Result |
|---|---|
| Kevin PATCH on a ghost → `last_edited_by='kevin'`, one-shot snapshot, round reset, `ghost_edited_by_kevin` | **PASS after fix D1** (see below) |
| JARVIS PATCH / `edit_ghost` → `last_edited_by='jarvis'`, round reset, snapshot kept | **PASS** (sim V01-8b) |
| Kevin accept on his own edit → **does not set**, `awaiting_jarvis`, batch kept, ONE cue, siblings set normally | **PASS** (sim V01-3, V01-9b) |
| Kevin re-click while awaiting → `409 awaiting_jarvis` | **PASS** (sim V01-4). Note the deliberate asymmetry: a *batch* accept skips awaiting rows instead of 409-ing the whole batch — correct, and now given user-visible feedback (fix D4). |
| Kevin accept after a push-back → re-ask, note kept, cue quotes it | **PASS** (sim V01-6) |
| JARVIS accept while `awaiting_jarvis`/`pushed_back` → `set`, all four fields cleared, `node_agreed` | **PASS** (sim V01-7) |
| JARVIS accept with `review_state='none'` → v0 rule | **PASS after fix D3** |
| `push_back` → `pushed_back` + note, jarvis-only, non-empty note | **PASS**. Route defaults `actor='jarvis'` (a bare POST would otherwise 403 on the kevin default); the tool hardcodes `'jarvis'`. |
| discard → clears review fields | **PASS** — both `discardGoalNode` and `discardGoalBatch`. |
| `ghost → set` by any path clears all four | **PASS** — single choke point, see THE ONE RULE above. |

### §11.3 the cue
**PASS.** Exactly the `dispatch-gate.ts fireCue` seam: `getInFlightMessageId` →
`enqueueMessage`, else `processMessage(text, 'cockpit:goal-<id>', 'goal-cue:<goalId>:<eventId>')`
with a `ConversationBusyError` → enqueue fallback. Checked specifically for:
- **fires twice** — no. One cue per HTTP request: `acceptGoalNode` fires for its
  single node, `acceptRows` collects and fires once for the whole batch, and no
  route calls both (sim V01-3 and V01-9b assert the exact call count).
- **fires inside the write transaction** — no. There is no `sqliteDb.transaction`
  anywhere in `goals.ts`; every statement autocommits before the cue is built,
  and the post itself is deferred behind a dynamic `import()`.
- **no thread** — warns and returns; never throws into the accept.
- **conversation busy** — enqueues (both the in-flight pre-check and the thrown-error path).
- **circular import at module load** — no. `agent.ts` statically imports
  `buildGoalThreadContext` from `goals.ts`; `goals.ts` reaches back only through
  `await import('./agent.js')` at call time.

### §11.4 focus injection
**PASS.** `✎K` marker on Kevin-edited ghosts, ` — AWAITING YOUR TAKE (was: "…")`,
` — you pushed back: "…"`, and `awaiting_you="N"` on `<goal_tree>` (sim V01-9c).
`kevin_edit_original` is JSON-parsed defensively on both sides.

### §11.5 cockpit
| Item | Result |
|---|---|
| Click any row → focus **and** expand in place; second click collapses; one at a time | **PASS** — `expandedId` lives on the panel, not the row, so it survives refetch/SSE re-renders. |
| expansion survives refetch/SSE | **PASS after fix D5** |
| Full title / done_means / notes + meta line + `was: "…"` line, no truncation in the expanded block | **PASS** — every element in `NodeDetail` wraps; no `truncate` class anywhere inside it. |
| Inline edit on `ghost|set|planned`, `pending_removal=0`; save on blur or ⌘/Ctrl+Enter; Esc reverts | **PASS after fix D2.** Esc reverts the field and does *not* collapse the row or clear tree focus — the global key handler in `goals_.$goalId.tsx` correctly ignores keys whose target is an `INPUT/TEXTAREA/SELECT`, so `Backspace` while editing can no longer walk focus up the tree either. (The code comment above the collapse effect claims Esc collapses the row; it doesn't, and shouldn't — comment left as the only inaccuracy, behaviour is right.) |
| Row chips `✎ you` / `JARVIS weighing in…` (pulsing) / `JARVIS pushed back`; ✓ disabled only while awaiting | **PASS** — `RowBtn` gained a real `disabled` prop with the contract tooltip; `pushed_back` re-enables ✓ (re-ask). |
| `✓ all` toast splits the outcome | **PASS after fix D4** |
| Header card expands + edits (PATCH /goals/:id), no silent truncation | **PASS** — collapsed state keeps `truncate` + full `title=` tooltips, as do collapsed rows. |

---

## Defects found and closed

**D1 — a no-op or reorder-only PATCH counted as a Kevin edit.** `patchGoalNode`
flipped `last_edited_by='kevin'`, snapshotted `kevin_edit_original` and **reset
`review_state` to `none`** on *any* Kevin PATCH of a ghost — including one that
changed nothing, or only `sort_order`. Two live consequences: (a) a bare re-save
sent an untouched proposal to JARVIS for a weigh-in whose cue read `now: "X" /
was: "X"`; (b) worse, a re-save landing while `review_state='awaiting_jarvis'`
silently cancelled the round JARVIS was in the middle of answering, after which
JARVIS's `accept` fell through the `review_state='none'` branch and set the node
anyway. Fix: `patchGoalNode` now computes `textChanged` and only runs the §11
edit-tracking when `title`/`done_means`/`notes` actually differ (which is exactly
what the §11.2 table keys on). Covered by sim **V01-10** and **V01-11**.

**D2 — the UI clobbered a field Kevin was typing in.** `AutoTextarea`'s
`useEffect(() => setDraft(value), [value])` adopts any server-side change
unconditionally. The likely trigger is the loop this feature creates: Kevin OKs
an edit → the cue fires → JARVIS `accept`s or `push_back`s that node → a
`goal_node` SSE lands → the node's text changes under him while he is refining a
sibling field, wiping what he had typed. Fix: the effect now bails when
`document.activeElement` is this textarea; the skipped value is adopted on blur.

**D3 — `node_agreed` wasn't logged when JARVIS approved a Kevin edit Kevin hadn't
OK'd yet.** With `last_edited_by='kevin'` and `review_state='none'` (Kevin
reworded a ghost but said "yeah go ahead" in chat instead of clicking ✓), JARVIS's
`accept` correctly solidified — it is the non-editing party approving — but logged
it as a plain `node_accepted`, so the audit trail didn't record that JARVIS had
agreed to *Kevin's* wording. Fix: that branch now logs `node_agreed`. State
transition unchanged. Covered by sim **V01-12**.

**D4 — `✓ all` looked dead when every remaining ghost was already awaiting.** The
server (correctly) skips awaiting rows on a batch accept, so the request returned
`[]` and the UI showed nothing at all. Fix: `toast.info("JARVIS is weighing in on
your edits — see the chat")` when the batch produced no changes.

**D5 — a focus change collapsed the expanded row mid-edit.** The panel closed the
detail whenever `expandedId !== focusNodeId`, and focus can move without Kevin
touching the row (a `goal_focus` SSE from JARVIS's weigh-in turn). Collapsing
unmounts the textarea and loses the draft, which §11.5's "expansion survives
refetch/SSE" exists to prevent. Fix: the collapse is skipped while a textarea has
DOM focus; collapse-on-vanish (discarded/merged node) is unconditional as before.

## Investigated, not defects
- **JARVIS cueing itself into a loop** — the `goals` tool passes `actor:'jarvis'`
  on every accept path, so a JARVIS accept can never take the `awaiting` branch
  that fires a cue. HTTP routes default to `kevin`, which is right for the cockpit.
- **`missing done_means` blocking a batch** — the check ran over the unfiltered
  rows; harmless in practice (an awaiting node always has `done_means`, since
  accept requires it), but reordered to run over the rows actually processed.
- **`ALTER TABLE … CHECK` on a populated live table** — accepted by SQLite, and
  exercised on every sim run because the columns are intentionally absent from
  `CREATE TABLE`.

## Not fixed (deliberate)
- `GoalCounts.awaiting_jarvis` is plumbed to the cockpit type but never rendered.
  §11 doesn't ask for it; a small "N awaiting" pill on the header card is the
  obvious v0.2 follow-up.
- The meta line's "edited by you 2m ago" uses `updated_at`, which any later
  server-side change (e.g. JARVIS's `push_back`) also bumps, so the timestamp can
  drift off the actual edit. Cosmetic; a dedicated column would be the honest fix.
