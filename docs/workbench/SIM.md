# WORKBENCH — SIM (hopper node #443)

Proves the whole loop end-to-end on a scratch sqlite DB (never `jarvis.db`) plus a
throwaway-port Express instance — no live model calls except a controlled fake
`claude` binary (see below), no touch of `/tree`, `/api/v1/smart-todos/*`, or the
`smart_todos` tool. Depends on node #441 (`hopper/workbench`, scoped `workbench`
tool + auto-notes/read_up + chat seeding), which is already on this branch.

**Run it yourself:**

```
cd /home/kevin/paperclip-worktrees/workbench/darwin-assistant
npm run build
JARVIS_DB_PATH=/tmp/workbench-sim-core.db   node scripts/workbench-sim-core.mjs
JARVIS_DB_PATH=/tmp/workbench-sim-routes.db node scripts/workbench-sim-routes.mjs
```

Both scripts refuse to run unless `JARVIS_DB_PATH` is set and is not the live
`jarvis.db` (same guard every other sim script in this repo uses), and both wipe
their scratch DB file on start so re-runs are idempotent. **Result: 43/43 checks
pass** (30 in `workbench-sim-core.mjs`, 13 in `workbench-sim-routes.mjs`).

## How the fake `claude` binary works

`workbench.ts`'s placement one-shot and `smart-todos-decompose.ts`'s `decomposeNote`
both resolve their binary from `UX_REVIEWER_CLAUDE_BIN`. Both scripts point that at
`scripts/workbench-sim-fake-claude.mjs`, a real spawnable executable (`execFile`
runs it exactly like the real CLI would be run) that reads a JSON control file
(`WORKBENCH_SIM_CONTROL`) written by the driver immediately before each call:

- `{"mode":"ok","payload":{...}}` → prints `{"result": "<payload as a JSON string>"}`,
  the same envelope shape `claude --output-format json` returns.
- `{"mode":"fail"}` → exits 1 with no stdout at all — this is what lets item 3b be
  proven deterministically instead of hoping a real model call happens to error.
- no control file present → prints `{"result":"{}"}"` (used in the routes sim,
  where `/workbench/jot`'s `decomposeNote` call isn't the thing under test —
  `{}` fails `sanitize()`'s title check and `decomposeNote` falls back to its own
  fallback item, so the request still succeeds).

This is a real local-process spawn via `execFile`, not an API call — no
`ANTHROPIC_API_KEY` is set or read anywhere in either script (NO API KEYS rule).
It's the same fake-binary technique `scripts/multi-claude-e2e-sim.mjs` already
uses for the `claude` adapter.

## What `workbench-sim-core.mjs` proves (function/tool level, 30 checks)

Imports the compiled `dist/smart-todos.js`, `dist/workbench.js`,
`dist/tools/workbench-tool.js`, `dist/conversation-db.js`, `dist/thread-summaries.js`
directly — no HTTP layer, so this exercises the actual logic with zero routing
noise.

