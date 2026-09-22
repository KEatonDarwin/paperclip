// GOALS v0.6 — COMMAND DECK board payload (tree-d22bdf40, node #604).
// See skills/goals/CONTRACT.md §17 (binding) — this file implements
// `GET /api/v1/goals/board`'s payload exactly.
//
// Zero new tables: every field is sourced from the existing `goals` /
// `goal_nodes` / `goal_guards` / `goal_events` stores (goals.ts §1). This is
// polled by the cockpit every ~8s, so every query here is a single prepared
// statement across ALL goals at once — never per-goal N+1.

import { sqliteDb } from './conversation-db.js';
import { listGoals, type GoalSummary, type GoalNodeState, type LeafKind, type ReviewState } from './goals.js';

// ---------------------------------------------------------------------------
// Types (CONTRACT §17)
// ---------------------------------------------------------------------------

/** The reduced state of a node's ghost/review/pending machinery, for the
 *  mini-map rail. `null` = a plain, settled node (nothing waiting on anyone). */
export type GoalsBoardNodeFlag = 'ghost' | 'awaiting_you' | 'awaiting_jarvis' | 'pending_edit' | null;

export interface GoalsBoardMapNode {
  id: number;
  goal_id: number;
  parent_id: number | null;
  title: string;
  state: GoalNodeState;
  leaf_kind: LeafKind;
  flag: GoalsBoardNodeFlag;
  has_chat: boolean;
  sort_order: number;
}

export type GoalsBoardAttentionKind =
  | 'ghost_awaiting_you'
  | 'need_you'
  | 'human_open'
  | 'guard_failing'
  | 'autopilot_parked'
  | 'goal_check';

export interface GoalsBoardAttentionItem {
  kind: GoalsBoardAttentionKind;
  goal_id: number;
  goal_title: string;
  node_id: number | null;
  node_title: string | null;
  since: string;
}

export interface GoalsBoardInFlightItem {
  goal_id: number;
  goal_title: string;
  node_id: number;
  node_title: string;
  tree_id: string | null;
  since: string;
}

export interface GoalsBoardResponse {
  goals: GoalSummary[];
  map: GoalsBoardMapNode[];
  attention: GoalsBoardAttentionItem[];
  in_flight: GoalsBoardInFlightItem[];
}

// ---------------------------------------------------------------------------
// Prepared statements — module scope, one query per shape, all goals at once.
// ---------------------------------------------------------------------------

const MAX_TITLE_LEN = 60;
function truncateTitle(title: string): string {
  return title.length > MAX_TITLE_LEN ? `${title.slice(0, MAX_TITLE_LEN - 1)}…` : title;
}

interface MapRawRow {
  id: number;
  parent_id: number | null;
  title: string;
  state: GoalNodeState;
  leaf_kind: LeafKind;
  review_state: ReviewState;
  pending_title: string | null;
  pending_done_means: string | null;
  pending_removal: 0 | 1;
  pending_parent_id: number | null;
  thread_ext: string | null;
  sort_order: number;
}

/** All non-discarded nodes of every non-archived goal, in tree-index order
 *  (matches idx_goal_nodes_goal so this is a covered index scan, not a table
 *  scan + sort). Grouped by goal_id in JS (map(goal_id -> node[])). */
const mapNodesStmt = sqliteDb.prepare(`
  SELECT gn.id, gn.parent_id, gn.title, gn.state, gn.leaf_kind, gn.review_state,
         gn.pending_title, gn.pending_done_means, gn.pending_removal, gn.pending_parent_id,
         gn.thread_ext, gn.sort_order, gn.goal_id
  FROM goal_nodes gn
  JOIN goals g ON g.id = gn.goal_id
  WHERE g.archived = 0 AND gn.state != 'discarded'
  ORDER BY gn.goal_id ASC, gn.parent_id ASC, gn.sort_order ASC, gn.id ASC
`);

/** §17.3(a) ghost_awaiting_you — a plain ghost, or a JARVIS-proposed pending
 *  edit/removal/move on a set node, that is NOT currently awaiting JARVIS. */
