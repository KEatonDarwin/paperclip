# WORKBENCH — adversarial review (hopper node #444)

**Reviewer:** opus-5 worker, 2026-09-18. Last line before deploy.
**Scope reviewed:** full diff on `hopper/workbench` (darwin-assistant, 737b117b2..cb40b510c)
and `hopper/workbench-ui` (jarvis-command-center, b05e4f5), plus SPEC.md / RECON.md / SIM.md.

## VERDICT: **PASS with fixes applied.** Deployable.

The backend was correct and well-guarded. **The UI was not wired to it.** Three of the
four defects below were client↔server contract breaks that the node #443 sim could not
have caught — it proved the backend in isolation (43/43, re-run green after my fixes) and
never exercised the browser client. One of them was silently destructive.

Kevin's #1 constraint is **not violated**: see §3.

---

## 1. Defects found and FIXED in this review

### 🔴 F1 — the jot bar 400s on every single use (core feature dead)
`workbenchJot()` posted `{ note, focus_id }`; `POST /workbench/jot` reads `body.text` and
returns `400 invalid_request` when it's empty. (`/smart-todos/jot` takes `note`;
`/workbench/jot` takes `text` — the author carried the wrong key across.)
Spec §5 — match-or-create on jot, the headline of Kevin's ask — was 100% non-functional
from the UI. **Fixed:** `src/lib/cockpit-api.ts` now sends `{ text: note, focus_id }`.

### 🔴 F2 — Undo / Move on a jot receipt destroyed an UNRELATED branch
`submitJot` took `const created = result.nodes[0]`. The backend's `nodes` is
`listSmartTodoNodes()` — **the entire tree**, ordered `root_id, sort_order, id`. So
`nodes[0]` is Kevin's oldest root branch, not the node just created. `undoJot()` then called
`deleteSmartTodo(that.id)` → `deleteSubtreeStmt` **cascade-deletes that whole branch**, and
`relocateJot()` would re-parent it. One click of "Undo" on a jot would have silently wiped an
arbitrary top-level branch and every descendant.
Masked only by F1 (the jot never succeeded, so the receipt never rendered) — fixing F1 alone
would have armed this.
**Fixed:** backend already returned a correct `created[]`; the client type dropped it. Client
now maps `created` and the receipt acts on `created[0]`.

