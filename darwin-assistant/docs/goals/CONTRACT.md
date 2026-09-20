# GOALS — CONTRACT (binding data / API / tool contract, v0)

**Status:** BINDING as of 2026-09-19 (tree-2d558f04, node #454). `DESIGN.md` is the concept + visual spec; THIS file is what the backend lane (`hopper/goals`, darwin-assistant) and the UI lane (`hopper/goals-ui`, jarvis-command-center) build against **without talking to each other**. Do not thin it out. Do not invent beyond it. If something is genuinely missing, the builder adds it here in the same commit (additive only) and says so in its finish result.

**Namespace rule (hard):** tables `goal*` · module `src/goals.ts` · routes `/api/v1/goals/*` · tool `goals` · SSE `goal`, `goal_node`, `goal_focus` · threads `cockpit:goal-<id>` · cockpit routes `/goals`, `/goals/$goalId`. Nothing in here imports from, references, or reuses `workbench*`, `smart-todos*`, `workstreams*`, `thread-todos*`, or the idea-tree UI. The ONLY reused assets are (a) the hopper engine (`createHopperTree` + `agreeHopperTree` + `GET /hopper-trees/:id` for the read-only overlay), (b) the existing conversation store + `/threads/:ext/messages` ingest, and (c) `ThreadPane`'s conversation rendering on the cockpit side.

---

## 0. Vocabulary (from DESIGN.md, restated so nothing is ambiguous)

| Term | Meaning |
|---|---|
| **Goal** | A root. `goals` row. Owns exactly one thread `cockpit:goal-<id>`. Never a task. |
| **Node** | Anything under a goal, any depth. `goal_nodes` row. |
| **Ghost** | A node with `state='ghost'` (JARVIS-proposed, not yet ✓'d) — OR a set node carrying a pending edit/removal. Rendered dashed/dimmed. |
| **Set** | `state='set'`: real, approved, in the tree for good. |
| **Leaf kind** | `leaf_kind ∈ {none, machine, human}`. `machine` = JARVIS can build it → Plan → hopper tree. `human` = only Kevin can do it (amber). `none` = not decided / still splits. |
| **Plan** | JSON on a machine leaf describing what gets built. Ghost until approved. |
| **Focus** | Server-owned pointer: one goal → at most one node. Clicking = focus. Zero model calls. |
| **Batch** | A set of ghosts proposed together, sharing `proposal_batch` (uuid). Enables "✓ all / ✕ all". |
| **actor** | `'kevin' \| 'jarvis' \| 'system'` — who caused a change. |

Authorship: `authored_by ∈ {kevin, jarvis}`. Kevin-authored nodes are born `set`; JARVIS-authored nodes are born `ghost`. This is the ONE rule that decides whether a write is a ghost.

---

## 1. SQLite DDL (jarvis.db, `src/goals.ts`)

Idempotent, declared at module load via `sqliteDb.exec(...)` exactly like `thread-links.ts`. Every table uses `TEXT` ISO timestamps via `datetime('now')`, `INTEGER PRIMARY KEY AUTOINCREMENT`, and `CHECK` constraints on enums. No migrations framework — additive `ALTER TABLE` guarded by a `PRAGMA table_info` check if a later version needs a column.

```sql
CREATE TABLE IF NOT EXISTS goals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  done_means    TEXT,                                    -- REQUIRED to become 'set'
  notes         TEXT,
  status        TEXT    NOT NULL DEFAULT 'ghost'
                CHECK (status IN ('ghost','set','done','parked')),
  authored_by   TEXT    NOT NULL DEFAULT 'kevin'
                CHECK (authored_by IN ('kevin','jarvis')),
  thread_ext    TEXT    UNIQUE,                          -- 'cockpit:goal-<id>' once the chat exists (NULL until first open)
  promoted_from_node_id INTEGER REFERENCES goal_nodes(id), -- set when this goal was promoted out of a node
  sort_order    INTEGER NOT NULL DEFAULT 0,
  verified_at   TEXT,                                    -- when status flipped to 'done'
  archived      INTEGER NOT NULL DEFAULT 0,              -- 0/1; archived goals hidden from the forest by default
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goal_nodes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id            INTEGER NOT NULL REFERENCES goals(id),
  parent_id          INTEGER REFERENCES goal_nodes(id),  -- NULL = direct child of the goal root
  title              TEXT    NOT NULL,
  done_means         TEXT,                               -- REQUIRED to become 'set'
  notes              TEXT,
  authored_by        TEXT    NOT NULL DEFAULT 'jarvis'
                     CHECK (authored_by IN ('kevin','jarvis')),
  state              TEXT    NOT NULL DEFAULT 'ghost'
                     CHECK (state IN ('ghost','set','planned','working','check','done','parked','discarded')),
  leaf_kind          TEXT    NOT NULL DEFAULT 'none'
                     CHECK (leaf_kind IN ('none','machine','human')),
  plan_state         TEXT    NOT NULL DEFAULT 'none'
                     CHECK (plan_state IN ('none','proposed','approved')),
  plan               TEXT,                               -- JSON (see §1.2) or NULL
  tree_id            TEXT,                               -- hopper_trees.id once dispatched (no FK: hopper engine owns that table)
  tree_status_cache  TEXT,                               -- last observed hopper tree status: 'active'|'done'|'blocked' (badge only)
  pending_title      TEXT,                               -- JARVIS-proposed edit awaiting ✓/✕ (set nodes only)
  pending_done_means TEXT,                               -- same
  pending_removal    INTEGER NOT NULL DEFAULT 0,         -- 0/1: JARVIS-proposed strike awaiting ✓/✕ (set nodes only)
  pending_by         TEXT    CHECK (pending_by IN ('jarvis') OR pending_by IS NULL),
  proposal_batch     TEXT,                               -- uuid shared by ghosts proposed together (NULL once set/discarded)
  promoted_to_goal_id INTEGER REFERENCES goals(id),      -- set when this node was promoted into its own goal
  sort_order         INTEGER NOT NULL DEFAULT 0,
  verified_at        TEXT,                               -- when state flipped to 'done'
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_goal_nodes_goal   ON goal_nodes(goal_id, parent_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_goal_nodes_batch  ON goal_nodes(proposal_batch);
CREATE INDEX IF NOT EXISTS idx_goal_nodes_tree   ON goal_nodes(tree_id);

CREATE TABLE IF NOT EXISTS goal_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     INTEGER NOT NULL REFERENCES goals(id),
  node_id     INTEGER REFERENCES goal_nodes(id),         -- NULL = goal-level event
  actor       TEXT    NOT NULL CHECK (actor IN ('kevin','jarvis','system')),
  kind        TEXT    NOT NULL,                          -- see §1.3
  text        TEXT,                                      -- human-readable one-liner
  data        TEXT,                                      -- JSON details (old/new values, tree_id, batch id…) or NULL
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_goal_events_goal ON goal_events(goal_id, id);

CREATE TABLE IF NOT EXISTS goal_focus (
  goal_id     INTEGER PRIMARY KEY REFERENCES goals(id),  -- one focus row per goal
  node_id     INTEGER REFERENCES goal_nodes(id),         -- NULL = goal root focused / no node focused
  set_by      TEXT    NOT NULL DEFAULT 'kevin' CHECK (set_by IN ('kevin','jarvis','system')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

### 1.1 Column semantics that the code must enforce (not just the CHECKs)

- `goals.done_means` and `goal_nodes.done_means` MUST be non-empty (trimmed) before `status/state` may become `set`. Server returns `409 done_means_required` otherwise.
- `goal_nodes.parent_id` MUST reference a node in the same `goal_id` (server-validated; `400 parent_goal_mismatch`).
- A node may only be created under a parent whose `state ∈ {set, planned, working, check}` — never under a ghost, discarded, parked, or done node (`409 parent_not_set`). Direct children of the root require `goals.status ∈ {set}` (`409 goal_not_set`). **This is how "one layer ahead, never two" is enforced structurally: a ghost cannot have children.**
- `leaf_kind` may only be `machine`/`human` on a node with NO non-discarded children (`409 node_has_children`). Creating a child under a node with `leaf_kind != 'none'` resets that node's `leaf_kind` to `none` and `plan_state` to `none`, `plan` to NULL — only allowed while `state ∈ {set}` (`409 leaf_already_dispatched` if `planned/working/check/done`).
- `plan`/`plan_state` are only meaningful when `leaf_kind='machine'`. Setting `leaf_kind` to `human` or `none` clears `plan`, `plan_state='none'`.
- `pending_*` fields exist only on `state='set'` nodes (and `planned`, for a title/done_means tweak). Resolving them (accept/reject) always clears all four (`pending_title`, `pending_done_means`, `pending_removal`, `pending_by`).
- `proposal_batch` is set at proposal time for JARVIS-authored ghosts; cleared to NULL when the node becomes `set` or `discarded`.
- `discarded` nodes are kept (audit) but excluded from every tree read unless `?include_discarded=1`.
- `sort_order`: siblings ordered by `(sort_order ASC, id ASC)`. New nodes default to `max(sibling sort_order)+1`.
- `updated_at` bumps on every write. `goals.updated_at` also bumps whenever any of its nodes/focus changes (drives "last activity" on the forest card).

### 1.2 `plan` JSON (machine leaves)

```json
{
  "what": "One paragraph: what gets built.",
  "deliverable": "One line: the artifact (branch/doc/endpoint/…) that proves done_means.",
  "model": "claude-sonnet-5",
  "adapter": "claude",
  "estimate": "~40 min, ~3 worker turns",
  "nodes": [
    { "title": "…", "spec": "…", "adapter": "claude", "model": "claude-sonnet-5", "depends_on_indexes": [] },
    { "title": "…", "spec": "…", "adapter": "claude", "model": "claude-opus-5", "depends_on_indexes": [0] }
  ],
  "proposed_at": "2026-09-19T17:10:00Z",
  "approved_at": null
}
```
- `nodes[]` is EXACTLY the hopper engine's `NewNodeInput[]` shape (title, spec, adapter, model, depends_on_indexes, priority). Flat DAG only (`parent_index` forbidden). 1–12 nodes.
- `adapter` is always `"claude"` in v0 (standing 🅰️🅱️ directive — the harness picks account A/B). `model` per `skills/jarvis-router/SKILL.md` tiers: Light `claude-haiku-4-5-20251001` · Standard `claude-sonnet-5` (default) · Heavy `claude-opus-5` (review gates/design). Never `claude-fable-5` on a leaf. Server rejects a plan whose `nodes[]` is empty, has a non-claude adapter, or has a fable/frontier model (`400 plan_invalid`).
- Top-level `model` is the headline shown on the Plan card (the dominant tier); `estimate` is free text.

### 1.3 `goal_events.kind` vocabulary (closed list)

`goal_created` · `goal_set` · `goal_done` · `goal_parked` · `goal_unparked` · `goal_updated` · `thread_opened` ·
`node_proposed` · `node_created` (kevin-authored, born set) · `node_accepted` · `node_discarded` · `node_updated` ·
`edit_proposed` · `edit_accepted` · `edit_rejected` · `removal_proposed` · `removal_accepted` · `removal_rejected` ·
`leaf_kind_set` · `plan_proposed` · `plan_approved` · `plan_rejected` · `tree_planted` · `tree_done` · `tree_blocked` ·
`node_check` (auto-flip) · `node_verified` · `node_parked` · `node_unparked` · `node_promoted` · `human_done` · `focus_set` · `log` ·
`ghost_edited_by_kevin` · `kevin_okd_edit` · `node_agreed` · `jarvis_pushed_back` (all four v0.1 §11.2) ·
`node_moved` · `move_proposed` · `move_accepted` · `move_rejected` · `kevin_restructured` (all five v0.2 §13).

Every state-changing route/tool op in §3/§5 writes exactly one event (listed per route). `focus_set` is written on focus PUT only when the node actually changes (no spam on re-clicks).

---

## 2. State machines (server-enforced; any other transition → `409 invalid_transition` with `{from, to}` in `extra`)

### 2.1 Node `state`

| From | To | Trigger | Preconditions |
|---|---|---|---|
| *(new, jarvis)* | `ghost` | propose | parent set (or goal set for root-level) |
| *(new, kevin)* | `set` | `set_from_kevin` / POST node with `authored_by=kevin` | done_means present; parent set |
| `ghost` | `set` | accept (one/batch/all) | done_means present |
| `ghost` | `discarded` | discard | — |
| `set` | `planned` | approve_plan when tree planting THROWS (plan approved, no tree yet — transient, retry re-plants) | leaf_kind=machine, plan_state=proposed |
| `set` | `working` | approve_plan (normal path: set→working in one transaction, `planned` skipped) | leaf_kind=machine, plan_state=proposed |
| `planned` | `working` | retry plant (`POST /nodes/:id/approve_plan` again) | tree_id NULL |
| `working` | `check` | **system**: linked hopper tree status → `done` | — |
| `set` (non-leaf) | `check` | **system**: every non-discarded child is `done` (and ≥1 child exists) | — |
| `set` (human leaf) | `check` | Kevin clicks **Done** (`POST /nodes/:id/human_done`) | leaf_kind=human |
| `check` | `done` | verify (Kevin ✓ or JARVIS `verify` op) | — |
| `check` | `set` | verify `passed=false` (reopen). Machine leaf: `plan_state='none'`, prior `plan`/`tree_id` kept for reference; a fresh propose_plan → approve_plan plants a NEW tree | — |
| `set`,`planned`,`check` | `parked` | park | — |
| `working` | `parked` | park — allowed; hopper tree is NOT touched (engine keeps running); UI shows parked + working pill | — |
| `parked` | *(previous state)* | unpark — server restores the state it left from (stored in the `node_parked` event `data.from`) | — |
| `set` (with `pending_removal=1`) | `discarded` | resolve removal accept | — |
| `set`,`planned`,`check`,`working` | *(unchanged)* + `promoted_to_goal_id` | promote — node stays in place as a link stub; its subtree MOVES to the new goal (see §3.16) | — |

Rules: `done` and `discarded` are terminal (no transition out). `working` cannot be discarded. A node can be promoted at most once.

### 2.2 Goal `status`

| From | To | Trigger |
|---|---|---|
| *(new)* | `ghost` | POST /goals without done_means (the normal `+ New goal` path) |
| *(new)* | `set` | POST /goals WITH done_means |
| `ghost` | `set` | PATCH /goals/:id with done_means (any actor) — goals never need a ✓; done_means IS the approval |
| `set` | `done` | POST /goals/:id/verify (root done_means verified). Precondition: every non-discarded, non-parked node is `done` (`409 children_not_done`) |
| `set` | `parked` | park |
| `parked` | `set` | unpark |
| `done` | *(terminal)* | — |

### 2.3 `plan_state` (machine leaves only)

`none → proposed` (propose_plan; replaces any prior proposed plan) · `proposed → approved` (approve_plan) · `proposed → none` (reject_plan, or leaf_kind change) · `approved` is terminal for that plan; a `check → set` reopen resets to `none`.

### 2.4 System auto-flips (run inside the same write transaction that triggered them)

1. **Child settles → parent check.** After any node write that leaves a node at `done` (or `discarded`), the server re-evaluates the parent: if parent `state='set'`, has ≥1 non-discarded child, and ALL non-discarded, non-parked children are `done` → parent → `check`, event `node_check`, emit `goal_node`. Recurse upward (a parent flipping to `check` does not flip ITS parent — that needs a verify). Root-level: if all root nodes are done, nothing auto-flips on the goal (goal `done` is always an explicit verify).
2. **Tree done → node check.** `hopper-engine.ts` `maybeFinishTree()` calls `goalsOnTreeStatus(treeId, 'done')` (exported from `goals.ts`, imported lazily to avoid a cycle). Node with `tree_id=treeId` and `state='working'` → `check`, `tree_status_cache='done'`, event `tree_done`.
3. **Tree blocked → badge only.** When any node of the linked tree lands `blocked` or `blocked_question`, the engine calls `goalsOnTreeStatus(treeId, 'blocked')` → `tree_status_cache='blocked'`, event `tree_blocked` (once per transition; a later unblock → `goalsOnTreeStatus(treeId,'active')` → cache `'active'`). Node `state` stays `working`.

---

## 3. HTTP routes — all under `/api/v1/goals`, bearer `JARVIS_COCKPIT_KEY`, JSON in/out, errors as `{ "error": { "code", "message", ...extra } }` via the existing `sendError`. Mount in `handlers/api-v1.ts` next to the hopper routes.

### 3.0 Shared response shapes

```ts
type GoalRow = {
  id: number; title: string; done_means: string | null; notes: string | null;
  status: 'ghost'|'set'|'done'|'parked'; authored_by: 'kevin'|'jarvis';
  thread_ext: string | null; promoted_from_node_id: number | null;
  sort_order: number; verified_at: string | null; archived: 0|1;
  created_at: string; updated_at: string;
};
type GoalCounts = {
  total: number; done: number; working: number; check: number;
  need_you: number;        // = ghosts + human_open + check + nodes with plan_state='proposed'
  ghosts: number;          // state='ghost' OR any pending_* set
  human_open: number;      // leaf_kind='human' AND state='set'
  awaiting_jarvis: number; // v0.1 §11.1 — ghosts with review_state='awaiting_jarvis' (Kevin OK'd, waiting on JARVIS); need_you unchanged
  progress: number;        // 0..100 = round(100 * done / max(1, total_non_discarded_non_parked))
};
type GoalSummary = GoalRow & { counts: GoalCounts; focus_node_id: number | null; last_event_at: string | null };

type GoalNodeRow = {
  id: number; goal_id: number; parent_id: number | null;
  title: string; done_means: string | null; notes: string | null;
  authored_by: 'kevin'|'jarvis';
  state: 'ghost'|'set'|'planned'|'working'|'check'|'done'|'parked'|'discarded';
  leaf_kind: 'none'|'machine'|'human';
  plan_state: 'none'|'proposed'|'approved'; plan: PlanJson | null;
  tree_id: string | null; tree_status_cache: 'active'|'done'|'blocked'|null;
  pending_title: string | null; pending_done_means: string | null; pending_removal: 0|1; pending_by: 'jarvis'|null;
  proposal_batch: string | null; promoted_to_goal_id: number | null;
  // v0.1 §11.1 — Kevin-edit tracking + JARVIS weigh-in gate:
  last_edited_by: 'kevin'|'jarvis'|null;      // who last edited this ghost's title/done_means/notes; NULL once it leaves ghost
  kevin_edit_original: string | null;         // JSON {title,done_means,notes} snapshot of the JARVIS wording at Kevin's FIRST edit
  review_state: 'none'|'awaiting_jarvis'|'pushed_back';
  review_note: string | null;                 // JARVIS's push-back note
  // v0.2 §13.1 — Kevin structure changes + JARVIS pending move:
  kevin_moved_at: string | null; kevin_move_from: number | null;   // Kevin's last move of this node (from parent id, -1 = root); NULL once the round closes
  pending_parent_id: number | null;           // JARVIS-proposed re-parent awaiting ✓/✕ (-1 = to root); resolved by route 19
  sort_order: number; verified_at: string | null; created_at: string; updated_at: string;
  // derived, always present on reads:
  depth: number;             // 0 = direct child of root
  child_count: number;       // non-discarded children
  path: string[];            // titles root→this, e.g. ["Goal title","Parent","This"]
};
type GoalTree = { goal: GoalSummary; nodes: GoalNodeRow[]; focus: FocusRow };  // nodes = flat pre-order (parent before children), siblings by sort_order
type FocusRow = { goal_id: number; node_id: number | null; set_by: 'kevin'|'jarvis'|'system'; updated_at: string; path: string[] };
type GoalEventRow = { id: number; goal_id: number; node_id: number | null; actor: 'kevin'|'jarvis'|'system'; kind: string; text: string | null; data: unknown | null; created_at: string };
```

`actor` on write requests: optional body field `actor` ∈ `kevin|jarvis|system`; default `kevin` for HTTP (the cockpit is Kevin's hand), `jarvis` when called via the tool (§5). Every write response returns the full affected row(s) AND the server emits the matching SSE event (§4) — clients may patch from the response or refetch on SSE; both are correct.

### 3.1 Goals

| # | Route | Body | 2xx response | Event |
|---|---|---|---|---|
| 1 | `GET /goals?include_done=0&include_archived=0` | — | `{ goals: GoalSummary[] }` ordered `sort_order, id` | — |
| 2 | `POST /goals` | `{ title, done_means?, notes?, authored_by? ('kevin' default), actor? }` | `201 { goal: GoalSummary, thread: { external_id, created: true, seed_text } }` — creates the thread row immediately (`getOrCreateConversation('cockpit:goal-<id>')`, renamed `🎯 <title>`), stores `thread_ext`, returns seed_text so the client can post it (§8). status = `set` if done_means non-empty else `ghost`. | `goal_created` (+`thread_opened`) |
| 3 | `GET /goals/:id?include_discarded=0` | — | `GoalTree` | — |
| 4 | `PATCH /goals/:id` | `{ title?, done_means?, notes?, sort_order?, archived?, actor? }` | `{ goal: GoalSummary }`. Setting a non-empty done_means on a `ghost` goal flips it to `set`. | `goal_updated` / `goal_set` |
| 5 | `POST /goals/:id/verify` | `{ passed: true, note?, actor? }` | `{ goal }` → `done`, `verified_at`. `passed:false` → no-op 200 with `{ goal, verified:false }`. `409 children_not_done`. | `goal_done` |
| 6 | `POST /goals/:id/park` / `POST /goals/:id/unpark` | `{ actor? }` | `{ goal }` | `goal_parked` / `goal_unparked` |
| 7 | `GET /goals/:id/events?after=<id>&limit=100` | — | `{ events: GoalEventRow[] }` ascending by id | — |
| 8 | `GET /goals/:id/thread` | — | `{ external_id: 'cockpit:goal-<id>', created: boolean, seed_text: string \| null }` — find-or-create, 2-step (§8): server creates/links the conversation; **client** POSTs `seed_text` to `POST /threads/:ext/messages` when `created=true`. Also called `POST` (same behavior) for symmetry with `/workstreams/:id/discuss`. | `thread_opened` (first time only) |

### 3.2 Nodes — `/goals/:id/nodes…` (goal id in path; node ids must belong to that goal → `404 node_not_found`)

| # | Route | Body | Response | Event |
|---|---|---|---|---|
| 9 | `POST /goals/:id/nodes` | `{ title, done_means?, notes?, parent_id? (null=root-level), authored_by? , leaf_kind?, sort_order?, actor? }` | `201 { node: GoalNodeRow }`. **`authored_by='kevin'` (default over HTTP) → born `set`** (done_means REQUIRED → `409 done_means_required`). **`authored_by='jarvis'` → born `ghost`** with a fresh `proposal_batch`. Parent preconditions §1.1. | `node_created` / `node_proposed` |
| 10 | `POST /goals/:id/nodes/propose` | `{ parent_id (null=root-level), items: [{ title, done_means, notes?, leaf_kind? }], actor:'jarvis' }` | `201 { batch_id, nodes: GoalNodeRow[] }` — all `ghost`, `authored_by='jarvis'`, same `proposal_batch`. **items must NOT nest** (`400 no_nesting` — one layer ahead). 1–12 items. | `node_proposed` ×N (data.batch_id) |
| 11 | `POST /goals/:id/nodes/:nodeId/accept` | `{ actor? }` | `{ node }` ghost→set; clears `proposal_batch`. `409 done_means_required` if empty. | `node_accepted` |
| 12 | `POST /goals/:id/batches/:batchId/accept` | `{ ids?: number[], actor? }` | `{ nodes: GoalNodeRow[] }` — all ghosts in batch (or the subset in `ids`) → set. Any missing done_means → whole call `409 done_means_required` with `extra.node_ids`. | `node_accepted` ×N |
| 13 | `POST /goals/:id/accept_all` | `{ parent_id?: number\|null, actor? }` | `{ nodes }` — every ghost in the goal (or only ghosts under `parent_id` when provided; `null` = root-level ghosts) → set. Also accepts ALL pending edits/removals in scope? **No.** accept_all is ghosts only; pending diffs are resolved individually (§3.4). | `node_accepted` ×N |
| 14 | `POST /goals/:id/nodes/:nodeId/discard` | `{ reason?, actor? }` | `{ node }` ghost→discarded | `node_discarded` |
| 15 | `POST /goals/:id/batches/:batchId/discard` | `{ ids?, actor? }` | `{ nodes }` | `node_discarded` ×N |
| 16 | `PATCH /goals/:id/nodes/:nodeId` | `{ title?, done_means?, notes?, sort_order?, actor? }` | `{ node }` — **direct edit**. Allowed for `actor='kevin'` on any non-terminal node. For `actor='jarvis'` allowed ONLY on `ghost` nodes (its own proposals morphing during conversation); on a set node JARVIS must use propose_edit (`403 jarvis_must_propose`). | `node_updated` (data.old/new) |

### 3.3 Pending edits / removals (JARVIS → set node)

| # | Route | Body | Response | Event |
|---|---|---|---|---|
| 17 | `POST /goals/:id/nodes/:nodeId/propose_edit` | `{ title?, done_means?, actor:'jarvis' }` (≥1 field) | `{ node }` with `pending_title`/`pending_done_means` set, `pending_by='jarvis'`. Only on `state ∈ {set, planned}`. Replaces any earlier pending edit. | `edit_proposed` |
| 18 | `POST /goals/:id/nodes/:nodeId/propose_removal` | `{ reason?, actor:'jarvis' }` | `{ node }` with `pending_removal=1`. Only on `state ∈ {set}` with **no non-discarded children** (`409 node_has_children`) and not `working` (`409 leaf_already_dispatched`). | `removal_proposed` |
| 19 | `POST /goals/:id/nodes/:nodeId/resolve_pending` | `{ accept: boolean, actor? }` | `{ node }`. accept+edit → title/done_means overwritten. accept+removal → `discarded`. reject → pending_* cleared, node untouched. `409 nothing_pending`. | `edit_accepted`/`edit_rejected`/`removal_accepted`/`removal_rejected` |

### 3.4 Leaf kind, plan, dispatch, verify

| # | Route | Body | Response | Event |
|---|---|---|---|---|
| 20 | `POST /goals/:id/nodes/:nodeId/leaf_kind` | `{ leaf_kind: 'none'\|'machine'\|'human', actor? }` | `{ node }`. Preconditions §1.1. Setting `human`/`none` clears plan. **Note:** JARVIS setting leaf_kind on a SET node is NOT a ghost operation — leaf kind is a classification, not content; it applies immediately (DESIGN: "decide leaf kind when a node can't split"). Kevin can flip it back any time. | `leaf_kind_set` |
| 21 | `POST /goals/:id/nodes/:nodeId/propose_plan` | `{ plan: PlanJson, actor:'jarvis' }` | `{ node }` `plan_state='proposed'`, plan stored with `proposed_at`. Requires `leaf_kind='machine'`, `state='set'` (`409 plan_requires_machine_leaf`). Validation §1.2 → `400 plan_invalid` with `extra.reason`. | `plan_proposed` |
| 22 | `POST /goals/:id/nodes/:nodeId/reject_plan` | `{ reason?, actor? }` | `{ node }` `plan_state='none'`, `plan=null` | `plan_rejected` |
| 23 | `POST /goals/:id/nodes/:nodeId/approve_plan` | `{ actor? }` | `{ node, tree: { id, topic }, hopper_nodes: HopperNodeRow[] }`. **Server does, in order:** (a) `plan_state='approved'`, `plan.approved_at`; (b) `createHopperTree(topic, 'cockpit:goal-<id>', plan.nodes)` where `topic = "<goal title> › <node path…> — <node title>"` (≤300 chars); (c) `agreeHopperTree(tree.id)`; (d) node `tree_id=tree.id`, `tree_status_cache='active'`, `state='working'`. If (b)/(c) throws: node left at `planned` (plan approved, no tree) and `502 tree_plant_failed`; a retry of the same route from `planned` re-runs (b)–(d). Precondition `plan_state='proposed'` (`409 plan_not_proposed`). | `plan_approved` + `tree_planted` (data.tree_id) |
| 24 | `POST /goals/:id/nodes/:nodeId/human_done` | `{ note?, actor? }` | `{ node }` human leaf `set → check` (Kevin says he did it; still verified against done_means like everything else — one click `Done`, one click `Verified ✓`; JARVIS's `verify` op may do the second). | `human_done` |
| 25 | `POST /goals/:id/nodes/:nodeId/verify` | `{ passed: boolean, note?, actor? }` | `{ node }`. `passed:true`: `check → done`, `verified_at`; then run §2.4(1) for the parent. `passed:false`: `check → set`; if machine leaf: `plan_state='none'` (plan kept in `plan` for reference, `tree_id` kept), `tree_status_cache=null`. `409 invalid_transition` unless `state='check'`. | `node_verified` (data.passed, note) |
| 26 | `POST /goals/:id/nodes/:nodeId/park` / `…/unpark` | `{ actor? }` | `{ node }` | `node_parked` (data.from) / `node_unparked` |
| 27 | `POST /goals/:id/nodes/:nodeId/promote` | `{ actor? }` | `201 { goal: GoalSummary, node: GoalNodeRow, thread: { external_id, created:true, seed_text } }` — see §3.16 | `node_promoted` + on new goal `goal_created`, `thread_opened` |
| 28 | `GET /goals/:id/nodes/:nodeId/tree` | — | proxy of `GET /hopper-trees/:treeId` → `{ tree, nodes }` for the overlay; `404 no_tree` when `tree_id` NULL. (Read-only; the overlay never edits.) | — |

### 3.5 Focus

| # | Route | Body | Response | Event |
|---|---|---|---|---|
| 29 | `GET /goals/:id/focus` | — | `{ focus: FocusRow }` (row auto-created with `node_id=null` if absent) | — |
| 30 | `PUT /goals/:id/focus` | `{ node_id: number \| null, set_by? ('kevin' default) }` | `{ focus: FocusRow }`. **ZERO model calls, ZERO thread creation.** `404 node_not_found` if node not in goal; discarded nodes cannot be focused (`409 node_discarded`). | `focus_set` only if node_id changed |

### 3.6 Promotion semantics (route 27, "the only escape hatch")

1. Create a new goal: `title` = node title, `done_means` = node done_means, `notes` = node notes, `authored_by` = node authored_by, `status='set'` (done_means already present, guaranteed by the node being set), `promoted_from_node_id = node.id`.
2. Create + link its thread (`cockpit:goal-<newId>`), same as POST /goals.
3. **Move the subtree:** every descendant of the node gets `goal_id=newId`; the node's direct children get `parent_id=NULL` (they become root-level in the new goal). States/plans/tree_ids carry over untouched. `goal_focus` for the old goal: if it pointed into the moved subtree, reset to `node_id=null`.
4. The original node stays in the old goal as a **link stub**: `promoted_to_goal_id=newId`, state unchanged, `leaf_kind='none'`, `child_count=0` after the move. UI renders it with a "→ goal" chip; clicking navigates to `/goals/<newId>`. When the new goal reaches `done`, the server flips the stub node `→ check` (event `node_check`, data.reason='promoted_goal_done'), so the parent goal still verifies it.
5. Preconditions: `state ∈ {set, planned, check, working}`, not already promoted (`409 already_promoted`).

---

## 4. SSE (via the existing `/events` stream; add `'goal','goal_node','goal_focus'` to the `FORWARD` set in `api-v1.ts` and the union in `sse-bus.ts`; add the same three to the cockpit `sse-worker.ts` `EVENT_TYPES`). All three are **global** (no `conversationId` — same treatment as `hopper_node`/`workstream`), so admin-scope clients receive them all; the cockpit filters by `goal_id` client-side.

```ts
export interface GoalEvent {            // 'goal'
  type: 'goal';
  action: 'created' | 'updated' | 'deleted';   // 'deleted' reserved (v0 never hard-deletes; archived → 'updated')
  goal: GoalSummary;
}
export interface GoalNodeEvent {        // 'goal_node'
  type: 'goal_node';
  action: 'created' | 'updated' | 'deleted';   // 'deleted' reserved; discard → 'updated' with state='discarded'
  goal_id: number;
  node: GoalNodeRow;                            // includes derived depth/child_count/path
  batch_id?: string;                            // present on propose/batch accept/discard so the UI can animate the bracket
}
export interface GoalFocusEvent {       // 'goal_focus'
  type: 'goal_focus';
  goal_id: number;
  focus: FocusRow;
}
```
Emission rules: one `goal_node` per affected node row (a batch of 6 ghosts = 6 events sharing `batch_id`); one `goal` event after any change that alters `GoalCounts`/`status`/`updated_at` (i.e. after every node write too — the forest card must stay live); `goal_focus` on PUT focus when changed and on promote-reset. Wire format is the existing one: `event: goal_node\ndata: {...,"external_id":undefined}`.

---

## 5. The `goals` JARVIS tool (`src/tools/goals-tool.ts`, registered in `tools/index.ts`)

**Scope resolution:** the tool reads `context.externalId`. If it matches `^cockpit:goal-(\d+)$`, `goal_id` is implied and **args.goal_id is ignored**; outside a goal thread, `goal_id` is required on every op except `list`. Writes from the tool are always `actor='jarvis'` (the tool cannot impersonate Kevin — except `set_from_kevin`, which records `authored_by='kevin'` because Kevin dictated it verbatim).

**THE RULE (in the tool description, verbatim):** *"Propose for anything not dictated verbatim by Kevin. `set_from_kevin` is ONLY for a node Kevin literally spelled out (title + what done means) in this conversation; everything you think of, infer, reword, split, or remove goes through propose / propose_edit / propose_remove and renders as a ghost until he ✓s it. Never create grandchildren: propose children only under the focused node or a node he named, one layer at a time. Every proposed node MUST carry a one-line done_means."*

| op | args | does (route) | returns |
|---|---|---|---|
| `list` | `goal_id?` — without it: the forest; with it: the full tree | GET /goals or GET /goals/:id | `{ goals }` or `GoalTree` (nodes trimmed to `id,parent_id,title,done_means,state,leaf_kind,plan_state,tree_id,tree_status_cache,pending_*,proposal_batch,depth,child_count,authored_by`) |
| `set_goal_done_means` | `done_means` | PATCH /goals/:id `{ done_means, actor:'jarvis' }` — ONLY after Kevin confirmed the sentence in this conversation; flips a ghost goal to set | `{ goal }` |
| `propose` | `parent_id` (number \| null = root-level; **defaults to the current focus node** when omitted inside a goal thread), `items: [{title, done_means, notes?, leaf_kind?}]` (1–12, NO nesting) | POST …/nodes/propose | `{ batch_id, nodes }` |
| `set_from_kevin` | `parent_id` (same default), `title`, `done_means`, `notes?`, `leaf_kind?` | POST …/nodes with `authored_by='kevin'` | `{ node }` (born set) |
| `accept` | `node_id?` \| `batch_id?` \| `all:true` (+ `parent_id?` for all) — exactly one | routes 11/12/13 — **use ONLY when Kevin said yes in this conversation** ("yep", "go", "✓ all"); never accept your own proposal unprompted | `{ nodes }` |
| `discard` | `node_id?` \| `batch_id?` — exactly one | routes 14/15 | `{ nodes }` |
| `edit_ghost` | `node_id`, `title?`, `done_means?`, `notes?` | route 16 PATCH with `actor='jarvis'` — reword YOUR OWN still-ghost proposal in place while Kevin talks it through (DESIGN: "we'd talk about it a little bit more and watch it change"). The server 403s `jarvis_must_propose` on anything already set, so this cannot write real content. Do NOT discard + re-propose to reword — that loses the row and its batch bracket. | `{ node }` |
| `propose_edit` | `node_id`, `title?`, `done_means?` | route 17 | `{ node }` |
| `propose_remove` | `node_id`, `reason?` | route 18 | `{ node }` |
| `move` | `node_id`, `parent_id` (number \| null) | v0.2 §13.6 — ghost → route 31 direct (actor jarvis); non-ghost → route 32 `propose_move` (pending move Kevin ✓s via route 19) | `{ node, moved:true }` / `{ node, proposed:true }` |
| `set_leaf_kind` | `node_id`, `leaf_kind` | route 20 | `{ node }` |
| `propose_plan` | `node_id`, `plan: PlanJson` (§1.2; the tool fills `adapter:'claude'` on every node if omitted and rejects fable/non-claude before hitting the server) | route 21 | `{ node }` |
| `dispatch` | `node_id` | route 23 approve_plan — **only when Kevin approved the plan in conversation** (the normal path is his click on the Plan card; this exists so "yeah go build it" typed in chat works) | `{ node, tree }` |
| `verify` | `node_id`, `passed: boolean`, `note?` | route 25 (or route 5 when `node_id` is omitted and `goal:true` → verify the goal root) | `{ node }` / `{ goal }` |
| `human_done` | `node_id`, `note?` | route 24 — only when Kevin said he did it | `{ node }` |
| `park` / `unpark` | `node_id?` (omit → the goal) | routes 26 / 6 | `{ node }` / `{ goal }` |
| `log` | `node_id?`, `text` | inserts `goal_events` kind=`log`, actor=jarvis; emits `goal` | `{ event }` |
| `promote` | `node_id` | route 27 | `{ goal, node, thread }` — the tool ALSO posts `seed_text` to the new thread via the internal ingest so the promoted goal's chat boots (tool-side only; HTTP callers do the 2-step) |
| `focus` | `node_id: number \| null` | PUT focus with `set_by='jarvis'` — use sparingly (e.g. right after Kevin accepts a batch, focus the first child so the next layer proposal lands there) | `{ focus }` |

Arg schema (JSON-schema, for the tool `parameters`): `operation` enum of the ops above incl. `set_goal_done_means` (required); `goal_id`, `node_id`, `parent_id` (number \| null), `batch_id` (string), `all` (boolean), `items` (array of objects `{title, done_means, notes?, leaf_kind?}`), `title`, `done_means`, `notes`, `leaf_kind` (enum), `plan` (object), `passed` (boolean), `note`, `reason`, `text`, `goal` (boolean).

> **Added by the review node (#460), additive per this file's preamble:** the `edit_ghost` op above. §3.2 route 16 always allowed `actor='jarvis'` to PATCH a ghost, but §5's op table had no way to reach it, so the only way for JARVIS to reword a proposal mid-conversation was discard + re-propose — which destroys the ghost row and its batch bracket under Kevin's cursor. The op is a thin wrapper over the existing route; the ghost-only guard is unchanged and still server-side. Every op returns `{ error: string }` (not a throw) on precondition failure, echoing the server's `error.code` + message so JARVIS can explain it to Kevin.

---

## 6. Per-turn focus injection (`agent.ts`, `cockpit:goal-*` threads only)

Add `goalContextBlock = buildGoalThreadContext(conv.external_id)` (exported from `goals.ts`) to `perTurnContextPrefix` right after `workbenchContextBlock`. Returns `''` for any thread whose external_id doesn't match `^cockpit:goal-(\d+)$` or whose goal no longer exists. Injected **once per turn, server-side, never into the transcript / stored turn content** (same treatment as `threadContextLine`). Format, exactly:

```
<goal_focus goal_id="12" node_id="87" path="Ship Perclickity v2 › Media-buy stats › Create monitoring" state="set" leaf_kind="none" pending="none"/>
<goal_tree goal_id="12" status="set" progress="38" working="1" need_you="3">
# Ship Perclickity v2 — done: Kevin can see media-buy revenue per link in the dashboard, reconciled to QB
- [set] #41 Media-buy stats — done: /stats page shows revenue per linkId for any date range
  - [done ✓] #55 external_id=linkId mapping — done: every click row carries linkId
  - [set ▶] #87 Create monitoring — done: an Overwatch query rule fails when daily revenue < 7-day avg -5%
    - [ghost b:3f9c] #101 Capture the SQL from smarty-pants — done: rule body = the proven query
    - [ghost b:3f9c] #102 Register the rule via lanes-tool — done: rule id returned, status query
  - [working 🌳 tree-9a1b2c3d] #56 Stats dashboard branch — done: perclickity/media-buy-stats reviewed
  - [human] #60 Kevin places the index.php redirect — done: redirect live on prod
- [check] #42 QB reconciliation — done: monthly totals match QB within $1
- [set ✎pending] #43 Docs — done: outbox/perclickity-v2.md reviewed
</goal_tree>
```
Rules for the snapshot:
- Root line: `# <goal title> — done: <done_means>`; nodes as `- [<state marker>] #<id> <title> — done: <done_means>`, indented two spaces per depth. Markers: `ghost b:<batch4>` · `set` · `set ✎pending` (pending edit) · `set ✂pending` (pending removal) · `planned` · `working 🌳 <tree_id>` (+ ` ⚠blocked` when `tree_status_cache='blocked'`) · `check` · `done ✓` · `parked` · `human` prefix replaces `set` when `leaf_kind='human'` (`human`, `human check`…) · `machine` likewise when `leaf_kind='machine'` and `plan_state='none'`; `machine plan?` when `plan_state='proposed'`. `▶` after the marker on the focused node. Promoted stubs: `→ goal #<id>`.
- **Collapse rule (mirrors the UI):** always include the root, every ancestor of the focused node, the focused node's siblings (title only, no children), and the focused node's children. Everything else collapses to `- [<state>] #<id> <title> (+N)` where N = hidden descendant count. If nothing is focused, show root-level nodes + their direct children only. Hard cap 60 lines; beyond that, drop the deepest collapsed lines first and append `… (+M more)`.
- `discarded` nodes never appear. `parked` appear collapsed.
- The block is generated from the DB every turn (no caching), cost ~≤1.5k tokens by the cap.
- **No transcript is ever injected** — the goal chat's memory IS this snapshot + the normal session resume. The `SKILL.md` (written by the docs node) tells JARVIS how to read it; the contract only fixes the format.

---

## 7. Hopper integration mapping

| Goals side | Hopper side |
|---|---|
| `plan.nodes[]` | `createHopperTree(topic, 'cockpit:goal-<id>', nodes)` — flat DAG, `parent_index` never set, ordering only via `depends_on_indexes`. `adapter='claude'` on every node; `model` per §1.2 (Standard sonnet default, Heavy opus for a review node, Light haiku for mechanical). A plan with ≥3 nodes SHOULD end with an adversarial-review node on `claude-opus-5` depending on the build nodes (rubric convention; the server does not enforce it, the tool's plan-building guidance does). |
| approve_plan | `agreeHopperTree(tree.id)` immediately (Kevin's ✓ on the Plan card IS the "agree"; no second confirm loop). |
| `tree_id` | `hopper_trees.id`; overlay reads `GET /goals/:id/nodes/:nodeId/tree` (= `GET /hopper-trees/:treeId`) and live-updates from the existing `hopper_node` SSE filtered by `tree_id`. |
| node `working` | tree `active` |
| node `check` | tree `done` (engine → `goalsOnTreeStatus(treeId,'done')` from `maybeFinishTree`) |
| node stays `working` + `tree_status_cache='blocked'` | any tree node `blocked`/`blocked_question` (engine → `goalsOnTreeStatus(treeId,'blocked')` from `finishHopperNode`/lease-recovery; back to `'active'` when the blocked node is answered/retried and no blocked nodes remain). The UI shows a red `blocked` badge on the working pill; Kevin answers inside the overlay's existing answer box (the overlay is read-only for structure, but the `blocked_question` answer box is allowed because it's the existing spawn-tree surface). |
| tree `archived` while node `working` | treat as `'blocked'` for the badge (event `tree_blocked`, data.reason='archived'). |
| Engine hook wiring | `hopper-engine.ts` calls `goalsOnTreeStatus` through a lazy `import('./goals.js')` (or a registered callback `registerTreeStatusListener(fn)` exported from hopper-engine and called at goals.ts load) — builder picks; the callback form is preferred to avoid an import cycle. Must be a no-op when no goal node references the tree. |
| Worker prompt | unchanged — workers don't know about goals. The tree `topic` carries the goal path so cockpit sidebar/tree listings read naturally. |

---

## 8. Thread naming + seed text

- **Name:** `cockpit:goal-<goal.id>` (numeric id, never the title). Conversation label: `🎯 <goal title>` (≤120 chars), re-applied on goal rename (PATCH title → `renameConversation`).
- **2-step open (identical to `/workstreams/:id/discuss` + hopper promote):** `GET|POST /goals/:id/thread` returns `{ external_id, created, seed_text }`. When `created=true`, the **client** POSTs `{ text: seed_text }` to `POST /api/v1/threads/<external_id>/messages` — that runs a full JARVIS turn on the battle-tested ingest path. When `created=false`, `seed_text` is `null` and nothing is posted. The `goals` tool's `promote` op is the one exception (tool posts the seed itself, §5).
- **Goal `done_means` authorship:** set by Kevin (PATCH from the UI header card) OR by JARVIS via the tool op `set_goal_done_means` once Kevin has confirmed the sentence in chat (goals have no ghost mechanism; done_means IS the approval).
- **Seed text (`composeGoalSeed(goal)`), exactly this shape:**

```
🎯 GOAL CHAT — this thread belongs to goal #<id> "<title>" and nothing else. Read skills/goals/SKILL.md before your first reply (it is the operating contract for goal chats); the `goals` tool is how you touch the tree. Every turn of this thread is prefixed with a <goal_focus/> line + a <goal_tree> snapshot — that snapshot is your memory of this goal; never ask Kevin to restate it.

Goal: <title>
Done means: <done_means | "(not set yet)">
Notes: <notes | "(none)">
Status: <status> · nodes: <total> (<done> done · <working> working · <need_you> need you)
Focus: <path | "(none — the goal itself)">

Rules for this chat (short form; SKILL.md has the long form):
1. No done_means yet → clarify in ≤5 questions, propose one sentence, and when Kevin confirms it call `goals` op `set_goal_done_means`.
2. Everything you add/reword/remove is a ghost until Kevin ✓s: use `propose` / `propose_edit` / `propose_remove`. `set_from_kevin` only for nodes he dictated verbatim.
3. One layer ahead, never two: propose children only under the focused node (or the goal root when nothing is focused).
4. A node that can't split is a leaf: `set_leaf_kind` machine (you can spec it) or human (only Kevin can do it). Machine leaves get a `propose_plan`; Kevin approves on the card (or says go → `dispatch`).
5. Push back when a branch doesn't serve the goal. Verify against done_means before anything becomes done (`verify`).
6. Kevin never has to say which node he means — the focus line tells you. If he clearly means a different node, say which one you're taking it as.

Open with: if done_means is empty, your clarify questions; otherwise a two-line read of where this goal stands and what you'd propose next under the current focus.
```

(Substitute the `<…>` placeholders server-side; keep the `Rules` block verbatim so both lanes and the SKILL.md agree on the same numbered rules.)

---

## 9. Cockpit surface (what the UI lane builds against; the backend lane ignores this section)

- Routes: `/goals` (forest) and `/goals/$goalId` (split view) in `src/routes/`, own shell (`GoalsShell`), NOT wrapped in the cockpit's thread-sidebar layout. Top bar: `◀ Cockpit` → `/`.
- Client fns in `cockpit-api.ts` (additive): `listGoals`, `createGoal`, `getGoal`, `patchGoal`, `verifyGoal`, `parkGoal/unparkGoal`, `listGoalEvents`, `openGoalThread`, `createGoalNode`, `proposeGoalNodes`, `acceptGoalNode`, `acceptGoalBatch`, `acceptAllGoalNodes`, `discardGoalNode`, `discardGoalBatch`, `patchGoalNode`, `resolveGoalPending`, `setGoalLeafKind`, `rejectGoalPlan`, `approveGoalPlan`, `humanDoneGoalNode`, `verifyGoalNode`, `parkGoalNode/unparkGoalNode`, `promoteGoalNode`, `getGoalNodeTree`, `getGoalFocus`, `setGoalFocus` — one per route in §3, same names as the route verbs. Types `GoalRow/GoalSummary/GoalNodeRow/GoalTree/FocusRow/GoalEventRow/PlanJson` copied from §3.0 verbatim.
- SSE: `onGoal`, `onGoalNode`, `onGoalFocus` handlers; `goal`,`goal_node`,`goal_focus` added to `sse-worker.ts` `EVENT_TYPES`. On any event for the open goal: patch the row in place from the payload (no refetch needed; refetch is allowed as a fallback).
- Left pane = `ThreadPane`'s conversation rendering for `cockpit:goal-<id>` (open via `openGoalThread`; on `created=true` POST seed via the existing `sendThreadMessage`). Composer shows the `Talking about: <path> ✕` chip from the `goal_focus` state.
- Every click on a node row → `setGoalFocus(goalId, nodeId)` (debounced 150ms, optimistic). Esc → `setGoalFocus(goalId, null)`.
- Approve/✓/✕/Done/Verified/Plan-approve are single-click row affordances calling the routes above with default `actor='kevin'`. No modals in the main loop. `⋯` menu = park/unpark, promote, edit (inline), discard (ghost only).
- Working pill click → overlay rendering `getGoalNodeTree` + live `hopper_node` events; includes the existing blocked_question answer box behavior (POST `/hopper-nodes/:id/answer`, already exists) and nothing else editable.
- Divider position persisted in `localStorage` key `goals.split.<goalId>`.

---

## 10. Acceptance (both lanes; the sim node runs these against a scratch DB, the review node checks them)

1. `POST /goals {title}` → ghost goal + thread row + seed; `PATCH done_means` → set. `POST /goals {title, done_means}` → set directly.
2. `POST /nodes` with `authored_by=kevin` → `set`; without done_means → `409 done_means_required`. With `authored_by=jarvis` → `ghost` + batch.
3. `propose` with nested `items[].children` → `400 no_nesting`. Propose under a ghost parent → `409 parent_not_set`.
4. Batch of 3 ghosts: `accept` one → set (batch cleared on that row); `batches/:id/accept` → remaining two set; `accept_all` with no ghosts → `{ nodes: [] }` 200.
5. `propose_edit` on a set node → pending fields; `resolve_pending {accept:true}` → applied + cleared; `{accept:false}` → cleared, untouched. `propose_edit` on a ghost → `409 invalid_transition` (JARVIS edits its own ghosts via PATCH instead).
6. `propose_removal` on a node with children → `409 node_has_children`.
7. `leaf_kind machine` + `propose_plan` (2 nodes, sonnet + opus review) + `approve_plan` → hopper tree exists with status `active`, 2 pending nodes, node `working`, `tree_id` set. Simulated `finishHopperNode(done)` on both → tree `done` → node `check` (via `goalsOnTreeStatus`). `verify {passed:true}` → `done`; parent with all children done → `check` automatically.
8. `approve_plan` with a `claude-fable-5` node in the plan → `400 plan_invalid` at propose time already.
9. `PUT focus` → `goal_focus` SSE fired; repeat same node → no event, no `focus_set` row. Focus a discarded node → `409`.
10. `buildGoalThreadContext('cockpit:goal-<id>')` renders the §6 block, respects the collapse rule and the 60-line cap; returns `''` for a non-goal thread.
11. `promote` → new goal with the subtree moved (children re-rooted), stub node keeps state + `promoted_to_goal_id`; old goal's focus reset if it was inside the subtree; new goal `done` → stub → `check`.
12. `human_done` → `check`; `verify` → `done`. `park` on working → parked with tree untouched; `unpark` restores `working`.
13. The three SSE types appear in `/events` for an admin key; a non-admin key still receives them (global events are not thread-scoped).
14. `tsc` clean in darwin-assistant; cockpit `bun run build` (NOT the deploy script) clean.

---

## 11. v0.1 — Kevin edits a ghost → JARVIS weighs in → both agree → it solidifies (added 2026-09-19, additive)

**Why (Kevin, verbatim, 2026-09-19):** *"I should be able to click any of them, see the synopsis/details, and I should be able to just erase/edit what's there. And it should 'save' the change and understand that I made the change. That way when it's not my turn — when I OK it or whatever — it would see that I made a change and would 'think about' the change, acknowledge I made it, and give me its thought on it. If it agrees, then we're good and it solidifies. But if you push back on it and don't think it should confirm yet, then we talk that one out until we're both good."*

**The one rule this section adds:** a ghost solidifies (`ghost → set`) only when **the party who did NOT make the last edit** approves it.
- JARVIS proposed / last reworded it + Kevin ✓ → `set` (v0 behaviour, unchanged).
- Kevin last edited it + Kevin ✓ → **not set yet**: the node enters `review_state='awaiting_jarvis'`, a cue is posted into the goal chat, and JARVIS must either `accept` (agree → `set`) or `push_back` (stays ghost, note shown; they talk it out). JARVIS rewording it with `edit_ghost` hands the last word back to JARVIS, so Kevin's next ✓ sets it.
- Kevin-AUTHORED nodes (`set_from_kevin` / POST node authored_by=kevin) are still born `set` — the pinned weigh-in on authored nodes is NOT part of v0.1 (only edits to JARVIS proposals). The mechanism below is what v1.1 would reuse.

### 11.1 DDL (additive `ALTER TABLE goal_nodes ADD COLUMN …`, idempotent, guarded by PRAGMA table_info)

```
last_edited_by       TEXT CHECK (last_edited_by IN ('kevin','jarvis') OR last_edited_by IS NULL)  -- who last changed title/done_means/notes while ghost; NULL = untouched since proposal
kevin_edit_original  TEXT   -- JSON {title, done_means, notes} = the JARVIS wording at the moment of Kevin's FIRST edit of this ghost; never overwritten by later Kevin edits; cleared (NULL) when the node leaves ghost
review_state         TEXT NOT NULL DEFAULT 'none' CHECK (review_state IN ('none','awaiting_jarvis','pushed_back'))
review_note          TEXT   -- JARVIS's push-back note (one or two sentences); cleared when review_state returns to 'none'
```
All four are returned on every `GoalNodeRow` read (add to §3.0 type). `GoalCounts` gains `awaiting_jarvis: number` (ghosts with `review_state='awaiting_jarvis'`); `need_you` is unchanged.

### 11.2 Semantics (server-enforced in `goals.ts`)

| Action | actor | Precondition | Effect | event kind |
|---|---|---|---|---|
| PATCH node (route 16) title/done_means/notes | kevin | state=ghost | `last_edited_by='kevin'`; if `kevin_edit_original IS NULL` snapshot the pre-edit `{title,done_means,notes}` into it; `review_state='none'`, `review_note=NULL` (a fresh edit re-opens the round) | `ghost_edited_by_kevin` (data: `{old,new}`) |
| PATCH node / `edit_ghost` | jarvis | state=ghost | `last_edited_by='jarvis'`; `review_state='none'`, `review_note=NULL` (JARVIS took the last word; Kevin's next ✓ sets it). `kevin_edit_original` is kept for the audit trail | `node_updated` (unchanged kind) |
| accept (one / batch / all) | kevin | state=ghost, `last_edited_by='kevin'` | **does NOT set.** `review_state='awaiting_jarvis'`, `proposal_batch` kept. Then fire ONE cue per HTTP request (§11.3) listing every node that just went awaiting. Nodes in the same request whose `last_edited_by != 'kevin'` set normally | `kevin_okd_edit` |
| accept | kevin | state=ghost, `review_state='awaiting_jarvis'` (re-click) | `409 awaiting_jarvis` — message: "JARVIS is weighing in on your edit — see the chat" | — |
| accept | kevin | state=ghost, `review_state='pushed_back'`, `last_edited_by='kevin'` | re-asks: `review_state='awaiting_jarvis'`, `review_note` kept, cue fires again with the note quoted ("Kevin re-OK'd without changes after your push-back") | `kevin_okd_edit` |
| accept | jarvis | state=ghost, `review_state ∈ {awaiting_jarvis, pushed_back}` | `state='set'`, `review_state='none'`, `review_note=NULL`, `kevin_edit_original=NULL`, `last_edited_by=NULL`, `proposal_batch=NULL` | `node_agreed` (text: "JARVIS agreed with Kevin's edit: <title>") |
| accept | jarvis | state=ghost, `review_state='none'` | unchanged v0 rule (only when Kevin said yes in chat) | `node_accepted` |
| `push_back` (NEW tool op + route `POST /goals/:id/nodes/:nodeId/push_back {note}`) | jarvis | state=ghost, `review_state='awaiting_jarvis'` (also allowed from `none` when `last_edited_by='kevin'`) | `review_state='pushed_back'`, `review_note=note` (required, non-empty) | `jarvis_pushed_back` (text = note) |
| discard | either | state=ghost | unchanged; clears review fields | `node_discarded` |
| ghost → set by any path | — | — | clears `review_state/review_note/kevin_edit_original/last_edited_by` | — |

`goal_events.kind` closed list gains: `ghost_edited_by_kevin` · `kevin_okd_edit` · `node_agreed` · `jarvis_pushed_back`.

### 11.3 The cue (backend → goal chat)

Same seam as `dispatch-gate.ts fireCue`: `processMessage(text, 'cockpit:goal-<id>', 'goal-cue:<goalId>:<eventId>')`; if the conversation is in flight (`getInFlightMessageId`) or throws `ConversationBusyError` → `enqueueMessage`. Fired once per accept request, after the write transaction commits. Text, exactly this shape (one block per node):

```
[goal #1 — Kevin edited 2 of your proposals and OK'd them. Weigh in.]
#12 now: "New title" — done: "new done_means"
    was (yours): "Old title" — done: "old done_means"
#14 now: … / was (yours): …
For each node: acknowledge the change in a sentence, then either agree → `goals` op `accept` {node_id} (it solidifies), or `push_back` {node_id, note} with your reason in one or two sentences and talk it out. Don't restate the rest of the tree.
```
When it is a re-ask after push-back, add a line `you pushed back with: "<review_note>"` under that node.

### 11.4 Focus injection additions (§6)

- Node marker gains `✎K` when `last_edited_by='kevin'` (ghost only). Line suffix: ` — AWAITING YOUR TAKE (was: "<original title>")` for `awaiting_jarvis`; ` — you pushed back: "<review_note>"` for `pushed_back`.
- `<goal_tree …>` gains attribute `awaiting_you="N"`.

### 11.5 Cockpit (§9 additions — `GoalTreePanel.tsx`, `cockpit-api.ts`)

- **Click any row → focus AND expand it in place** (one expanded row at a time; a second click on the same row collapses it; expansion survives refetch/SSE). The expanded block sits directly under the row, inside the tree — no modal, no page change — and shows the FULL title, full done_means, notes, and a meta line (`proposed by JARVIS · edited by you 2m ago` / `authored by you`), plus `was: "<kevin_edit_original.title>" — done: "…"` when present.
- **Inline edit:** title / done_means / notes are auto-sized textareas when `state ∈ {ghost, set, planned}` and `pending_removal=0`. Save on blur or ⌘/Ctrl+Enter; Esc reverts. PATCH route 16 (actor defaults to kevin). Toast on error, optimistic update.
- **Row chips:** `✎ you` (small, amber) on a Kevin-edited ghost; `JARVIS weighing in…` (pulsing) when `awaiting_jarvis` — the row's ✓ is disabled with tooltip "JARVIS is weighing in — see the chat"; `JARVIS pushed back` (destructive tint) when `pushed_back` — the note is shown in the expanded block, ✓ re-enabled (re-ask).
- **Batch bar `✓ all`:** result toast splits the outcome: "3 set · 2 sent to JARVIS to weigh in".
- **Header card:** the goal's title/done_means no longer truncate silently — click expands + edits (PATCH /goals/:id), same textarea behaviour.
- Collapsed rows keep single-line truncation but always carry the full text in `title=` tooltips.

---

## 13. v0.2 — Kevin restructures the tree himself (add row / move / indent) → JARVIS weighs in on his next turn (added 2026-09-19, additive)

**Why (Kevin, verbatim, 2026-09-19, thread cockpit:fff28b3e-…):** *"I just had Jarvis clear out the 5 items it wrote in response to my initial request and create a new layer of top levels (like MBI, BI, etc) so that way we can keep the todo items grouped together as we go forward. Technically, if I had a way to add a row and indent things into that row, I wouldn't need to say anything to jarvis and waste a turn. I could just move them around and then you would check me after i do it during one of your replies, letting me know if you agree or not, etc."*

**THE PIN this builds (DESIGN.md):** Kevin's own nodes are born SET, but JARVIS gets to weigh in afterwards — *"maybe we both agree and it locks in."* v0.1 (§11) built that loop for **text edits to JARVIS ghosts**. This section builds it for **structure**: Kevin adds a row, edits a set row, or drags a row under a new parent — the tree changes **immediately** (no ghost, no turn), the node is flagged `awaiting_jarvis`, and ONE debounced cue lands in the goal chat so JARVIS reviews the whole burst on its next turn and either agrees (flag clears) or pushes back (flag becomes a conversation marker; the node is NEVER un-set).

**Two rules this section adds:**
1. **A Kevin structure change is real the moment he makes it.** Kevin-actor `POST /nodes` (route 9), `PATCH /nodes/:id` on a set node (route 16, text changed), and the new `move` route (31) write the tree directly AND mark the node `review_state='awaiting_jarvis'`, `last_edited_by='kevin'`. Pushing back on a set node never changes its state — `pushed_back` on a non-ghost is a flag for the conversation, nothing more.
2. **JARVIS still proposes structure.** JARVIS may `move` only its own ghosts directly. Moving a set node goes through a pending move (`pending_parent_id`) that Kevin ✓s via route 19 — exactly the `propose_edit` shape.

### 13.1 DDL (additive `ALTER TABLE goal_nodes ADD COLUMN …`, idempotent, guarded by PRAGMA table_info — same `ensureGoalNodeColumn` helper as §11.1)

```
kevin_moved_at     TEXT      -- ISO datetime of Kevin's most recent move of this node; NULL when the move round closed (accept) or never moved
kevin_move_from    INTEGER   -- parent id the node was moved FROM in that move; -1 = it was root-level; NULL with kevin_moved_at
pending_parent_id  INTEGER   -- JARVIS-proposed re-parent awaiting ✓/✕ (non-ghost nodes only); -1 = propose moving to root-level; NULL = no pending move
```
All three are returned on every `GoalNodeRow` read (add to §3.0 type). `kevin_edit_original` (§11.1) is REUSED for set nodes: on Kevin's first text edit of a **set** node in an open round it snapshots the pre-edit `{title, done_means, notes}` (so the cue can show was/now); it is cleared when the round closes (JARVIS `accept`). `GoalCounts.awaiting_jarvis` now counts **any** node with `review_state='awaiting_jarvis'` (ghost or not); `need_you` unchanged.

`goal_events.kind` closed list gains: `node_moved` · `move_proposed` · `move_accepted` · `move_rejected` · `kevin_restructured` (the digest cue was posted; data = the burst).

### 13.2 Route 31 — `POST /goals/:id/nodes/:nodeId/move`

| Body | Response | Event |
|---|---|---|
| `{ parent_id: number \| null, sort_order?: number, actor? ('kevin' default) }` | `{ node: GoalNodeRow }` | `node_moved` (data `{old_parent_id, new_parent_id, old_sort_order, new_sort_order, actor}`; `null` = root) |

Semantics (server-enforced in `goals.ts` `moveGoalNode`):
- Re-parents **within the same goal**. `parent_id` must be a node of this goal (`400 parent_goal_mismatch`) with `state ∈ {set, planned, working, check}` (`409 parent_not_set`), or `null` for root-level (requires `goals.status='set'`, `409 goal_not_set` — same check as route 9).
- The node must be non-terminal: `state ∉ {done, discarded}` (`409 invalid_transition`). A `working` leaf MAY move — its `tree_id`/plan ride along untouched. `ghost`/`parked`/`check`/`planned` may move.
- **No cycles:** `parent_id` must not be the node itself or any descendant of it (`409 move_cycle`).
- Moving a node with children moves the **whole subtree** (children keep `parent_id` → the node; only their derived `path`/`depth` change).
- `sort_order`: when omitted and the parent changes → `max(sibling sort_order)+1` under the new parent; when omitted and the parent is unchanged → kept. A call that changes neither parent nor sort_order is a **no-op** (200, node returned, no event, no review flag).
- New parent leaf reset: same as route 9 — moving anything under a parent with `leaf_kind != 'none'` resets that parent's `leaf_kind/plan_state/plan` (`409 leaf_already_dispatched` if that parent is `planned/working/check/done`).
- Old parent: after the move, §2.4(1) runs for the **old** parent (if its remaining non-parked children are all `done`, it flips `→ check`, event `node_check`). A parent left with zero children never vacuously completes. The NEW parent is never un-checked (consistent with route 9, which also allows a child under a `check` parent).
- `actor='jarvis'` on a **non-ghost** node → `403 jarvis_must_propose` (use route 32). `actor='jarvis'` on its own ghost → direct move, no review flag.
- **`actor='kevin'` (default) → the review flag** (§13.4): `review_state='awaiting_jarvis'`, `last_edited_by='kevin'`, `kevin_moved_at=now`, `kevin_move_from=<old parent id | -1>`, `review_note=NULL`; the digest cue is scheduled (§13.5). Any state — a ghost Kevin drags is also flagged (Kevin placing a JARVIS ghost is an implicit OK of its placement; JARVIS `accept` then sets it via the §11.2 `node_agreed` path).
- SSE: `goal_node` `updated` for the node **and every descendant** (their derived `path`/`depth` changed — same treatment as promote), then `goal` (counts). If the focus points at the node or a descendant, a `goal_focus` event is emitted with the refreshed `path` — the focus row itself is untouched (no `focus_set` event).

### 13.3 Route 32 — `POST /goals/:id/nodes/:nodeId/propose_move` (JARVIS → set node) + route 19 extension

| Body | Response | Event |
|---|---|---|
| `{ parent_id: number \| null, actor:'jarvis' }` | `{ node }` with `pending_parent_id` set (`-1` when `parent_id` is null), `pending_by='jarvis'` | `move_proposed` (data `{parent_id}`) |

- Only on `state ∈ {set, planned, check, parked}` (`409 invalid_transition`); never on `working` (`409 leaf_already_dispatched`). Preconditions of §13.2 (parent state, same goal, no cycle) are checked at proposal time AND again at resolve.
- A pending move **coexists** with a pending text edit (both are diffs Kevin ✓s together); a pending **removal** supersedes both (`propose_removal` clears `pending_parent_id`; `propose_move`/`propose_edit` clear `pending_removal`). Proposing a move to the node's current parent is a `409 nothing_to_move`.
- **Route 19 `resolve_pending`:** `hasPending` now also includes `pending_parent_id IS NOT NULL`. `accept:true` applies the text edit (if any) AND performs the move (same code path as route 31 with `actor='kevin'` but **without** the review flag — JARVIS proposed it, Kevin agreed, so the round is closed: the node's `review_state/review_note/last_edited_by/kevin_moved_at/kevin_move_from/kevin_edit_original` are cleared). Events: `edit_accepted` and/or `move_accepted` (+ `node_moved`, actor kevin). `accept:false` clears every pending_* incl. `pending_parent_id` (`edit_rejected`/`move_rejected`) and leaves review fields alone. Resolve re-validates the move; if it no longer applies (parent discarded, cycle) → `409` with the move's code and the pending fields are left for JARVIS to re-propose.

### 13.4 The review flag on non-ghost nodes (extends §11.2)

| Action | actor | Precondition | Effect | event kind |
|---|---|---|---|---|
| route 9 create (`authored_by='kevin'`, born set) | kevin | — | `review_state='awaiting_jarvis'`, `last_edited_by='kevin'`; digest scheduled (kind `added`) | `node_created` (unchanged) |
| route 16 PATCH title/done_means/notes | kevin | `state='set'`, text actually changed (a bare re-save or a `sort_order`-only reorder is NOT an edit — §11.2 rule, unchanged) | `review_state='awaiting_jarvis'`, `last_edited_by='kevin'`, `review_note=NULL`; `kevin_edit_original` snapshots the pre-edit text if NULL; digest scheduled (kind `edited`) | `node_updated` (unchanged) |
| route 31 move | kevin | §13.2 | as §13.2; digest scheduled (kind `moved`) | `node_moved` |
| `accept` {node_id} (route 11 / tool op) | jarvis | `state != 'ghost'`, `review_state ∈ {awaiting_jarvis, pushed_back}` | **state unchanged**; `review_state='none'`, `review_note=NULL`, `last_edited_by=NULL`, `kevin_edit_original=NULL`, `kevin_moved_at=NULL`, `kevin_move_from=NULL` | `node_agreed` (text: "JARVIS agreed with Kevin's change: <title>") |
| `accept` | jarvis | `state != 'ghost'`, `review_state='none'` | unchanged v0: `409 invalid_transition` (nothing to agree with) | — |
| `accept` | kevin | `state != 'ghost'` | unchanged v0: `409 invalid_transition` (Kevin has no ✓ on a set row) | — |
| `push_back` {note} | jarvis | `state != 'ghost'`, `review_state='awaiting_jarvis'` (or `'none'` with `last_edited_by='kevin'`) | `review_state='pushed_back'`, `review_note=note`. **The node stays set/planned/working/… — never un-set.** They talk it out; the round closes by JARVIS `accept`, by Kevin ✓-ing a JARVIS counter-proposal (route 19 accept), or by Kevin changing it again (a fresh edit/move re-opens `awaiting_jarvis`, note cleared) | `jarvis_pushed_back` |
| node → `done` (route 25 passed) / `discarded` (route 14 / 19 removal) | — | — | review fields + `kevin_moved_at/kevin_move_from` cleared (terminal). A promoted subtree keeps its flags — they travel to the new goal, whose chat weighs in | (existing kinds) |

Everything §11.2 says about **ghosts** is unchanged. Only ONE round is open per node at a time: a second Kevin change while `awaiting_jarvis` just refreshes the round (and the digest lists the node once, with its latest change).

### 13.5 The structure digest cue (extends §11.3)

Kevin drags several rows in a burst, so the cue is **debounced 20 s per goal** (env `GOALS_STRUCTURE_DEBOUNCE_MS`, default `20000`; the sim sets it low). Each Kevin structure change (§13.4 rows 1–3) adds `{node_id, kind: added|moved|edited, from, to}` to the goal's in-memory burst and (re)starts the timer. When it fires, the server re-reads every burst node, drops any that no longer awaits JARVIS (already agreed / discarded), writes ONE `kevin_restructured` event (data = the burst) and posts ONE cue through the §11.3 seam (`processMessage(text, 'cockpit:goal-<id>', 'goal-structure:<goalId>:<lastEventId>')`, `enqueueMessage` when busy). Text, exactly this shape:

```
[goal #7 — Kevin restructured the tree: moved "Docs" under "BI"; added "BI" under root; edited "MBI". Weigh in.]
#12 moved: "Docs" — from: Goal › MBI → now: Goal › BI
#15 added: "BI" under Goal (root) — done: "every BI module has a dashboard"
#9 edited: "MBI" now: "MBI (media-buy intake)" — done: "…"
    was: "MBI" — done: "…"
For each node: acknowledge the change in a sentence, then either agree → `goals` op `accept` {node_id} (the flag clears; it stays set), or `push_back` {node_id, note} with your reason in one or two sentences and talk it out. Don't restate the rest of the tree.
```
- A node that was `pushed_back` and then changed again by Kevin is listed like any other change; the fresh change already cleared `review_note` (§13.4), so no "you pushed back with" line is added — JARVIS's earlier note is in the chat history.
- The burst is process memory: if the service restarts inside the 20 s window no cue posts, but the nodes are still `awaiting_jarvis` and the §6 snapshot flags them (`↕K`/`✎K` + `AWAITING YOUR TAKE`), so JARVIS still weighs in on its next turn. Kevin-actor `move` of a ghost is included in the burst; JARVIS-actor changes never are. A goal with no conversation yet logs and skips (same as §11.3).

### 13.6 Tool (§5 additions)

| op | args | does | returns |
|---|---|---|---|
| `move` | `node_id`, `parent_id` (number \| null) | **ghost** node → route 31 with `actor='jarvis'` (direct, no flag). **Non-ghost** node → route 32 `propose_move` (a pending move Kevin ✓s; the tool never moves a set node directly) | `{ node, moved:true }` or `{ node, proposed:true }` |

The op table's `accept` row now also closes a set-node round (§13.4). `push_back` works on non-ghost nodes (§13.4). `list` trims now include `kevin_moved_at`, `kevin_move_from`, `pending_parent_id`. Tool description gains one sentence: *"When Kevin restructures the tree himself (adds a row, edits a set row, drags a row under a new parent) the change is already real and flagged awaiting you: on your next turn `accept` {node_id} to agree or `push_back` {node_id, note} — never try to undo it; to move a set node yourself use `move` (it becomes a pending move he ✓s), your own ghosts move directly."*

### 13.7 Focus injection (§6 additions)

- Node marker gains ` ↕K` when `kevin_moved_at IS NOT NULL AND review_state='awaiting_jarvis'`, and ` ✎K` on a **non-ghost** node when `last_edited_by='kevin' AND review_state='awaiting_jarvis'` and it was not moved (added / text-edited). A pending JARVIS move renders `set ↕pending` (alongside `✎pending`/`✂pending`; `pending` attr on `<goal_focus>` gains the value `move`; when both an edit and a move are pending the label is `edit+move`).
- Line suffix for `awaiting_jarvis`: ` — AWAITING YOUR TAKE (was: "<original title>")` when `kevin_edit_original` is present (unchanged), else ` — AWAITING YOUR TAKE (moved from: "<old parent title | root>")` when `kevin_moved_at` is set, else ` — AWAITING YOUR TAKE (Kevin added this)`.
- `<goal_tree awaiting_you="N">` already counts these (shared `review_state`).

### 13.8 Cockpit (§9 additions — what the UI lane builds against)

- **Add row:** a `+` affordance on the root and on every set-ish row (`set/planned/working/check`) opens an inline row (title + done_means) → route 9 with `authored_by='kevin'` (born set, flagged). Enter saves, Esc cancels.
- **Indent / outdent:** `Tab` = move under the previous sibling; `Shift+Tab` = move under the grandparent, after the current parent. Both = route 31 with the computed `parent_id` (+ `sort_order`). `Alt+↑/↓` = reorder among siblings (route 16 `sort_order` only — not flagged).
- **Drag re-parent:** drag a row onto another row (drop = child, appended) or between rows (drop = sibling at that position) → route 31. Disallowed targets (ghost/done/discarded/parked parents, own subtree) render no drop zone. The subtree moves with the row.
- **Chips:** the existing amber `JARVIS weighing in…` chip renders on set rows too (`review_state='awaiting_jarvis'`), with `↕` when `kevin_moved_at` is set; `JARVIS pushed back` (destructive tint) on set rows shows the note in the expanded block. A JARVIS pending move renders the row with a dashed `→ under "<parent title>"` diff line + the same ✓/✕ as a pending edit (route 19).
- **SSE:** on `goal_node` for a moved node, patch it AND its descendants from the events (the server emits every one); re-sort children by `(sort_order, id)`.

### 13.9 Acceptance (sim checks `V02-1…`, run by `npm run goals:sim`)

1. Kevin move re-parents a set node under another set node → 200, `parent_id` updated, `node_moved` event, `review_state='awaiting_jarvis'`, `last_edited_by='kevin'`, `kevin_moved_at` set, `kevin_move_from` = old parent (`-1` for root).
2. Moving a subtree carries the children (their `path` / `depth` change; `goal_node` SSE emitted for the node and each descendant).
3. Cycle (`parent_id` = own descendant) → `409 move_cycle`; done/discarded node → `409 invalid_transition`; ghost parent → `409 parent_not_set`; other goal's node → `400 parent_goal_mismatch`.
4. Debounced digest: three Kevin changes (move + add + set-node edit) inside the window → exactly ONE cue, correlation `goal-structure:<goalId>:<eventId>`, listing all three; a change JARVIS already agreed to before the timer fires is not listed.
5. JARVIS `accept` on a set node awaiting → state still `set`, review fields + `kevin_moved_*` cleared, `node_agreed`; JARVIS `push_back` on a set node → `review_state='pushed_back'`, still `set`.
6. JARVIS `move` on a set node (tool / route 31 actor jarvis) → `403 jarvis_must_propose`; route 32 sets `pending_parent_id`; route 19 accept performs the move (node ends under the proposed parent, no review flag, `move_accepted` + `node_moved`); route 19 reject clears `pending_parent_id`.
7. Sort-order-only PATCH on a set node and a no-op move → no review flag, no cue.
8. Old parent left with only `done` children after a move → `check` (§2.4(1)); old parent left empty → unchanged.
9. All 80 v0/v0.1 checks still pass.