const attentionGhostAwaitingYouStmt = sqliteDb.prepare(`
  SELECT gn.id AS node_id, gn.goal_id, gn.title AS node_title, g.title AS goal_title, gn.updated_at AS since
  FROM goal_nodes gn
  JOIN goals g ON g.id = gn.goal_id
  WHERE g.archived = 0 AND gn.state != 'discarded' AND gn.review_state != 'awaiting_jarvis'
    AND (
      gn.state = 'ghost'
      OR gn.pending_title IS NOT NULL OR gn.pending_done_means IS NOT NULL
      OR gn.pending_removal = 1 OR gn.pending_parent_id IS NOT NULL
    )
`);

/** §17.3(b) need_you — a working leaf whose linked hopper tree is blocked
 *  (blocked or blocked_question outcome; both collapse to tree_status_cache
 *  ='blocked', see goals.ts goalsOnTreeStatus). */
const attentionNeedYouStmt = sqliteDb.prepare(`
  SELECT gn.id AS node_id, gn.goal_id, gn.title AS node_title, g.title AS goal_title, gn.updated_at AS since
  FROM goal_nodes gn
  JOIN goals g ON g.id = gn.goal_id
  WHERE g.archived = 0 AND gn.state = 'working' AND gn.tree_status_cache = 'blocked'
`);

/** §17.3(c) human_open — an open human leaf (mirrors GoalCounts.human_open). */
const attentionHumanOpenStmt = sqliteDb.prepare(`
  SELECT gn.id AS node_id, gn.goal_id, gn.title AS node_title, g.title AS goal_title, gn.updated_at AS since
  FROM goal_nodes gn
  JOIN goals g ON g.id = gn.goal_id
  WHERE g.archived = 0 AND gn.leaf_kind = 'human' AND gn.state = 'set'
`);

/** §17.3(d) guard_failing — a set guard currently failing/erroring. `node_id`/
 *  `node_title` are NULL for a goal-level guard (no node_id on the guard row). */
const attentionGuardFailingStmt = sqliteDb.prepare(`
  SELECT gg.node_id AS node_id, gg.goal_id, gn.title AS node_title, g.title AS goal_title,
         COALESCE(gg.last_checked_at, gg.updated_at) AS since
  FROM goal_guards gg
  JOIN goals g ON g.id = gg.goal_id
  LEFT JOIN goal_nodes gn ON gn.id = gg.node_id
  WHERE g.archived = 0 AND gg.state = 'set' AND gg.health IN ('failing', 'error')
`);

/** §17.3(e) autopilot_parked — a node currently parked whose MOST RECENT
 *  'autopilot_parked' event (goals.ts parkGoalNode, fired only when an
 *  autopilot goal is parked by a non-kevin actor) is still the latest word on
 *  it — i.e. it hasn't been unparked and re-parked by Kevin since. */
const attentionAutopilotParkedStmt = sqliteDb.prepare(`
  SELECT gn.id AS node_id, gn.goal_id, gn.title AS node_title, g.title AS goal_title, ge.created_at AS since
  FROM goal_nodes gn
  JOIN goals g ON g.id = gn.goal_id
  JOIN goal_events ge ON ge.node_id = gn.id AND ge.kind = 'autopilot_parked'
    AND ge.id = (SELECT MAX(ge2.id) FROM goal_events ge2 WHERE ge2.node_id = gn.id AND ge2.kind = 'autopilot_parked')
  WHERE g.archived = 0 AND gn.state = 'parked'
`);

/** §17.3(f) goal_check (node) — a node sitting in `check`, awaiting verify. */
const attentionNodeCheckStmt = sqliteDb.prepare(`
  SELECT gn.id AS node_id, gn.goal_id, gn.title AS node_title, g.title AS goal_title, gn.updated_at AS since
  FROM goal_nodes gn
  JOIN goals g ON g.id = gn.goal_id
  WHERE g.archived = 0 AND gn.state = 'check'
`);

/** §17.3(g) in_flight — every currently-working leaf across all goals. A
 *  working node always carries its dispatching tree_id (goals.ts approvePlan
 *  sets state='working' and tree_id together), so this alone is "the running
 *  hopper tree linked to a goal node" — no separate hopper_trees join needed. */
const inFlightStmt = sqliteDb.prepare(`
  SELECT gn.id AS node_id, gn.goal_id, gn.title AS node_title, g.title AS goal_title, gn.tree_id AS tree_id, gn.updated_at AS since
  FROM goal_nodes gn
  JOIN goals g ON g.id = gn.goal_id
  WHERE g.archived = 0 AND gn.state = 'working'
  ORDER BY gn.updated_at ASC
`);