### 🟠 F3 — the docked chat used `/tree`'s opener, so §2/§3/§4 were never delivered
Both call sites used `openSmartTodoChat()` → `POST /smart-todos/:id/open-chat`. The whole
`POST /workbench/:id/open-chat` route and `buildWorkbenchSeedText()` were **dead code**.
Every scoped Workbench chat was therefore seeded with the plain `/tree` text ("use the
`smart_todos` tool's `sync` op") and got **none** of: the scope statement ("you are node N"),
the automatic subtree context, the ancestor chain, the `workbench` tool instructions, the
`read_up` rule, or the auto-notes contract. The server-side scope *guard* still worked
(it resolves from `linked_thread_ext`, not the seed), but the chat had no idea it was scoped.
That is Kevin's "instructed as to which leaf it is and how to traverse up the tree for
context" — structurally missing.
**Fixed:** added `openWorkbenchNodeChat()` to the client; both the docked binding and the
per-node "Open chat" button now use it. Find-or-create contract is identical, so no second
thread is ever created for a node.

### 🟠 F4 — `context_notes` was invisible to Kevin
The auto-notes the chats write (`write_context`) landed in the DB but were never fetched
(`toSmartTodoNode` didn't map the column) or rendered anywhere. Kevin's "each item has notes,
mine or automatic, so everything has context" was half-built: written, never readable.
**Fixed:** `context_notes` → `contextNotes` on the shared client shape (additive; `/tree`
ignores it), plus a ✨ indicator on any node/focus header that has auto-context and a
read-only "Auto-context" block above the notes textarea. Kevin's own `notes` textarea is
untouched — the two are visually and structurally separate.

### 🟡 F5 — the additive `ALTER` swallowed every error, not just "already exists"
`try { ALTER } catch { /* column already exists */ }` also swallowed a locked/read-only DB.
Since `appendContextStmt` and `touchActivityStmt` are `prepare()`d at module load against
those columns, a silently-failed ALTER turns into an inscrutable boot crash instead of the
real cause. **Fixed:** rethrows unless the message is `duplicate column name`.

### 🟡 F6 — new TS error introduced by the sidebar `/workbench` Link
`<Link to="/workbench">` without `search` failed the route's `validateSearch`.
**Fixed** (`search={{ focus: undefined }}`). UI typecheck is back to the 11 pre-existing
repo-baseline errors, none in files this branch touches.

---

## 2. Adversarial probes that came back CLEAN

| Probe | Result |
|---|---|
| **Migration safety** | `ADD COLUMN <name> TEXT`, nullable, no default → sqlite O(1) metadata-only, safe on the live populated table. Idempotent. No drop/rename/retype. ✅ |
| **Scope guard — move/split/relocate escape** | `move` guards **both** the node *and* the destination parent, and refuses `new_parent_id: null` from a zoomed scope. `add_child` guards the parent. `split`/`update`/`set_status`/`write_context` all guard the target. `read_up` is ancestor-only. Scope is re-resolved on every tool call (so nodes created earlier in the turn are legitimately in scope). ✅ |
| **Crafted id / scope claim** | Scope comes from the calling thread's `linked_thread_ext`, never an argument — a chat cannot widen its own scope. `parent_id: null` on `add_child` falls through `?? focusId`, so it can't escape to root. ✅ |
| **Cycle via in-scope move** | `moveSmartTodoNode` rejects moving a node into its own descendant. ✅ |
| **Placement — confident wrong parent** | Model may only name an id from the deterministic shortlist (`sanitizeDecision` filters to `candidateIds`); `confidence < 0.55` → forced to root + flagged; a parent deleted mid-flight → forced to root; any spawn/parse/timeout failure → `null` decision → root + `fallbackItem`. **A jot is never lost and never lands on a low-confidence guess.** The shortlist itself is fully deterministic (match_key / title substring / token overlap) and the model call is genuinely optional. ✅ |
| **NO API KEYS** | Both model call sites (`workbench.ts` placement, `smart-todos-decompose.ts`) spawn the local `claude` binary via `execFile` with `delete env.ANTHROPIC_API_KEY`, matching `briefing.ts` / `jarvis-brief.ts` / `foundry.ts`. No SDK import, no key anywhere in the diff. ✅ |
| **Thread identity / second thread** | `/workbench/:id/open-chat` reuses `linked_thread_ext` when the conversation still exists, and writes the same field `/tree` uses — a node opened from either surface resolves to the **same** thread. ✅ |
| **Fast-zoom binding to the wrong node** | `chatBindingKeyRef` is set synchronously before the async open and re-checked before `setChatBinding`; the `WorkbenchChatBar` is `key`ed on `externalId` so state resets on rebind. Stale responses are discarded. ✅ |
| **`context_notes` clobbering `notes`** | `appendSmartTodoContext` writes only `context_notes` (append, `\n`-joined, tail-capped at 8000). `notes` is never in that statement. Proven by sim check [7]. ✅ |
| **`/tree` regression** | `src/routes/tree.tsx` byte-for-byte unchanged; `/api/v1/smart-todos/*` handlers unchanged; `smart-todos-tool.ts` unchanged. Sim [10] re-verified all five smart-todos routes' response shapes. ✅ |

---

## 3. Kevin's #1 constraint — judgement

`src/smart-todos.ts` **is** modified. I examined whether that is a violation and concluded
**it is not**, because every change is strictly additive and SPEC.md's "Data decision"
section explicitly sanctions it (Kevin can flip it in one word):

- 3 nullable columns appended via idempotent `ALTER` — nothing existing dropped/renamed/retyped.
- `subtreeIds` changed from module-private to `export` — same function, same body.
- One **new** function `appendSmartTodoContext` + its own new statement.
- **No existing statement, function signature, return shape, or route was altered.**

`/tree`'s observable behaviour changes in exactly one way: `GET /smart-todos` (a `SELECT *`)
now also returns the 3 new nullable keys. `/tree`'s client mapper reads named fields and
ignores unknown ones, so nothing renders differently. Verified, not assumed.

**If Kevin reads his constraint as literally byte-for-byte on `src/smart-todos.ts`**, the
isolation flip SPEC.md already offers (a separate `workbench_nodes` table) is the answer —
but it costs him the actual premise ("it has to be HIS tree, not a second copy that
immediately diverges"). My recommendation is to keep it as built and tell him plainly that
one shared file grew, additively, on purpose.

---

## 4. Does it deliver the ask? Item by item

| Kevin's words | Status |
|---|---|
| "figures out if what I'm saying already has a place… if it exists, find where to put it; if not, create a top-level item and break it apart" | ✅ **after F1** — shortlist + one-shot + decomposition, with a Move/Undo receipt |
| "each individual tree item, no matter how far down, can have its own chat" | ✅ any node, any depth |
| "instructed as to which leaf it is and how to traverse up the tree for context" | ✅ **after F3** |
| "the chats themselves can create, read and update the individual tree items… adds them to the tree as we talk" | ✅ `workbench` tool + live `smart_todo` SSE — nodes appear above the chat as it talks |
| "click one top-level task and it zooms in on that branch" | ✅ + URL `?focus=`, so it's linkable and survives reload |
| "the chat at the bottom is then for me to talk directly to that branch" | ✅ docked bar, re-binds on zoom, header always names the scope |
| "click any smaller branch or leaf and it zooms to that part. Buttons to zoom out further and further" | ✅ breadcrumb (every crumb clickable) + zoom-out button + Esc |
| "if I need to talk for a long time, I open a real chat with the button you've provided" | ✅ same thread, full window |
| "context for every node underneath automatically" | ✅ **after F3** — full subtree in the seed |
| "ability to look at chats going upwards — but not automatic" | ✅ `read_up`, ancestor-only, summary-only, on demand |
| "each item has notes, taken by me or automatically" | ✅ **after F4** — `notes` (his) + `context_notes` (auto), separate and both visible |
| Flight Deck excluded | ✅ zero workstream/turn/next_action references in the diff |

**Nothing in the ask is missing after these fixes.** Two things are thinner than ideal and
are recorded as deferred items in `DECISIONS.md` (§D1 eager thread creation on zoom, §D2 the
`smart_todos` side-door) — neither blocks deploy.

## 5. Re-verification after my fixes
- `darwin-assistant` `tsc --noEmit`: **0 errors**.
- `workbench-sim-core.mjs` (scratch DB): **30/30 ✅**
- `workbench-sim-routes.mjs` (real HTTP): **13/13 ✅** — including the `/smart-todos/*` regression block.
- `jarvis-command-center` production build: **✅** (stray `.output` removed; deploy via
  `jarvis-cockpit-deploy.sh`, never a bare `bun run build`).
