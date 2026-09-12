import './hopper-engine.js'; // side-effect: hopper_trees/hopper_nodes DDL + column migrations
import './spawn-tasks.js'; // side-effect: spawn_tasks DDL + hopper_tree_id/hopper_node_id columns
import { sqliteDb } from './conversation-db.js';
import {
  getHopperTree,
  type HopperTreeRow,
  type HopperNodeRow,
  type HopperNodeStatus,
} from './hopper-engine.js';
import type { SpawnTaskRow } from './spawn-tasks.js';

// SPAWN-TREE MISSION CONTROL — the aggregate view over hopper_trees/hopper_nodes
// (durable work-tree state) + spawn_tasks (execution attempts). Everything below
// the exported build* functions is a PURE FUNCTION over injected rows so it
// unit-tests without the live DB — see docs/SPAWN-MONITOR-CONTRACT.md.

// ---------------------------------------------------------------------------
// One-time startup backfill — older spawn_tasks rows predate the hopper_tree_id/
// hopper_node_id stamp columns. Parse the node id out of the well-known
// `cockpit:hopper-node-<id>-<hex>` ext pattern and resolve its tree, once, so
// grouping doesn't depend on live pattern-parsing for pre-existing rows.
// ---------------------------------------------------------------------------
function backfillHopperStamps(): void {
  const rows = sqliteDb
    .prepare<[], { id: number; thread_ext: string }>(
      `SELECT id, thread_ext FROM spawn_tasks WHERE hopper_node_id IS NULL AND thread_ext LIKE 'cockpit:hopper-node-%'`,
    )
    .all();
  if (!rows.length) return;
  const nodeTreeStmt = sqliteDb.prepare<[number], { tree_id: string }>(`SELECT tree_id FROM hopper_nodes WHERE id = ?`);
  const updateStmt = sqliteDb.prepare(`UPDATE spawn_tasks SET hopper_node_id = ?, hopper_tree_id = ? WHERE id = ?`);
  let updated = 0;
  for (const row of rows) {
    const m = row.thread_ext.match(/^cockpit:hopper-node-(\d+)-/);
    if (!m) continue;
    const nodeId = parseInt(m[1], 10);
    const nodeRow = nodeTreeStmt.get(nodeId);
    updateStmt.run(nodeId, nodeRow?.tree_id ?? null, row.id);
    updated++;
  }
  if (updated) console.log(`[spawn-monitor] backfilled hopper stamps on ${updated} spawn_tasks row(s)`);
}
backfillHopperStamps();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnTaskLite {
  thread_ext: string;
  label: string | null;
  status: SpawnTaskRow['status'];
  model: string | null;
  turn_count: number;
  created_at: string;
  updated_at: string;
}

export interface SpawnMonitorNodeCounts {
  total: number;
  done: number;
  running: number;
  pending: number;
  blocked: number;
  blocked_question: number;
  draft: number;
  split: number;
}

export interface SpawnMonitorAttentionEntry {
  node_id: number;
  title: string;
  status: 'blocked' | 'blocked_question';
  question: string | null;
}

export interface SpawnMonitorTreeSummary {
  id: string;
  topic: string;
  status: HopperTreeRow['status'];
  origin_thread_ext: string | null;
  created_at: string;
  updated_at: string;
  counts: SpawnMonitorNodeCounts;
  models: string[];
  running_nodes: Array<{ id: number; title: string; lease_expires_at: string | null }>;
  attention: SpawnMonitorAttentionEntry[];
}

export interface SpawnMonitorCluster {
  key: string;
  kind: 'foundry' | 'single';
  title: string;
  trees: SpawnMonitorTreeSummary[];
}

export interface SpawnMonitorAdhocGroup {
  parent: string | null;
  workers: SpawnTaskLite[];
}

export interface SpawnMonitorSnapshot {
  governor: unknown;
  totals: { active_trees: number; running_workers: number; needs_attention: number };
  clusters: SpawnMonitorCluster[];
  adhoc: SpawnMonitorAdhocGroup[];
}

