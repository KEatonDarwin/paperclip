// GOALS — the goal-driven development surface (tree-2d558f04, node #454/#455).
// See skills/goals/CONTRACT.md (binding) and skills/goals/DESIGN.md (concept).
//
// Namespace rule (hard, per CONTRACT.md): tables `goal*`, routes `/api/v1/goals/*`,
// SSE `goal`/`goal_node`/`goal_focus`, threads `cockpit:goal-<id>`. Nothing here
// imports from workbench/smart-todos/workstreams/thread-todos.
//
// THIS FILE (BACKEND A, node #455) covers CONTRACT §1 (DDL), §2 (state machines
// EXCEPT the plan/dispatch/tree-hook transitions), §3.1/§3.2/§3.3/§3.5 (goals,
// nodes, pending edits, focus routes) and the store side of §4 (SSE emit). The
// leaf_kind/propose_plan/reject_plan/approve_plan/promote routes (§3.4 minus
// human_done/verify/park/unpark) and the §5-§8 material (the `goals` tool, the
// per-turn focus-injection block, the hopper-tree mapping, and the explicit
// GET/POST /goals/:id/thread endpoint) are BACKEND B's job (node #456) — this
// file exposes `composeGoalSeed`/`pathForNode` etc. as building blocks for it.

import { randomUUID } from 'node:crypto';
import { sqliteDb, getOrCreateConversation, getConversation, renameConversation } from './conversation-db.js';
import { sseBus, type GoalEvent, type GoalNodeEvent, type GoalFocusEvent } from './sse-bus.js';
import {
  registerTreeStatusListener,
  createHopperTree,
  agreeHopperTree,
  getHopperTree,
  listTreeNodes,
  type HopperTreeRow,
  type HopperNodeRow,
} from './hopper-engine.js';

// ---------------------------------------------------------------------------
// Types (mirrors CONTRACT.md §1 / §3.0 exactly — additive-only if extended)
// ---------------------------------------------------------------------------

export type GoalStatus = 'ghost' | 'set' | 'done' | 'parked';
export type GoalNodeState = 'ghost' | 'set' | 'planned' | 'working' | 'check' | 'done' | 'parked' | 'discarded';
export type LeafKind = 'none' | 'machine' | 'human';
export type PlanState = 'none' | 'proposed' | 'approved';
export type GoalActor = 'kevin' | 'jarvis' | 'system';
export type NodeAuthor = 'kevin' | 'jarvis';
/** v0.1 §11.1 — who last edited a ghost + where it sits in the weigh-in round. */
export type ReviewState = 'none' | 'awaiting_jarvis' | 'pushed_back';

/** §1.2 — plan JSON stored on a machine leaf. Shape only; propose/approve live in BACKEND B. */
export interface PlanJsonNode {
  title: string;
  spec?: string;
  adapter?: string | null;
  model?: string | null;
  depends_on_indexes?: number[];
  priority?: number;
}
export interface PlanJson {
  what: string;
  deliverable: string;
  model: string;
  adapter: string;
  estimate?: string;
  nodes: PlanJsonNode[];
  proposed_at?: string | null;
  approved_at?: string | null;
}

