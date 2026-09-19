# SIM-V2 — client-contract-driven proof on a scratch DB

Node #451 (tree tree-fb2b1d82). Proves SPEC.md "V2 — THE INTERACTION CORRECTION" end to end
against the exact client<->server wire contract, not just the backend in isolation — the lesson
from v1 (three client<->server breaks shipped past a backend-only 43/43 sim, caught only by the
adversarial review). Companion to `docs/workbench/RECON-V2.md` (node #446's contract table) and
v1's `docs/workbench/{RECON,SIM,REVIEW,DECISIONS}.md` (different branch, `hopper/workbench`).

**Script:** `scripts/workbench-sim-v2.mjs`. Run with `npm run build && node scripts/workbench-sim-v2.mjs`
after setting `JARVIS_DB_PATH` to a scratch path (the script refuses to run against the live
jarvis.db). Real Express router, real HTTP over a throwaway port, real `workbench` tool calls —
zero live model calls (a fake `claude` binary stands in for both the placement one-shot path and
the dispatch route's real `processMessage()` call, same pattern as `multi-claude-e2e-sim.mjs`).

**Result: ALL 55 checks passed, 1 non-blocking finding (see §4 below).**

## How this sim avoids the v1 failure class

Rather than re-implement the client's request bodies from memory, the sim:
1. **Reads the real client source** (`jarvis-command-center` worktree `/home/kevin/worktrees/workbench-v2-ui`,
   `src/lib/cockpit-api.ts`) as text and extracts the actual `JSON.stringify({...})` object literal
   each function sends, and the actual `r.<field>` reads each function does on the response.
2. **Reads the real route source** (`src/handlers/api-v1.ts`) and extracts the actual `body.<field>`
   reads inside each route handler.
3. **Diffs them (§0 below)** — any field the client sends that the route never reads is a FAIL.
   All 5 client<->route pairs (`sayToWorkbenchBrain`, `dispatchWorkbenchNode`,
   `acceptWorkbenchProposals`, `rejectWorkbenchProposals`, `workbenchJot`) passed with zero mismatch.
4. **Then actually drives the wire** with those same shapes over real HTTP for every behavioral item.
5. **Zoom purity (item 2)** can't be proven by hitting an endpoint (the whole point is that zoom
   calls NO endpoint) — so it's proven by extracting `zoomTo()`'s real function body out of the
   real `workbench.tsx` source and asserting it contains no thread/chat/fetch calls, plus scanning
   every `useEffect` in the file for the exact v1 defect shape (a zoom-keyed effect that opens a thread).

## Item-by-item

**1. `/workbench/say` session lifecycle** — first-ever call births a session (`seed_text` present,
external_id `cockpit:workbench-brain-<uuid>`); a second call within the idle window reuses it
(`seed_text: null`, same external_id); a focus change (root -> node) injects a `[focus: #id "title"]`
header + subtree snapshot into `wrapped_text`; an unchanged focus omits it (bare text, verified
byte-exact both times — root->root and node->same-node); `force_new: true` ends the open session and
starts a genuinely new one (different external_id, `seed_text` present again). `GET /workbench/session`
resolves the currently-open sitting without ever advancing `last_activity_at` (two consecutive bare
GETs return byte-identical timestamps), and correctly flips to the new sitting's ext once `force_new`
supersedes the old one.

**2. Zoom purity** — `zoomTo()`'s body contains only a `navigate({...})` URL update; no
`openWorkbenchNodeChat`, `openWorkbenchRootChat`, `sayToWorkbenchBrain`, or raw `fetch`/`req` call.
No `useEffect` anywhere in `workbench.tsx` opens or binds a thread as a side effect (the exact v1
defect — a zoom-keyed effect that eagerly opened a thread per node visited — is gone). The
"Open chat" deep-dive affordance still exists as an explicit, non-zoom call site.

**3. Ghost proposals** — `propose_batch` (called through the real `workbench` tool, from an unbound
thread the way a brain session would) returns every row including nested ones (the node #448 fix —
"must return nested rows, not just top-level" — holds). Hierarchy is correct: top-level items get
`parent_node_id` = the real parent; a nested item gets `parent_proposal_id` pointing at its sibling
proposal, `parent_node_id: null`. `GET /workbench/proposals` groups by batch. A partial reject
(`ids: [oneNestedId]`) removes only that ghost + its descendants and never touches the real tree
(node count unchanged, verified). A full accept materializes the rest via `createSmartTodoNode`,
returning real node ids with the correct `parent_id`, and deletes the accepted proposals. A second,
nested-parent+child batch proves the accept-time parent resolution is correct — the child's real
`parent_id` is the newly minted PARENT's real id, never a stale proposal id (the exact trap
RECON-V2 flagged). `accept_batch` called via the tool itself (the "Kevin said yes in conversation"
path) uses the identical internal code path as the HTTP route. `workbench_proposal` SSE events fire
for `created`, `rejected`, and `accepted`.