export interface SpawnMonitorInput {
  trees: HopperTreeRow[];
  nodes: HopperNodeRow[];
  spawnTasks: SpawnTaskRow[];
  governor: unknown;
  includeArchived?: boolean;
}

export interface SpawnMonitorNodeDetail {
  id: number;
  tree_id: string;
  parent_id: number | null;
  title: string;
  spec: string | null;
  status: HopperNodeStatus;
  depends_on: number[];
  priority: number;
  attempts: number;
  question: string | null;
  answer: string | null;
  result: string | null;
  worker_thread_ext: string | null;
  lease_expires_at: string | null;
  adapter: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  spawns: SpawnTaskLite[];
}

export interface SpawnMonitorTreeDetail {
  tree: HopperTreeRow;
  nodes: SpawnMonitorNodeDetail[];
}

// ---------------------------------------------------------------------------
// Attempt <-> node matching — the bulletproof grouping. Prefers the stamped
// columns, falls back to the ext pattern, then to worker_thread_ext equality.
// Anything left over is a genuine ad-hoc (non-hopper) worker.
// ---------------------------------------------------------------------------

const NODE_EXT_PATTERN = /^cockpit:hopper-node-(\d+)-/;

export interface SpawnMatchResult {
  byNode: Map<number, SpawnTaskRow[]>; // node id -> attempts, oldest first
  unmatched: SpawnTaskRow[];
}

export function matchSpawnTasksToNodes(spawnTasks: SpawnTaskRow[], nodes: HopperNodeRow[]): SpawnMatchResult {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const workerExtToNodeId = new Map<string, number>();
  for (const n of nodes) {
    if (n.worker_thread_ext) workerExtToNodeId.set(n.worker_thread_ext, n.id);
  }

  const byNode = new Map<number, SpawnTaskRow[]>();
  const unmatched: SpawnTaskRow[] = [];

  for (const s of spawnTasks) {
    let nodeId: number | null = null;
    if (s.hopper_node_id != null && nodeIds.has(s.hopper_node_id)) {
      nodeId = s.hopper_node_id;
    }
    if (nodeId == null) {
      const m = s.thread_ext.match(NODE_EXT_PATTERN);
      if (m) {
        const parsed = parseInt(m[1], 10);
        if (nodeIds.has(parsed)) nodeId = parsed;
      }
    }
    if (nodeId == null) {
      const viaExt = workerExtToNodeId.get(s.thread_ext);
      if (viaExt != null) nodeId = viaExt;
    }
    if (nodeId != null) {
      if (!byNode.has(nodeId)) byNode.set(nodeId, []);
      byNode.get(nodeId)!.push(s);
    } else {
      unmatched.push(s);
    }
  }

  for (const arr of byNode.values()) {
    arr.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  }
  return { byNode, unmatched };
}

