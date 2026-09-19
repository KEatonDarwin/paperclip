# RECON-V2 — mapping v1 + the seams v2 rides on

Node #446 (tree tree-fb2b1d82). Read-only recon; the only change in this commit is this file.
Companion to `docs/workbench/{RECON,SIM,REVIEW,DECISIONS}.md` (v1) — read those first for the
v1 build/verify trail. This doc maps exactly where v2 (SPEC.md "V2 — THE INTERACTION
CORRECTION") needs to cut in, with a binding client↔server contract table so the UI and SIM
nodes build against the same field names instead of drifting (the v1 lesson — 3 client/server
mismatches shipped past a backend-only sim; see v1 REVIEW.md).

All line numbers below are against `hopper/workbench-v2` @ `99b80cb6d` (this worktree's HEAD).

---

## 1. The v1 workbench surface (what exists today)

### Backend — `darwin-assistant`

| File | What's there |
|---|---|
| `src/workbench.ts` (505 lines) | §1 Zoom (`getWorkbenchScope`), §5 Placement (`matchOrCreatePlacement`, the shortlist+one-shot-claude jot brain), §3/4 scope resolution for the tool (`resolveWorkbenchToolScope`, `assertWorkbenchScope`) + seed-text builder (`buildWorkbenchSeedText`). All pure functions the routes call into. |
| `src/tools/workbench-tool.ts` (281 lines) | The `workbench` tool: `list_scope / add_child / split / update / set_status / move / write_context / read_up`. Scope resolved server-side from `context?.externalId` via `resolveWorkbenchToolScope` — never from a model-supplied arg. |
| `src/handlers/api-v1.ts` | Three routes, `/workbench/*` namespace, all additive next to (not touching) `/smart-todos/*`: `GET /workbench/scope/:id` (2596), `POST /workbench/jot` (2615), `POST /workbench/:id/open-chat` (2651, handles both a node id and the `root`/`0` sentinel). |
| `src/tools/index.ts` | Registers the `workbench` tool (mirrors how `smart_todos` is registered — both stay globally registered per Kevin's D2 constraint). |

### Cockpit — `jarvis-command-center`

| File | What's there |
|---|---|
| `src/routes/workbench.tsx` (875 lines) | The page. Fetches the whole tree client-side (`listSmartTodos()`), derives zoom/ancestors/subtree in-memory from `focus` in the URL search params (no dedicated fetch per zoom). Renders `NodeRow` recursively, the jot bar + landing receipt (Move/Undo), and docks `WorkbenchChatBar` at the bottom. |
| `src/components/WorkbenchChatBar.tsx` (196 lines) | The docked strip. Built from `Timeline` + `Composer` (imported from `@/routes/threads` — the SAME building blocks `ThreadPane.tsx` uses, not a copy). Calls `getThread(externalId)` on mount, `sendMessage` on send, subscribes via `openGlobalEvents` for live stream/turn/status. |
| `src/lib/cockpit-api.ts` | Client fns: `workbenchJot` (2703), `openWorkbenchNodeChat` (2732), `openWorkbenchRootChat` (2748), plus the pre-existing `sendMessage`/`getThread`/`openGlobalEvents` this file reuses. |

### THE DEFECT v2 removes (exact location)

`workbench.tsx` lines 181–224: a `useEffect` keyed on `effectiveFocusId` that on **every zoom
change** calls `openWorkbenchNodeChat`/`openWorkbenchRootChat` (find-or-create a thread) and, if
the thread is new, immediately `sendMessage(externalId, seedText)` — i.e. every first click into
a fresh branch fires a real JARVIS turn before Kevin has typed anything. This is exactly what
Kevin's feedback is about ("clicking on any one of the tree items... have it start to think").
v2 deletes this effect outright: **click = zoom = pure client-side state change, zero network
calls that create a thread or post a message.**

---

## 2. The message dispatch path (2-step pattern) — confirmed, reused as-is

`POST /api/v1/threads/:external_id/messages` (`api-v1.ts:3631`) is the ONE ingress that starts a
real JARVIS turn:

- Body: `{ text: string, images?: OutgoingImage[] }` (`images[].{data,mime}`, base64).
- If the thread is already mid-turn: `202 { status: "queued", queued_id, pending_message_id }`
  (server-owned FIFO, drained when the running turn ends).
- Else: fires `processMessage(text, externalId, messageId, images?)` (fire-and-forget on the
  server; not awaited by the route) and returns `202 { message_id, status: "processing",
  poll_url, events_url }` immediately.
- Poll: `GET /threads/:external_id/messages/:message_id` (3776) → `{status: "processing"}` until
  the assistant turn lands, then the turn content.

**The 2-step "create-thread-then-post" pattern** (hopper promote is the reference instance,
`api-v1.ts:2086-2124` server / `cockpit-api.ts:2435-2448` client): the mutating POST
(`/hopper/:id/promote`, or v2's `/workbench/say`) does the find-or-create + composes a seed, and
returns `{external_id, seed_text}` WITHOUT itself starting a turn. The **client** then calls
`sendMessage(externalId, seedText)` separately. Confirmed end-to-end in `hopper.tsx:74-75`:
```ts
const { externalId, seedText } = await promoteHopperItem(item.id, opts);
await sendMessage(externalId, seedText);
```
This is exactly the shape spec'd for `POST /workbench/say` — reuse it verbatim, don't
reinvent a variant.

`sendMessage` client fn: `cockpit-api.ts:1457-1468` — `sendMessage(externalId, text, signal?,
images?)` → POST to `/threads/:ext/messages`.

---

## 3. The spawn-worker pattern (for `POST /workbench/nodes/:id/dispatch`)

Two candidate shapes exist in the codebase; **the in-process one is the right model to copy**,
not an HTTP round-trip through the API server's own `/threads/:ext/messages`:

**`hopper-engine.ts:529-550` (`spawnWorker`) — the pattern to copy.** Runs server-side, in the
same process as the route handlers (`api-v1.ts` already imports `processMessage` directly at
line 275, used for the messages route itself):
1. `getOrCreateConversation(ext)` — ext is a fresh `cockpit:...-<uuid>` thread.
2. `renameConversation(conv.id, label)`.
3. `setThreadModelOverride(conv.id, adapter, model)` — **explicit model, always set, never
   inherited from the parent thread's own override** (this is the exact mechanism spec's
   dispatch contract means by "explicit model, default claude-sonnet-5, NEVER inherited").
4. Insert a `spawn_tasks` row (see below).
5. `await processMessageRef(prompt, ext, messageId)` — calls straight into the same
   `processMessage` function the HTTP route uses, in-process, no self-HTTP-call.
6. On spawn failure (busy/adapter error), roll back cleanly rather than leaving a stuck claim.

Dispatch backend (a future node) should follow this shape: build the worker prompt (node +
ancestor titles/notes + `context_notes` + Kevin's `instructions`), `getOrCreateConversation`,
`setThreadModelOverride(conv.id, 'claude', model ?? 'claude-sonnet-5')`, insert into
`spawn_tasks`, call `processMessage(prompt, ext, messageId)` directly (already imported in
`api-v1.ts`), return `202` with the ext + spawn_tasks id. No need for the 2-step create+POST
pattern here — that pattern exists for CLIENT-driven thread starts (Kevin's own message going
out); a server-initiated dispatch can call `processMessage` directly like hopper-engine does.

**`spawn_tasks` table** (`src/spawn-tasks.ts:14-36, 38-63`): `id, thread_ext (UNIQUE), 
conversation_id, parent_thread_ext, parent_conversation_id, group_id, label, task_prompt, model,
status ('running'|'done'|'stuck'|'failed'|'released'), pid, result, error, message_id,
turn_count, last_seen_running, created_at, updated_at, last_heartbeat, hopper_tree_id,
hopper_node_id`. The hopper engine's own insert (`hopper-engine.ts:518-521`) does NOT populate
`model` — dispatch's insert SHOULD (spec calls for an explicit model always), that's an
additive field the existing schema already supports, no migration needed.

**The reconciler's expectations** (`scripts/jarvis-spawn-reconcile.py:321-345`): polls
`spawn_tasks WHERE status IN ('running','stuck')`, cross-checks each via
`GET /threads/:ext` (the `running` + `turn_count` fields on the descriptor) — NOT anything
dispatch-specific. `hopper_node_for_spawn` (line 132) tries `hopper_node_id` first, then a
regex against `thread_ext` for `cockpit:hopper-node-<id>`-shaped externals for the
hopper-specific finish-recovery path; a `cockpit:workbench-dispatch-<uuid>` ext simply won't
match that fallback and the reconciler falls through to its generic done/stuck logic
(turn_count advanced → done, stale + no progress → stuck) — **that's sufficient and correct for
workbench dispatch, no reconciler changes needed.** Worker finish contract per spec is
"append outcome to `context_notes` + optionally set status" — this should happen via the
existing `write_context`/`set_status` workbench-tool ops the spawned worker calls itself (it's
just a normal JARVIS turn with tool access), not a bespoke finish endpoint. `GET
/workbench/nodes/:id/dispatch` (status query, spec'd) should read the latest `spawn_tasks` row
for that node (join on a new `smart_todo_node_id` stamp column, or infer via `parent_thread_ext`
matching a `cockpit:workbench-dispatch-<node id>-<uuid>` naming convention — see trap #3 below).

---

## 4. Brain inline rendering — reuse, and the one real gap

`WorkbenchChatBar.tsx` already proves the reuse path for spec's "docked bar = the brain: inline
conversation render": `Timeline` + `Composer` (both from `@/routes/threads`, the same components
`ThreadPane.tsx` uses — line 27 of that file) + `getThread(externalId)` for history +
`openGlobalEvents` for live stream/turn/status deltas + `sendMessage` for sending. v2's brain bar
is the same shape, just re-pointed at the session ext instead of a per-node ext, and NOT
re-created on every zoom (spec: "Zooming re-points, never re-binds threads").

**Trap found — `getThread` 404s before a session exists.** `WorkbenchChatBar` calls
`getThread(externalId)` unconditionally on mount (`WorkbenchChatBar.tsx:52-58`), and
`getThread` (`cockpit-api.ts:1433-1438`) is a plain `GET /threads/:externalId` — 404 if the
conversation row doesn't exist yet. Spec's `POST /workbench/say` only find-or-creates the
session on an actual send (needs `text`), so **on page load, before Kevin's first message of a
sitting, there is no thread to `getThread` against** — nothing in the current contract lets the
UI discover "is there already a live session within `workbench_session_idle_hours`, and if so
what's its ext" without sending a message. Two ways to close this, flagging for the backend/UI
nodes rather than deciding it here:
  (a) add a cheap read-only `GET /api/v1/workbench/session` → `{external_id, last_activity_at}
      | {external_id: null}` the UI calls on mount to resolve (and immediately render Timeline
      via `getThread`) an in-progress sitting; or
  (b) the UI simply renders composer-only (no Timeline) until the first send of a sitting
      returns an ext, matching how `ThreadPane`/`WorkbenchChatBar` already tolerate "no thread
      yet" today for a brand-new per-node chat (before v2, that case didn't really exist because
      the eager-open effect always created one).
  (a) is cheap (one prepared statement against `workbench_sessions`) and makes a page
  reload mid-sitting NOT look like a fresh chat, which matches "PER-SITTING... the tree is
  long-term memory, conversations stay disposable" — a *reload* shouldn't count as a new
  sitting. Recommend (a); note it as a gap in SPEC.md's contract table (§ below) since the spec
  as written doesn't define this GET.

---

## 5. SSE plumbing

- Server event union: `src/sse-bus.ts:295-306` (`SSEEvent`). `SmartTodoEvent` (232-236,
  `{type:'smart_todo', action:'created'|'updated'|'deleted'|'bulk', node?}`) already fires on
  every workbench-tool write today (tree edits reuse the pre-existing smart-todos emit path —
  `workbench-tool.ts` calls `createSmartTodoNode`/`updateSmartTodoNode`/etc. from
  `smart-todos.ts`, which already call `emit(...)`; nothing workbench-specific needed there).
- Global forward allowlist: `api-v1.ts:4388-4397` (`/events` route) — `smart_todo` and
  `hopper_item` are both already in the `FORWARD` set as precedent for a new global (not
  conversation-scoped) event type.
- Frontend: `src/lib/sse-worker.ts:28-49` (`EVENT_TYPES`, includes `hopper_item`/`smart_todo`) →
  `cockpit-api.ts:3789-3807` (`GlobalEventHandlers`, `onHopperItem`/`onSmartTodo`) →
  `openGlobalEvents` (4030) is the single subscription point `workbench.tsx` already uses
  (line 105: `openGlobalEvents({ onSmartTodo: () => void reload() })`).

**For the ghost/proposal layer:** add `WorkbenchProposalEvent {type:'workbench_proposal',
action:'created'|'accepted'|'rejected', batch_id, proposal?}` following the exact
`HopperItemEvent`/`SmartTodoEvent` shape (`sse-bus.ts` ~222-236) — global, not
conversation-scoped, same treatment. Add to the `SSEEvent` union (306), the `FORWARD` set
(4394-4396), `sse-worker.ts` `EVENT_TYPES` (49), and a `GlobalEventHandlers.onWorkbenchProposal`
in `cockpit-api.ts` (near 3807). This is the smallest-diff option since it doesn't need a new
per-node subscription — the whole tree page already reloads on any `smart_todo`/proposal event,
so ghosts appearing/resolving "live above the chat" falls out of the existing reload-on-SSE
pattern `workbench.tsx` already has, no new polling loop needed.

---

## 6. Client ↔ Server contract table (binding — code against this verbatim)

| Route | Method | Request body | Response shape | Client fn (existing or to add) |
|---|---|---|---|---|
| `/workbench/scope/:id` | GET | — (`:id` = node id or `root`/`0`) | `{node, ancestors[], subtree[]}` (existing `WorkbenchScope`) | *(unused by v1 UI — zoom is computed client-side from the full tree; v2 keeps this)* |
| `/workbench/jot` | POST | `{text, focus_id?, group_id?}` | `{parent_id, confidence, reason, unsorted, created[], node, nodes[]}` | `workbenchJot(note, focusId?)` — **unchanged in v2** |
| `/workbench/say` **(NEW)** | POST | `{text: string, focus_id?: number\|null}` | `{external_id: string, seed_text: string\|null, wrapped_text: string}` — `seed_text` present only on session birth (first message of a sitting); `wrapped_text` = focus header + Kevin's text verbatim, what the client actually sends to `/threads/:ext/messages` | `sayToWorkbenchBrain(text, focusId?)` **(NEW)** — client does the 2-step: `POST /workbench/say` → then `sendMessage(external_id, seed_text ? seed_text + '\n\n' + wrapped_text : wrapped_text)` (exact join convention is the backend node's call; document it in the response so the client doesn't have to guess — recommend the SERVER pre-joins and returns one `post_text` field instead of two, to remove that ambiguity — see trap #1) |
| `/workbench/session` **(NEW, recommended — see §4 gap)** | GET | — | `{external_id: string, last_activity_at: string} \| {external_id: null}` | `getWorkbenchSession()` **(NEW)** — called once on page mount to resolve an in-progress sitting so Timeline can render before the first send |
| `/workbench/proposals/:batchId/accept` **(NEW)** | POST | `{ids?: number[]}` (omit = accept whole batch) | `{ok: true, created: SmartTodoNodeRow[]}` | `acceptProposals(batchId, ids?)` **(NEW)** |
| `/workbench/proposals/:batchId/reject` **(NEW)** | POST | `{ids?: number[]}` (omit = reject whole batch) | `{ok: true, removed: number}` | `rejectProposals(batchId, ids?)` **(NEW)** |
| `/workbench/nodes/:id/dispatch` **(NEW)** | POST | `{instructions?: string}` | `{ok: true, thread_ext: string, spawn_task_id: number, status: 'queued'}` | `dispatchWorkbenchNode(nodeId, instructions?)` **(NEW)** |
| `/workbench/nodes/:id/dispatch` **(NEW)** | GET | — | `{status: 'none'\|'queued'\|'running'\|'done'\|'stuck'\|'failed', thread_ext?, updated_at?}` | `getWorkbenchDispatchStatus(nodeId)` **(NEW)** — polled for the UI badge |
| `/workbench/:id/open-chat` | POST | — (`:id` = node id or `root`/`0`) | `{thread, external_id, group_id, reused, seed_text}` | `openWorkbenchNodeChat(nodeId)` / `openWorkbenchRootChat()` — **kept for the per-node "Open chat" deep-dive, but v2 UI must stop calling it on zoom (§1 defect) and only call it from the explicit "Open chat" button, which per spec should itself defer thread creation to first send too** (trap #4) |
| `/threads/:ext/messages` | POST | `{text, images?}` | `202 {message_id, status, poll_url, events_url}` or `202 {status:'queued', queued_id, pending_message_id}` | `sendMessage(ext, text, signal?, images?)` — **unchanged, reused by both the brain bar and dispatch's own worker turns** |
| `/threads/:ext` | GET | — | `ThreadDescriptor` (`thread_id, status, title, ...`) + `turns[]` | `getThread(ext)` — **unchanged**; UI must not call this for the brain bar until an `external_id` is known (see §4) |
| `/events` (global SSE) | GET (stream) | — | `event: smart_todo` / `event: workbench_proposal` (NEW) / etc. | `openGlobalEvents({onSmartTodo, onWorkbenchProposal (NEW), ...})` |

**Tool (`workbench`) op additions (v2, per SPEC.md):** `propose_batch {parent_id, items:
[{title, notes?, children?}]}`, `update_proposal {proposal_id, title?, notes?}`,
`delete_proposal {proposal_id}`, `accept_batch {batch_id}` — these are MODEL-facing (called by
the brain thread via the tool, not HTTP routes the client hits directly) but their side effects
(insert/delete `workbench_proposals` rows, or promote them into real nodes) must emit the same
`workbench_proposal` SSE the HTTP accept/reject routes emit, since both paths ("Kevin clicks
Accept" and "Kevin says 'yes do that' in chat and the brain calls `accept_batch`") need to
converge on one code path — recommend the tool's `accept_batch`/`propose_batch` call the SAME
internal functions the `/workbench/proposals/:batchId/accept` route calls, not a parallel
implementation (same discipline as `PromptRuleWriter` in the Overwatch build — one write path,
no drift).

---

## 7. Traps found (read before building)

**Trap #1 — `seed_text` vs `wrapped_text` ambiguity in the `/workbench/say` contract.**
SPEC.md's own wording is ambiguous about whether the client concatenates `seed_text` +
`wrapped_text` itself or the server pre-joins. Given the hopper-promote precedent
(`seed_text` alone IS the full text to post — no client-side joining happens anywhere in the
codebase today), recommend the backend node return ONE field the client posts verbatim
(call it `post_text`), computed server-side as `seed_text ? seed_text + '\n\n---\n\n' +
wrapped_text : wrapped_text`. This removes a footgun class identical to the v1 defect where the
UI used the wrong seed field name (v1 REVIEW.md's fix #1) — don't give the client two strings
and an implicit join order to get right.

**Trap #2 — ghost/proposal nesting: what does `parent_id` point at?** SPEC.md's
`workbench_proposals` schema says `parent_id NULL=root` (singular, per-row) but the tool op
`propose_batch` takes a single `parent_id` PLUS a nested `items[] {title, notes?, children?}`
tree (like the existing `DecompositionItem` shape `workbench.ts` already has for real inserts).
Those two are in tension: if proposals are flat rows with independent `parent_id`, a
multi-level ghost breakdown needs child rows to point at THEIR proposal parent (not a real
node) — but the schema field is documented against real node ids. Recommended resolution
(flagging, not deciding): store `propose_batch`'s nested `items[]` as a **flat set of rows within
one `batch_id`, inserted in an SQLite transaction in top-down order**, where a child's `parent_id`
is either (a) a real existing `smart_todo_nodes.id` (top-level proposals under a real parent), or
(b) another row's `id` **within the same batch** (nested proposals) — resolved at accept-time by
walking the batch in `id` ascending order (guaranteed topological since a parent proposal row is
always inserted, and thus has a lower id, before its children in the same transaction) and
maintaining a `proposal_id → real_node_id` map, inserting via the existing `insertUnderParent`
(`workbench.ts:263-279`) once each row's resolved real parent id is known. This reuses the exact
recursive-insert helper `split`/jot decomposition already use — no new insert logic needed,
just a topological resolve pass first.
**Also unresolved: partial accept/reject** ("per-node ✓/✕ + per-batch Accept all") — if Kevin
accepts a child proposal but rejects its parent proposal, the child has nowhere real to attach.
Simplest safe rule (recommend, don't over-build): accepting a proposal row implicitly accepts
its whole ANCESTOR chain within the batch (you can't materialize a child without its parent
existing somewhere real) but does NOT auto-accept siblings or descendants beyond what was
selected. Rejecting a row rejects that row and everything nested under it in the batch. Flag this
explicitly to Kevin/the reviewer as a locked-in behavior, since SPEC.md doesn't say.

**Trap #3 — dispatch status lookup has no direct node→spawn_task join today.** `spawn_tasks`
has no `smart_todo_node_id` column (only `hopper_tree_id`/`hopper_node_id`, hopper-specific).
`GET /workbench/nodes/:id/dispatch` needs SOME way to find "the latest spawn_tasks row for
this node." Two options: (a) add an additive `smart_todo_node_id INTEGER` column to
`spawn_tasks` (same lazy-migration pattern already used for `hopper_tree_id`/`hopper_node_id`,
`spawn-tasks.ts:69-75`) and stamp it at dispatch time — clean, recommended; or (b) encode the
node id in the `thread_ext` itself (e.g. `cockpit:workbench-dispatch-<nodeId>-<uuid>`) and
regex-match on query, mirroring the hopper fallback (`jarvis-spawn-reconcile.py:143`) — works
but is the same fragile-parsing pattern the hopper code itself calls out as needing the
bulletproof column fix. **Recommend (a).**

**Trap #4 — the "Open chat" deep-dive button's own eager-create.** SPEC.md says "Open chat"
(per-node) "stays, but creates the thread ON FIRST SEND — opening the pane is free." Today's
`openWorkbenchNodeChat` (`api-v1.ts:2651-2733`) itself does the find-or-create AND, per the old
UI wiring, an immediate seed post follows if new (`workbench.tsx:192-197`). Removing the
zoom-triggered call (§1) is necessary but not sufficient — the "Open chat" button's own handler
must ALSO stop posting the seed immediately; it should open a normal `/thread/:ext` window bound
to a NOT-YET-CREATED thread (or defer the `open-chat` POST itself until the window's composer
first sends) rather than pre-seeding on open. Confirm this is actually wired that way in the UI
node — don't assume fixing the docked-bar effect alone satisfies spec.

**Trap #5 (informational, not blocking) — root/unrestricted scope is already correct for the
brain thread, for free.** `resolveWorkbenchToolScope` (`workbench.ts:375-386`) returns
`allowedIds: null` (unrestricted) for any thread whose `external_id` doesn't match a node's
`linked_thread_ext`. The brain session's ext (`cockpit:workbench-brain-<uuid>`) will never match
one, so it automatically gets tree-wide scope with ZERO code changes to scope resolution — the
existing guard mechanism already does the right thing for "brain scope = tree-wide." Only the
NEW tool ops (`propose_batch`/`update_proposal`/`delete_proposal`/`accept_batch`) need to be
added to the tool's operation list/switch; scope guarding for them can reuse
`assertWorkbenchScope` unchanged where they touch real nodes (e.g. `propose_batch`'s
`parent_id`, when it's a real node id) and skip the guard for proposal-id-only targets (a
proposal isn't in `allowedIds` since it's not a `smart_todo_nodes` row at all).

**Trap #6 (regression risk) — the "get the exact request bodies the client sends" SIM
requirement.** SPEC.md's SIM instruction for v2 explicitly calls out driving the CLIENT
contract, not just the backend, because v1 shipped 3 client/server field-name mismatches past a
43/43 backend-only sim (see v1 REVIEW.md / DECISIONS.md). The fn↔route field-name diff check
should specifically watch for: `text` vs `note` (the `/workbench/jot` vs `/smart-todos/jot`
naming trap that already bit v1 once, `cockpit-api.ts:2713-2715` has a comment scar about it),
and whichever of `seed_text`/`wrapped_text`/`post_text` the backend node actually ships (trap
#1) — that field name WILL drift if the backend and UI nodes are built in parallel without
reading each other's diff.

---

## 8. Summary — exact file+line touch list per downstream node

**Backend node(s):**
- `darwin-assistant/src/workbench.ts` — add `workbench_sessions` DDL + find-or-create helper
  (idle-hours reuse per settings-KV `workbench_session_idle_hours`, default `4`, via
  `getSetting`/`setSetting`, `conversation-db.ts:872-885`), `workbench_proposals` DDL + CRUD,
  `composeBrainSay(text, focusId)` (the say/wrapped_text builder — resolve trap #1).
- `darwin-assistant/src/tools/workbench-tool.ts` — add `propose_batch`/`update_proposal`/
  `delete_proposal`/`accept_batch` ops; accept must call the same internal accept fn the HTTP
  route uses (§6 note).
- `darwin-assistant/src/handlers/api-v1.ts` — new routes: `POST /workbench/say`,
  `GET /workbench/session`, `POST /workbench/proposals/:batchId/{accept,reject}`,
  `POST|GET /workbench/nodes/:id/dispatch`. Remove nothing from the existing `/workbench/*`
  block (2589-2733) — purely additive, matching v1's own constraint discipline.
- `darwin-assistant/src/spawn-tasks.ts` — additive `smart_todo_node_id INTEGER` column (trap #3).
- `darwin-assistant/src/sse-bus.ts` — new `WorkbenchProposalEvent`, add to `SSEEvent` union (306).
- `darwin-assistant/src/handlers/api-v1.ts:4388-4397` — add `'workbench_proposal'` to `FORWARD`.

**UI node:**
- `jarvis-command-center/src/routes/workbench.tsx` — DELETE the zoom-triggered open-chat effect
  (lines 181-224 today; §1). Add ghost-node rendering (dashed/dimmed, per-node ✓/✕, per-batch
  Accept-all) fed by `workbench_proposal` SSE. Keep jot bar unchanged.
- `jarvis-command-center/src/components/WorkbenchChatBar.tsx` (or a new `WorkbenchBrainBar`
  component, since the binding contract is different enough — one persistent session vs.
  per-node rebind) — gate `getThread` on having a resolved `external_id` (§4 gap; use
  `GET /workbench/session` on mount), first send does say→post, later sends reuse the ext.
- `jarvis-command-center/src/lib/cockpit-api.ts` — new client fns per the contract table (§6);
  update `sse-worker.ts` `EVENT_TYPES` + `GlobalEventHandlers`.
- Per-node dispatch button + running/done badge (poll `GET /workbench/nodes/:id/dispatch`).

**SIM node:** exercise the exact client fn request bodies (import or mirror them) against the
new routes, plus the fn↔route field-name diff check called out in trap #6. Regression-check
`/tree`, `/api/v1/smart-todos/*`, the `smart_todos` tool, AND the v1 `/workbench/*` three routes
(scope/jot/open-chat) stay byte-identical/additive.
