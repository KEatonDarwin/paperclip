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
`ghost_edited_by_kevin` · `kevin_okd_edit` · `node_agreed` · `jarvis_pushed_back` (all four v0.1 §11.2).

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

## 12. Guards (v0.2) — every `done_means` can become a monitored Overwatch rule (added 2026-09-19, additive)

**Why (Kevin, verbatim, 2026-09-19):** *"All of the leaves/branches in the goal system have a 'done' reasoning. Basically it's win condition. That is absolutely positively primed for reliable automation into a coded overwatch rule. Something that is checked with overwatch to make sure that it's still working (in the case that it makes sense that is)… I think that's one hell of a thing if it works like I hope it will."*

Concept + loop = `docs/goals/GUARDS.md`. Overwatch API, read from source = `docs/goals/GUARDS-RECON.md` (**read it — it corrects two things GUARDS.md got wrong**). Optional push channel = `docs/goals/GUARDS-OVERWATCH-WEBHOOK.md`. This section is the binding contract; it is purely additive on Goals v0/v0.1 shapes.

**Two recon facts that drive everything here (do not re-litigate — cited in GUARDS-RECON):**
1. **The Overwatch rule key is server-generated** (`prompt.<slug>-<rand4>`); a client cannot choose it. → We put the goal/node identity in the rule **`name`**, and **store the returned `key`** in `goal_guards.overwatch_key`. `overwatch_rule_id` stays NULL (the API has no numeric id).
2. **`GET /rules/{key}` already returns `last_result {status,value,summary,at}`.** → A **poller** is the health source; the webhook (§12.8) is OPTIONAL and off the critical path.

**Namespace additions (hard):** table `goal_guards` · routes `/api/v1/goals/:id/guards*` + `/api/v1/goals/guards/webhook` · tool ops `propose_guard`/`discard_guard`/`list_guards` (on the existing `goals` tool) · SSE `goal_guard` · events `guard_*`. All Overwatch traffic goes through one module-internal client `src/goals-overwatch.ts` (create/get/patch/delete) so the key/auth/degrade logic lives in exactly one place.

### 12.1 SQLite DDL (jarvis.db, in `src/goals.ts` — new table, idempotent `CREATE TABLE IF NOT EXISTS`)

```sql
CREATE TABLE IF NOT EXISTS goal_guards (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id           INTEGER NOT NULL REFERENCES goals(id),
  node_id           INTEGER REFERENCES goal_nodes(id),        -- NULL = guard on the goal root
  state             TEXT    NOT NULL DEFAULT 'ghost'
                    CHECK (state IN ('ghost','set','discarded')),
  mode              TEXT    NOT NULL DEFAULT 'query'
                    CHECK (mode IN ('query','agent')),
  title             TEXT    NOT NULL,                          -- plain-words label ("first paid-lead send inside 4h")
  -- query mode:
  sql               TEXT,
  comparator        TEXT    CHECK (comparator IN ('gte','lte','gt','lt','eq') OR comparator IS NULL),
  threshold         REAL,
  value_column      TEXT,
  sample_columns    TEXT,                                     -- JSON array of column names or NULL
  -- agent mode:
  check_prompt      TEXT,
  failure_prompt    TEXT,
  -- overwatch rule knobs:
  cadence           INTEGER NOT NULL DEFAULT 60,              -- cadence_minutes we ask Overwatch to run at
  severity          TEXT    NOT NULL DEFAULT 'medium'
                    CHECK (severity IN ('critical','high','medium','low')),
  ow_group          TEXT    NOT NULL DEFAULT 'custom',        -- must be a whitelisted Overwatch group (recon §2)
  window_minutes    INTEGER NOT NULL DEFAULT 60,
  -- linkage to the live rule (filled on accept):
  overwatch_key     TEXT,                                     -- the server-generated key; NULL while ghost / unwritten
  overwatch_rule_id TEXT,                                     -- reserved; stays NULL (API keys by string)
  -- health (from the poller / webhook):
  health            TEXT    NOT NULL DEFAULT 'unknown'
                    CHECK (health IN ('unknown','passing','failing','error')),
  last_checked_at   TEXT,
  last_value        REAL,
  last_summary      TEXT,
  authored_by       TEXT    NOT NULL DEFAULT 'jarvis'
                    CHECK (authored_by IN ('kevin','jarvis')),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_goal_guards_goal ON goal_guards(goal_id, node_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_guards_owkey ON goal_guards(overwatch_key) WHERE overwatch_key IS NOT NULL;
-- one ACTIVE guard per node (v0): enforce in code, not by index, because discarded rows must be allowed to pile up.
```

