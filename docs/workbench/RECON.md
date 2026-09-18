# WORKBENCH — Recon (node #439)

Maps the `/tree` stack end to end so downstream nodes have exact file/line targets. **Nothing in this
doc touches `/tree`, `/api/v1/smart-todos/*`, or the `smart_todos` tool — read-only recon.**

Repo roots referenced below are the **live checkouts** (`/home/kevin/paperclip/darwin-assistant`,
`/home/kevin/paperclip/jarvis-command-center`) since that's where the code actually lives today — this
worktree (`/home/kevin/paperclip-worktrees/workbench`, branch `hopper/workbench`) is a full monorepo
checkout with `darwin-assistant/` at its root; line numbers match 1:1 between the two (worktree was cut
from the same tip). The UI worktree `hopper/workbench-ui` does not exist yet (no `/home/kevin/worktrees`
dir) — whoever builds the UI node needs to create it off `jarvis-command-center` first.

## 1. The existing stack, top to bottom

```
jarvis-command-center/src/routes/tree.tsx          (557 lines) — the /tree page
  ↓ imports
jarvis-command-center/src/lib/cockpit-api.ts        lines 2556-2683 — Smart Todo Tree client section
  ↓ HTTP via BASE = "/cockpit-api" (req() helper, cockpit-api.ts:1134-1151)
darwin-assistant/src/handlers/api-v1.ts             lines 2391-2586 — the /smart-todos routes
  ↓ calls
darwin-assistant/src/smart-todos.ts                 (367 lines) — table + CRUD + SSE emit
darwin-assistant/src/smart-todos-decompose.ts       (113 lines) — jot → decomposed tree (claude one-shot)
darwin-assistant/src/tools/smart-todos-tool.ts      (119 lines) — the `smart_todos` model tool
darwin-assistant/src/sse-bus.ts                     SmartTodoEvent (lines 228-236) + FORWARD set (api-v1.ts:4241-4250)
```

Chat rendering reused by Workbench's docked bar lives in a separate stack:
```
jarvis-command-center/src/components/ThreadPane.tsx (672 lines) — full single-thread surface
jarvis-command-center/src/routes/threads.tsx        Timeline (4611), Composer (5217), ModelSelector (4529),
                                                     mergeSummaryBookmarks (502) — all exported, reusable
```

## 2. Exact touch points per downstream node

### Backend: new `/api/v1/workbench/*` namespace (darwin-assistant)

- **New file `src/smart-todos.ts` companion, NOT an edit to it.** Do not add columns/functions to
  `smart-todos.ts` directly for Workbench-only concerns — see §3 for the additive-column plan, which
  DOES touch `smart-todos.ts` (schema is additive/backward compatible, `/tree` ignores unknown columns
  and untouched query shapes). Everything else (scope queries, `write_context`, `read_up`, the matcher)
  belongs in a new `src/workbench.ts`.
- **Route registration point:** `src/handlers/api-v1.ts`, right after the Smart Todo Tree block ends
  (after line 2586, before the `/notifications/:id/checkin-snooze` route at 2588). Same `router` instance,
  same `AuthedRequest` pattern, same `sendError`/`res.json` conventions used at 2397-2586.
- **Imports to add near the existing smart-todos import block** (api-v1.ts:162-173): pull in whatever
  `src/workbench.ts` exports (scope query, jot placement, write_context, read_up), plus reuse
  `getConversation`, `getConversationById`, `getOrCreateConversation`, `renameConversation`,
  `setThreadGroup` (all already imported for the `/smart-todos/:id/open-chat` route — no new imports
  needed for those), `createGroup` (`conversation-groups.ts`), `callerExternalIdPrefix`.
