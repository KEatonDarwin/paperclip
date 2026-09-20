# Tree Cue — wake JARVIS in a tree's origin thread on done/blocked

**Tree:** tree-c82544e2 · **Nodes:** #473 (backend) → #474 (adversarial review) · **Branch:** `hopper/tree-cue`

## The problem

When a hopper tree finished (or hit a wall), the only feedback was:

- the cockpit bell — a 🌳 `hopper_node`/tree notification, and
- the goals node hook (`goalsOnTreeStatus`) — updates a `/goals` node badge **if** a goal node references the tree.

**Nothing woke JARVIS in the thread that PLANTED the tree.** So review/deploy of a
finished tree waited for a commitment deadline, the watchdog, a scheduled
check-in, or for Kevin to ask "is it done yet?". Kevin (2026-09-19): *"what
normally happens after a tree, does it not somehow notify you immediately when
it's done running so the next steps can happen?"*

## The fix

`src/tree-cue.ts` registers a tree-status listener (`registerTreeStatusListener`,
`src/hopper-engine.ts`). On a tree's transition to **`done`** or **`blocked`**,
if the tree has an `origin_thread_ext`, it posts a short cue **into that origin
thread**, running a real JARVIS turn there — so review/deploy starts
immediately.

### The seam (identical to `dispatch-gate.ts` `fireCue`)

```
getInFlightMessageId(convId) → enqueueMessage(convId, text)   // thread is mid-turn
else processMessage(text, originExt, `tree-cue:<treeId>:<status>`)
  .catch(ConversationBusyError → enqueueMessage(convId, text))
```

`agent.js` + `thread-message-queue.js` are imported **dynamically** (mirroring
`goals.ts` `fireGoalReviewCue`) to avoid an import cycle and to keep the seam
testable with a scoped ESM loader hook.

### Registration / load

- `src/tree-cue.ts` calls `registerTreeStatusListener(treeCueOnTreeStatus)` at
  module load.
- `src/index.ts` has a side-effect `import './tree-cue.js';` next to the
  hopper-engine import, so the module actually loads in the live service.

### Dedupe