Column rules the code enforces:
- **One non-discarded guard per node** (v0). A `propose_guard` on a node that already has a `ghost`/`set` guard → `409 guard_exists`.
- A guard may be proposed only on a node whose `state ∈ {check, done}` (`409 node_not_verifiable`), or on the goal root when `goal.status='done'` (all nodes done). The win condition must be real before we monitor it (GUARDS.md).
- `mode='query'` requires `sql`, `comparator`, `threshold` non-null before `accept` (`409 guard_incomplete`, `extra.missing`). `mode='agent'` requires `check_prompt`.
- `ow_group` must be one of the whitelisted Overwatch groups (recon §2: `leads,email,queue,billing,revenue,system,custom,general`); default `custom`. Not validated by us at write time (Overwatch 422s a bad group on accept); the tool guidance defaults it to `custom`.
- `updated_at` bumps on every write; the parent `goals.updated_at` bumps too (guards affect the forest card's `guards_failing`).

### 12.2 State machine (server-enforced; other transitions → `409 invalid_transition {from,to}`)

**Lifecycle `state`:** `ghost` (proposed, not written to Overwatch) → `set` (Kevin ✓, rule written, `overwatch_key` stored) → `discarded` (removed; if it was `set`, the Overwatch rule is DELETEd first). `discarded` is terminal. Kevin may edit a ghost's sql/threshold/etc inline before ✓ (route 33 PATCH, actor kevin) exactly like a ghost node; a set guard's knobs may still be PATCHed (route 33) → the change is pushed to Overwatch via `PATCH /rules/{key}` in the same transaction.

**Health (independent axis, only meaningful when `state='set'`):** `unknown` (created, Overwatch hasn't run it yet, or Overwatch unreachable) → `passing` / `failing` / `error`, driven by the poller/webhook per the recon §5 mapping:

| Overwatch `last_result` | `goal_guards.health` |
|---|---|
| `null` (never run) / API unreachable / no key | `unknown` |
| `status='ok'` | `passing` |
| `status='fail'` or `status='warn'` | `failing` |
| `status='error'`, or `at` older than `max(3×cadence, 60m)` | `error` |

Ghost/discarded guards are always reported `health='unknown'` regardless.

### 12.3 The loop (verify → propose → accept → watch → cue)

1. **Verify → propose.** When a node reaches `done` (via §3 route 25 verify, or a human leaf's `human_done`+verify) AND the `done_means` is a measurable condition over Hub data worth checking on a cadence (JARVIS's judgment — GUARDS.md "guardable"), the goal chat calls `goals` op `propose_guard`. Not every done node gets one; one-offs and agreements don't.
2. **Kevin ✓ (Shape).** `POST /goals/:id/guards/:gid/accept` → server writes the rule to Overwatch via `src/goals-overwatch.ts` create, stores `overwatch_key`, `state='set'`, `health='unknown'`, event `guard_set`. ✕ = `discard`.
3. **Watch.** The poller (§12.7) reads each `set` guard's `GET /rules/{key}` every `goal_guard_poll_min`, maps `last_result.status` (§12.2), stores `last_value/last_summary/last_checked_at`, flips `health` **only on change**, emits `goal_guard` + the matching `guard_*` event.
4. **Fail → cue.** On `passing → failing` (state CHANGE only): event `guard_failed`, cue into the goal chat (§12.6), UI shows the node's red shield + the goal card's failing count. JARVIS then proposes the fix under that node (a child or a Plan) — the tree grows where it broke. `failing → passing` → `guard_recovered` + a one-line cue. `* → error` → `guard_error` + cue (distinct wording: the check itself broke, not necessarily the goal).

### 12.4 HTTP routes — under `/api/v1/goals`, bearer `JARVIS_COCKPIT_KEY` (the webhook, route 35, is the ONE exception — its own secret)

| # | Route | Body | 2xx response | Event |
|---|---|---|---|---|
| 31 | `GET /goals/:id/guards` | — | `{ guards: GoalGuardRow[], overwatch_connected: boolean }` (all non-discarded for the goal; `?include_discarded=1` to include; `overwatch_connected` = both env vars present, so the UI can show "Overwatch not connected" on load — review #479) | — |
| 32 | `POST /goals/:id/guards/propose` | `{ node_id (null=root), mode ('query'\|'agent'), title, sql?, comparator?, threshold?, value_column?, sample_columns?, check_prompt?, failure_prompt?, cadence?, severity?, ow_group?, window_minutes?, actor:'jarvis' }` | `201 { guard: GoalGuardRow }` — `state='ghost'`, nothing written to Overwatch yet. Preconditions §12.1 (`409 node_not_verifiable`/`guard_exists`). | `guard_proposed` |
| 33 | `PATCH /goals/:id/guards/:gid` | any of the query/agent/knob fields + `title`, `actor?` | `{ guard }` — direct edit. `actor='kevin'` on ghost OR set. `actor='jarvis'` only on ghost (its own proposal morphing; on a set guard → `403 jarvis_must_propose` — v0 has no guard propose_edit, JARVIS discards+re-proposes or asks Kevin to edit). **If the guard is `set`, the change is pushed to Overwatch (`PATCH /rules/{overwatch_key}`) inside the same write; a `422` from Overwatch → `422 overwatch_rejected {extra.reason}` and the local row is NOT changed.** | `guard_updated` |
| 34 | `POST /goals/:id/guards/:gid/accept` | `{ actor? }` | `{ guard }` — ghost→set. Server calls Overwatch create (recon §2), stores `overwatch_key`, `health='unknown'`. `409 guard_incomplete {extra.missing}` if required mode fields absent. **If Overwatch is not configured (`503`/no key) → `503 overwatch_not_connected`, guard stays ghost** (nothing lost; re-accept when the key lands). Overwatch `422` → `422 overwatch_rejected {extra.reason}`. | `guard_set` |
| — | `POST /goals/:id/guards/:gid/discard` | `{ reason?, actor? }` | `{ guard }` — →discarded. If it was `set`, DELETE the Overwatch rule first (`DELETE /rules/{key}`); a `404` from Overwatch (already gone) is tolerated; any other Overwatch error still discards locally but sets `last_summary='overwatch delete failed: …'` (don't strand the UI). | `guard_discarded` |
| — | `GET /goals/:id/guards/:gid` | — | `{ guard: GoalGuardRow }`; `404 guard_not_found` if not in this goal. | — |
| 35 | `POST /goals/guards/webhook` (GLOBAL, not under `:id`) | `{ key, status, value?, summary?, ran_at? }` | `{ ok: true }` — OPTIONAL push path (§12.8). **NOT bearer-authed:** header `X-Goals-Guard-Secret` compared constant-time to `GOALS_GUARD_WEBHOOK_SECRET`; unset → `503`, wrong → `401`. Looks up guard by `overwatch_key`; unknown key → `404 no_guard_for_key` (ignored, not alarmed). Applies the SAME `applyGuardHealth()` as the poller. | `guard_failed`/`guard_recovered`/`guard_error` on change only |

`GoalGuardRow` (returned on every guard read; add to §3.0 types):
```ts
type GoalGuardRow = {
  id: number; goal_id: number; node_id: number | null;
  state: 'ghost'|'set'|'discarded';
  mode: 'query'|'agent'; title: string;
  sql: string | null; comparator: 'gte'|'lte'|'gt'|'lt'|'eq'|null; threshold: number | null;
  value_column: string | null; sample_columns: string[] | null;
  check_prompt: string | null; failure_prompt: string | null;
  cadence: number; severity: 'critical'|'high'|'medium'|'low'; ow_group: string; window_minutes: number;
  overwatch_key: string | null; overwatch_rule_id: string | null;
  health: 'unknown'|'passing'|'failing'|'error';
  last_checked_at: string | null; last_value: number | null; last_summary: string | null;
  authored_by: 'kevin'|'jarvis'; created_at: string; updated_at: string;
  // derived on reads:
  node_title: string | null;     // for cue/UI labels; null when guard is on the goal root
  dashboard_url: string | null;  // Overwatch dashboard link once set
};
```

### 12.5 `goals` tool ops (added to §5's op table; scope-resolution + actor rules identical to §5)

| op | args | does (route) | returns |
|---|---|---|---|
| `list_guards` | `goal_id?` (implied in a goal thread) | GET /goals/:id/guards | `{ guards }` |
| `propose_guard` | `node_id?` (omitted = the current focus inside a goal thread, like `propose`'s `parent_id`; explicit `null` = root), `mode` (`'query'` default), `title`, `sql?`,`comparator?`,`threshold?`,`value_column?`,`sample_columns?`, `check_prompt?`,`failure_prompt?`, `cadence?`,`severity?`,`ow_group?` — the tool fills `ow_group:'custom'` when omitted, and prefers `mode='query'` (captured proven SQL) over `agent` | route 32 | `{ guard }` (ghost) |
| `discard_guard` | `guard_id` | route …/discard | `{ guard }` |

Guidance in the tool description (verbatim intent): *"When a node verifies done and its done_means is a measurable condition over Hub data worth watching (a rate, a count, a reconciliation — NOT a one-off deliverable or an agreement), propose a Guard: capture the SQL that PROVED the done_means during verify (don't re-derive it — recon §0.1), pick the comparator so `value COMPARATOR threshold` = the win condition holding, and write a plain-words `title`. Kevin ✓s it on the card; only then is it written to Overwatch. Never accept your own guard proposal. If Overwatch isn't connected, the proposal still stands as a ghost and writes the moment Kevin's key lands."*

(There is no guard `accept`/`verify` tool op — accept is Kevin's click, route 34; a guard is not a node in the node state machine.)

### 12.6 The cue (backend → goal chat) — same seam as §11.3 (`processMessage` / `enqueueMessage`, id `goal-guard:<goalId>:<guardId>:<eventId>`)

Fired once per `health` transition (never per poll). Exact shapes:

```
[goal #12 — guard on #87 "Create monitoring" is FAILING: revenue -7.4% vs 7-day avg]
Propose the fix under that node (a child or a Plan) — the win condition it protects has broken. Don't restate the rest of the tree.
```
```
[goal #12 — guard on #87 "Create monitoring" RECOVERED: revenue +1.2% vs 7-day avg]
```
```
[goal #12 — guard on #87 "Create monitoring" ERRORED: the check itself failed (bad SQL or Hub unreachable) — <summary>. This is the guard, not necessarily the goal; fix the rule or tell me to discard it.]
```
Root-goal guards read `guard on this goal "<goal title>"` instead of `on #<node> "<title>"`.

### 12.7 The poller (`src/goals.ts` interval, started at module load like the watchdog cadence)

- Interval = settings-KV **`goal_guard_poll_min`** (default **10**, floored at 1). Read via the uncached `getSetting` so a live change takes effect next tick.
- Each tick: for every `state='set'` guard with a non-null `overwatch_key`, `GET /rules/{key}` via `src/goals-overwatch.ts`. Map `last_result` → health (§12.2). Store `last_value/last_summary/last_checked_at` always; flip `health` and emit `goal_guard` + `guard_*` + cue **only on change** (compare to the row's current `health`). One in-flight guard per tick is fine; batch sequentially, don't hammer.
- **Degrade:** if Overwatch is unconfigured (no `OVERWATCH_API_URL`/`OVERWATCH_API_KEY`) the poller is a no-op (guards sit `unknown`). If a single `GET` throws/times out, that guard → `health` unchanged this tick (transient), but if `last_checked_at` goes older than `max(3×cadence,60m)` it flips to `error` with `last_summary='guard stale — Overwatch not reporting'`.
- **One code path** `applyGuardHealth(guardId, {status,value,summary,at})` is shared by the poller and the webhook (route 35) so push and poll can never diverge; it is idempotent (unchanged health = no event, no cue).

### 12.8 Optional webhook (push) — see `docs/goals/GUARDS-OVERWATCH-WEBHOOK.md`
Route 35 above is the Goals-side receiver (safe to build now, dormant until `GOALS_GUARD_WEBHOOK_SECRET` is set and Kevin adds the `webhook` notify channel on the darwin-dashboard box). The poller stays on as the safety net even when the webhook is live. Not required for v0.2 correctness.

### 12.9 SSE (add `'goal_guard'` to the `FORWARD` set in `api-v1.ts`, the union in `sse-bus.ts`, and `sse-worker.ts` `EVENT_TYPES`; global, like `goal`/`goal_node`)

```ts
export interface GoalGuardEvent {          // 'goal_guard'
  type: 'goal_guard';
  action: 'proposed' | 'set' | 'updated' | 'discarded' | 'health';  // 'health' = passing/failing/error change
  goal_id: number;
  guard: GoalGuardRow;                      // includes derived node_title/dashboard_url + current health
}
```
A `goal` event is ALSO emitted after any guard write that changes `GoalCounts` (i.e. when `guards`/`guards_failing` move — §12.11), so the forest card stays live.

### 12.10 `goal_events.kind` additions (closed list §1.3 gains):
`guard_proposed` · `guard_set` · `guard_discarded` · `guard_updated` · `guard_failed` · `guard_recovered` · `guard_error`.
Each guard write/health-change writes exactly one such event (actor: `jarvis` for propose/discard via tool, `kevin` for accept/HTTP edits, `system` for poller/webhook health flips).

### 12.11 Focus injection (§6 additions) + counts (§3.0 additions)

- **`GoalCounts` gains:** `guards: number` (count of `state='set'` guards in the goal) and `guards_failing: number` (`state='set'` AND `health IN ('failing','error')`). `need_you` is UNCHANGED (a failing guard cues the chat; it is not a fresh approval the way a ghost/plan is — the fix it prompts becomes a new ghost, which already counts).
- **`<goal_tree …>` attribute:** add `guards_failing="N"` when > 0 (omit when 0).
- **Node line suffix** in the §6 snapshot, for a node carrying a `set` guard: ` 🛡` (passing/unknown) or ` 🛡✗ "<last_summary>"` (failing/error). Placed after any existing markers, before the focus `▶`. Root guard: append ` 🛡✗ "<summary>"` to the `#` root line.
- **Seed text (§8):** no change required; SKILL.md (docs node) teaches JARVIS the guard loop and when a done node is "guardable".

### 12.12 Env contract (darwin-assistant `.env`; all optional — Guards degrade cleanly without them)

| var | meaning | absent behavior |
|---|---|---|
| `OVERWATCH_API_URL` | e.g. `https://health.thedarwinhub.com` (the `src/goals-overwatch.ts` client prefixes `/api/v1/overwatch/rules`) | Guards UI shows "Overwatch not connected"; `accept` → `503 overwatch_not_connected` (proposal stays ghost); poller no-op |
| `OVERWATCH_API_KEY` | bearer for the Overwatch rule API (recon §1) | same as above |
| `GOALS_GUARD_WEBHOOK_SECRET` | shared secret for route 35 (OPTIONAL push) | route 35 → `503`; polling still covers health fully |

Kevin supplies `OVERWATCH_API_URL` + `OVERWATCH_API_KEY` once (GUARDS.md "what Kevin has to supply"). Until then everything works except the actual write/read to Overwatch — proposals accumulate as ghosts and are written the moment the key lands. **No API key is ever used for a model call** (this is a monitoring API key, the allowed read/write-a-rule exception — it never authenticates a model).

### 12.13 Acceptance (guards; sim node runs these against a scratch DB with a stubbed Overwatch client)

1. `propose_guard` on a `done` node (query mode, sql+comparator+threshold) → `ghost`; on a `set` (unverified) node → `409 node_not_verifiable`; a second propose on a node that already has a guard → `409 guard_exists`.
2. `accept` with Overwatch stub returning a key → `state='set'`, `overwatch_key` stored, `health='unknown'`, event `guard_set`. Accept with the stub unconfigured → `503 overwatch_not_connected`, guard stays ghost.
3. Poller tick with stub `last_result.status='ok'` → `health='passing'` (event on the flip from unknown); flip stub to `'fail'` → `health='failing'`, `guard_failed` event + cue fired once; a second identical tick → NO event, NO cue. `'fail'→'ok'` → `guard_recovered`. `status='error'` → `guard_error`.
4. `PATCH` a set guard's threshold → Overwatch stub `PATCH /rules/{key}` called; stub `422` → `422 overwatch_rejected`, local row unchanged.
5. `discard` a set guard → Overwatch stub `DELETE /rules/{key}` called, `state='discarded'`; stub `404` tolerated.
6. Route 35 webhook with a valid secret + known key → same `applyGuardHealth` path as the poller (health flips, cue fires once); wrong secret → `401`; unset secret → `503`; unknown key → `404 no_guard_for_key`.
7. `GoalCounts.guards`/`guards_failing` reflect set/failing guards; `<goal_tree>` shows `guards_failing="N"` and the node ` 🛡✗ "…"` suffix; `need_you` unchanged by guard state.
8. `goal_guard` SSE reaches an admin key; `tsc` clean.