- **`GET /workbench/scope/:id`** (spec §1): implement as a new function in `src/workbench.ts`, e.g.
  `getWorkbenchScope(nodeId: number)`. Shape: reuse `getSmartTodoNode` for the focus node, walk `parent_id`
  up for `ancestors[]` (same loop shape as `isDescendant` in tree.tsx:334-341, server-side equivalent
  doesn't exist yet — write it), and reuse the existing `subtreeIds`-style recursive CTE pattern from
  `smart-todos.ts:126-138` (currently private/unexported — either export `subtreeIds` from
  `smart-todos.ts` or duplicate the CTE in `workbench.ts`; **recommend exporting it**, it's a pure read
  helper, zero risk to `/tree`). `focus=null` (whole tree) is just `listSmartTodoNodes()` — no new query.
- **`POST /workbench/jot`** (spec §5, match-or-create): **do not touch `POST /smart-todos/jot`
  (api-v1.ts:2402-2414) or `decomposeNote()`** — that path is a different behavior (always creates a new
  root). Build a new `matchOrCreatePlacement(note, focusNodeId?)` in `workbench.ts`: deterministic
  shortlist first (SQL substring/LIKE scoring — no model cost, see spec step 1), then ONE
  `runClaudeOneShot`-style call (copy the exact pattern from `smart-todos-decompose.ts:23-45`, do **not**
  import it — that function is decompose-specific; duplicate the ~20-line spawn wrapper or, better, factor
  a tiny shared `runClaudeOneShot(prompt, {timeoutMs})` helper both files import from a new
  `src/tools/ux-reviewer/vision-critique.js`-adjacent home — **recommend**: extract to
  `src/claude-one-shot.ts` since a 3rd caller (§ placement matcher) makes duplication a real smell; two
  existing near-identical copies already exist at `smart-todos-decompose.ts:23-45` and
  `jarvis-brief.ts:176`). On a match, insert children via `createSmartTodoNode`/`insertSmartTodoTree`
  (both already exported from `smart-todos.ts`, no changes needed). Return `{ parent_id, confidence,
  reason, nodes }` — UI needs `parent_id` + `confidence` to render "Landed under X · Move · Undo".
- **`write_context` / `read_up`:** `write_context` = `UPDATE smart_todo_nodes SET context_notes = ?`
  (new column, §3) — add as a new statement + exported fn in `smart-todos.ts` itself (it's a genuine
  column op on the shared table, same shape as `updateSmartTodoNode`, additive and harmless to `/tree`
  since `/tree`'s `SmartTodoNodeRow`/`toSmartTodoNode` mapping simply won't reference the new field).
  `read_up(nodeId)` = walk to an ancestor's `linked_thread_ext` → `getConversation(ext)` →
  `getLatestThreadSummary(conv.id)` (already exported, `src/thread-summaries.ts:51-57`) — zero new
  summary infra needed, it's a straight reuse.
- **New tool `workbench`** (spec §3): new file `src/tools/workbench-tool.ts`, registered in
  `src/tools/index.ts` next to `smartTodos` (imported at line 135, registered at line 203 in the tools
  map) — add an import + a sibling map entry, same shape. **Scope guard is the one genuinely new piece
  of logic**: every write op takes the *focused* node id (passed by the calling thread's seed context —
  see §4 chat binding) and must verify the target node id is inside `subtreeIds(focusNodeId)` before
  writing; refuse otherwise with a plain string error the model relays to Kevin. This guard does not
  exist anywhere today — write it fresh in `workbench-tool.ts`, using the same `subtreeIds` export
  recommended above.
- **Chat binding — reuse, do not fork:** `POST /smart-todos/:id/open-chat` (api-v1.ts:2521-2586) is
  already the exact "find-or-create a thread tied to a node" contract the spec asks for in §2. **Call it
  as-is** for the docked chat's thread resolution — no new endpoint needed for "which thread does node N
  use." The only gap: it's currently mounted under `/smart-todos/:id/open-chat`, which is fine to keep
  calling directly (cross-namespace call, not a duplication) rather than re-implementing under
  `/workbench/*`. For **root/whole-tree scope** (`workbench-root`, spec §2 last bullet), there is no
  smart-todo node to hang a thread off — this needs a small new codepath: either (a) a sentinel
  `external_id = "cockpit:workbench-root"` that's `getOrCreateConversation`'d directly (mirrors the
  `${prefix}tree-${uuid()}` pattern at api-v1.ts:2560 but with a fixed, singleton id instead of a fresh
  uuid so "root chat" always resolves to the same thread), or (b) a real node with `parent_id: null` used
  as a hidden root anchor. **Recommend (a)** — simplest, no schema/UI implication, matches how
  `hopper-<uuid>` vs a fixed id would differ; a singleton external_id is idiomatic here since there's
  exactly one root scope, ever.

### Frontend: new `/workbench` page (jarvis-command-center, branch `hopper/workbench-ui`, worktree TBD)

- **New route file `src/routes/workbench.tsx`**, structurally cloned from `tree.tsx` (557 lines) —
  same `listSmartTodos`/SSE-poll/tree-render scaffolding (tree.tsx:61-327) is 90% reusable as-is for the
  subtree rendering inside a zoomed view. New surface, not an edit to `tree.tsx`.
  - **Zoom state**: `focus` from `/workbench?focus=<id>` (TanStack Router search param, same pattern as
    `readGroupParam()` in `thread.$externalId.tsx:10-13`, but wired through the router's search-params API
    rather than raw `URLSearchParams` since it needs to push/replace on navigation — check
    `Route.useSearch()` conventions elsewhere in the repo, e.g. `routes/threads.tsx`, before hand-rolling).
  - **`GET /workbench/scope/:id`** client fn to add in `cockpit-api.ts`, sibling section to
    `listSmartTodos`/`jotSmartTodo` (2608-2683) — same `req()` + type-mapping shape.
  - **Breadcrumb** = render `ancestors[]` from the scope response as clickable crumbtrail; reuses
    `toSmartTodoNode` mapping already exported.
  - The node list itself (`NodeRow`, tree.tsx:354-535) is reusable **verbatim or near-verbatim** for
    rendering the zoomed subtree — it already recurses on `childrenByParent`; scope response's `subtree[]`
    just needs to be reduced into the same `Map<number|null, SmartTodoNode[]>` shape tree.tsx builds at
    lines 91-100.
- **Docked scoped chat bar**: **do not build a new chat renderer.** `ThreadPane.tsx` already assembles
  everything needed (getThread + sendMessage + openGlobalEvents wiring at lines 123-282, Timeline +
  Composer usage further down) — the cleanest path is a new **slim component**
  `src/components/WorkbenchChatBar.tsx` that:
  - takes `externalId` as a prop (resolved by the page from the focused node's `open-chat` call, or the
    `workbench-root` sentinel when nothing is zoomed),
  - internally mirrors ThreadPane's `refresh()`/SSE-subscribe/`handleSend()` triple (lines 123-137,
    166-235, 237-254) but renders `Timeline` (routes/threads.tsx:4611) in a fixed-height scroll pane
    instead of full-flex, plus `Composer` (routes/threads.tsx:5217) pinned below it — **both imported
    directly from `@/routes/threads`, exactly as ThreadPane.tsx:27 already does.** This is a "reuse the
    building blocks, not the whole pane" job — do not import `ThreadPane` itself into a docked strip (it's
    header-heavy: settings popover, dispatch panel, links bar — all wrong for a persistent bottom bar).
  - **Re-bind on zoom change**: when `focus` changes, the bar's `externalId` prop changes → the internal
    `useEffect([externalId])` re-fetches and re-subscribes exactly like ThreadPane already does per-thread
    (ThreadPane is itself remounted by `key={thread.id}` elsewhere in the app for the same reason — grep
    `key={` call sites in `group.tsx` if a remount-vs-rebind precedent is needed).
  - **"Open chat" escape hatch** = literally `window.open(`/thread/${encodeURIComponent(externalId)}`, …)`,
    same one-liner as tree.tsx:225 — zero new code.