- Additive column `hopper_trees.last_cue_status TEXT` (PRAGMA-checked `ALTER`,
  same pattern as hopper-engine's router columns).
- One cue per `(tree, status)` transition: skip when `last_cue_status === status`.
- `'active'` **never cues**; it only re-arms the guard so the NEXT done/blocked
  cues again — covering both `blocked → active → blocked` AND
  `done → re-agreed → done` (a repair / continuation run). `agreeHopperTree` now
  emits that `'active'` notify (review #474; goals' listener no-ops on it unless
  the node was showing a blocked badge). No-op `active` pings don't write when
  the guard is already clear.
- The guard is set **before** the async post, so a second synchronous notify of
  the same status can't double-fire while the promise is in flight. If the
  dynamic `import()` itself fails the guard is cleared again (review #474), so a
  cue is never silently lost to its own dedupe.

### Skipped origins + skipped trees

Origin threads that must never be woken: `cockpit:hopper-node-*` (ephemeral
workers — this is what stops a cue spawning work recursively), `ephemeral:*`
(checkin/plumbing), `quick:*` (disposable quick chats).

**Foundry trees never cue** (review #474). A foundry project plants one hopper
tree per module plus an integration tree, and every one carries the *project's*
`origin_thread_ext` — cueing each would storm that thread with a JARVIS turn per
module and fight foundry's own auto-decide / integration-retry ladder. This is
the same reason `hopper-engine.ts` already suppresses foundry bells
(`isFoundryTree`). Foundry reports through `/foundry`.

### Kill switch

Settings-KV **`hopper_tree_cue`** — `'on'` (default) | `'off'` — read live via
`getSetting` (uncached), so Kevin can silence it without a restart.

### Finish-line-gate columns

When present, the tree's `original_ask` / `deferred_scope` columns (added by the
separate finish-line-gate tree) are included in the cue body. Absence is
tolerated entirely (checked once at module load via `PRAGMA table_info`).

## Cue text

```
[tree <id> "<topic>" <DONE|BLOCKED> — <done>/<total> nodes done[, N blocked]]
nodes:
  #<id> <status> <title>            (up to 12; "… (+N more)" past that)
[original ask: <text>]              (when the column exists + is set)
[deferred scope: <text>]            (when the column exists + is set)
<DONE:>    Next: review the deliverables against the original ask, then deploy/merge per your standing rules and mark the matching commitment done.
<BLOCKED:> blocked node(s):
             #<id> <title>[ [needs Kevin]] — <last result / question line>
           Next: unstick the blocked node(s) per the Smart Unblocker rule …
           (question-only tree → "Kevin's call, not yours. Surface it …")
```

`<done>` counts `done` **and** `split` nodes — a `split` parent is settled once
its children bubbled it up, so a finished tree reads `N/N` (review #474).
A `blocked_question` node prints its `question` (not its empty `result`) and is
tagged `[needs Kevin]`; when every blocked node is a question the Next line tells
JARVIS to surface it rather than answer it, matching the standing rule that
`blocked_question` is Kevin's call and the Smart Unblocker never touches one.

## Test — `scripts/tree-cue-check.mjs`

Scratch-DB exercise (no real model call: `dist/agent.js`'s dynamic import from
`tree-cue.js` is intercepted by `scripts/tree-cue-check.hooks.mjs` and stubbed).

```
npm run tree-cue:check      # builds first, then runs against /tmp/tree-cue-check.db
```

(The script refuses to run against the live `jarvis.db`.)

Covers (12 checks): DONE → exactly one cue with correct text; repeat DONE →
deduped (no second cue); BLOCKED → one cue with the blocked node + its last
result line; `active` never cues; `blocked → active → blocked` cues again;
`hopper_tree_cue=off` suppresses; worker/ephemeral/quick + null origins are
skipped; **foundry trees never cue**; **`blocked_question` shows the question,
is tagged `[needs Kevin]`, and gets the surface-don't-answer Next line**;
**a `split` parent counts as done**; **a re-agreed tree cues again**
(the last four added by review #474).

### Output (2026-09-19, post-review — 12/12 passed)

```
[tree-cue-check] scratch DB: /tmp/tree-cue-check.db

=== DONE cue text ===

[tree tree-1d1227c8 "build the tree-cue seam" DONE — 3/3 nodes done]
nodes:
  #1 done BACKEND — tree done/blocked cue
  #2 done SIM — scratch-DB test
  #3 done DOCS + push
Next: review the deliverables against the original ask, then deploy/merge per your standing rules and mark the matching commitment done.

=== BLOCKED cue text ===

[tree tree-77275ec5 "foundation gate build" BLOCKED — 1/3 nodes done, 1 blocked]
nodes:
  #4 done RECON
  #5 blocked BACKEND scaffold
  #6 draft REVIEW
blocked node(s):
  #5 BACKEND scaffold — composer create-project failed: missing PHP toolchain on the box
Next: unstick the blocked node(s) per the Smart Unblocker rule if the subscription juice allows; any node tagged [needs Kevin] is his call — surface it, don't answer it yourself.

=== RE-BLOCK cue (after active re-armed the guard) fired: OK ===
=== kill switch (hopper_tree_cue=off) suppressed the cue: OK ===
=== worker/ephemeral/quick origins skipped: OK ===
=== null origin skipped: OK ===
=== foundry module/integration trees skipped: OK ===

=== BLOCKED_QUESTION cue text ===

[tree tree-9fa42af8 "needs a product call" BLOCKED — 1/2 nodes done, 1 blocked]
nodes:
  #14 done RECON
  #15 blocked_question BUILD the export
blocked node(s):
  #15 BUILD the export [needs Kevin] — CSV or XLSX for the advertiser export?
Next: this is a blocked_question — Kevin's call, not yours. Surface it to him and answer the node only once he has decided.
=== split parent counted as done: OK ===
=== re-agreed tree cues again: OK ===

ALL TREE-CUE CHECKS PASSED ✅
```

## Adversarial review — node #474 (2026-09-19)

Verdict: **PASS with fixes** — 5 defects found, all fixed in place on this
branch; `tsc` clean, `npm run tree-cue:check` 12/12, and the unrelated
`goals:sim` (80/80) + `goals:review-checks` (14/14) still pass after the
`hopper-engine.ts` touch.

| # | Item reviewed | Verdict | Detail |
|---|---|---|---|
| 1 | Cue fires **once** per transition | **PASS** | Guard `hopper_trees.last_cue_status` is written *before* the async post; a repeat `done`/`blocked` notify is deduped (check 2). |
| 2 | Cue fires at the **FINAL** done, not before a finish-line audit node | **PASS (by construction)** | The cue rides the tree's status transition, which `maybeFinishTree` owns — it only notifies `'done'` when it actually flips `hopper_trees.status = 'done'`. The finish-line gate (tree-6097474e) is **not merged here or in the live checkout** (verified), and its design keeps the tree active until the audit node finishes, so the single notify stays the final one. **Constraint for that branch:** the gate must append its audit node *without* flipping `status='done'` first; if it ever flips-then-reopens, the reopened run is still covered because `'active'` now re-arms the guard (defect 3). |
| 3 | Dedupe guard vs. re-runs | **FAIL → fixed** | `'active'` only re-armed from `'blocked'`, and `agreeHopperTree` emitted no notify at all — so a DONE tree that was re-agreed for a repair/continuation run was deduped **forever** and never cued its second completion. Fixed: `agreeHopperTree` now notifies `'active'`, and the re-arm covers any set guard. Regression check 12. |
| 4 | Double-fire while the thread is busy | **PASS** | `getInFlightMessageId` → `enqueueMessage`, plus the `ConversationBusyError` catch — the exact `dispatch-gate.ts fireCue` seam. |
| 5 | Busy-thread **wedge** | **PASS** | `thread_message_queue` is drained server-side by the `status:false` SSE hook in `handlers/api-v1.ts` (`shiftQueuedMessage` → `processMessage`), so an enqueued cue runs when the in-flight turn ends. Nothing in this branch can strand it. |
| 6 | Cue landing in a **worker** thread / recursive work | **PASS** | `isNonWakeableOrigin` skips `cockpit:hopper-node-*`, `ephemeral:*`, `quick:*` (check 7). A tree planted *by* a worker carries that worker's ext and is skipped, so a cue cannot spawn work recursively. |
| 7 | Cue **storm** from one origin thread | **FAIL → fixed** | Foundry plants a tree per module + an integration tree, all carrying the project's origin thread — an 8-module project would have fired 8 JARVIS turns into it and fought foundry's auto-decide ladder (which is why the engine already suppresses foundry bells). Fixed: `foundry:` topics never cue. Regression check 9. |
| 8 | `blocked_question` handling | **FAIL → fixed** | The blocked block read `n.result`, which is **null** for a `blocked_question` (the text lives in `n.question`) — the cue printed a bare title — and the Next line invited JARVIS to "unstick" a node reserved for Kevin. Fixed: prints the question, tags `[needs Kevin]`, and a question-only tree gets a surface-don't-answer Next line. Regression check 10. |
| 9 | Header counts | **FAIL → fixed** | `split` parents were counted as not-done, so a finished tree could announce itself as `7/9 nodes done`. Fixed: `done` + `split`. Regression check 11. |
| 10 | Lost cue on import failure | **FAIL → fixed** | The guard was set before the post but never cleared if the dynamic `import()` rejected — that cue was gone permanently. Fixed: the `.catch` clears the guard so a later notify retries. |
| 11 | Module-load **import cycle** (hopper-engine ↔ agent ↔ tree-cue) | **PASS** | `tree-cue.ts` statically imports only `conversation-db.js` + `hopper-engine.js`; `agent.js` and `thread-message-queue.js` are dynamic (mirrors `goals.ts`). Nothing imports `tree-cue.ts` except the `src/index.ts` side-effect import, so no cycle exists in either direction. |
| 12 | The **ALTER guard** on the live DB | **PASS** | Additive `ALTER TABLE hopper_trees ADD COLUMN last_cue_status TEXT`, `PRAGMA table_info`-checked and try/caught. Ordering is safe: `hopper-engine.js` runs its `CREATE TABLE IF NOT EXISTS hopper_trees` at module load and is a *static* import of `tree-cue.ts`, so the table always exists before the ALTER (and before the module-level `prepare`). No data is rewritten; rollback is just reverting the code (the unused column can stay). |
| 13 | Settings-KV **kill switch** | **PASS** | `getSetting('hopper_tree_cue')` is read per-call and uncached, default `'on'`; `'off'` suppresses before any DB write or compose (check 6). |
| 14 | Optional finish-line columns | **PASS** | `original_ask` / `deferred_scope` are PRAGMA-detected once at load and read defensively; absence is tolerated (they are absent on the live DB today). |
| 15 | NO API KEYS / no new deps | **PASS** | No model call in this module — it hands text to `processMessage`, which uses the existing subscription CLI path. No dependency added; the test stubs the model call entirely via a scoped ESM loader hook. |

### Known, accepted behaviour (not defects)

- A cue **runs a real JARVIS turn** on the origin thread's pinned model — that is
  the whole point of the feature, and it is the origin thread's own model/budget.
  Several trees planted from one thread (e.g. a BI wave) will cue several turns;
  they serialize through the thread queue rather than running concurrently.
- The cue does not consult the hopper governor. It is a single turn in Kevin's
  own thread, the same as any cockpit message, and the kill switch covers the
  case where he wants silence.
