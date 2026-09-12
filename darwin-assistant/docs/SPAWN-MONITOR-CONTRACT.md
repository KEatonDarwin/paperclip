# Spawn-Tree Mission Control — Build Contract

**Status: AUTHORITATIVE.** Builders implement against this doc. If reality contradicts it,
the builder verifies and appends a dated note to the **Corrections** section at the bottom —
the contract is amended, never silently deviated from.

## Why this build exists

The cockpit's `/spawn-tree` page groups workers ONLY by `spawn_tasks.parent_thread_ext`.
Hopper-engine workers are spawned by the server (no parent thread), so all ~105 of them pile
into one giant "(no parent)" bucket spanning every project. Meanwhile the REAL grouping —
`hopper_trees` (30 trees) → `hopper_nodes` (140 nodes, each with `tree_id`,
`worker_thread_ext`, adapter/model, attempts) — is never consumed by any cockpit page.
Kevin's ask: Foundry-style top-level cards you click into, listing workers + statuses, with
bulletproof grouping even across multiple threads/attempts, so he can actually monitor it.

## Ground truth (verified 2026-09-12)

- DB: `/home/kevin/paperclip/darwin-assistant/jarvis.db` (live). Workers NEVER write the live
  DB or touch live checkouts; unit-test against scratch/in-memory sqlite.
- `hopper_trees(id, topic, origin_thread_ext, status: draft|active|done|archived, created_at, updated_at)`
- `hopper_nodes(id, tree_id, parent_id, title, spec, status: draft|pending|running|done|split|blocked|blocked_question, depends_on, priority, attempts, question, answer, result, worker_thread_ext, lease_expires_at, adapter, model, ...)`
- `spawn_tasks(id, thread_ext UNIQUE, parent_thread_ext, label, model, status: running|done|stuck|failed|released, turn_count, created_at, updated_at, ...)` — the attempt ledger. Hopper attempts use `thread_ext = 'cockpit:hopper-node-<nodeId>-<hex>'`; a retried node has MULTIPLE spawn rows, only the latest is in `hopper_nodes.worker_thread_ext`.
- Existing API (darwin-assistant `src/handlers/api-v1.ts`, bearer `JARVIS_COCKPIT_KEY`):
  `GET /api/v1/spawn-tasks` · `GET /hopper-trees` · `GET /hopper-trees/:id` (tree+nodes) ·
  `POST /hopper-trees/:id/agree` · `POST /hopper-nodes/:id/finish` · `POST /hopper-nodes/:id/answer`
  (exists at line ~1706, **never consumed by any UI**) · `GET /hopper-engine/governor` ·
  `GET /hopper-engine/history`.
- `src/hopper-engine.ts` exports incl. `retryHopperNode(id)` (**no HTTP route wraps it yet**),
  `answerHopperNode`, `listHopperTrees`, `listTreeNodes`.
- SSE: `hopper_node` events already flow through `/events` (see `src/sse-bus.ts` +
  cockpit `sse-worker.ts` EVENT_TYPES).
- Foundry module trees are named `foundry:<project>/<module>` (e.g. `foundry:suppression-manager/match-api`) — 8+ trees per Foundry project; they must cluster.

## Part 1 — Backend (darwin-assistant, branch `hopper/spawn-monitor`, worktree `/home/kevin/paperclip-worktrees/spawn-monitor`)

New module `src/spawn-monitor.ts` + routes in `api-v1.ts`. Keep aggregation as a **pure
function over injected rows** (`buildSpawnMonitorSnapshot({trees, nodes, spawnTasks})`) so it
unit-tests without the live DB; routes are thin wrappers.

### 1a. Attempt↔node matching (the bulletproof grouping)

1. Additive migration: `ALTER TABLE spawn_tasks ADD COLUMN hopper_tree_id TEXT` and
   `ADD COLUMN hopper_node_id INTEGER` (nullable; follow the existing lazy-migration pattern
   used elsewhere in the codebase — look at how other columns were added).
2. Stamp both columns at hopper spawn time (wherever the engine inserts the spawn_tasks row /
   creates the worker thread — find it in `hopper-engine.ts`/`spawn-tasks.ts`).
3. One-time backfill on startup: rows matching `thread_ext LIKE 'cockpit:hopper-node-%'` parse
   the node id, resolve tree via `hopper_nodes`.
4. Grouping logic prefers stamped ids, falls back to the `cockpit:hopper-node-<id>-%` pattern,
   then to `worker_thread_ext` equality. Anything unmatched = ad-hoc worker.

### 1b. `GET /api/v1/spawn-monitor` — the overview payload (one call paints the page)

```jsonc
{
  "governor": { /* verbatim result of the existing governor status fn + usage %s if cheaply available */ },
  "totals": { "active_trees": n, "running_workers": n, "needs_attention": n },
  "clusters": [            // ordered: attention first, then active, draft, done; archived EXCLUDED unless ?include_archived=1
    {
      "key": "foundry:suppression-manager",   // or the tree id for non-foundry
      "kind": "foundry" | "single",
      "title": "suppression-manager",          // human title; single = tree topic
      "trees": [ {
        "id": "tree-...", "topic": "...", "status": "active",
        "origin_thread_ext": null, "created_at": "...", "updated_at": "...",
        "counts": { "total": 7, "done": 5, "running": 1, "pending": 1, "blocked": 0, "blocked_question": 0, "draft": 0, "split": 0 },
        "models": ["claude/claude-sonnet-5", "codex/gpt-5.5"],   // distinct adapter/model over nodes
        "running_nodes": [ { "id": 136, "title": "...", "lease_expires_at": "..." } ],
        "attention": [ { "node_id": 139, "title": "...", "status": "blocked_question", "question": "..." } ]
      } ]
    }
  ],
  "adhoc": [ { "parent": "cockpit:<ext>" | null, "workers": [ SpawnTaskLite ] } ]  // non-hopper spawn_tasks grouped by parent, newest group first
}
```