- **SSE**: `smart_todo` is already in `sse-worker.ts` `EVENT_TYPES` (line 49) and already wired through
  `openGlobalEvents`'s `onSmartTodo` handler (cockpit-api.ts:3732, 4016-4020) — **Workbench's live
  node updates need NO new SSE event.** See §5 for why this holds even with the new columns.

## 3. Data decision — validated, additive columns are safe

Confirmed by reading `smart-todos.ts` end to end: every query is either `SELECT *` (`getByIdStmt`,
`listAllStmt`, `getByThreadStmt`) or an explicit column list in `INSERT`/`UPDATE` statements. **Adding
`context_notes TEXT`, `match_key TEXT`, `last_activity_at TEXT` via `ALTER TABLE ... ADD COLUMN` is
100% additive and will not break `/tree` or the `smart_todos` tool**, because:
- `RawSmartTodoNode`/`SmartTodoNode`/`toSmartTodoNode` (cockpit-api.ts:2559-2606) only read the fields
  they name — new columns simply aren't in the TS type, so `SELECT *` rows carry them silently unused.
- `smart-todos-tool.ts`'s `execute()` only ever reads/writes the fields it already names.
- No existing code does `INSERT INTO smart_todo_nodes (col1, col2, ...)` with a column count that would
  break on a wider table — better-sqlite3 positional `?` binding in `insertStmt` (smart-todos.ts:83-88)
  uses a fixed 8-arg signature; a new column with a `DEFAULT NULL` needs no changes to that INSERT at all.

