# Tree Cue — wake JARVIS in a tree's origin thread on done/blocked

**Tree:** tree-c82544e2 · **Node:** #473 · **Branch:** `hopper/tree-cue`

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
- `'active'` **never cues**; it only re-arms the guard (`blocked → active`) so a
  `blocked → active → blocked` cycle can cue again. The frequent no-op `active`
  pings (fired on every node finish) don't write unless the guard was `blocked`.
- The guard is set **before** the async post, so a second synchronous notify of
  the same status can't double-fire while the promise is in flight.

### Skipped origins

Origin threads that must never be woken: `cockpit:hopper-node-*` (ephemeral
workers), `ephemeral:*` (checkin/plumbing), `quick:*` (disposable quick chats).

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
             #<id> <title> — <last result line>
           Next: unstick per the Smart Unblocker rule or escalate.
```

## Test — `scripts/tree-cue-check.mjs`

Scratch-DB exercise (no real model call: `dist/agent.js`'s dynamic import from
`tree-cue.js` is intercepted by `scripts/tree-cue-check.hooks.mjs` and stubbed).

```
npm run build
node --import ./scripts/tree-cue-check.hooks.mjs scripts/tree-cue-check.mjs
```

Covers: DONE → exactly one cue with correct text; repeat DONE → deduped (no
second cue); BLOCKED → one cue with the blocked node + its last result line;
`active` never cues; `blocked → active → blocked` cues again; `hopper_tree_cue=off`
suppresses; worker/ephemeral/quick + null origins are skipped.

### Output (2026-09-19, all checks passed)

```
[tree-cue-check] scratch DB: /tmp/tree-cue-check.db

=== DONE cue text ===

[tree tree-3208594e "build the tree-cue seam" DONE — 3/3 nodes done]
nodes:
  #1 done BACKEND — tree done/blocked cue
  #2 done SIM — scratch-DB test
  #3 done DOCS + push
Next: review the deliverables against the original ask, then deploy/merge per your standing rules and mark the matching commitment done.

=== BLOCKED cue text ===

[tree tree-7f820a87 "foundation gate build" BLOCKED — 1/3 nodes done, 1 blocked]
nodes:
  #4 done RECON
  #5 blocked BACKEND scaffold
  #6 draft REVIEW
blocked node(s):
  #5 BACKEND scaffold — composer create-project failed: missing PHP toolchain on the box
Next: unstick per the Smart Unblocker rule or escalate.

=== RE-BLOCK cue (after active re-armed the guard) fired: OK ===
=== kill switch (hopper_tree_cue=off) suppressed the cue: OK ===
=== worker/ephemeral/quick origins skipped: OK ===
=== null origin skipped: OK ===

ALL TREE-CUE CHECKS PASSED ✅
```