// ---------------------------------------------------------------------------
// Flag reduction (map) — §17.2
// ---------------------------------------------------------------------------

function reduceFlag(row: MapRawRow): GoalsBoardNodeFlag {
  const hasPending =
    row.pending_title !== null || row.pending_done_means !== null || row.pending_removal === 1 || row.pending_parent_id !== null;
  if (row.state === 'ghost') {
    return row.review_state === 'awaiting_jarvis' ? 'awaiting_jarvis' : 'ghost';
  }
  if (hasPending) return 'pending_edit';
  if (row.review_state === 'awaiting_jarvis') return 'awaiting_jarvis';
  if (row.review_state === 'pushed_back') return 'awaiting_you';
  return null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface AttentionRawRow {
  node_id: number | null;
  goal_id: number;
  node_title: string | null;
  goal_title: string;
  since: string;
}

function toAttentionItems(kind: GoalsBoardAttentionKind, rows: AttentionRawRow[]): GoalsBoardAttentionItem[] {
  return rows.map((r) => ({
    kind,
    goal_id: r.goal_id,
    goal_title: r.goal_title,
    node_id: r.node_id,
    node_title: r.node_title,
    since: r.since,
  }));
}

export function buildGoalsBoard(): GoalsBoardResponse {
  // §17.1 — same enriched shape GET /goals returns, includeDone=true (a done
  // goal still belongs on the board; the forest just renders it collapsed).
  const goals = listGoals(true, false);
  const goalTitleById = new Map<number, string>(goals.map((g) => [g.id, g.title]));

  // §17.2 — map: flat node list, one row per node, tagged with its goal_id so
  // the client can group by goal (the mini-map renders one subtree per goal).
  const rawMapRows = mapNodesStmt.all() as Array<MapRawRow & { goal_id: number }>;
  const map: GoalsBoardMapNode[] = rawMapRows.map((r) => ({
    id: r.id,
    goal_id: r.goal_id,
    parent_id: r.parent_id,
    title: truncateTitle(r.title),
    state: r.state,
    leaf_kind: r.leaf_kind,
    flag: reduceFlag(r),
    has_chat: r.thread_ext !== null,
    sort_order: r.sort_order,
  }));

  // §17.3 — attention: union of six kinds, sorted oldest-first across all of them.
  const attention: GoalsBoardAttentionItem[] = [
    ...toAttentionItems('ghost_awaiting_you', attentionGhostAwaitingYouStmt.all() as AttentionRawRow[]),
    ...toAttentionItems('need_you', attentionNeedYouStmt.all() as AttentionRawRow[]),
    ...toAttentionItems('human_open', attentionHumanOpenStmt.all() as AttentionRawRow[]),
    ...toAttentionItems('guard_failing', attentionGuardFailingStmt.all() as AttentionRawRow[]),
    ...toAttentionItems('autopilot_parked', attentionAutopilotParkedStmt.all() as AttentionRawRow[]),
    ...toAttentionItems('goal_check', attentionNodeCheckStmt.all() as AttentionRawRow[]),
  ];
  // §17.3(h) goal_check (goal root) — derived from the already-computed
  // `goals` summaries (counts), not a new query: status='set' and every
  // non-parked/non-discarded node is done (the exact precondition verifyGoal
  // enforces). GoalCounts doesn't expose the internal `denom` (total minus
  // parked, see goals.ts computeCounts) — total - parked recomputes it here.
  for (const g of goals) {
    const denom = g.counts.total - g.counts.parked;
    if (g.status === 'set' && denom > 0 && g.counts.done === denom) {
      attention.push({ kind: 'goal_check', goal_id: g.id, goal_title: g.title, node_id: null, node_title: null, since: g.updated_at });
    }
  }
  attention.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));

  // §17.4 — in_flight.
  const rawInFlight = inFlightStmt.all() as Array<{ node_id: number; goal_id: number; node_title: string; tree_id: string | null; since: string }>;
  const in_flight: GoalsBoardInFlightItem[] = rawInFlight.map((r) => ({
    goal_id: r.goal_id,
    goal_title: goalTitleById.get(r.goal_id) ?? '',
    node_id: r.node_id,
    node_title: r.node_title,
    tree_id: r.tree_id,
    since: r.since,
  }));

  return { goals, map, attention, in_flight };
}
