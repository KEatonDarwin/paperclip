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
import { sqliteDb, getOrCreateConversation, renameConversation } from './conversation-db.js';
import { sseBus, type GoalEvent, type GoalNodeEvent, type GoalFocusEvent } from './sse-bus.js';

// ---------------------------------------------------------------------------
// Types (mirrors CONTRACT.md §1 / §3.0 exactly — additive-only if extended)
// ---------------------------------------------------------------------------

export type GoalStatus = 'ghost' | 'set' | 'done' | 'parked';
export type GoalNodeState = 'ghost' | 'set' | 'planned' | 'working' | 'check' | 'done' | 'parked' | 'discarded';
export type LeafKind = 'none' | 'machine' | 'human';
export type PlanState = 'none' | 'proposed' | 'approved';
export type GoalActor = 'kevin' | 'jarvis' | 'system';
export type NodeAuthor = 'kevin' | 'jarvis';

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
    SUM(CASE WHEN state NOT IN ('discarded','parked') THEN 1 ELSE 0 END) AS denom
  FROM goal_nodes WHERE goal_id = ?
`);

function computeCounts(goalId: number): GoalCounts {
  const row = countsStmt.get(goalId) as {
    total: number | null; done: number | null; working: number | null; check_count: number | null;
    ghost_state: number | null; pending_count: number | null; human_open: number | null;
    plan_proposed: number | null; denom: number | null;
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

  insertEvent(id, null, actor, flipped ? 'goal_set' : 'goal_updated', flipped ? 'Goal set: done_means confirmed.' : 'Goal updated.');
  emitGoal('updated', id);
  return toGoalSummary(getGoalRowStmt.get(id) as GoalRow);
}

export function verifyGoal(id: number, passed: boolean, note?: string, actor?: unknown): { goal: GoalSummary; verified: boolean } {
  const existing = requireGoal(id);
  if (existing.status !== 'set') {
    throw new GoalError(409, 'invalid_transition', `goal is ${existing.status}, not set`, { from: existing.status, to: 'done' });
  }
  const act = assertActor(actor, 'kevin');
  if (!passed) {
    return { goal: toGoalSummary(existing), verified: false };
  }
  const nodes = listRawNodesForGoal(id, true);
  const blocking = nodes.filter((n) => n.state !== 'discarded' && n.state !== 'parked' && n.state !== 'done');
  if (blocking.length) {
    throw new GoalError(409, 'children_not_done', `${blocking.length} node(s) are not done yet`, { node_ids: blocking.map((n) => n.id) });
  }
  sqliteDb.prepare(`UPDATE goals SET status = 'done', verified_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  insertEvent(id, null, act, 'goal_done', note ? `Goal verified done: ${note}` : 'Goal verified done.', { note });
  emitGoal('updated', id);
  return { goal: toGoalSummary(getGoalRowStmt.get(id) as GoalRow), verified: true };
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

export function acceptGoalNode(goalId: number, nodeId: number, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  if (node.state !== 'ghost') {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, not ghost`, { from: node.state, to: 'set' });
  }
  if (!node.done_means?.trim()) throw new GoalError(409, 'done_means_required', 'done_means is required before this node can be set');
  const act = assertActor(actor, 'kevin');
  sqliteDb.prepare(`UPDATE goal_nodes SET state = 'set', proposal_batch = NULL, updated_at = datetime('now') WHERE id = ?`).run(nodeId);
  insertEvent(goalId, nodeId, act, 'node_accepted', `Accepted: ${node.title}`);
  const fresh = getRawNodeStmt.get(nodeId) as GoalNodeDbRow;
  emitNode('updated', fresh);
  return deriveSingleNode(fresh);
}

function acceptRows(goalId: number, rows: GoalNodeDbRow[], actor: GoalActor): GoalNodeRow[] {
  const missing = rows.filter((r) => !r.done_means?.trim());
  if (missing.length) {
    throw new GoalError(409, 'done_means_required', 'some nodes are missing done_means', { node_ids: missing.map((r) => r.id) });
  }
  const out: GoalNodeRow[] = [];
  for (const r of rows) {
    sqliteDb.prepare(`UPDATE goal_nodes SET state = 'set', proposal_batch = NULL, updated_at = datetime('now') WHERE id = ?`).run(r.id);
    insertEvent(goalId, r.id, actor, 'node_accepted', `Accepted: ${r.title}`);
    const fresh = getRawNodeStmt.get(r.id) as GoalNodeDbRow;
    emitNode('updated', fresh);
    out.push(deriveSingleNode(fresh));
  }
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

export function discardGoalNode(goalId: number, nodeId: number, reason?: string, actor?: unknown): GoalNodeRow {
  const node = requireNode(goalId, nodeId);
  if (node.state !== 'ghost') {
    throw new GoalError(409, 'invalid_transition', `node is ${node.state}, not ghost`, { from: node.state, to: 'discarded' });
  }
  const act = assertActor(actor, 'kevin');
  sqliteDb.prepare(`UPDATE goal_nodes SET state = 'discarded', proposal_batch = NULL, updated_at = datetime('now') WHERE id = ?`).run(nodeId);
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
    sqliteDb.prepare(`UPDATE goal_nodes SET state = 'discarded', proposal_batch = NULL, updated_at = datetime('now') WHERE id = ?`).run(r.id);
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
  const notes = patch.notes !== undefined ? (patch.notes.trim() || null) : node.notes;
  const sortOrder = patch.sort_order !== undefined ? patch.sort_order : node.sort_order;

  sqliteDb.prepare(`UPDATE goal_nodes SET title = ?, done_means = ?, notes = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(title, doneMeans, notes, sortOrder, nodeId);
  insertEvent(goalId, nodeId, actor, 'node_updated', `Edited: ${title}`, {
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
  sqliteDb.prepare(`
    UPDATE goal_nodes SET pending_title = ?, pending_done_means = ?, pending_by = 'jarvis', updated_at = datetime('now') WHERE id = ?
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
  sqliteDb.prepare(`UPDATE goal_nodes SET pending_removal = 1, pending_by = 'jarvis', updated_at = datetime('now') WHERE id = ?`).run(nodeId);
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