### 1c. `GET /api/v1/spawn-monitor/trees/:id` — the drill-in payload

Tree + full nodes array; each node additionally carries
`"spawns": [ { "thread_ext", "label", "status", "model", "turn_count", "created_at", "updated_at" } ]`
(ALL attempts, oldest first), plus `question`, `answer`, `result`, `depends_on` (parsed to int
array), `lease_expires_at`.

### 1d. Two small action routes

- `POST /hopper-nodes/:id/retry` → wraps existing `retryHopperNode`; 404 unknown, 409 if the
  node isn't in a retryable state (mirror the function's own guards).
- `POST /hopper-trees/:id/archive` → sets status `archived` (allowed from `done` OR a dead
  `draft`; **409 for `active`** — active trees must finish or be handled, not hidden).
  Verify `dispatchTick` ignores archived trees (it should — confirm, correct if not).
  Also `POST /hopper-trees/:id/unarchive` → back to `done`/`draft` (whichever it came from is
  overkill; restore to `done`).

### 1e. Tests

Unit-test the pure aggregator: foundry clustering, multi-attempt nodes, unmatched→adhoc,
archived exclusion, attention ordering. In-memory better-sqlite3 or plain fixture arrays.
`tsc` clean. Do NOT restart jarvis.service; do NOT touch the live DB.

## Part 2 — UI (jarvis-command-center, branch `hopper/spawn-tree-mission-control`, worktree `/home/kevin/paperclip-worktrees/spawn-tree-ui`)

Rewrite `src/routes/spawn-tree.tsx` + add `src/routes/spawn-tree.$treeId.tsx`. Design
reference: `src/routes/foundry.tsx` (ProjectCard grid → drill-in) — match the cockpit's
existing shadcn/tailwind idiom. Client fns + types go in `src/lib/cockpit-api.ts` following
its existing patterns. Build against the payload shapes in THIS contract (don't wait on Part 1).

### Overview page `/spawn-tree`

1. **Header strip:** page title + live totals; governor pill (green "dispatching" / amber
   "holding: <reason>"); auto-refresh indicator. Poll 5s (existing pattern).
2. **Needs-attention band** (only when non-empty, always on top, amber/red): one row per
   attention node across ALL trees — tree topic, node title, the question text, and an
   **inline answer box** → `POST /hopper-nodes/:id/answer` (this is the zero-token answer
   path; it exists server-side and was never wired). Blocked (non-question) nodes show a
   **Retry** button → the new retry route.
3. **Card grid** (the Foundry feel): one card per cluster. Foundry clusters render the project
   title + per-module compact rows (module name, segmented progress, status). Single-tree
   cards show: topic, status pill, **segmented progress bar** (emerald done / amber-pulse
   running / slate pending / red blocked), `done/total` count, running node titles (small,
   pulsing dot), model chips, relative updated time. Click → drill-in route.
4. **Sections in order:** Attention · Active · Draft (awaiting agree) · Completed (collapsed
   by default, count in header, each card gets an **Archive** button) · Archived (hidden
   behind a toggle, loads with `?include_archived=1`, Unarchive button).
5. **Ad-hoc workers** section at the bottom: the old parent→children tree view (it was fine
   for these — they have real parents), collapsed when empty.

### Drill-in `/spawn-tree/$treeId`

Back link, tree header (topic, status, progress bar, origin thread link if present), then the
node list ordered by id: status dot + title + adapter·model chip + attempts badge (`2×` when
>1) + lease countdown when running (`mm:ss`, client-side tick) + `deps: #135 #136` chips.
Expandable per node: spec (collapsed), result (for done), question+answer box (blocked_question),
Retry button (blocked/failed states), and the **attempt list — every spawn row links to its
worker thread** `/thread/<encoded ext>` with status + turn count. Poll 4s while the tree is
active; stop polling when done/archived (foundry.tsx has this pattern).

### Constraints

- `bun run typecheck`/`tsc` clean; verify with `npx tsc --noEmit` if no script. Do NOT run a
  bare `bun run build` (wrong-preset landmine) and do NOT deploy/restart anything — JARVIS
  deploys after review via the deploy script.
- Keep `spawn_task`/`hopper_node` SSE handling out of scope for v1 — polling only (matches
  foundry.tsx). Noted as v1.1.

## Division of labor

| Node | Repo/branch | Model |
|---|---|---|
| Backend aggregate + actions | paperclip monorepo, `hopper/spawn-monitor` | sonnet |
| UI mission control | jarvis-command-center, `hopper/spawn-tree-mission-control` | opus |
| Adversarial review (both) | read-only across both worktrees | codex/gpt-5.5 |
| Docs + push + outbox report | both worktrees | sonnet |

## Corrections

(append dated corrections here — builders amend, never silently deviate)