1. **Existing-subject jot lands under the matching node.** Fixture: a root node
   "Update Dashboard X". Jot: "need to change the refresh speed on that dashboard
   page". The deterministic shortlist picks up the node purely on title/token
   overlap (`dashboard`) with no `match_key` needed; the fake one-shot returns
   `parent_id` = that node's real id at confidence 0.9; the created child lands
   under it (`parent_id`/`root_id` both equal the dashboard node's id).
2. **No-match jot creates a new top-level branch + decomposition.** A newsletter-
   launch note with no related existing item gets `parent_id: null` from the
   one-shot plus a 3-child decomposition; asserts the new root's `parent_id` is
   `null` and all 3 children share its `root_id`.
3. **Low confidence → root, flagged; one-shot failure → root, no hard-fail.**
   (3a) The fake one-shot names a real candidate but at confidence 0.2 (under the
   0.55 `CONFIDENCE_THRESHOLD`); `matchOrCreatePlacement` overrides `parent_id`
   back to `null` and appends `"(low confidence; filed at root instead of
   guessing)"` to `reason` — this is the signal the UI's "flagged unsorted"
   receipt state reads. (3b) The fake binary exits 1 (simulating the CLI being
   unreachable); `decidePlacement`'s try/catch returns `null`; the call resolves
   normally (does not throw) and falls back to `fallbackItem(note)` at root with
   the default reason text. Exactly one node is created either way — a jot is
   never lost.
4. **`focus_id` bypasses matching entirely.** Calling `matchOrCreatePlacement`
   with `focusId` set never touches `buildShortlist`/`decidePlacement` at all —
   it calls `decomposeNote` (a *different* CLI prompt/shape, `{title,notes,
   children}` not `{parent_id,confidence,...}`) and attaches directly under the
   given node with `confidence: 1` and the fixed reason `"Placed under the item
   you were zoomed into."`.
6. **The `workbench` tool: scoped write allowed, cross-branch write refused.** A
   thread bound (via `linked_thread_ext`) to a node inside "Branch A" can
   `add_child` under another node inside Branch A's own subtree — allowed. The
   same thread attempting `add_child` under sibling "Branch B" is refused with
   `"...outside your scope..."`, and the refused call is confirmed to have
   created **nothing** under Branch B. A thread with **no** node binding (the
   root-sentinel shape) is confirmed unrestricted and can write to Branch B —
   proving the guard is genuinely scope-based, not a blanket lock.
7. **`write_context` appends to `context_notes`, never touches `notes`.** Two
   sequential `write_context` calls both land in `context_notes` newline-joined
   (not overwritten); the node's own Kevin-authored `notes` field is byte-
   identical before and after both calls; `last_activity_at` is stamped.
8. **`read_up` is ancestor-summary-only, on demand, never a transcript.** A
   3-level fixture (parent → child → grandchild) with a `thread_summaries` row
   seeded on the parent's linked thread. From a chat scoped to the grandchild,
   `read_up` on the parent (2 levels up) returns exactly that summary's content;
   the response object is asserted to contain no `transcript`/`turns` key at
   all. `read_up` on a non-ancestor id is refused ("not one of your ancestors").
   An ancestor that has a real chat but **no summary generated yet** returns
   `summary: null` + an explanatory note, not an error (a genuinely-recoverable
   state, not a failure).
9. **Relocate + undo-jot behave.** A jot lands as a new root item; the UI's
   "Move" action is `moveSmartTodoNode` (pre-existing, unmodified) — proven to
   relocate the node under a chosen home, then relocate it again to a different
   home without duplicating it; "Undo" is `deleteSmartTodoNode` (also pre-
   existing) — proven to remove the node entirely. Both are pre-existing
   functions; this proves the Workbench's jot output interops with them
   correctly, which is all the UI's landing-receipt actually calls (see the
   integration note below).

## What `workbench-sim-routes.mjs` proves (real HTTP, throwaway port, 13 checks)

Imports `dist/handlers/api-v1.js`'s real `createApiV1Router()` mounted on a fresh
`express()` app via `app.listen(0, '127.0.0.1', ...)` (OS-assigned port), and a
real bearer token from `dist/api-keys.js`'s `mintApiKey()` — the same pattern
`scripts/claude-accounts-route-test.mjs` already uses for a different route.

5. **`GET /workbench/scope/:id` at three zoom depths**, on a 4-node fixture
   (Root → Mid → {Leaf 1, Leaf 2}):
   - **Root/whole-tree** (`id="root"`): `node: null`, `ancestors: []`, `subtree`
     is all 4 nodes.
   - **Mid-level**: `node` is Mid, `ancestors` is `[Root]`, `subtree` is
     Mid+Leaf1+Leaf2 — asserts Root is **not** in the subtree (a zoom must not
     see its own ancestor).
   - **Leaf**: `node` is Leaf 1, `ancestors` is `[Root, Mid]` **root-first**,
     `subtree` is `[Leaf 1]` only — asserts Leaf 2 (its sibling) is **not**
     visible, proving subtree isolation at the deepest level.
   - Unknown id → 404. No bearer token → 401 (same `bearerAuth` middleware every
     other route uses).
10. **Regression: every existing `/smart-todos/*` route is behaviorally
    untouched**, exercised for real over HTTP: `GET /smart-todos` still returns
    exactly `{ nodes: [...] }` (no new top-level envelope key); every
    pre-existing node field (`id`, `parent_id`, `root_id`, `title`, `notes`,
    `original_prompt`, `origin`, `sort_order`, `collapsed`, `status`,
    `group_id`, `linked_thread_ext`, `created_at`, `updated_at`) is present with
    its original meaning; `PATCH /smart-todos/:id` still returns `{ node }` and
    applies the patch; `POST /smart-todos/:id/move` still returns
    `{ node, nodes }`; `DELETE /smart-todos/:id` still 204s with an empty body;
    an unknown id still 404s. `POST /workbench/jot` is proven to live on its own
    namespace, entirely independent of `POST /smart-todos/jot`, and to honor
    `focus_id`.

### The one shape nuance (spec-sanctioned, not a bug)

`GET /smart-todos` (and every other route that returns a raw node) now
additionally includes `context_notes`, `match_key`, and `last_activity_at` on
every node (all `null` for nodes that predate Workbench, or that no Workbench op
has touched) — because those columns are now genuinely part of the
`smart_todo_nodes` row and the existing routes still do `SELECT *`. This is
exactly the "two views, one tree" design the spec's Data decision section
calls for, not an accidental regression: `/tree`'s own client-side type
(`jarvis-command-center/src/lib/cockpit-api.ts`'s `SmartTodoNode` interface,
confirmed unmodified — see below) only names the pre-existing camelCase fields,
so the extra snake_case keys are simply never read by `/tree`.