export interface GoalRow {
  id: number;
  title: string;
  done_means: string | null;
  notes: string | null;
  status: GoalStatus;
  authored_by: NodeAuthor;
  thread_ext: string | null;
  promoted_from_node_id: number | null;
  sort_order: number;
  verified_at: string | null;
  archived: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface GoalCounts {
  total: number;
  done: number;
  working: number;
  check: number;
  need_you: number;
  ghosts: number;
  human_open: number;
  awaiting_jarvis: number;   // v0.1 §11.1 — ghosts Kevin OK'd, waiting on JARVIS to weigh in
  progress: number;
}

export interface GoalSummary extends GoalRow {
  counts: GoalCounts;
  focus_node_id: number | null;
  last_event_at: string | null;
}

/** Raw DB row for goal_nodes — snake_case, 1:1 with the table. */
export interface GoalNodeDbRow {
  id: number;
  goal_id: number;
  parent_id: number | null;
  title: string;
  done_means: string | null;
  notes: string | null;
  authored_by: NodeAuthor;
  state: GoalNodeState;
  leaf_kind: LeafKind;
  plan_state: PlanState;
  plan: string | null;
  tree_id: string | null;
  tree_status_cache: 'active' | 'done' | 'blocked' | null;
  pending_title: string | null;
  pending_done_means: string | null;
  pending_removal: 0 | 1;
  pending_by: 'jarvis' | null;
  proposal_batch: string | null;
  promoted_to_goal_id: number | null;
  // v0.1 §11.1 — Kevin-edit tracking + JARVIS weigh-in gate.
  last_edited_by: NodeAuthor | null;
  kevin_edit_original: string | null;   // JSON {title,done_means,notes} snapshot of the JARVIS wording at Kevin's FIRST edit
  review_state: ReviewState;
  review_note: string | null;           // JARVIS's push-back note
  sort_order: number;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Public node shape — raw row + derived depth/child_count/path (CONTRACT §3.0). */
export interface GoalNodeRow extends GoalNodeDbRow {
  depth: number;
  child_count: number;
  path: string[];
}

export interface GoalTree {
  goal: GoalSummary;
  nodes: GoalNodeRow[];
  focus: FocusRow;
}

export interface FocusRow {
  goal_id: number;
  node_id: number | null;
  set_by: GoalActor;
  updated_at: string;
  path: string[];
}

export interface GoalEventRow {
  id: number;
  goal_id: number;
  node_id: number | null;
  actor: GoalActor;
  kind: string;
  text: string | null;
  data: unknown | null;
  created_at: string;
}

export class GoalError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// DDL (idempotent, CONTRACT.md §1 verbatim)
// ---------------------------------------------------------------------------

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT    NOT NULL,
    done_means    TEXT,
    notes         TEXT,
    status        TEXT    NOT NULL DEFAULT 'ghost'
                  CHECK (status IN ('ghost','set','done','parked')),
    authored_by   TEXT    NOT NULL DEFAULT 'kevin'
                  CHECK (authored_by IN ('kevin','jarvis')),
    thread_ext    TEXT    UNIQUE,
    promoted_from_node_id INTEGER REFERENCES goal_nodes(id),
    sort_order    INTEGER NOT NULL DEFAULT 0,
    verified_at   TEXT,
    archived      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS goal_nodes (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id            INTEGER NOT NULL REFERENCES goals(id),
    parent_id          INTEGER REFERENCES goal_nodes(id),
    title              TEXT    NOT NULL,
    done_means         TEXT,
    notes              TEXT,
    authored_by        TEXT    NOT NULL DEFAULT 'jarvis'
                       CHECK (authored_by IN ('kevin','jarvis')),
    state              TEXT    NOT NULL DEFAULT 'ghost'
                       CHECK (state IN ('ghost','set','planned','working','check','done','parked','discarded')),
    leaf_kind          TEXT    NOT NULL DEFAULT 'none'
                       CHECK (leaf_kind IN ('none','machine','human')),
    plan_state         TEXT    NOT NULL DEFAULT 'none'
                       CHECK (plan_state IN ('none','proposed','approved')),
    plan               TEXT,
    tree_id            TEXT,
    tree_status_cache  TEXT,
    pending_title      TEXT,
    pending_done_means TEXT,
    pending_removal    INTEGER NOT NULL DEFAULT 0,
    pending_by         TEXT    CHECK (pending_by IN ('jarvis') OR pending_by IS NULL),
    proposal_batch     TEXT,
    promoted_to_goal_id INTEGER REFERENCES goals(id),
    sort_order         INTEGER NOT NULL DEFAULT 0,
    verified_at        TEXT,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_goal_nodes_goal   ON goal_nodes(goal_id, parent_id, sort_order, id);
  CREATE INDEX IF NOT EXISTS idx_goal_nodes_batch  ON goal_nodes(proposal_batch);
  CREATE INDEX IF NOT EXISTS idx_goal_nodes_tree   ON goal_nodes(tree_id);

  CREATE TABLE IF NOT EXISTS goal_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id     INTEGER NOT NULL REFERENCES goals(id),
    node_id     INTEGER REFERENCES goal_nodes(id),
    actor       TEXT    NOT NULL CHECK (actor IN ('kevin','jarvis','system')),
    kind        TEXT    NOT NULL,
    text        TEXT,
    data        TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_goal_events_goal ON goal_events(goal_id, id);

  CREATE TABLE IF NOT EXISTS goal_focus (
    goal_id     INTEGER PRIMARY KEY REFERENCES goals(id),
    node_id     INTEGER REFERENCES goal_nodes(id),
    set_by      TEXT    NOT NULL DEFAULT 'kevin' CHECK (set_by IN ('kevin','jarvis','system')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// v0.1 (CONTRACT §11.1) — additive columns for the Kevin-edit / JARVIS-weigh-in
// gate. Guarded by PRAGMA table_info so the live jarvis.db migrates in place on
// restart (no migrations framework; ADD COLUMN only). Each DDL fragment is a
// valid SQLite ADD COLUMN (NOT NULL carries a constant default; CHECKs reference
// only the new column).
function ensureGoalNodeColumn(column: string, ddl: string): void {
  const cols = sqliteDb.prepare(`PRAGMA table_info(goal_nodes)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    sqliteDb.exec(`ALTER TABLE goal_nodes ADD COLUMN ${ddl}`);
  }
}
ensureGoalNodeColumn('last_edited_by', `last_edited_by TEXT CHECK (last_edited_by IN ('kevin','jarvis') OR last_edited_by IS NULL)`);
ensureGoalNodeColumn('kevin_edit_original', `kevin_edit_original TEXT`);
ensureGoalNodeColumn('review_state', `review_state TEXT NOT NULL DEFAULT 'none' CHECK (review_state IN ('none','awaiting_jarvis','pushed_back'))`);
ensureGoalNodeColumn('review_note', `review_note TEXT`);

// ---------------------------------------------------------------------------
// Low-level accessors
// ---------------------------------------------------------------------------

const getGoalRowStmt = sqliteDb.prepare(`SELECT * FROM goals WHERE id = ?`);
const getRawNodeStmt = sqliteDb.prepare(`SELECT * FROM goal_nodes WHERE id = ?`);

function requireGoal(id: number): GoalRow {
  const row = getGoalRowStmt.get(id) as GoalRow | undefined;
  if (!row) throw new GoalError(404, 'goal_not_found', 'goal not found');
  return row;
}

function requireNode(goalId: number, nodeId: number): GoalNodeDbRow {
  const row = getRawNodeStmt.get(nodeId) as GoalNodeDbRow | undefined;
  if (!row || row.goal_id !== goalId) throw new GoalError(404, 'node_not_found', 'node not found in this goal');
  return row;
}

function listRawNodesForGoal(goalId: number, includeDiscarded: boolean): GoalNodeDbRow[] {
  const rows = sqliteDb.prepare(`SELECT * FROM goal_nodes WHERE goal_id = ?`).all(goalId) as GoalNodeDbRow[];
  return includeDiscarded ? rows : rows.filter((r) => r.state !== 'discarded');
}

export function assertActor(value: unknown, fallback: GoalActor): GoalActor {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'kevin' || value === 'jarvis' || value === 'system') return value;
  throw new GoalError(400, 'invalid_request', "actor must be one of 'kevin', 'jarvis', 'system'");
}

function normLeafKind(value: unknown): LeafKind {
  return value === 'machine' || value === 'human' ? value : 'none';
}

// ---------------------------------------------------------------------------
// Derived fields — depth / child_count / path
// ---------------------------------------------------------------------------

function buildDerivedNodes(goalTitle: string, rawNodes: GoalNodeDbRow[]): GoalNodeRow[] {
  const byId = new Map<number, GoalNodeDbRow>(rawNodes.map((n) => [n.id, n]));
  const childrenOf = new Map<number | null, GoalNodeDbRow[]>();
  for (const n of rawNodes) {
    const key = n.parent_id;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(n);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

  const childCountOf = new Map<number, number>();
  for (const n of rawNodes) {
    if (n.parent_id != null && n.state !== 'discarded') {
      childCountOf.set(n.parent_id, (childCountOf.get(n.parent_id) ?? 0) + 1);
    }
  }

  function pathOf(n: GoalNodeDbRow): string[] {
    const chain: string[] = [];
    let cur: GoalNodeDbRow | undefined = n;
    while (cur) {
      chain.unshift(cur.title);
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
    }
    return [goalTitle, ...chain];
  }

  function depthOf(n: GoalNodeDbRow): number {
    let d = 0;
    let cur: GoalNodeDbRow | undefined = n;
    while (cur && cur.parent_id != null) {
      const p = byId.get(cur.parent_id);
      if (!p) break;
      d += 1;
      cur = p;
    }
    return d;
  }

  const out: GoalNodeRow[] = [];
  function walk(parentId: number | null): void {
    for (const n of childrenOf.get(parentId) ?? []) {
      out.push({ ...n, depth: depthOf(n), child_count: childCountOf.get(n.id) ?? 0, path: pathOf(n) });
      walk(n.id);
    }
  }
  walk(null);
  return out;
}

function deriveSingleNode(node: GoalNodeDbRow): GoalNodeRow {
  const goal = requireGoal(node.goal_id);
  const all = listRawNodesForGoal(node.goal_id, true);
  const derived = buildDerivedNodes(goal.title, all);
  const found = derived.find((d) => d.id === node.id);
  if (!found) throw new Error(`internal: node ${node.id} missing from its own derived tree`);
  return found;
}

/** Titles root(goal)→node, e.g. ["Goal title","Parent","This"]. Null if node doesn't exist. */
export function pathForNode(nodeId: number): string[] | null {
  const node = getRawNodeStmt.get(nodeId) as GoalNodeDbRow | undefined;
  if (!node) return null;
  const goal = getGoalRowStmt.get(node.goal_id) as GoalRow | undefined;
  if (!goal) return null;
  const chain: string[] = [];
  let cur: GoalNodeDbRow | undefined = node;
  while (cur) {
    chain.unshift(cur.title);
    cur = cur.parent_id != null ? (getRawNodeStmt.get(cur.parent_id) as GoalNodeDbRow | undefined) : undefined;
  }
  return [goal.title, ...chain];
}

// ---------------------------------------------------------------------------
// Counts / summaries
// ---------------------------------------------------------------------------

const countsStmt = sqliteDb.prepare(`
  SELECT
    SUM(CASE WHEN state != 'discarded' THEN 1 ELSE 0 END) AS total,
    SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS done,
    SUM(CASE WHEN state = 'working' THEN 1 ELSE 0 END) AS working,
    SUM(CASE WHEN state = 'check' THEN 1 ELSE 0 END) AS check_count,
    SUM(CASE WHEN state = 'ghost' THEN 1 ELSE 0 END) AS ghost_state,
    SUM(CASE WHEN pending_title IS NOT NULL OR pending_done_means IS NOT NULL OR pending_removal = 1 THEN 1 ELSE 0 END) AS pending_count,
    SUM(CASE WHEN leaf_kind = 'human' AND state = 'set' THEN 1 ELSE 0 END) AS human_open,
    SUM(CASE WHEN plan_state = 'proposed' THEN 1 ELSE 0 END) AS plan_proposed,
    SUM(CASE WHEN review_state = 'awaiting_jarvis' THEN 1 ELSE 0 END) AS awaiting_jarvis,
    SUM(CASE WHEN state NOT IN ('discarded','parked') THEN 1 ELSE 0 END) AS denom
  FROM goal_nodes WHERE goal_id = ?
`);

function computeCounts(goalId: number): GoalCounts {
  const row = countsStmt.get(goalId) as {
    total: number | null; done: number | null; working: number | null; check_count: number | null;
    ghost_state: number | null; pending_count: number | null; human_open: number | null;
    plan_proposed: number | null; awaiting_jarvis: number | null; denom: number | null;
  };
  const ghosts = (row.ghost_state ?? 0) + (row.pending_count ?? 0);
  const humanOpen = row.human_open ?? 0;
  const checkCount = row.check_count ?? 0;
  const needYou = ghosts + humanOpen + checkCount + (row.plan_proposed ?? 0);
  const denom = Math.max(1, row.denom ?? 0);
  const done = row.done ?? 0;
  return {
    total: row.total ?? 0,
    done,
    working: row.working ?? 0,
    check: checkCount,
    need_you: needYou,
    ghosts,
    human_open: humanOpen,
    awaiting_jarvis: row.awaiting_jarvis ?? 0,
    progress: Math.round((100 * done) / denom),
  };
}

const lastEventAtStmt = sqliteDb.prepare(`
  SELECT created_at FROM goal_events WHERE goal_id = ? ORDER BY id DESC LIMIT 1
`);

function toGoalSummary(row: GoalRow): GoalSummary {
  const focus = getFocusRaw(row.id);
  const lastEvent = lastEventAtStmt.get(row.id) as { created_at: string } | undefined;
  return {
    ...row,
    counts: computeCounts(row.id),
    focus_node_id: focus.node_id,
    last_event_at: lastEvent?.created_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Events + SSE emit
// ---------------------------------------------------------------------------

interface RawEventRow {
  id: number; goal_id: number; node_id: number | null; actor: string;
  kind: string; text: string | null; data: string | null; created_at: string;
}

function parseEventRow(row: RawEventRow): GoalEventRow {
  let data: unknown = null;
  if (row.data) {
    try { data = JSON.parse(row.data); } catch { data = row.data; }
  }
  return {
    id: row.id, goal_id: row.goal_id, node_id: row.node_id,
    actor: row.actor as GoalActor, kind: row.kind, text: row.text, data,
    created_at: row.created_at,
  };
}

function insertEvent(
  goalId: number,
  nodeId: number | null,
  actor: GoalActor,
  kind: string,
  text: string | null,
  data?: unknown,
): void {
  sqliteDb.prepare(`
    INSERT INTO goal_events (goal_id, node_id, actor, kind, text, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(goalId, nodeId, actor, kind, text ?? null, data !== undefined ? JSON.stringify(data) : null);
}

function emitGoal(action: GoalEvent['action'], goalId: number): void {
  const row = getGoalRowStmt.get(goalId) as GoalRow | undefined;
  if (!row) return;
  sseBus.emit('sse', { type: 'goal', action, goal: toGoalSummary(row) } satisfies GoalEvent);
}

/** Bumps updated_at + emits 'goal' — every node write must keep the forest card live. */
function touchGoal(goalId: number): void {
  sqliteDb.prepare(`UPDATE goals SET updated_at = datetime('now') WHERE id = ?`).run(goalId);
  emitGoal('updated', goalId);
}

function emitNode(action: GoalNodeEvent['action'], node: GoalNodeDbRow, batchId?: string | null): void {
  const derived = deriveSingleNode(node);
  const payload: GoalNodeEvent = { type: 'goal_node', action, goal_id: node.goal_id, node: derived };
  if (batchId) payload.batch_id = batchId;
  sseBus.emit('sse', payload);
  touchGoal(node.goal_id);
}

// ---------------------------------------------------------------------------
// Focus (CONTRACT §3.5)
// ---------------------------------------------------------------------------

interface RawFocusRow { goal_id: number; node_id: number | null; set_by: string; updated_at: string; }

function getFocusRaw(goalId: number): RawFocusRow {
  let row = sqliteDb.prepare(`SELECT * FROM goal_focus WHERE goal_id = ?`).get(goalId) as RawFocusRow | undefined;
  if (!row) {
    sqliteDb.prepare(`INSERT OR IGNORE INTO goal_focus (goal_id, node_id, set_by) VALUES (?, NULL, 'kevin')`).run(goalId);
    row = sqliteDb.prepare(`SELECT * FROM goal_focus WHERE goal_id = ?`).get(goalId) as RawFocusRow;
  }
  return row;
}

function toFocusRow(goalId: number, raw: RawFocusRow): FocusRow {
  const fullPath = raw.node_id != null ? pathForNode(raw.node_id) : null;
  return {
    goal_id: goalId,
    node_id: raw.node_id,
    set_by: raw.set_by as GoalActor,
    updated_at: raw.updated_at,
    path: fullPath ? fullPath.slice(1) : [],
  };
}

export function getGoalFocus(goalId: number): FocusRow {
  requireGoal(goalId);
  return toFocusRow(goalId, getFocusRaw(goalId));
}

export function setGoalFocus(goalId: number, nodeId: number | null, setBy?: unknown): FocusRow {
  requireGoal(goalId);
  if (nodeId != null) {
    const node = getRawNodeStmt.get(nodeId) as GoalNodeDbRow | undefined;
    if (!node || node.goal_id !== goalId) throw new GoalError(404, 'node_not_found', 'node not found in this goal');
    if (node.state === 'discarded') throw new GoalError(409, 'node_discarded', 'cannot focus a discarded node');
  }
  const current = getFocusRaw(goalId);
  const by = assertActor(setBy, 'kevin');
  if (current.node_id === nodeId) {
    // No change: zero events, zero SSE — repeat clicks on the same node are silent.
    return toFocusRow(goalId, current);
  }
  sqliteDb.prepare(`UPDATE goal_focus SET node_id = ?, set_by = ?, updated_at = datetime('now') WHERE goal_id = ?`)
    .run(nodeId, by, goalId);
  insertEvent(goalId, nodeId, by, 'focus_set', nodeId != null ? `Focus set to node ${nodeId}.` : 'Focus cleared.');
  const result = toFocusRow(goalId, getFocusRaw(goalId));
  sseBus.emit('sse', { type: 'goal_focus', goal_id: goalId, focus: result } satisfies GoalFocusEvent);
  return result;
}

// ---------------------------------------------------------------------------
// §2.4(1) — child settles → parent check (the only auto-flip this file owns;
// tree-done→check and tree-blocked badges are BACKEND B's hopper-hook wiring).
// ---------------------------------------------------------------------------

function maybeSettleParent(nodeId: number): void {
  const node = getRawNodeStmt.get(nodeId) as GoalNodeDbRow | undefined;
  if (!node || node.parent_id == null) return;
  const parent = getRawNodeStmt.get(node.parent_id) as GoalNodeDbRow | undefined;
  if (!parent || parent.state !== 'set') return;
  const children = sqliteDb.prepare(`SELECT * FROM goal_nodes WHERE parent_id = ?`).all(parent.id) as GoalNodeDbRow[];
  const nonDiscarded = children.filter((c) => c.state !== 'discarded');
  if (nonDiscarded.length === 0) return;
  const relevant = nonDiscarded.filter((c) => c.state !== 'parked');
  if (relevant.length === 0) return; // every remaining child parked — never vacuously complete
  if (!relevant.every((c) => c.state === 'done')) return;
  sqliteDb.prepare(`UPDATE goal_nodes SET state = 'check', updated_at = datetime('now') WHERE id = ?`).run(parent.id);
  insertEvent(parent.goal_id, parent.id, 'system', 'node_check', `All subtasks done: ${parent.title}`);
  emitNode('updated', getRawNodeStmt.get(parent.id) as GoalNodeDbRow);
  maybeSettleParent(parent.id); // naturally terminates: parent is now 'check', not 'done'
}

// ---------------------------------------------------------------------------
// Goals — §3.1 (routes 1-7; route 8 GET/POST .../thread is BACKEND B's)
// ---------------------------------------------------------------------------

export function listGoals(includeDone = false, includeArchived = false): GoalSummary[] {
  const rows = sqliteDb.prepare(`
    SELECT * FROM goals
    WHERE (archived = 0 OR ?) AND (status != 'done' OR ?)
    ORDER BY sort_order ASC, id ASC
  `).all(includeArchived ? 1 : 0, includeDone ? 1 : 0) as GoalRow[];
  return rows.map(toGoalSummary);
}

/** Seed text for the goal's dedicated thread (CONTRACT §8). Exported for BACKEND B's
 *  GET/POST /goals/:id/thread + promote to reuse verbatim. */
export function composeGoalSeed(goal: GoalRow): string {
  const counts = computeCounts(goal.id);
  const focus = getFocusRaw(goal.id);
  const focusRow = toFocusRow(goal.id, focus);
  const focusLine = focusRow.node_id != null && focusRow.path.length
    ? focusRow.path.join(' › ')
    : '(none — the goal itself)';
  return [
    `🎯 GOAL CHAT — this thread belongs to goal #${goal.id} "${goal.title}" and nothing else. Read skills/goals/SKILL.md before your first reply (it is the operating contract for goal chats); the \`goals\` tool is how you touch the tree. Every turn of this thread is prefixed with a <goal_focus/> line + a <goal_tree> snapshot — that snapshot is your memory of this goal; never ask Kevin to restate it.`,
    '',
    `Goal: ${goal.title}`,
    `Done means: ${goal.done_means || '(not set yet)'}`,
    `Notes: ${goal.notes || '(none)'}`,
    `Status: ${goal.status} · nodes: ${counts.total} (${counts.done} done · ${counts.working} working · ${counts.need_you} need you)`,
    `Focus: ${focusLine}`,
    '',
    'Rules for this chat (short form; SKILL.md has the long form):',
    '1. No done_means yet → clarify in ≤5 questions, propose one sentence, and when Kevin confirms it call `goals` op `set_goal_done_means`.',
    "2. Everything you add/reword/remove is a ghost until Kevin ✓s: use `propose` / `propose_edit` / `propose_remove`. `set_from_kevin` only for nodes he dictated verbatim.",
    '3. One layer ahead, never two: propose children only under the focused node (or the goal root when nothing is focused).',
    "4. A node that can't split is a leaf: `set_leaf_kind` machine (you can spec it) or human (only Kevin can do it). Machine leaves get a `propose_plan`; Kevin approves on the card (or says go → `dispatch`).",
    "5. Push back when a branch doesn't serve the goal. Verify against done_means before anything becomes done (`verify`).",
    "6. Kevin never has to say which node he means — the focus line tells you. If he clearly means a different node, say which one you're taking it as.",
    '',
    'Open with: if done_means is empty, your clarify questions; otherwise a two-line read of where this goal stands and what you\'d propose next under the current focus.',
  ].join('\n');
}

export function createGoal(args: {
  title: string;
  done_means?: string | null;
  notes?: string | null;
  authored_by?: unknown;
  actor?: unknown;
}): { goal: GoalSummary; thread: { external_id: string; created: true; seed_text: string } } {
  const title = args.title?.trim();
  if (!title) throw new GoalError(400, 'title_required', 'title is required');
  const doneMeans = args.done_means?.trim() || null;
  const authoredBy: NodeAuthor = args.authored_by === 'jarvis' ? 'jarvis' : 'kevin';
  const status: GoalStatus = doneMeans ? 'set' : 'ghost';
  const actor = assertActor(args.actor, 'kevin');

  const info = sqliteDb.prepare(`
    INSERT INTO goals (title, done_means, notes, status, authored_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(title, doneMeans, args.notes?.trim() || null, status, authoredBy);
  const id = Number(info.lastInsertRowid);

  const externalId = `cockpit:goal-${id}`;
  const conv = getOrCreateConversation(externalId);
  renameConversation(conv.id, `🎯 ${title}`.slice(0, 120));
  sqliteDb.prepare(`UPDATE goals SET thread_ext = ? WHERE id = ?`).run(externalId, id);

  insertEvent(id, null, actor, 'goal_created', `Goal created: ${title}`);
  insertEvent(id, null, 'system', 'thread_opened', `Thread ${externalId} opened.`);

  const row = getGoalRowStmt.get(id) as GoalRow;
  emitGoal('created', id);
  const seedText = composeGoalSeed(row);
  return {
    goal: toGoalSummary(row),
    thread: { external_id: externalId, created: true, seed_text: seedText },
  };
}

export function getGoalTree(id: number, includeDiscarded = false): GoalTree | null {
  const row = getGoalRowStmt.get(id) as GoalRow | undefined;
  if (!row) return null;
  const raw = listRawNodesForGoal(id, includeDiscarded);
  const nodes = buildDerivedNodes(row.title, raw);
  const focus = toFocusRow(id, getFocusRaw(id));
  return { goal: toGoalSummary(row), nodes, focus };
}

export function patchGoal(id: number, patch: {
  title?: string;
  done_means?: string | null;
  notes?: string | null;
  sort_order?: number;
  archived?: boolean;
  actor?: unknown;
}): GoalSummary {
  const existing = requireGoal(id);
  const actor = assertActor(patch.actor, 'kevin');

  const title = patch.title !== undefined ? patch.title.trim() : existing.title;
  if (!title) throw new GoalError(400, 'title_required', 'title cannot be empty');
  const doneMeans = patch.done_means !== undefined ? (patch.done_means?.trim() || null) : existing.done_means;
  const notes = patch.notes !== undefined ? (patch.notes?.trim() || null) : existing.notes;
  const sortOrder = patch.sort_order !== undefined ? patch.sort_order : existing.sort_order;
  const archived = patch.archived !== undefined ? (patch.archived ? 1 : 0) : existing.archived;

  let status = existing.status;
  const flipped = existing.status === 'ghost' && !!doneMeans;
  if (flipped) status = 'set';

  sqliteDb.prepare(`
    UPDATE goals SET title = ?, done_means = ?, notes = ?, sort_order = ?, archived = ?, status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(title, doneMeans, notes, sortOrder, archived, status, id);

  // CONTRACT §8: the conversation label is `🎯 <goal title>`, re-applied on rename.
  if (title !== existing.title && existing.thread_ext) {
    const conv = getConversation(existing.thread_ext);
    if (conv) renameConversation(conv.id, `🎯 ${title}`.slice(0, 120));
  }

  insertEvent(id, null, actor, flipped ? 'goal_set' : 'goal_updated', flipped ? 'Goal set: done_means confirmed.' : 'Goal updated.');
  emitGoal('updated', id);
  return toGoalSummary(getGoalRowStmt.get(id) as GoalRow);
}

export function verifyGoal(id: number, passed: boolean, note?: string, actor?: unknown): { goal: GoalSummary; verified: boolean } {
  const existing = requireGoal(id);
  // REVIEW fix: `passed:false` is a no-op 200 per CONTRACT route 5 — it must not
  // 409 just because the goal isn't `set` (e.g. a stray reopen on a done goal).
  if (!passed) {
    return { goal: toGoalSummary(existing), verified: false };
  }
  if (existing.status !== 'set') {
    throw new GoalError(409, 'invalid_transition', `goal is ${existing.status}, not set`, { from: existing.status, to: 'done' });
  }
  const act = assertActor(actor, 'kevin');
  const nodes = listRawNodesForGoal(id, true);
  const blocking = nodes.filter((n) => n.state !== 'discarded' && n.state !== 'parked' && n.state !== 'done');
  if (blocking.length) {
    throw new GoalError(409, 'children_not_done', `${blocking.length} node(s) are not done yet`, { node_ids: blocking.map((n) => n.id) });
  }
  sqliteDb.prepare(`UPDATE goals SET status = 'done', verified_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  insertEvent(id, null, act, 'goal_done', note ? `Goal verified done: ${note}` : 'Goal verified done.', { note });
  emitGoal('updated', id);
  flipPromotedStubOnGoalDone(id);
  return { goal: toGoalSummary(getGoalRowStmt.get(id) as GoalRow), verified: true };
}

/** §3.6(4) — when a promoted-into goal reaches done, the stub node left behind
 *  in the parent goal flips to `check` so the parent still verifies it. */
function flipPromotedStubOnGoalDone(newGoalId: number): void {
  const stub = sqliteDb.prepare(`SELECT * FROM goal_nodes WHERE promoted_to_goal_id = ?`).get(newGoalId) as GoalNodeDbRow | undefined;
  if (!stub) return;
  if (stub.state === 'done' || stub.state === 'discarded' || stub.state === 'check') return;
  sqliteDb.prepare(`UPDATE goal_nodes SET state = 'check', updated_at = datetime('now') WHERE id = ?`).run(stub.id);
  insertEvent(stub.goal_id, stub.id, 'system', 'node_check', `Promoted goal done: ${stub.title}`, { reason: 'promoted_goal_done' });
  emitNode('updated', getRawNodeStmt.get(stub.id) as GoalNodeDbRow);
  maybeSettleParent(stub.id);
}

export function parkGoal(id: number, actor?: unknown): GoalSummary {
  const existing = requireGoal(id);
  if (existing.status !== 'set') {
    throw new GoalError(409, 'invalid_transition', `goal is ${existing.status}, not set`, { from: existing.status, to: 'parked' });
  }
  const act = assertActor(actor, 'kevin');
  sqliteDb.prepare(`UPDATE goals SET status = 'parked', updated_at = datetime('now') WHERE id = ?`).run(id);
  insertEvent(id, null, act, 'goal_parked', 'Goal parked.');
  emitGoal('updated', id);
  return toGoalSummary(getGoalRowStmt.get(id) as GoalRow);
}

export function unparkGoal(id: number, actor?: unknown): GoalSummary {
  const existing = requireGoal(id);
  if (existing.status !== 'parked') {
    throw new GoalError(409, 'invalid_transition', `goal is ${existing.status}, not parked`, { from: existing.status, to: 'set' });
  }
  const act = assertActor(actor, 'kevin');
  sqliteDb.prepare(`UPDATE goals SET status = 'set', updated_at = datetime('now') WHERE id = ?`).run(id);
  insertEvent(id, null, act, 'goal_unparked', 'Goal unparked.');
  emitGoal('updated', id);
  return toGoalSummary(getGoalRowStmt.get(id) as GoalRow);
}

export function listGoalEvents(id: number, after?: number, limit = 100): GoalEventRow[] {
  requireGoal(id);
  const n = Math.max(1, Math.min(limit, 500));
  const rows = (after
    ? sqliteDb.prepare(`SELECT * FROM goal_events WHERE goal_id = ? AND id > ? ORDER BY id ASC LIMIT ?`).all(id, after, n)
    : sqliteDb.prepare(`SELECT * FROM goal_events WHERE goal_id = ? ORDER BY id ASC LIMIT ?`).all(id, n)) as RawEventRow[];
  return rows.map(parseEventRow);
}

// ---------------------------------------------------------------------------
// Nodes — §3.2 (routes 9-16)
// ---------------------------------------------------------------------------

function nextSortOrder(goalId: number, parentId: number | null): number {
  const row = (parentId == null
    ? sqliteDb.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM goal_nodes WHERE goal_id = ? AND parent_id IS NULL`).get(goalId)
    : sqliteDb.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM goal_nodes WHERE goal_id = ? AND parent_id = ?`).get(goalId, parentId)
  ) as { m: number };
  return (row?.m ?? -1) + 1;
}

/** §1.1 parent preconditions, shared by direct create + propose. */
function validateParentForNewChild(goalId: number, parentId: number | null): GoalNodeDbRow | null {
  if (parentId == null) {
    const goal = requireGoal(goalId);
    if (goal.status !== 'set') throw new GoalError(409, 'goal_not_set', 'goal must be set before adding root-level nodes');
    return null;
  }
  const parent = getRawNodeStmt.get(parentId) as GoalNodeDbRow | undefined;
  if (!parent || parent.goal_id !== goalId) throw new GoalError(400, 'parent_goal_mismatch', 'parent node does not belong to this goal');
  if (!['set', 'planned', 'working', 'check'].includes(parent.state)) {
    throw new GoalError(409, 'parent_not_set', `parent node is ${parent.state}, must be set/planned/working/check`);
  }
  return parent;
}

/** §1.1: adding a child under a dispatched-leaf-classified parent resets its leaf_kind/plan. */
function resetParentLeafIfNeeded(parent: GoalNodeDbRow | null): void {
  if (!parent || parent.leaf_kind === 'none') return;
  if (['planned', 'working', 'check', 'done'].includes(parent.state)) {
    throw new GoalError(409, 'leaf_already_dispatched', `parent node ${parent.id} already has a dispatched leaf (${parent.state})`);
  }
  sqliteDb.prepare(`UPDATE goal_nodes SET leaf_kind = 'none', plan_state = 'none', plan = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(parent.id);
}

export function createGoalNode(goalId: number, args: {
  title: string;
  done_means?: string | null;
  notes?: string | null;
  parent_id?: number | null;
  authored_by?: unknown;
  leaf_kind?: unknown;
  sort_order?: number;
  actor?: unknown;
}): GoalNodeRow {
  requireGoal(goalId);
  const title = args.title?.trim();
  if (!title) throw new GoalError(400, 'title_required', 'title is required');
  const parentId = args.parent_id ?? null;
  const parent = validateParentForNewChild(goalId, parentId);

  const authoredBy: NodeAuthor = args.authored_by === 'jarvis' ? 'jarvis' : 'kevin';
  const doneMeans = args.done_means?.trim() || null;
  const leafKind = normLeafKind(args.leaf_kind);
  const actor = assertActor(args.actor, 'kevin');

  let state: GoalNodeState;
  let batch: string | null = null;
  if (authoredBy === 'kevin') {
    if (!doneMeans) throw new GoalError(409, 'done_means_required', 'done_means is required for a Kevin-authored node');
    state = 'set';
  } else {
    state = 'ghost';
    batch = randomUUID();
  }

  resetParentLeafIfNeeded(parent);
  const sortOrder = args.sort_order ?? nextSortOrder(goalId, parentId);

  const info = sqliteDb.prepare(`
    INSERT INTO goal_nodes (goal_id, parent_id, title, done_means, notes, authored_by, state, leaf_kind, proposal_batch, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(goalId, parentId, title, doneMeans, args.notes?.trim() || null, authoredBy, state, leafKind, batch, sortOrder);
  const id = Number(info.lastInsertRowid);
  const row = getRawNodeStmt.get(id) as GoalNodeDbRow;

  insertEvent(
    goalId, id, actor,
    authoredBy === 'kevin' ? 'node_created' : 'node_proposed',
    `${authoredBy === 'kevin' ? 'Created' : 'Proposed'}: ${title}`,
    batch ? { batch_id: batch } : undefined,
  );
  emitNode('created', row, batch);
  return deriveSingleNode(row);
}

export function proposeGoalNodes(goalId: number, args: {
  parent_id?: number | null;
  items: Array<{ title: string; done_means: string; notes?: string; leaf_kind?: unknown; children?: unknown }>;
  actor?: unknown;
}): { batch_id: string; nodes: GoalNodeRow[] } {
  requireGoal(goalId);
  const items = args.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 12) {
    throw new GoalError(400, 'invalid_request', 'items must contain 1-12 entries');
  }
  for (const item of items) {
    if (item && typeof item === 'object' && 'children' in item && (item as { children?: unknown }).children != null) {
      throw new GoalError(400, 'no_nesting', 'propose items must not nest children — one layer at a time');
    }
    if (!item?.title?.trim()) throw new GoalError(400, 'invalid_request', 'every item needs a title');
    if (!item?.done_means?.trim()) throw new GoalError(400, 'invalid_request', 'every item needs done_means');
  }

  const parentId = args.parent_id ?? null;
  const parent = validateParentForNewChild(goalId, parentId);
  resetParentLeafIfNeeded(parent);

  const batchId = randomUUID();
  const actor = assertActor(args.actor, 'jarvis');
  let sortOrder = nextSortOrder(goalId, parentId);
  const created: GoalNodeDbRow[] = [];

  for (const item of items) {
    const leafKind = normLeafKind(item.leaf_kind);
    const info = sqliteDb.prepare(`
      INSERT INTO goal_nodes (goal_id, parent_id, title, done_means, notes, authored_by, state, leaf_kind, proposal_batch, sort_order)
      VALUES (?, ?, ?, ?, ?, 'jarvis', 'ghost', ?, ?, ?)
    `).run(goalId, parentId, item.title.trim(), item.done_means.trim(), item.notes?.trim() || null, leafKind, batchId, sortOrder);
    sortOrder += 1;
    created.push(getRawNodeStmt.get(Number(info.lastInsertRowid)) as GoalNodeDbRow);
  }

  for (const row of created) {
    insertEvent(goalId, row.id, actor, 'node_proposed', `Proposed: ${row.title}`, { batch_id: batchId });
    emitNode('created', row, batchId);
  }
  return { batch_id: batchId, nodes: created.map(deriveSingleNode) };
}

/** v0.1 §11.2 — ghost → set. Clears the batch AND every review field (the four
 *  columns are only meaningful while a node is a ghost). */
function setGhostToSet(goalId: number, nodeId: number, actor: GoalActor, eventKind: string, eventText: string): GoalNodeDbRow {
  sqliteDb.prepare(`
    UPDATE goal_nodes SET state = 'set', proposal_batch = NULL,
      review_state = 'none', review_note = NULL, kevin_edit_original = NULL, last_edited_by = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(nodeId);
  insertEvent(goalId, nodeId, actor, eventKind, eventText);
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  return fresh;
}

type AcceptOutcome = { row: GoalNodeDbRow; outcome: 'set' | 'awaiting' | 'agreed'; reask: boolean };

/** v0.1 §11.2 — the agreement gate. A ghost solidifies only when the party who
 *  did NOT make the last edit approves it (see CONTRACT §11). Does NOT fire the
 *  review cue itself — the caller collects the `awaiting` rows and fires ONE cue
 *  per HTTP request. */
function applyAcceptToNode(goalId: number, node: GoalNodeDbRow, actor: GoalActor): AcceptOutcome {
  if (node.state !== 'ghost') {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, not ghost`, { from: node.state, to: 'set' });
  }
  if (!node.done_means?.trim()) {
    throw new GoalError(409, 'done_means_required', 'done_means is required before this node can be set', { node_ids: [node.id] });
  }
  if (actor === 'kevin') {
    if (node.review_state === 'awaiting_jarvis') {
      throw new GoalError(409, 'awaiting_jarvis', 'JARVIS is weighing in on your edit — see the chat', { node_ids: [node.id] });
    }
    if (node.last_edited_by === 'kevin') {
      // Kevin made the last edit → it must go to JARVIS to weigh in before it
      // solidifies. Covers the first OK (review_state='none') and a re-OK after a
      // push-back (review_state='pushed_back', note kept, cue re-fires).
      const reask = node.review_state === 'pushed_back';
      sqliteDb.prepare(`UPDATE goal_nodes SET review_state = 'awaiting_jarvis', updated_at = datetime('now') WHERE id = ?`).run(node.id);
      insertEvent(
        goalId, node.id, actor, 'kevin_okd_edit',
        reask ? `Kevin re-OK'd without changes after your push-back: ${node.title}` : `Kevin OK'd his edit: ${node.title}`,
        { reask },
      );
      const fresh = getRawNodeStmt.get(node.id) as GoalNodeDbRow;
      emitNode('updated', fresh);
      return { row: fresh, outcome: 'awaiting', reask };
    }
    // JARVIS proposed / last reworded it (or an untouched proposal) → Kevin ✓ sets it (v0).
    return { row: setGhostToSet(goalId, node.id, actor, 'node_accepted', `Accepted: ${node.title}`), outcome: 'set', reask: false };
  }
  // actor === 'jarvis' | 'system'
  if (node.review_state === 'awaiting_jarvis' || node.review_state === 'pushed_back') {
    // JARVIS agrees with Kevin's edit → it solidifies.
    return { row: setGhostToSet(goalId, node.id, actor, 'node_agreed', `JARVIS agreed with Kevin's edit: ${node.title}`), outcome: 'agreed', reask: false };
  }
  // No Kevin edit awaiting → v0 rule (only when Kevin said yes in chat).
  return { row: setGhostToSet(goalId, node.id, actor, 'node_accepted', `Accepted: ${node.title}`), outcome: 'set', reask: false };
}

export function acceptGoalNode(goalId: number, nodeId: number, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  const act = assertActor(actor, 'kevin');
  const result = applyAcceptToNode(goalId, node, act);
  const derived = deriveSingleNode(result.row);
  if (result.outcome === 'awaiting') fireGoalReviewCue(goalId, [derived], result.reask);
  return derived;
}

function acceptRows(goalId: number, rows: GoalNodeDbRow[], actor: GoalActor): GoalNodeRow[] {
  const missing = rows.filter((r) => !r.done_means?.trim());
  if (missing.length) {
    throw new GoalError(409, 'done_means_required', 'some nodes are missing done_means', { node_ids: missing.map((r) => r.id) });
  }
  // A "✓ all" / batch accept from Kevin should not error the whole batch just
  // because one node is mid-review — skip those (a re-click on a single node
  // still 409s via applyAcceptToNode, per CONTRACT §11.2).
  const toProcess = actor === 'kevin' ? rows.filter((r) => r.review_state !== 'awaiting_jarvis') : rows;
  const out: GoalNodeRow[] = [];
  const awaiting: GoalNodeRow[] = [];
  for (const r of toProcess) {
    const result = applyAcceptToNode(goalId, r, actor);
    const derived = deriveSingleNode(result.row);
    out.push(derived);
    if (result.outcome === 'awaiting') awaiting.push(derived);
  }
  if (awaiting.length) fireGoalReviewCue(goalId, awaiting, false);
  return out;
}

export function acceptGoalBatch(goalId: number, batchId: string, ids?: number[], actor?: unknown): GoalNodeRow[] {
  requireGoal(goalId);
  let rows = sqliteDb.prepare(`SELECT * FROM goal_nodes WHERE goal_id = ? AND proposal_batch = ? AND state = 'ghost'`)
    .all(goalId, batchId) as GoalNodeDbRow[];
  if (ids?.length) {
    const idSet = new Set(ids);
    rows = rows.filter((r) => idSet.has(r.id));
  }
  return acceptRows(goalId, rows, assertActor(actor, 'kevin'));
}

export function acceptAllGoalNodes(goalId: number, parentId: number | null | undefined, actor?: unknown): GoalNodeRow[] {
  requireGoal(goalId);
  let rows: GoalNodeDbRow[];
  if (parentId === undefined) {
    rows = sqliteDb.prepare(`SELECT * FROM goal_nodes WHERE goal_id = ? AND state = 'ghost'`).all(goalId) as GoalNodeDbRow[];
  } else if (parentId === null) {
    rows = sqliteDb.prepare(`SELECT * FROM goal_nodes WHERE goal_id = ? AND state = 'ghost' AND parent_id IS NULL`).all(goalId) as GoalNodeDbRow[];
  } else {
    rows = sqliteDb.prepare(`SELECT * FROM goal_nodes WHERE goal_id = ? AND state = 'ghost' AND parent_id = ?`).all(goalId, parentId) as GoalNodeDbRow[];
  }
  return acceptRows(goalId, rows, assertActor(actor, 'kevin'));
}

// ---------------------------------------------------------------------------
// v0.1 §11.2/§11.3 — push_back + the review cue into the goal chat
// ---------------------------------------------------------------------------

/** JARVIS pushes back on Kevin's OK'd edit instead of agreeing — the node stays
 *  a ghost, the note is shown, and they talk it out (CONTRACT §11.2). */
export function pushBackGhost(goalId: number, nodeId: number, note: string, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  const act = assertActor(actor, 'jarvis');
  if (act !== 'jarvis') {
    throw new GoalError(403, 'jarvis_only', 'only JARVIS can push back on an edit');
  }
  if (node.state !== 'ghost') {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, not ghost`, { from: node.state, to: node.state });
  }
  // Allowed while awaiting a weigh-in, or straight from 'none' when Kevin made
  // the last edit (JARVIS can pre-empt before Kevin even clicks ✓).
  const allowed = node.review_state === 'awaiting_jarvis' || (node.review_state === 'none' && node.last_edited_by === 'kevin');
  if (!allowed) {
    throw new GoalError(409, 'nothing_to_push_back', 'no Kevin edit is awaiting your weigh-in on this node');
  }
  const trimmed = (note ?? '').trim();
  if (!trimmed) throw new GoalError(400, 'invalid_request', 'push_back requires a non-empty note');
  sqliteDb.prepare(`UPDATE goal_nodes SET review_state = 'pushed_back', review_note = ?, updated_at = datetime('now') WHERE id = ?`).run(trimmed, nodeId);
  insertEvent(goalId, nodeId, act, 'jarvis_pushed_back', trimmed);
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  return deriveSingleNode(fresh);
}

const lastEventIdStmt = sqliteDb.prepare(`SELECT id FROM goal_events WHERE goal_id = ? ORDER BY id DESC LIMIT 1`);

/** CONTRACT §11.3 — post ONE cue into the goal chat listing every node Kevin
 *  just OK'd that now awaits JARVIS's weigh-in. Same seam as `dispatch-gate.ts
 *  fireCue`; dynamic imports avoid the agent.ts <-> goals.ts static cycle
 *  (agent.ts imports buildGoalThreadContext from here). Best-effort: a missing
 *  conversation or a busy thread degrades to enqueue / log, never throws into
 *  the accept transaction (which has already committed by the time this runs). */
export function fireGoalReviewCue(goalId: number, nodes: GoalNodeRow[], reask = false): void {
  if (!nodes.length) return;
  const externalId = `cockpit:goal-${goalId}`;
  const conv = getConversation(externalId);
  if (!conv) {
    console.warn(`[goals] review cue skipped — no conversation for ${externalId}`);
    return;
  }
  const n = nodes.length;
  const header = `[goal #${goalId} — Kevin edited ${n} of your proposal${n === 1 ? '' : 's'} and OK'd ${n === 1 ? 'it' : 'them'}. Weigh in.]`;
  const blocks = nodes.map((node) => {
    let orig: { title?: string; done_means?: string } = {};
    if (node.kevin_edit_original) {
      try { orig = JSON.parse(node.kevin_edit_original) as { title?: string; done_means?: string }; } catch { /* keep {} */ }
    }
    let block =
      `#${node.id} now: "${node.title}" — done: "${node.done_means ?? ''}"\n` +
      `    was (yours): "${orig.title ?? ''}" — done: "${orig.done_means ?? ''}"`;
    if (node.review_note) block += `\n    you pushed back with: "${node.review_note}"`;
    return block;
  });
  const footer =
    'For each node: acknowledge the change in a sentence, then either agree → `goals` op `accept` {node_id} (it solidifies), ' +
    'or `push_back` {node_id, note} with your reason in one or two sentences and talk it out. Don\'t restate the rest of the tree.';
  const text = [header, ...blocks, footer].join('\n');
  const eventId = (lastEventIdStmt.get(goalId) as { id: number } | undefined)?.id ?? 0;
  const correlationKey = `goal-cue:${goalId}:${eventId}`;
  const convId = conv.id;

  void reask; // header/per-node note already convey re-ask; param kept for the §11 contract signature
  Promise.all([import('./agent.js'), import('./thread-message-queue.js')])
    .then(([agent, queue]) => {
      if (agent.getInFlightMessageId(convId)) {
        queue.enqueueMessage(convId, text);
        return;
      }
      agent.processMessage(text, externalId, correlationKey).catch((err: unknown) => {
        if (err instanceof agent.ConversationBusyError) queue.enqueueMessage(convId, text);
        else console.error('[goals] review cue post failed', err);
      });
    })
    .catch((err) => console.error('[goals] review cue import failed', err));
}

export function discardGoalNode(goalId: number, nodeId: number, reason?: string, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  if (node.state !== 'ghost') {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, not ghost`, { from: node.state, to: 'discarded' });
  }
  const act = assertActor(actor, 'kevin');
  sqliteDb.prepare(`UPDATE goal_nodes SET state = 'discarded', proposal_batch = NULL, review_state = 'none', review_note = NULL, kevin_edit_original = NULL, last_edited_by = NULL, updated_at = datetime('now') WHERE id = ?`).run(nodeId);
  insertEvent(goalId, nodeId, act, 'node_discarded', reason ? `Discarded: ${reason}` : `Discarded: ${node.title}`, reason ? { reason } : undefined);
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  maybeSettleParent(nodeId);
  return deriveSingleNode(getRawNodeStmt.get(nodeId) as GoalNodeDbRow);
}

export function discardGoalBatch(goalId: number, batchId: string, ids?: number[], actor?: unknown): GoalNodeRow[] {
  requireGoal(goalId);
  let rows = sqliteDb.prepare(`SELECT * FROM goal_nodes WHERE goal_id = ? AND proposal_batch = ? AND state = 'ghost'`)
    .all(goalId, batchId) as GoalNodeDbRow[];
  if (ids?.length) {
    const idSet = new Set(ids);
    rows = rows.filter((r) => idSet.has(r.id));
  }
  const act = assertActor(actor, 'kevin');
  const out: GoalNodeRow[] = [];
  for (const r of rows) {
    sqliteDb.prepare(`UPDATE goal_nodes SET state = 'discarded', proposal_batch = NULL, review_state = 'none', review_note = NULL, kevin_edit_original = NULL, last_edited_by = NULL, updated_at = datetime('now') WHERE id = ?`).run(r.id);
    insertEvent(goalId, r.id, act, 'node_discarded', `Discarded: ${r.title}`);
    emitNode('updated', getRawNodeStmt.get(r.id) as GoalNodeDbRow);
    maybeSettleParent(r.id);
    out.push(deriveSingleNode(getRawNodeStmt.get(r.id) as GoalNodeDbRow));
  }
  return out;
}

export function patchGoalNode(goalId: number, nodeId: number, patch: {
  title?: string; done_means?: string; notes?: string; sort_order?: number; actor?: unknown;
}): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  const actor = assertActor(patch.actor, 'kevin');
  if (actor === 'jarvis' && node.state !== 'ghost') {
    throw new GoalError(403, 'jarvis_must_propose', 'JARVIS may only directly edit its own ghost proposals; use propose_edit on a set node');
  }
  if (node.state === 'done' || node.state === 'discarded') {
    throw new GoalError(409, 'invalid_transition', `node is terminal (${node.state})`, { from: node.state, to: node.state });
  }
  const title = patch.title !== undefined ? patch.title.trim() : node.title;
  if (!title) throw new GoalError(400, 'title_required', 'title cannot be empty');
  const doneMeans = patch.done_means !== undefined ? (patch.done_means.trim() || null) : node.done_means;
  // done_means is REQUIRED at every level once a node is real (CONTRACT §1.1) —
  // a direct edit must not be able to strip it back off a non-ghost node.
  if (!doneMeans && node.state !== 'ghost') {
    throw new GoalError(409, 'done_means_required', 'done_means cannot be cleared on a node that is already set');
  }
  const notes = patch.notes !== undefined ? (patch.notes.trim() || null) : node.notes;
  const sortOrder = patch.sort_order !== undefined ? patch.sort_order : node.sort_order;

  // v0.1 §11.2 — editing a GHOST moves the "last word":
  //  - Kevin edits → last_edited_by='kevin', snapshot the original JARVIS wording
  //    once, and reset any open review round (a fresh edit re-opens it). His next
  //    ✓ will send it to JARVIS to weigh in rather than solidify.
  //  - JARVIS edits (edit_ghost) → last_edited_by='jarvis', review reset; JARVIS
  //    took the last word so Kevin's next ✓ sets it. kevin_edit_original is kept.
  // Non-ghost edits (Kevin only) never touch the review machinery.
  const isGhost = node.state === 'ghost';
  let lastEditedBy = node.last_edited_by;
  let kevinOriginal = node.kevin_edit_original;
  let reviewState: ReviewState = node.review_state;
  let reviewNote = node.review_note;
  let editEventKind = 'node_updated';
  if (isGhost && actor === 'kevin') {
    lastEditedBy = 'kevin';
    if (kevinOriginal == null) {
      kevinOriginal = JSON.stringify({ title: node.title, done_means: node.done_means, notes: node.notes });
    }
    reviewState = 'none';
    reviewNote = null;
    editEventKind = 'ghost_edited_by_kevin';
  } else if (isGhost && actor === 'jarvis') {
    lastEditedBy = 'jarvis';
    reviewState = 'none';
    reviewNote = null;
  }

  sqliteDb.prepare(`
    UPDATE goal_nodes SET title = ?, done_means = ?, notes = ?, sort_order = ?,
      last_edited_by = ?, kevin_edit_original = ?, review_state = ?, review_note = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(title, doneMeans, notes, sortOrder, lastEditedBy, kevinOriginal, reviewState, reviewNote, nodeId);
  insertEvent(goalId, nodeId, actor, editEventKind, `Edited: ${title}`, {
    old: { title: node.title, done_means: node.done_means },
    new: { title, done_means: doneMeans },
  });
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  return deriveSingleNode(fresh);
}

// ---------------------------------------------------------------------------
// Pending edits / removals — §3.3 (routes 17-19)
// ---------------------------------------------------------------------------

export function proposeEdit(goalId: number, nodeId: number, args: { title?: string; done_means?: string; actor?: unknown }): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  if (!['set', 'planned'].includes(node.state)) {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, must be set or planned to propose an edit`, { from: node.state, to: node.state });
  }
  if (args.title === undefined && args.done_means === undefined) {
    throw new GoalError(400, 'invalid_request', 'propose_edit needs at least one of title/done_means');
  }
  const actor = assertActor(args.actor, 'jarvis');
  // A pending EDIT and a pending REMOVAL cannot coexist: resolve_pending reads
  // pending_removal first, so leaving a stale removal flag set would silently
  // discard the node when Kevin ✓s what he was shown as a text diff.
  sqliteDb.prepare(`
    UPDATE goal_nodes SET pending_title = ?, pending_done_means = ?, pending_removal = 0, pending_by = 'jarvis', updated_at = datetime('now') WHERE id = ?
  `).run(
    args.title !== undefined ? args.title.trim() : null,
    args.done_means !== undefined ? args.done_means.trim() : null,
    nodeId,
  );
  insertEvent(goalId, nodeId, actor, 'edit_proposed', 'Edit proposed.', { title: args.title, done_means: args.done_means });
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  return deriveSingleNode(fresh);
}

export function proposeRemoval(goalId: number, nodeId: number, reason?: string, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  if (node.state !== 'set') {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, must be set to propose removal`, { from: node.state, to: node.state });
  }
  const childCount = (sqliteDb.prepare(`SELECT COUNT(*) AS n FROM goal_nodes WHERE parent_id = ? AND state != 'discarded'`).get(nodeId) as { n: number }).n;
  if (childCount > 0) throw new GoalError(409, 'node_has_children', 'node has children and cannot be removed directly');
  const actor2 = assertActor(actor, 'jarvis');
  // Mirror of propose_edit: a removal supersedes any pending text edit.
  sqliteDb.prepare(`UPDATE goal_nodes SET pending_removal = 1, pending_title = NULL, pending_done_means = NULL, pending_by = 'jarvis', updated_at = datetime('now') WHERE id = ?`).run(nodeId);
  insertEvent(goalId, nodeId, actor2, 'removal_proposed', reason ? `Removal proposed: ${reason}` : 'Removal proposed.', reason ? { reason } : undefined);
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  return deriveSingleNode(fresh);
}

export function resolvePending(goalId: number, nodeId: number, accept: boolean, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  const hasPending = node.pending_title != null || node.pending_done_means != null || node.pending_removal === 1;
  if (!hasPending) throw new GoalError(409, 'nothing_pending', 'node has no pending edit or removal');
  const act = assertActor(actor, 'kevin');
  const isRemoval = node.pending_removal === 1;

  if (accept && isRemoval) {
    sqliteDb.prepare(`
      UPDATE goal_nodes SET state = 'discarded', pending_title = NULL, pending_done_means = NULL, pending_removal = 0, pending_by = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(nodeId);
    insertEvent(goalId, nodeId, act, 'removal_accepted', `Removed: ${node.title}`);
  } else if (accept) {
    const title = node.pending_title ?? node.title;
    const doneMeans = node.pending_done_means ?? node.done_means;
    sqliteDb.prepare(`
      UPDATE goal_nodes SET title = ?, done_means = ?, pending_title = NULL, pending_done_means = NULL, pending_removal = 0, pending_by = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(title, doneMeans, nodeId);
    insertEvent(goalId, nodeId, act, 'edit_accepted', `Edit accepted: ${title}`);
  } else {
    sqliteDb.prepare(`
      UPDATE goal_nodes SET pending_title = NULL, pending_done_means = NULL, pending_removal = 0, pending_by = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(nodeId);
    insertEvent(goalId, nodeId, act, isRemoval ? 'removal_rejected' : 'edit_rejected', isRemoval ? 'Removal rejected.' : 'Edit rejected.');
  }

  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  if (accept && isRemoval) maybeSettleParent(nodeId);
  return deriveSingleNode(getRawNodeStmt.get(nodeId) as GoalNodeDbRow);
}

// ---------------------------------------------------------------------------
// §3.4 (partial) — human_done / verify / park / unpark for NODES.
// leaf_kind / propose_plan / reject_plan / approve_plan / promote / the tree
// overlay proxy are BACKEND B's (they touch the hopper tree).
// ---------------------------------------------------------------------------

export function humanDoneNode(goalId: number, nodeId: number, note?: string, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  if (node.leaf_kind !== 'human') throw new GoalError(409, 'leaf_kind_required', 'node must be a human leaf');
  if (node.state !== 'set') {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, not set`, { from: node.state, to: 'check' });
  }
  const act = assertActor(actor, 'kevin');
  sqliteDb.prepare(`UPDATE goal_nodes SET state = 'check', updated_at = datetime('now') WHERE id = ?`).run(nodeId);
  insertEvent(goalId, nodeId, act, 'human_done', note ? `Marked done: ${note}` : 'Marked done.', note ? { note } : undefined);
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  return deriveSingleNode(fresh);
}

export function verifyGoalNode(goalId: number, nodeId: number, passed: boolean, note?: string, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  if (node.state !== 'check') {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, not check`, { from: node.state, to: passed ? 'done' : 'set' });
  }
  const act = assertActor(actor, 'kevin');

  if (passed) {
    sqliteDb.prepare(`UPDATE goal_nodes SET state = 'done', verified_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(nodeId);
    insertEvent(goalId, nodeId, act, 'node_verified', note ? `Verified: ${note}` : 'Verified.', { passed: true, note });
    emitNode('updated', getRawNodeStmt.get(nodeId) as GoalNodeDbRow);
    maybeSettleParent(nodeId);
  } else {
    const clearPlan = node.leaf_kind === 'machine';
    sqliteDb.prepare(`
      UPDATE goal_nodes SET state = 'set'${clearPlan ? ", plan_state = 'none', tree_status_cache = NULL" : ''}, updated_at = datetime('now')
      WHERE id = ?
    `).run(nodeId);
    insertEvent(goalId, nodeId, act, 'node_verified', note ? `Reopened: ${note}` : 'Reopened.', { passed: false, note });
    emitNode('updated', getRawNodeStmt.get(nodeId) as GoalNodeDbRow);
  }
  return deriveSingleNode(getRawNodeStmt.get(nodeId) as GoalNodeDbRow);
}

export function parkGoalNode(goalId: number, nodeId: number, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  if (!['set', 'planned', 'check', 'working'].includes(node.state)) {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, cannot be parked`, { from: node.state, to: 'parked' });
  }
  const act = assertActor(actor, 'kevin');
  sqliteDb.prepare(`UPDATE goal_nodes SET state = 'parked', updated_at = datetime('now') WHERE id = ?`).run(nodeId);
  insertEvent(goalId, nodeId, act, 'node_parked', `Parked (was ${node.state}).`, { from: node.state });
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  return deriveSingleNode(fresh);
}

export function unparkGoalNode(goalId: number, nodeId: number, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  if (node.state !== 'parked') {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, not parked`, { from: node.state, to: 'set' });
  }
  const act = assertActor(actor, 'kevin');
  const lastPark = sqliteDb.prepare(`SELECT data FROM goal_events WHERE node_id = ? AND kind = 'node_parked' ORDER BY id DESC LIMIT 1`)
    .get(nodeId) as { data: string | null } | undefined;
  let restoreTo: GoalNodeState = 'set';
  if (lastPark?.data) {
    try {
      const parsed = JSON.parse(lastPark.data) as { from?: string };
      if (parsed.from) restoreTo = parsed.from as GoalNodeState;
    } catch { /* fall back to 'set' */ }
  }
  // A hopper tree keeps running while its node is parked. If it finished (or
  // finished before the park was even recorded), restoring `working` would
  // strand the node forever — nothing fires goalsOnTreeStatus a second time.
  if (restoreTo === 'working' && node.tree_id) {
    const treeDone = node.tree_status_cache === 'done' || getHopperTree(node.tree_id)?.status === 'done';
    if (treeDone) {
      restoreTo = 'check';
      sqliteDb.prepare(`UPDATE goal_nodes SET tree_status_cache = 'done' WHERE id = ?`).run(nodeId);
      insertEvent(goalId, nodeId, 'system', 'tree_done', `Tree finished while parked: ${node.title}`, { tree_id: node.tree_id });
    }
  }

  sqliteDb.prepare(`UPDATE goal_nodes SET state = ?, updated_at = datetime('now') WHERE id = ?`).run(restoreTo, nodeId);
  insertEvent(goalId, nodeId, act, 'node_unparked', `Unparked to ${restoreTo}.`);
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  return deriveSingleNode(fresh);
}

// ---------------------------------------------------------------------------
// Exports for BACKEND B (tool / focus-injection / hopper mapping / promote)
// ---------------------------------------------------------------------------

/** Raw node accessor — BACKEND B needs this for leaf_kind/plan/promote/tree routes. */
export function getRawGoalNode(nodeId: number): GoalNodeDbRow | null {
  return (getRawNodeStmt.get(nodeId) as GoalNodeDbRow | undefined) ?? null;
}

export function getRawGoal(goalId: number): GoalRow | null {
  return (getGoalRowStmt.get(goalId) as GoalRow | undefined) ?? null;
}

export { requireGoal, requireNode, listRawNodesForGoal, deriveSingleNode, maybeSettleParent, insertEvent, emitNode, emitGoal, touchGoal };

// ---------------------------------------------------------------------------
// BACKEND B (node #456) — §3.4 leaf_kind/plan/dispatch/promote/tree-overlay,
// §3.1 route 8 (thread), §5 the `goals` tool, §6 focus injection, §7 hopper
// mapping. Everything above this line is BACKEND A (node #455).
// ---------------------------------------------------------------------------

// -- §3.4 route 20: leaf_kind --------------------------------------------

export function setLeafKind(goalId: number, nodeId: number, leafKindInput: unknown, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  if (leafKindInput !== 'none' && leafKindInput !== 'machine' && leafKindInput !== 'human') {
    throw new GoalError(400, 'invalid_request', "leaf_kind must be one of 'none', 'machine', 'human'");
  }
  const childCount = (sqliteDb.prepare(`SELECT COUNT(*) AS n FROM goal_nodes WHERE parent_id = ? AND state != 'discarded'`).get(nodeId) as { n: number }).n;
  if (leafKindInput !== 'none' && childCount > 0) {
    throw new GoalError(409, 'node_has_children', 'node has non-discarded children and cannot be classified as a leaf');
  }
  // Re-classifying a leaf after dispatch would clear the plan out from under a
  // live hopper tree (and orphan tree_id), so leaf kind is frozen from `planned`
  // onward — CONTRACT §1.1's `leaf_already_dispatched` rule.
  if (['planned', 'working', 'check'].includes(node.state)) {
    throw new GoalError(409, 'leaf_already_dispatched', `node is ${node.state}; leaf_kind is frozen once a leaf has been dispatched`, { from: node.state, to: node.state });
  }
  if (!['ghost', 'set'].includes(node.state)) {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, leaf_kind cannot be changed`, { from: node.state, to: node.state });
  }
  const act = assertActor(actor, 'jarvis');
  const clearsPlan = leafKindInput !== 'machine';
  sqliteDb.prepare(`
    UPDATE goal_nodes SET leaf_kind = ?${clearsPlan ? ", plan_state = 'none', plan = NULL" : ''}, updated_at = datetime('now')
    WHERE id = ?
  `).run(leafKindInput, nodeId);
  insertEvent(goalId, nodeId, act, 'leaf_kind_set', `Leaf kind set to ${leafKindInput}: ${node.title}`, { leaf_kind: leafKindInput });
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  return deriveSingleNode(fresh);
}

// -- §1.2 plan JSON validation --------------------------------------------

function validatePlanJson(raw: unknown): PlanJson {
  if (!raw || typeof raw !== 'object') throw new GoalError(400, 'plan_invalid', 'plan must be an object', { reason: 'not_object' });
  const p = raw as Record<string, unknown>;
  if (typeof p.what !== 'string' || !p.what.trim()) {
    throw new GoalError(400, 'plan_invalid', 'plan.what is required', { reason: 'missing_what' });
  }
  if (typeof p.deliverable !== 'string' || !p.deliverable.trim()) {
    throw new GoalError(400, 'plan_invalid', 'plan.deliverable is required', { reason: 'missing_deliverable' });
  }
  if (!Array.isArray(p.nodes) || p.nodes.length < 1 || p.nodes.length > 12) {
    throw new GoalError(400, 'plan_invalid', 'plan.nodes must contain 1-12 entries', { reason: 'nodes_length' });
  }
  const nodes: PlanJsonNode[] = [];
  for (const rawNode of p.nodes as unknown[]) {
    if (!rawNode || typeof rawNode !== 'object') {
      throw new GoalError(400, 'plan_invalid', 'each plan node must be an object', { reason: 'node_not_object' });
    }
    const n = rawNode as Record<string, unknown>;
    if (typeof n.title !== 'string' || !n.title.trim()) {
      throw new GoalError(400, 'plan_invalid', 'each plan node needs a title', { reason: 'node_title' });
    }
    const adapter = typeof n.adapter === 'string' && n.adapter.trim() ? n.adapter.trim() : 'claude';
    if (adapter !== 'claude') {
      throw new GoalError(400, 'plan_invalid', `plan node adapter must be 'claude', got '${adapter}'`, { reason: 'non_claude_adapter' });
    }
    const model = typeof n.model === 'string' && n.model.trim() ? n.model.trim() : null;
    if (model && /fable/i.test(model)) {
      throw new GoalError(400, 'plan_invalid', `plan node model must not be a fable/frontier planner model: ${model}`, { reason: 'fable_model' });
    }
    nodes.push({
      title: n.title.trim(),
      spec: typeof n.spec === 'string' ? n.spec : undefined,
      adapter,
      model,
      depends_on_indexes: Array.isArray(n.depends_on_indexes) ? (n.depends_on_indexes as unknown[]).map((v) => Number(v)) : [],
      priority: typeof n.priority === 'number' ? n.priority : undefined,
    });
  }
  const topModel = typeof p.model === 'string' && p.model.trim() ? p.model.trim() : (nodes[0]?.model ?? 'claude-sonnet-5');
  if (/fable/i.test(topModel)) {
    throw new GoalError(400, 'plan_invalid', `plan.model must not be a fable/frontier planner model: ${topModel}`, { reason: 'fable_model' });
  }
  return {
    what: p.what.trim(),
    deliverable: p.deliverable.trim(),
    model: topModel,
    adapter: 'claude',
    estimate: typeof p.estimate === 'string' ? p.estimate : undefined,
    nodes,
    proposed_at: new Date().toISOString(),
    approved_at: null,
  };
}

// -- §3.4 route 21/22: propose_plan / reject_plan --------------------------

export function proposePlan(goalId: number, nodeId: number, planInput: unknown, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  if (node.leaf_kind !== 'machine' || node.state !== 'set') {
    throw new GoalError(409, 'plan_requires_machine_leaf', 'node must be leaf_kind=machine and state=set to receive a plan', { leaf_kind: node.leaf_kind, state: node.state });
  }
  const plan = validatePlanJson(planInput);
  const act = assertActor(actor, 'jarvis');
  sqliteDb.prepare(`UPDATE goal_nodes SET plan = ?, plan_state = 'proposed', updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(plan), nodeId);
  insertEvent(goalId, nodeId, act, 'plan_proposed', `Plan proposed: ${node.title}`);
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  return deriveSingleNode(fresh);
}

export function rejectPlan(goalId: number, nodeId: number, reason?: string, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  if (node.plan_state !== 'proposed') {
    throw new GoalError(409, 'plan_not_proposed', `plan is ${node.plan_state}, not proposed`);
  }
  const act = assertActor(actor, 'kevin');
  sqliteDb.prepare(`UPDATE goal_nodes SET plan_state = 'none', plan = NULL, updated_at = datetime('now') WHERE id = ?`).run(nodeId);
  insertEvent(goalId, nodeId, act, 'plan_rejected', reason ? `Plan rejected: ${reason}` : 'Plan rejected.', reason ? { reason } : undefined);
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  return deriveSingleNode(fresh);
}

// -- §3.4 route 23: approve_plan (plants + agrees the hopper tree) --------

function buildGoalTreeTopic(path: string[]): string {
  const goalTitle = path[0] ?? 'Goal';
  const rest = path.slice(1);
  const nodeTitle = rest[rest.length - 1] ?? '';
  const ancestors = rest.slice(0, -1);
  const topic = ancestors.length
    ? `${goalTitle} › ${ancestors.join(' › ')} — ${nodeTitle}`
    : `${goalTitle} — ${nodeTitle}`;
  return topic.slice(0, 300);
}

export function approvePlan(goalId: number, nodeId: number, actor?: unknown): {
  node: GoalNodeRow;
  tree: { id: string; topic: string };
  hopper_nodes: HopperNodeRow[];
} {
  const node = requireNode(goalId, nodeId);
  if (node.leaf_kind !== 'machine') {
    throw new GoalError(409, 'plan_requires_machine_leaf', 'node is not a machine leaf');
  }
  const act = assertActor(actor, 'kevin');

  const isRetry = node.state === 'planned';
  if (isRetry) {
    if (node.tree_id) {
      throw new GoalError(409, 'invalid_transition', 'node already has a tree_id', { from: 'planned', to: 'working' });
    }
  } else if (node.state === 'set') {
    if (node.plan_state !== 'proposed') {
      throw new GoalError(409, 'plan_not_proposed', `plan is ${node.plan_state}, not proposed`);
    }
  } else {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, expected set or planned`, { from: node.state, to: 'working' });
  }
  if (!node.plan) throw new GoalError(409, 'plan_not_proposed', 'node has no plan');

  let plan: PlanJson;
  try {
    plan = JSON.parse(node.plan) as PlanJson;
  } catch {
    throw new GoalError(500, 'plan_invalid', 'stored plan is not valid JSON');
  }

  if (!isRetry) {
    plan.approved_at = new Date().toISOString();
    sqliteDb.prepare(`UPDATE goal_nodes SET plan = ?, plan_state = 'approved', updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(plan), nodeId);
    insertEvent(goalId, nodeId, act, 'plan_approved', `Plan approved: ${node.title}`);
    emitNode('updated', getRawNodeStmt.get(nodeId) as GoalNodeDbRow);
  }

  const path = pathForNode(nodeId) ?? [node.title];
  const topic = buildGoalTreeTopic(path);

  let created: { tree: HopperTreeRow; nodes: HopperNodeRow[] };
  try {
    created = createHopperTree(
      topic,
      `cockpit:goal-${goalId}`,
      plan.nodes.map((n) => ({
        title: n.title,
        spec: n.spec ?? null,
        depends_on_indexes: n.depends_on_indexes ?? [],
        priority: n.priority,
        adapter: 'claude',
        model: n.model ?? null,
      })),
    );
    agreeHopperTree(created.tree.id);
  } catch (err) {
    sqliteDb.prepare(`UPDATE goal_nodes SET state = 'planned', updated_at = datetime('now') WHERE id = ?`).run(nodeId);
    emitNode('updated', getRawNodeStmt.get(nodeId) as GoalNodeDbRow);
    throw new GoalError(502, 'tree_plant_failed', err instanceof Error ? err.message : String(err));
  }

  sqliteDb.prepare(`UPDATE goal_nodes SET state = 'working', tree_id = ?, tree_status_cache = 'active', updated_at = datetime('now') WHERE id = ?`)
    .run(created.tree.id, nodeId);
  insertEvent(goalId, nodeId, 'system', 'tree_planted', `Tree planted: ${created.tree.id}`, { tree_id: created.tree.id });
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  return { node: deriveSingleNode(fresh), tree: { id: created.tree.id, topic }, hopper_nodes: listTreeNodes(created.tree.id) };
}

// -- §7 hopper → goals hook (registered below at module load) ------------

/** Called by hopper-engine's tree-status listener whenever a tree flips
 *  done/blocked/active. No-op when no goal node references the tree. */
export function goalsOnTreeStatus(treeId: string, status: 'done' | 'blocked' | 'active'): void {
  const node = sqliteDb.prepare(`SELECT * FROM goal_nodes WHERE tree_id = ?`).get(treeId) as GoalNodeDbRow | undefined;
  if (!node) return;
  // A reopened node (check -> set) KEEPS its old tree_id for reference
  // (CONTRACT route 25), so a late status callback from that finished tree must
  // not paint a badge onto — or re-flip — a node that has moved on.
  if (node.state !== 'working' && node.state !== 'parked') return;

  if (status === 'done') {
    // Parked-while-working is legal (CONTRACT §2.1) and the engine keeps
    // running. Record the completion on the cache so unpark can land the node
    // on `check` instead of stranding it at `working` with a finished tree.
    sqliteDb.prepare(`UPDATE goal_nodes SET tree_status_cache = 'done', updated_at = datetime('now') WHERE id = ?`).run(node.id);
    if (node.state === 'working') {
      sqliteDb.prepare(`UPDATE goal_nodes SET state = 'check', updated_at = datetime('now') WHERE id = ?`).run(node.id);
    }
    insertEvent(node.goal_id, node.id, 'system', 'tree_done', `Tree finished: ${node.title}`, { tree_id: treeId, parked: node.state === 'parked' });
    emitNode('updated', getRawNodeStmt.get(node.id) as GoalNodeDbRow);
  } else if (status === 'blocked') {
    if (node.tree_status_cache === 'blocked' || node.tree_status_cache === 'done') return; // fire once per transition
    sqliteDb.prepare(`UPDATE goal_nodes SET tree_status_cache = 'blocked', updated_at = datetime('now') WHERE id = ?`).run(node.id);
    insertEvent(node.goal_id, node.id, 'system', 'tree_blocked', `Tree blocked: ${node.title}`, { tree_id: treeId });
    emitNode('updated', getRawNodeStmt.get(node.id) as GoalNodeDbRow);
  } else {
    // 'active' — clears a prior blocked badge only.
    if (node.tree_status_cache !== 'blocked') return;
    sqliteDb.prepare(`UPDATE goal_nodes SET tree_status_cache = 'active', updated_at = datetime('now') WHERE id = ?`).run(node.id);
    emitNode('updated', getRawNodeStmt.get(node.id) as GoalNodeDbRow);
  }
}

registerTreeStatusListener(goalsOnTreeStatus);

// -- §3.4 route 28: read-only tree overlay proxy --------------------------

export function getNodeTreeOverlay(goalId: number, nodeId: number): { tree: HopperTreeRow; nodes: HopperNodeRow[] } {
  const node = requireNode(goalId, nodeId);
  if (!node.tree_id) throw new GoalError(404, 'no_tree', 'node has no linked hopper tree');
  const tree = getHopperTree(node.tree_id);
  if (!tree) throw new GoalError(404, 'no_tree', 'linked hopper tree not found');
  return { tree, nodes: listTreeNodes(tree.id) };
}

// -- §3.1 route 8: GET|POST /goals/:id/thread ------------------------------

export function getOrCreateGoalThread(goalId: number): { external_id: string; created: boolean; seed_text: string | null } {
  const goal = requireGoal(goalId);
  const externalId = `cockpit:goal-${goalId}`;
  const existingConv = getConversation(externalId);
  if (existingConv && goal.thread_ext === externalId) {
    return { external_id: externalId, created: false, seed_text: null };
  }
  const conv = getOrCreateConversation(externalId);
  if (!existingConv) {
    renameConversation(conv.id, `🎯 ${goal.title}`.slice(0, 120));
  }
  if (goal.thread_ext !== externalId) {
    sqliteDb.prepare(`UPDATE goals SET thread_ext = ? WHERE id = ?`).run(externalId, goalId);
    insertEvent(goalId, null, 'system', 'thread_opened', `Thread ${externalId} opened.`);
  }
  const seedText = existingConv ? null : composeGoalSeed(requireGoal(goalId));
  return { external_id: externalId, created: !existingConv, seed_text: seedText };
}

// -- §3.6 route 27: promote (the only escape hatch) ------------------------

export function promoteNode(goalId: number, nodeId: number, actor?: unknown): {
  goal: GoalSummary;
  node: GoalNodeRow;
  thread: { external_id: string; created: true; seed_text: string };
} {
  const node = requireNode(goalId, nodeId);
  if (node.promoted_to_goal_id != null) {
    throw new GoalError(409, 'already_promoted', 'node has already been promoted');
  }
  if (!['set', 'planned', 'check', 'working'].includes(node.state)) {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, cannot be promoted`, { from: node.state, to: node.state });
  }
  const act = assertActor(actor, 'jarvis');

  // 1) new goal (done_means guaranteed present: the node reached 'set' at least once)
  const info = sqliteDb.prepare(`
    INSERT INTO goals (title, done_means, notes, status, authored_by, promoted_from_node_id)
    VALUES (?, ?, ?, 'set', ?, ?)
  `).run(node.title, node.done_means, node.notes, node.authored_by, node.id);
  const newGoalId = Number(info.lastInsertRowid);

  // 2) create + link its thread
  const externalId = `cockpit:goal-${newGoalId}`;
  const conv = getOrCreateConversation(externalId);
  renameConversation(conv.id, `🎯 ${node.title}`.slice(0, 120));
  sqliteDb.prepare(`UPDATE goals SET thread_ext = ? WHERE id = ?`).run(externalId, newGoalId);
  insertEvent(newGoalId, null, act, 'goal_created', `Goal created via promotion: ${node.title}`);
  insertEvent(newGoalId, null, 'system', 'thread_opened', `Thread ${externalId} opened.`);

  // 3) move the subtree: descendants get goal_id=newGoalId; node's direct
  // children become root-level (parent_id=NULL) in the new goal.
  const allNodes = listRawNodesForGoal(goalId, true);
  const byParent = new Map<number, GoalNodeDbRow[]>();
  for (const n of allNodes) {
    if (n.parent_id != null) {
      if (!byParent.has(n.parent_id)) byParent.set(n.parent_id, []);
      byParent.get(n.parent_id)!.push(n);
    }
  }
  const descendantIds: number[] = [];
  const stack = [...(byParent.get(nodeId) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    descendantIds.push(cur.id);
    for (const child of byParent.get(cur.id) ?? []) stack.push(child);
  }
  if (descendantIds.length) {
    const placeholders = descendantIds.map(() => '?').join(',');
    sqliteDb.prepare(`UPDATE goal_nodes SET goal_id = ? WHERE id IN (${placeholders})`).run(newGoalId, ...descendantIds);
  }
  sqliteDb.prepare(`UPDATE goal_nodes SET parent_id = NULL WHERE parent_id = ?`).run(nodeId);

  // 4) stub the original node in place
  sqliteDb.prepare(`
    UPDATE goal_nodes SET promoted_to_goal_id = ?, leaf_kind = 'none', plan_state = 'none', plan = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(newGoalId, nodeId);
  insertEvent(goalId, nodeId, act, 'node_promoted', `Promoted to goal #${newGoalId}: ${node.title}`, { new_goal_id: newGoalId });

  // 5) reset old goal's focus if it pointed into the moved subtree
  const oldFocus = getFocusRaw(goalId);
  if (oldFocus.node_id != null && descendantIds.includes(oldFocus.node_id)) {
    sqliteDb.prepare(`UPDATE goal_focus SET node_id = NULL, set_by = 'system', updated_at = datetime('now') WHERE goal_id = ?`).run(goalId);
    insertEvent(goalId, null, 'system', 'focus_set', 'Focus cleared (was inside promoted subtree).');
    sseBus.emit('sse', { type: 'goal_focus', goal_id: goalId, focus: toFocusRow(goalId, getFocusRaw(goalId)) } satisfies GoalFocusEvent);
  }

  const newGoalRow = getGoalRowStmt.get(newGoalId) as GoalRow;
  emitGoal('created', newGoalId);
  const stubFresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', stubFresh);
  for (const id of descendantIds) {
    emitNode('updated', getRawNodeStmt.get(id) as GoalNodeDbRow);
  }

  const seedText = composeGoalSeed(newGoalRow);
  return {
    goal: toGoalSummary(newGoalRow),
    node: deriveSingleNode(stubFresh),
    thread: { external_id: externalId, created: true, seed_text: seedText },
  };
}

// -- §6 per-turn focus injection (agent.ts, cockpit:goal-* threads only) --

function nodeMarker(n: GoalNodeDbRow): string {
  if (n.state === 'ghost') return `ghost b:${(n.proposal_batch ?? '').slice(0, 4)}`;
  if (n.pending_removal) return 'set ✂pending';
  if (n.pending_title != null || n.pending_done_means != null) return 'set ✎pending';
  if (n.state === 'set') {
    if (n.leaf_kind === 'human') return 'human';
    if (n.leaf_kind === 'machine') return n.plan_state === 'proposed' ? 'machine plan?' : 'machine';
    return 'set';
  }
  if (n.state === 'planned') return 'planned';
  if (n.state === 'working') return `working 🌳 ${n.tree_id ?? '?'}${n.tree_status_cache === 'blocked' ? ' ⚠blocked' : ''}`;
  if (n.state === 'check') return n.leaf_kind === 'human' ? 'human check' : 'check';
  if (n.state === 'done') return 'done ✓';
  if (n.state === 'parked') return 'parked';
  return n.state;
}

function pendingLabel(n: GoalNodeDbRow): string {
  if (n.pending_removal) return 'removal';
  if (n.pending_title != null || n.pending_done_means != null) return 'edit';
  return 'none';
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** CONTRACT §6 — injected once per turn for `cockpit:goal-<id>` threads only.
 *  '' for every other thread. Never stored in the transcript; regenerated
 *  fresh from the DB every turn (no caching). */
export function buildGoalThreadContext(externalId: string): string {
  try {
    const m = /^cockpit:goal-(\d+)$/.exec(externalId);
    if (!m) return '';
    const goalId = Number(m[1]);
    const goal = getGoalRowStmt.get(goalId) as GoalRow | undefined;
    if (!goal) return '';

    const counts = computeCounts(goalId);
    const focusRaw = getFocusRaw(goalId);
    const focusNode = focusRaw.node_id != null ? (getRawNodeStmt.get(focusRaw.node_id) as GoalNodeDbRow | undefined) : undefined;
    const focusPath = focusRaw.node_id != null ? pathForNode(focusRaw.node_id) : null;
    const focusPathStr = focusPath ? escapeAttr(focusPath.slice(1).join(' › ')) : '';
    const focusLine = `<goal_focus goal_id="${goalId}" node_id="${focusRaw.node_id ?? ''}" path="${focusPathStr}" state="${focusNode?.state ?? ''}" leaf_kind="${focusNode?.leaf_kind ?? ''}" pending="${focusNode ? pendingLabel(focusNode) : 'none'}"/>`;

    const allNodes = listRawNodesForGoal(goalId, false); // discarded never appear
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    const byParent = new Map<number | null, GoalNodeDbRow[]>();
    for (const n of allNodes) {
      const key = n.parent_id;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(n);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

    const ancestorIds = new Set<number>();
    if (focusNode) {
      let cur = focusNode.parent_id != null ? byId.get(focusNode.parent_id) : undefined;
      while (cur) {
        ancestorIds.add(cur.id);
        cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
      }
    }

    function countDescendants(id: number): number {
      let total = 0;
      for (const c of byParent.get(id) ?? []) total += 1 + countDescendants(c.id);
      return total;
    }

    const lines: string[] = [];
    function walk(parentId: number | null, depth: number): void {
      for (const n of byParent.get(parentId) ?? []) {
        const indent = '  '.repeat(depth);
        const isFocused = focusNode ? n.id === focusNode.id : false;
        const marker = nodeMarker(n) + (isFocused ? ' ▶' : '');
        const stub = n.promoted_to_goal_id ? ` → goal #${n.promoted_to_goal_id}` : '';
        const doneMeans = n.done_means ? n.done_means : '(no done_means yet)';
        const children = byParent.get(n.id) ?? [];
        const showChildren = children.length > 0
          && (focusNode ? (n.id === focusNode.id || ancestorIds.has(n.id)) : depth === 0);
        const hidden = children.length && !showChildren ? countDescendants(n.id) : 0;
        const collapsed = hidden > 0 ? ` (+${hidden})` : '';
        lines.push(`${indent}- [${marker}] #${n.id} ${n.title}${stub} — done: ${doneMeans}${collapsed}`);
        if (showChildren) walk(n.id, depth + 1);
      }
    }
    walk(null, 0);

    let body = lines;
    if (body.length > 60) {
      body = body.slice(0, 59).concat([`… (+${lines.length - 59} more)`]);
    }

    const header = `# ${goal.title} — done: ${goal.done_means ?? '(not set yet)'}`;
    const treeBlock = `<goal_tree goal_id="${goalId}" status="${goal.status}" progress="${counts.progress}" working="${counts.working}" need_you="${counts.need_you}">\n${header}\n${body.join('\n')}\n</goal_tree>`;
    return `${focusLine}\n${treeBlock}\n`;
  } catch {
    return '';
  }
}