**One genuine risk, flag it to Kevin at the review gate rather than silently deciding:** `last_activity_at`
implies something writes to it on activity, which means either (a) a trigger-less manual touch call added
inside `workbench.ts`'s write paths (safe, isolated) or (b) piggybacking `smart-todos.ts`'s own
`touchStmt`/emit calls (touches shared code — still additive/backward-compatible but worth a second pair
of eyes since it's the one shared-file edit in the whole plan). **Recommend (a)**: keep all Workbench-only
writes in `workbench.ts`, touch `smart-todos.ts` only for the `ALTER TABLE` migration + the `context_notes`
setter (which needs to live there since it's a raw column op parallel to `updateSmartTodoNode`).

## 4. Context rules (spec §4) — what's cheap, what's on-demand

- **Automatic** (focused node + subtree + ancestor titles/notes): a single `GET /workbench/scope/:id`
  gives the frontend everything; for the **chat's** system context (not the UI), the seed text /
  scope-aware system prompt for the scoped thread should be assembled server-side in `workbench.ts`
  (mirrors the seed-text assembly already at api-v1.ts:2566-2576 for `open-chat`, but keyed off the
  scope query instead of a single node) — this is new code, no existing seed-builder to reuse beyond the
  string-building style.
- **On-demand (`read_up`)**: confirmed cheap — `getLatestThreadSummary` (thread-summaries.ts:55-57) is a
  single indexed row read, not a transcript. No new infra.
- **Auto-notes**: appended to `context_notes` at end of a scoped turn. This needs a hook at turn-completion
  time scoped to Workbench threads specifically (a thread is "a workbench thread" iff its
  `linked_thread_ext` matches a `smart_todo_nodes` row, via `getSmartTodoByThread` — already exported,
  `smart-todos.ts:121-123`). **Where this hooks in is a real open question for the build node**: JARVIS
  turn completion isn't obviously observable from `workbench-tool.ts` alone (tool calls happen mid-turn,
  not at turn-end) — likely needs either (a) the model calling `write_context` itself as the last tool
  call of a scoped turn (simplest, tool-prompt-driven, matches how `smart_todos`'s `sync` op already works
  today — same "the model does it because the tool description tells it to" contract, zero new server
  hook), or (b) a genuine turn-end hook in `agent.ts`. **Recommend (a)** — it's the existing pattern in
  this codebase (`sync` op) and needs no new architecture; document it forcefully in the `workbench` tool's
  description so the model reliably calls `write_context` before ending a scoped turn.

## 5. Answering the two explicit questions

**Q: Can the new page reuse the existing `smart_todo` SSE event, or does it need a new one?**
**A: Reuse it — no new SSE event.** Reasoning: `SmartTodoEvent` (sse-bus.ts:232-236) already carries
`action: 'created'|'updated'|'deleted'|'bulk'` + the affected row (or nothing, for `bulk`). Every
Workbench write (placement, scope-guarded tool writes, `write_context`) goes through the *same*
`smart_todo_nodes` table via the *same* `smart-todos.ts` write functions (`createSmartTodoNode`,
`updateSmartTodoNode`, `insertSmartTodoTree`, `moveSmartTodoNode`, `deleteSmartTodoNode`, plus the new
`context_notes` setter if added there) — **every one of those already calls `emit()`** (smart-todos.ts:105-107),
which is already in the global `/events` FORWARD set (api-v1.ts:4247) and already listened for by
`sse-worker.ts` (line 49) and `openGlobalEvents.onSmartTodo` (cockpit-api.ts:4016-4020). The `/workbench`
page just needs to call `openGlobalEvents({ onSmartTodo: () => void reloadScope() })`, identical to
`tree.tsx:83`. A brand-new SSE event type would only be justified if Workbench introduced a genuinely
different entity (it doesn't — same rows, same table, additive columns).

**Q: Exact function signatures to reuse (backend + frontend), consolidated:**
| Need | Reuse | Location |
|---|---|---|
| Read a node | `getSmartTodoNode(id): SmartTodoNodeRow \| null` | `smart-todos.ts:113-115` |
| List whole tree | `listSmartTodoNodes(): SmartTodoNodeRow[]` | `smart-todos.ts:117-119` |
| Node's linked thread lookup | `getSmartTodoByThread(ext): SmartTodoNodeRow \| null` | `smart-todos.ts:121-123` |
| Recursive subtree ids | `subtreeIds(id)` (currently unexported — export it) | `smart-todos.ts:126-138` |
| Create one node | `createSmartTodoNode(args)` | `smart-todos.ts:146-178` |
| Insert a decomposed tree | `insertSmartTodoTree(prompt, tree, opts)` | `smart-todos.ts:189-234` |
| Patch a node | `updateSmartTodoNode(id, patch)` | `smart-todos.ts:243-262` |
| Move/reparent | `moveSmartTodoNode(id, parentId, sortOrder)` | `smart-todos.ts:297-348` |
| Delete subtree | `deleteSmartTodoNode(id)` | `smart-todos.ts:360-366` |
| Claude one-shot pattern | inline `execFile` wrapper (copy, or extract shared — see §2) | `smart-todos-decompose.ts:23-45` |
| Thread find-or-create for a node | `POST /smart-todos/:id/open-chat` (call as HTTP, don't refactor) | `api-v1.ts:2527-2586` |
| Ancestor thread summary | `getLatestThreadSummary(conversationId)` | `thread-summaries.ts:55-57` |
| Frontend tree fetch | `listSmartTodos()` | `cockpit-api.ts:2608-2611` |
| Frontend node CRUD | `addSmartTodo`/`updateSmartTodo`/`moveSmartTodo`/`deleteSmartTodo` | `cockpit-api.ts:2623-2668` |
| Frontend chat open | `openSmartTodoChat(id)` | `cockpit-api.ts:2673-2683` |
| Thread fetch for docked bar | `getThread(externalId)` | `cockpit-api.ts:1433-1438` |
| Send into docked bar | `sendMessage(externalId, text, signal?, images?)` | `cockpit-api.ts:1457-1468` |
| Live stream wiring | `openGlobalEvents({ onStreamStart, onStreamDelta, onStreamEnd, onTurn, onSmartTodo, ... })` | `cockpit-api.ts:3955+`, pattern at `ThreadPane.tsx:166-235` |
| Chat rendering | `Timeline(...)`, `Composer(...)` (both exported) | `routes/threads.tsx:4611`, `:5217` |

## 6. Traps found

1. **`decomposeNote()` and the future placement matcher must stay separate functions.** They look similar
   (both: one-shot claude call → JSON envelope → sanitize) but have different contracts — decompose always
   makes a *new* root; the matcher decides *whether* to attach to an existing node first. Don't try to
   parametrize one into doing both; a shared `runClaudeOneShot` helper is fine, a shared "decide and
   decompose" function is not (spec explicitly separates steps 1-2 in §5).
2. **`subtreeIds` is currently a private, unexported function** (`smart-todos.ts:126-138`) needed by at
   least three new things (scope query, move-cycle-safety already uses it internally, and the tool's scope
   guard). Export it rather than reimplementing the recursive CTE a second time — reimplementing risks a
   subtle divergence (e.g. forgetting the `id = ?` seed row inclusion) that would make the scope guard
   under- or over-permissive.
3. **The `open-chat` route's group-creation side effect** (api-v1.ts:2551-2558: ensures a `ConversationGroup`
   exists for the root branch) fires on every first-time chat open, including ones Workbench triggers.
   This is desired (matches spec "lands in the branch's group") but means the very first zoom-and-chat on a
   node the user never explicitly grouped will silently create a new cockpit group — not a bug, just note
   it so nobody "fixes" it away.
4. **`insertSmartTodoTree`'s root creation always sets `parent_id: null`** (smart-todos.ts:196-207) — the
   placement matcher's "attach under an existing node" path can **only** use `createSmartTodoNode`
   per-child + manual recursion (or a new `insertSmartTodoTree` variant that accepts a `parent_id` seed),
   **not** `insertSmartTodoTree` as-is, since that function is hardcoded to create a fresh root. Confirm
   which one the placement-matcher node picks — if it needs "insert a decomposed subtree under an existing
   parent," that's a new function (`insertSmartTodoSubtree(parentId, tree, opts)`), not a reuse of
   `insertSmartTodoTree`.
5. **`Composer` and `Timeline` both expect a full `Thread` object**, not just an externalId string
   (`routes/threads.tsx:5221 thread: Thread`, `:4611` implicitly via `TimelineEvent[]` sourced from
   `getThread`). The docked bar must call `getThread(externalId)` in full (same as ThreadPane does) — it
   cannot cheaply render with a lighter-weight fetch. This is fine (ThreadPane already pays this cost per
   pane in the existing `/group` window) but budget for the same fetch-on-every-zoom-change cost the spec
   implicitly accepts ("Zooming changes which thread the bar is bound to").
6. **No `/home/kevin/worktrees/workbench-ui` exists yet.** Whoever picks up the UI node needs to create it
   (`git worktree add /home/kevin/worktrees/workbench-ui -b hopper/workbench-ui` against
   `jarvis-command-center`, following the same convention as other `hopper/*-ui` branches) before writing
   any frontend code — it is not pre-provisioned like the backend worktree was.
7. **`callerExternalIdPrefix(caller.id)` gates thread-id ownership** (api-v1.ts:2835, 2840, etc.) — any new
   thread Workbench creates (the `workbench-root` sentinel, in particular) must still be prefixed per-caller
   like `tree-${uuid()}` is at line 2560, or writes to it from a different API key will 403. A *fixed*
   sentinel id (not a fresh uuid) still needs the caller prefix baked in, e.g.
   `` `${callerExternalIdPrefix(caller.id)}workbench-root` `` — a truly global fixed id without the prefix
   would break the ownership check other routes rely on.
8. **NO API KEYS**: confirmed `smart-todos-decompose.ts` already does this correctly (`delete
   env.ANTHROPIC_API_KEY`, line 25) — the placement-matcher's one-shot call must copy that exact pattern,
   not the plain `execFile` without the env scrub.

## 7. Summary for the build nodes

- Backend touch surface: **one new file** (`src/workbench.ts`) + **one small schema migration** (3 additive
  columns via `ALTER TABLE`, landed inside `smart-todos.ts`'s existing `sqliteDb.exec(...)` migration block)
  + **one new tool file** (`src/tools/workbench-tool.ts`, registered in `tools/index.ts`) + **new routes
  appended to `api-v1.ts`** after line 2586. Everything else is imports/reuse.
- Frontend touch surface: **one new route** (`src/routes/workbench.tsx`, structurally cloned from
  `tree.tsx`) + **one new component** (`src/components/WorkbenchChatBar.tsx`, built from ThreadPane's
  wiring + `Timeline`/`Composer`) + a handful of new client fns in `cockpit-api.ts` (scope fetch, jot,
  the workbench-root/open-chat helpers) appended near the existing Smart Todo Tree section (2556-2683).
- Zero new SSE event types. Zero changes to `/tree`, `/api/v1/smart-todos/*`, or `smart_todos-tool.ts`.
- The one shared-file edit that touches existing code (`smart-todos.ts`: export `subtreeIds`, add 3
  columns, add a `context_notes` setter) is additive and backward-compatible per §3 — call this out
  explicitly to the adversarial reviewer since it's the sole place Workbench code lives inside a file
  `/tree` also depends on.