function toSpawnTaskLite(s: SpawnTaskRow): SpawnTaskLite {
  return {
    thread_ext: s.thread_ext,
    label: s.label,
    status: s.status,
    model: s.model,
    turn_count: s.turn_count,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Overview aggregation
// ---------------------------------------------------------------------------

const FOUNDRY_TREE_RE = /^foundry:([^/]+)\/(.+)$/;

function nodeCounts(nodes: HopperNodeRow[]): SpawnMonitorNodeCounts {
  const counts: SpawnMonitorNodeCounts = {
    total: nodes.length,
    done: 0,
    running: 0,
    pending: 0,
    blocked: 0,
    blocked_question: 0,
    draft: 0,
    split: 0,
  };
  for (const n of nodes) {
    switch (n.status) {
      case 'done': counts.done++; break;
      case 'running': counts.running++; break;
      case 'pending': counts.pending++; break;
      case 'blocked': counts.blocked++; break;
      case 'blocked_question': counts.blocked_question++; break;
      case 'draft': counts.draft++; break;
      case 'split': counts.split++; break;
      default: break;
    }
  }
  return counts;
}

function distinctModels(nodes: HopperNodeRow[]): string[] {
  const set = new Set<string>();
  for (const n of nodes) {
    if (n.adapter || n.model) set.add(`${n.adapter ?? 'claude'}/${n.model ?? 'default'}`);
  }
  return Array.from(set).sort();
}

function summarizeTree(tree: HopperTreeRow, treeNodes: HopperNodeRow[]): SpawnMonitorTreeSummary {
  return {
    id: tree.id,
    topic: tree.topic,
    status: tree.status,
    origin_thread_ext: tree.origin_thread_ext,
    created_at: tree.created_at,
    updated_at: tree.updated_at,
    counts: nodeCounts(treeNodes),
    models: distinctModels(treeNodes),
    running_nodes: treeNodes
      .filter((n) => n.status === 'running')
      .map((n) => ({ id: n.id, title: n.title, lease_expires_at: n.lease_expires_at })),
    attention: treeNodes
      .filter((n): n is HopperNodeRow & { status: 'blocked' | 'blocked_question' } =>
        n.status === 'blocked' || n.status === 'blocked_question',
      )
      .map((n) => ({ node_id: n.id, title: n.title, status: n.status, question: n.question })),
  };
}

/** attention < active < draft < done < archived — lower sorts first. */
function treeTier(s: SpawnMonitorTreeSummary): number {
  if (s.attention.length > 0) return 0;
  if (s.status === 'active') return 1;
  if (s.status === 'draft') return 2;
  if (s.status === 'done') return 3;
  return 4; // archived
}

function buildAdhoc(unmatched: SpawnTaskRow[]): SpawnMonitorAdhocGroup[] {
  const groups = new Map<string, SpawnTaskRow[]>();
  const NO_PARENT = ' __no_parent__';
  for (const s of unmatched) {
    const key = s.parent_thread_ext ?? NO_PARENT;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const result: SpawnMonitorAdhocGroup[] = [];
  for (const [key, rows] of groups) {
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id); // newest first
    result.push({ parent: key === NO_PARENT ? null : key, workers: rows.map(toSpawnTaskLite) });
  }
  result.sort((a, b) => (b.workers[0]?.created_at ?? '').localeCompare(a.workers[0]?.created_at ?? ''));
  return result;
}

/**
 * The overview payload — one call paints the /spawn-tree page. Pure function
 * over injected rows (see docs/SPAWN-MONITOR-CONTRACT.md §1b); routes are thin
 * wrappers that fetch the rows and hand them here.
 */
export function buildSpawnMonitorSnapshot(input: SpawnMonitorInput): SpawnMonitorSnapshot {
  const includeArchived = input.includeArchived ?? false;
  const visibleTrees = input.trees.filter((t) => includeArchived || t.status !== 'archived');
  const visibleTreeIds = new Set(visibleTrees.map((t) => t.id));
  const nodesByTree = new Map<string, HopperNodeRow[]>();
  for (const n of input.nodes) {
    if (!nodesByTree.has(n.tree_id)) nodesByTree.set(n.tree_id, []);
    nodesByTree.get(n.tree_id)!.push(n);
  }

  const clusterMap = new Map<string, { kind: 'foundry' | 'single'; title: string; trees: HopperTreeRow[] }>();
  for (const t of visibleTrees) {
    const m = t.topic.match(FOUNDRY_TREE_RE);
    if (m) {
      const key = `foundry:${m[1]}`;
      if (!clusterMap.has(key)) clusterMap.set(key, { kind: 'foundry', title: m[1], trees: [] });
      clusterMap.get(key)!.trees.push(t);
    } else {
      clusterMap.set(t.id, { kind: 'single', title: t.topic, trees: [t] });
    }
  }

  const clusters: SpawnMonitorCluster[] = [];
  for (const [key, group] of clusterMap) {
    const summaries = group.trees
      .map((t) => summarizeTree(t, nodesByTree.get(t.id) ?? []))
      .sort((a, b) => treeTier(a) - treeTier(b) || a.id.localeCompare(b.id));
    clusters.push({ key, kind: group.kind, title: group.title, trees: summaries });
  }
  clusters.sort((a, b) => {
    const tierA = Math.min(...a.trees.map(treeTier));
    const tierB = Math.min(...b.trees.map(treeTier));
    if (tierA !== tierB) return tierA - tierB;
    const recentA = a.trees.reduce((m, t) => (t.updated_at > m ? t.updated_at : m), '');
    const recentB = b.trees.reduce((m, t) => (t.updated_at > m ? t.updated_at : m), '');
    return recentB.localeCompare(recentA);
  });

  const visibleNodes = input.nodes.filter((n) => visibleTreeIds.has(n.tree_id));
  const totals = {
    active_trees: visibleTrees.filter((t) => t.status === 'active').length,
    running_workers: visibleNodes.filter((n) => n.status === 'running').length,
    needs_attention: visibleNodes.filter((n) => n.status === 'blocked' || n.status === 'blocked_question').length,
  };

  // Match against ALL nodes (not just visible-tree ones) so an attempt tied to
  // an archived tree's node is never mistaken for a genuine ad-hoc worker.
  const { unmatched } = matchSpawnTasksToNodes(input.spawnTasks, input.nodes);
  const adhoc = buildAdhoc(unmatched);

  return { governor: input.governor, totals, clusters, adhoc };
}

// ---------------------------------------------------------------------------
// Drill-in aggregation
// ---------------------------------------------------------------------------

function parseDependsOn(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

/** Tree + full nodes array, each carrying its complete attempt history. */
export function buildSpawnMonitorTreeDetail(
  tree: HopperTreeRow,
  nodes: HopperNodeRow[],
  spawnTasks: SpawnTaskRow[],
): SpawnMonitorTreeDetail {
  const { byNode } = matchSpawnTasksToNodes(spawnTasks, nodes);
  const detailNodes: SpawnMonitorNodeDetail[] = nodes.map((n) => ({
    id: n.id,
    tree_id: n.tree_id,
    parent_id: n.parent_id,
    title: n.title,
    spec: n.spec,
    status: n.status,
    depends_on: parseDependsOn(n.depends_on),
    priority: n.priority,
    attempts: n.attempts,
    question: n.question,
    answer: n.answer,
    result: n.result,
    worker_thread_ext: n.worker_thread_ext,
    lease_expires_at: n.lease_expires_at,
    adapter: n.adapter,
    model: n.model,
    created_at: n.created_at,
    updated_at: n.updated_at,
    spawns: (byNode.get(n.id) ?? []).map(toSpawnTaskLite),
  }));
  return { tree, nodes: detailNodes };
}

// ---------------------------------------------------------------------------
// Actions — archive/unarchive. Retry itself just wraps the existing
// retryHopperNode export (see the route in api-v1.ts); these two are new.
// ---------------------------------------------------------------------------

export type SpawnMonitorActionResult =
  | { ok: true; tree: HopperTreeRow }
  | { ok: false; code: 404 | 409; message: string };

/** Archive a settled tree so it drops out of the default overview. Active trees
 *  must finish or have their blocked nodes handled first — archiving is for
 *  cleanup, not for hiding something still running. */
export function archiveHopperTreeAction(id: string): SpawnMonitorActionResult {
  const tree = getHopperTree(id);
  if (!tree) return { ok: false, code: 404, message: 'hopper tree not found' };
  if (tree.status === 'active') {
    return { ok: false, code: 409, message: 'tree is active — let it finish or resolve its blocked nodes before archiving' };
  }
  if (tree.status === 'archived') return { ok: true, tree };
  sqliteDb.prepare(`UPDATE hopper_trees SET status = 'archived', updated_at = datetime('now') WHERE id = ?`).run(id);
  return { ok: true, tree: getHopperTree(id)! };
}

/** Restore an archived tree to `done` (its post-run resting state either way). */
export function unarchiveHopperTreeAction(id: string): SpawnMonitorActionResult {
  const tree = getHopperTree(id);
  if (!tree) return { ok: false, code: 404, message: 'hopper tree not found' };
  if (tree.status !== 'archived') return { ok: false, code: 409, message: `tree is ${tree.status}, not archived` };
  sqliteDb.prepare(`UPDATE hopper_trees SET status = 'done', updated_at = datetime('now') WHERE id = ?`).run(id);
  return { ok: true, tree: getHopperTree(id)! };
}