## Regression proof (item 10, static half) — zero behavioral drift

Diffed the branch's base (`20e42e157`, the commit `hopper/workbench` forked
from) against `HEAD` for every file the constraint covers:

- **`darwin-assistant/src/tools/smart-todos-tool.ts` — empty diff.** Byte-for-byte
  unchanged.
- **`jarvis-command-center/src/routes/tree.tsx` — empty diff** (checked in the
  `hopper/workbench-ui` worktree, base `421f890` → `HEAD`). Byte-for-byte
  unchanged.
- **`darwin-assistant/src/handlers/api-v1.ts`** — diffed line-by-line: every
  `+` line belongs to the new `/workbench/*` block (added *after* the existing
  `/smart-todos/*` routes, which appear with **zero** changed lines). No `-`
  lines anywhere in the file.
- **`darwin-assistant/src/smart-todos.ts`** — 100% additive: 3 new interface
  fields, one idempotent `ALTER TABLE ... ADD COLUMN` loop (wrapped in
  try/catch so it's a no-op on a DB that already has the columns), one new
  exported function (`appendSmartTodoContext`), and **one visibility change**:
  `subtreeIds` went from a private `function` to an `export function` — same
  name, same signature, same body, same behavior; only reachable from outside
  the file now because Workbench's scope/placement code needs it. No existing
  statement, query, or exported function's behavior changed.

Both diffs are reproducible with:
```
cd darwin-assistant && git diff 20e42e157 HEAD -- src/tools/smart-todos-tool.ts src/handlers/api-v1.ts src/smart-todos.ts
cd ../../../worktrees/workbench-ui && git diff 421f890 HEAD -- src/routes/tree.tsx
```

## Integration finding for the review/integration node (not fixed here — out of this node's scope)

`jarvis-command-center/src/routes/workbench.tsx`'s docked chat bar opens the
chat for a **zoomed non-root node** via `openSmartTodoChat(node.id)` →
`POST /smart-todos/:id/open-chat` (the pre-existing `/tree` endpoint, which seeds
the plain "Smart-todo item" text) — **not** the new
`POST /workbench/:id/open-chat` built in node #441, which returns the richer
`buildWorkbenchSeedText()` (full subtree + ancestor chain + the explicit
auto-notes/`read_up`-is-on-demand instructions the scoped chat needs). Only the
**root** scope correctly uses `openWorkbenchRootChat()` →
`POST /workbench/root/open-chat`.

This does **not** break scope enforcement — `resolveWorkbenchToolScope` keys off
`linked_thread_ext`, which both endpoints set identically via the same
`setSmartTodoThread` call, so the `workbench` tool's write-guard is unaffected
regardless of which endpoint created the thread. The only loss is orientation
quality: a chat opened on a zoomed non-root node from the UI today gets the
plain `/tree` seed instead of being told it's scoped, what's in its subtree, or
to use `write_context`/`read_up`. (The tool's own description text still
explains this to the model when it looks at the tool schema, so it's degraded,
not broken.) Root cause is simply commit ordering — the UI commit (`b05e4f5`,
15:53:28) landed 8 minutes before the backend commit that added
`POST /workbench/:id/open-chat` (`5a6f8ce3`, 16:01:09), both dispatched in
parallel. **Fix for whoever picks up the integration/review node:** in
`workbench.tsx`, swap the non-root branch of the chat-opening effect (and
`openChatWindow`) from `openSmartTodoChat(id)` to a node-scoped equivalent of
`openWorkbenchRootChat()` (i.e. call `POST /workbench/${id}/open-chat` instead
of `POST /smart-todos/${id}/open-chat`) — a one-line swap in
`jarvis-command-center/src/lib/cockpit-api.ts` plus the two call sites in
`workbench.tsx`.

## What was intentionally NOT re-proven here

- `insertSmartTodoTree`/`createSmartTodoNode`/`moveSmartTodoNode`/
  `deleteSmartTodoNode`'s own internals — these are pre-existing, already
  covered by `/tree`'s own history; this sim only proves Workbench code calls
  them correctly and gets the expected results back (items 2 and 9).
- A real (non-fake) `claude` CLI call — the fake binary proves the code's
  handling of both the success and failure shapes deterministically, which a
  live model call could not do reliably for the failure case. Given the fake
  binary is a real local process spawned via `execFile` with `ANTHROPIC_API_KEY`
  deleted from its env exactly like production, this does not weaken the NO
  API KEYS proof.
- The UI (`workbench.tsx`/`WorkbenchChatBar.tsx`) itself — out of this
  backend-only node's scope; the one integration gap it has is documented above
  for the review node.