**4. Bulk-creation rule — ⚠️ one honest finding, not a wiring break.** `add_child` is mechanically
capped at one node per call — its execute() handler only ever reads a single `title`; even smuggling
an `items` array into the call args produces exactly one node and the smuggled items are never
materialized. That part of SPEC.md's rule is real and enforced in code. **However: `split` still
writes MULTIPLE real nodes directly in one call** (verified: a `split` with two children materialized
both immediately, bypassing `propose_batch` entirely). SPEC.md's binding contract states "any
creation of >1 node MUST be a proposal... never add_child/split" — but `workbench-tool.ts`'s `split`
handler has no guard routing multi-item calls through `propose_batch`; the rule is enforced ONLY via
the tool description's prompt instruction to the model, not in code. This is not a client<->server
wiring defect (split predates v2, and v1's own per-node scoped chats still use it as designed) — but
it does mean a brain-session model call can still bulk-write around the ghost/correction layer if it
ignores the instruction and reaches for `split` instead of `propose_batch`. **Flagging for the
reviewer/Kevin to decide** whether `split` needs the same `>1 item -> propose_batch` guard that
`propose_batch`'s own `parent_id` handling and `add_child`'s single-title shape already have.

**5. Dispatch** — `POST /workbench/nodes/:id/dispatch` returns 201 with an EXPLICIT model
(`claude-sonnet-5` by default, never inherited/undefined) and a worker thread ext scoped to the
node (`...workbench-worker-<nodeId>-<hex>`). `GET .../dispatch` immediately reflects the same row
(`running`, correct model + worker_thread_ext). A second dispatch while the first is still `running`
-> 409 `dispatch_already_running`, not a duplicate worker. The `spawn_tasks` row has every column
`jarvis-spawn-reconcile.py`'s generic `WHERE status IN ('running','stuck')` sweep reads
(`thread_ext`, `conversation_id`, `model`, `workbench_node_id`) — confirmed by reading the
reconciler's actual query, not assumed. After the fake worker finishes (~0.6s), the row is still
`running` with `error: null` — proving the real `processMessage()` call succeeded end-to-end through
the fake `claude` binary (the adapter correctly strips `ANTHROPIC_API_KEY`); the flip to `done` is
the external 5-minute reconciler's job, not this route's, so a third dispatch attempt still 409s
until that flip happens — simulated by hand-updating the row to `done`, after which a fourth dispatch
is correctly allowed as a genuinely new attempt. `GET .../dispatch` on a never-dispatched node
returns `status: "none"`.

**6. Scope guard** — the v1 per-node scope guard is untouched: a chat bound to node A (via
`POST /workbench/:id/open-chat`, same `linked_thread_ext` contract as before) is refused writing to
an unrelated sibling node B ("outside your scope" error) and can freely write to its own node.
The v2 brain session thread (from item 1, `cockpit:workbench-brain-<uuid>`) is never bound to any
node's `linked_thread_ext` — it therefore resolves to root/unrestricted scope by construction and
can `write_context` on a node it never zoomed into, matching SPEC.md's "Brain scope = tree-wide."
A dispatch worker thread is likewise unbound and gets the same unrestricted scope, matching its own
finish contract (`write_context`/`set_status` on its target node from an unscoped thread).

**7. Regression** — runtime: `/smart-todos` list/PATCH/move/DELETE all return their pre-existing
envelope shapes unchanged; the v1 `/workbench/scope/root` and `/workbench/root/open-chat` routes
still work exactly as before, additive alongside v2. Git evidence (checked against the v1 review
baseline commits, not assumed): `src/smart-todos.ts` and `src/tools/smart-todos-tool.ts` are
byte-identical since `378f93a13` (the v1 adversarial-review commit); every diff hunk in
`src/handlers/api-v1.ts` since that same baseline lands outside the `/smart-todos/*` route block
(lines 2408-2597); `src/routes/tree.tsx` in the UI repo is byte-identical since `bfdee11` (the v1 UI
review-fix commit). Flight Deck / workstreams / turn / next_action: zero references anywhere in
either diff (grepped during authoring; not reintroduced by v2).

## Captured run

```
[workbench-v2-sim] scratch DB:    /tmp/workbench-v2-sim-final.db
[workbench-v2-sim] scratch dir:   /tmp/workbench-v2-sim-pQcFDz
[workbench-v2-sim] fake claude:   /tmp/workbench-v2-sim-pQcFDz/fake-claude.sh
[workbench-v2-sim] server: http://127.0.0.1:46591/api/v1

[0] automated client<->server field-name diff
  ✓ sayToWorkbenchBrain -> POST /workbench/say: every client-sent field is read by the route (focus_id, force_new, text)
  ✓ dispatchWorkbenchNode -> POST /workbench/nodes/:id/dispatch: every client-sent field is read by the route (instructions)
  ✓ acceptWorkbenchProposals -> POST /workbench/proposals/:batchId/accept: every client-sent field is read by the route (ids)
  ✓ rejectWorkbenchProposals -> POST /workbench/proposals/:batchId/reject: every client-sent field is read by the route (ids)
  ✓ workbenchJot -> POST /workbench/jot: every client-sent field is read by the route (text, focus_id)
  ✓ sayToWorkbenchBrain reads only external_id/seed_text/wrapped_text (matches WorkbenchSayResult)
  ✓ dispatchWorkbenchNode reads only fields the dispatch route actually returns

[1] /workbench/say session lifecycle
  ✓ first /workbench/say ever -> 201, seed_text present (session birth)
  ✓ second /workbench/say within idle window -> 200, seed_text null (session reused), same external_id
  ✓ unchanged focus (null -> null) omits the header/snapshot wrapper
  ✓ focus change (root -> node) -> same session, wrapped_text carries a focus header + subtree snapshot
  ✓ unchanged focus (node -> same node) omits the header again
  ✓ GET /workbench/session resolves the open sitting WITHOUT extending it (a bare GET never ticks last_activity_at)
  ✓ a second consecutive bare GET returns byte-identical last_activity_at (idempotent read)
  ✓ force_new=true -> a brand NEW session (different external_id), seed_text present again
  ✓ GET /workbench/session now resolves the NEW sitting (old one ended)

[2] zoom purity (static contract check on the real UI source)
  ✓ zoomTo() — the click/zoom handler — makes NO network/thread/chat calls
  ✓ no useEffect anywhere in workbench.tsx opens/binds a thread as a side effect
  ✓ openWorkbenchNodeChat is only reachable from an explicit "Open chat" action, not from zoom

[3] ghost proposals: propose_batch / accept / reject / SSE
  ✓ propose_batch (tool) returns ok + a batch_id + ALL rows incl. nested (top-level fix from node #448 holds)
  ✓ proposal hierarchy: Sub 1/Sub 2 hang off the real parent, Sub 2a hangs off the Sub 2 PROPOSAL (not the real node)
  ✓ GET /workbench/proposals groups by batch and the tree is UNTOUCHED so far
  ✓ reject with a partial ids[] removes ONLY that proposal (and any nested under it), never touches the real tree
  ✓ Sub 2a is gone, Sub 1 + Sub 2 remain pending
  ✓ reject truly never touches the real tree (node count unchanged)
  ✓ accept (whole remaining batch) -> 200, created returns real node ids, correct parent
  ✓ accepted proposals are deleted from the ghost table
  ✓ nested accept: Child C.parent_id resolves to Parent P's REAL id, not the proposal id
  ✓ accept_batch via the workbench TOOL works (same internal path as the HTTP route)
  ✓ SSE: workbench_proposal fired "created" for every propose_batch and "rejected"/"accepted" for every resolve

[4] bulk-creation rule (contract-level)
  ✓ add_child creates exactly ONE node per call even if an items array is smuggled in — it has no code path that reads it
  ✓ the tool contract documents add_child as the single-node exception, everything else routes through propose_batch
  ⚠ FINDING: 'split' still writes MULTIPLE real nodes directly in one call, bypassing propose_batch — SPEC.md's "any creation of >1 node MUST be a proposal" / "never add_child/split" rule is enforced ONLY via the tool description's prompt instruction, not in split's execute() handler (workbench-tool.ts op 'split' has no items.length>1 guard routing to propose_batch). Not a wiring break — split predates v2 and v1's own per-node scoped chats still rely on it — but it means a brain-session model call CAN still bulk-write around the ghost layer if it ignores the instruction. Flagging for the reviewer/Kevin to decide whether split needs the same guard propose_batch/add_child already have.

[5] explicit node dispatch
  ✓ POST dispatch -> 201, explicit model (never inherited/undefined), worker thread ext scoped to this node
  ✓ GET status immediately reflects the same row (running, correct model + worker_thread_ext)
  ✓ a SECOND dispatch while one is still running -> 409, not a duplicate worker
  ✓ the reconciler schema accepts this row (workbench_node_id stamped, thread_ext/conversation_id/model present — the exact columns jarvis-spawn-reconcile.py's generic `WHERE status IN ('running','stuck')` sweep reads)
  ✓ after the worker finishes, status is STILL "running" (never flipped to "failed") — proves processMessage() succeeded through the fake claude; running->done is the external 5-min reconciler's job, not this route's
  ✓ the 409 guard checks status==="running" only — since running->done is the reconciler's job (not this route's) and it never ran in this sim, the row is STILL "running" even after the worker finished, so a third dispatch correctly still 409s rather than double-spawning
  ✓ once the reconciler (simulated here) flips the prior attempt to done, a fresh dispatch is allowed again — a genuinely new attempt, not a duplicate
  ✓ GET dispatch status on a node that's never been dispatched -> status 'none'

[6] scope guard: v1 intact + brain/dispatch tree-wide
  ✓ v1 per-node open-chat still binds one thread per node (untouched contract)
  ✓ a per-node scoped chat (bound to node A) is REFUSED writing to an unrelated node B — v1 scope guard intact
  ✓ the SAME scoped chat CAN write to its own bound node
  ✓ the BRAIN session thread (unbound — never a linked_thread_ext on any node) has unrestricted tree-wide scope, and can write to a node it never zoomed into
  ✓ a DISPATCH WORKER thread is likewise unbound -> unrestricted scope, matching its own finish contract (write_context/set_status on its target node, or in principle any node)

[7] regression: smart-todos untouched (runtime + git evidence)
  ✓ GET /smart-todos -> { nodes: [...] }, exactly the pre-existing envelope
  ✓ PATCH /smart-todos/:id -> { node } shape unchanged, patch applied
  ✓ POST /smart-todos/:id/move -> { node, nodes } shape unchanged
  ✓ DELETE /smart-todos/:id -> 204 empty body, unchanged
  ✓ v1 GET /workbench/scope/root still works, additive-only alongside v2
  ✓ v1 POST /workbench/root/open-chat still works (find-or-create, 200 or 201 either way)
  ✓ git: src/smart-todos.ts byte-identical since the v1 review baseline (378f93a13)
  ✓ git: src/tools/smart-todos-tool.ts byte-identical since the v1 review baseline
  ✓ git: the /smart-todos/* route block in api-v1.ts is untouched (all v2 diff hunks land outside lines 2408-2597, verified against the review baseline)
  ✓ git (UI repo): src/routes/tree.tsx byte-identical since the v1 UI review baseline (bfdee11)

[workbench-v2-sim] ALL 55 checks passed ✅
[workbench-v2-sim] 1 non-blocking finding(s) recorded for the reviewer — see docs/workbench/SIM-V2.md
```

## Verdict

Client<->server wiring for all of v2 (say/sessions, zoom purity, proposals, dispatch, scope guard)
is correct and matches SPEC.md and RECON-V2.md's contract table. Regression surface (`/tree`,
`/api/v1/smart-todos/*`, the `smart_todos` tool, v1's own `/workbench` routes) is untouched, proven
by both runtime behavior and git diff against the pre-v2 baseline on both repos. One real,
non-blocking gap found and documented in §4 (`split` bypasses the ghost layer for bulk writes) —
recommend the adversarial review decide whether to gate it before deploy or accept it as a known,
low-probability deviation (the prompt instruction already steers the model away from it, and no
existing v1 caller relies on multi-child `split` calls from an unrestricted/tree-wide thread).
