import { randomUUID } from 'node:crypto';
import './spawn-tasks.js'; // side-effect: guarantees the spawn_tasks DDL ran before we prepare against it
import { sqliteDb, getOrCreateConversation, renameConversation, setThreadModelOverride, getSetting } from './conversation-db.js';
import { sseBus, type HopperNodeEvent } from './sse-bus.js';
import { createNotification } from './notifications.js';
import { governorCheck, governorStatus, kevinActive, providerFor, concurrencyCap, type GovernorProvider, type GovernorVerdict } from './hopper-governor.js';
// ⚡ THROTTLE — Kevin's dials (skills/throttle/CONTRACT.md). Every one is read
// uncached, so a change lands on the NEXT tick with no restart.
import {
  hopperSlots,
  enforceAdmissionFloor,
  throttleCapsForTick,
  throttleRerouteFor,
  rerouteAuditLine,
  notifyReroute,
  setThrottlePausedTreesProvider,
} from './throttle.js';

// HOPPER ENGINE — the autonomous work-tree executor (designed 2026-09-06 with
// Kevin; worker-model details hashed out in cockpit:worker-engine-design-2026-09-06).
//
// Two-table architecture, deliberately:
//   • hopper_trees / hopper_nodes  = the durable WORK TREE (server-owned state)
//   • spawn_tasks                  = execution ATTEMPTS against a node
// One node → zero-or-many worker runs. "Server owns state, model owns story."
//
// Dispatch is EVENT-DRIVEN PLAIN CODE — dispatchTick() runs after every node
// state write plus a slow safety interval. Zero model calls at rest; seconds
// (not heartbeat-minutes) between a node finishing and its dependents starting.
// Workers are EPHEMERAL cockpit threads: born with one leaf + injected context,
// they report back through the finish endpoint and die. The queue IS the inbox.
//
// Recovery is lease-based and non-destructive (same rules as the watchdog):
// an expired lease re-queues the node, max MAX_ATTEMPTS ever, then it parks
// `blocked` with a notification — never a silent stall, never a hot retry loop.

export type HopperNodeStatus =
  | 'draft'            // authored during the breakdown/confirm loop; never dispatches
  | 'pending'          // agreed + waiting for deps/slot
  | 'running'          // claimed by a worker under lease
  | 'done'
  | 'split'            // worker decomposed it into children (terminal for this node)
  | 'blocked'          // recovery exhausted or worker hit a wall — needs a human
  | 'blocked_question'; // worker needs ONE answer from Kevin; resumes on /answer

export interface HopperTreeRow {
  id: string;
  topic: string;
  origin_thread_ext: string | null;
  status: 'draft' | 'active' | 'done' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface HopperNodeRow {
  id: number;
  tree_id: string;
  parent_id: number | null;
  title: string;
  spec: string | null;
  status: HopperNodeStatus;
  depends_on: string | null;      // JSON array of sibling/other node ids
  priority: number;
  attempts: number;
  question: string | null;
  answer: string | null;
  result: string | null;
  worker_thread_ext: string | null;
  lease_expires_at: string | null;
  adapter: string | null;
  model: string | null;
  foundry_auto_retries: number;
  /** ⚡ THROTTLE §5.2: audit trail for a cross-provider reroute; null normally. */
  throttle_reroute: string | null;
  created_at: string;
  updated_at: string;
}

// TOTAL WORKER SLOTS — live-settable (Kevin, 2026-09-24: "I need a way to
// manually control this so I can turn it way up when I need to"). Was a
// module-load env constant, which meant the one dial he most wanted to turn
// required a service restart. Settings-KV wins over env; uncached, so a change
// lands on the very next tick.
// Delegates to throttle.ts so there is exactly ONE implementation of the dial
// (the throttle API, the admission floor and dispatch must never disagree about
// how many slots there are).
function maxSlots(): number {
  return hopperSlots();
}
const LEASE_MINUTES = Math.max(5, parseInt(process.env.HOPPER_ENGINE_LEASE_MIN ?? '30', 10) || 30);
const MAX_ATTEMPTS = 2;
// Default worker loadout when a node has no planner-assigned model. Settings-KV
// key wins over env so it's changeable live (no restart); unset both = inherit
// the global model — which is exactly the "workers on Fable" trap, so keep one.
const WORKER_ADAPTER = process.env.HOPPER_WORKER_ADAPTER ?? 'claude';
function defaultWorkerModel(): string | null {
  return getSetting('hopper_worker_model')?.trim() || process.env.HOPPER_WORKER_MODEL || null;
}

// Retry escalation ladder: a node that burned an attempt retries one tier UP.
// This is the misroute safety net that makes routing down aggressively cheap.
const MODEL_LADDER = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5'];
function escalateModel(model: string | null): string | null {
  const current = model ?? defaultWorkerModel();
  if (!current) return null;
  const i = MODEL_LADDER.indexOf(current);
  return i >= 0 && i < MODEL_LADDER.length - 1 ? MODEL_LADDER[i + 1] : current;
}

// Cross-provider retry ladder (governor-v2, ported from hopper/provider-daytime):
// a Claude node keeps riding the tier ladder above; a non-Claude node instead
// HOPS PROVIDER on retry, since a provider-specific failure (rate limit, a
// broken CLI auth) is unlikely to un-happen on the same pool a few minutes
// later. Each candidate is governor-checked before being chosen so a capped
// Auggie pool never receives a Codex retry (or vice versa).
interface WorkerLoadout {
  adapter: string | null;
  model: string | null;
}
interface RetryRoute extends WorkerLoadout {
  note: string;
}
const CLAUDE_FALLBACK: WorkerLoadout = { adapter: 'claude', model: 'claude-sonnet-5' };
const CROSS_PROVIDER_RETRY_LADDER: Partial<Record<GovernorProvider, WorkerLoadout[]>> = {
  auggie: [
    { adapter: 'codex', model: 'gpt-5.5' },
    CLAUDE_FALLBACK,
  ],
  codex: [
    // auggie's model ids come from its own CLI catalog (`auggie model list`,
    // ids like 'opus4.8'), not the claude adapter's 'claude-*' ids. 'default'
    // is a no-op model flag (buildArgs skips --model for it), so the retry
    // lands on auggie's own configured default instead of guessing a catalog
    // id that can also drift over time.
    { adapter: 'auggie', model: 'default' },
    CLAUDE_FALLBACK,
  ],
  devin: [CLAUDE_FALLBACK],
};

function loadoutLabel(loadout: WorkerLoadout): string {
  return `${loadout.adapter ?? WORKER_ADAPTER}/${loadout.model ?? defaultWorkerModel() ?? 'default'}`;
}

/** Lease-expiry retry routing: Claude bumps a tier, non-Claude hops provider. */
function retryRouteFor(node: HopperNodeRow): RetryRoute {
  const current: WorkerLoadout = { adapter: node.adapter ?? WORKER_ADAPTER, model: node.model ?? defaultWorkerModel() };
  const provider = providerFor(current.adapter);
  if (provider === 'claude') {
    const bumped = escalateModel(node.model);
    return {
      adapter: node.adapter,
      model: bumped,
      note: `claude tier retry: ${loadoutLabel(current)} -> ${loadoutLabel({ adapter: node.adapter ?? WORKER_ADAPTER, model: bumped })}`,
    };
  }
  const ladder = CROSS_PROVIDER_RETRY_LADDER[provider] ?? [CLAUDE_FALLBACK];
  const chosen =
    ladder.find((candidate) => providerFor(candidate.adapter) !== provider && governorStatus(candidate.adapter).allow) ??
    ladder[ladder.length - 1];
  return { ...chosen, note: `cross-provider retry: ${loadoutLabel(current)} -> ${loadoutLabel(chosen)}` };
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS hopper_trees (
    id                TEXT PRIMARY KEY,
    topic             TEXT NOT NULL,
    origin_thread_ext TEXT,
    status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','done','archived')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hopper_nodes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    tree_id          TEXT NOT NULL REFERENCES hopper_trees(id),
    parent_id        INTEGER REFERENCES hopper_nodes(id),
    title            TEXT NOT NULL,
    spec             TEXT,
    status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','pending','running','done','split','blocked','blocked_question')),
    depends_on       TEXT,
    priority         INTEGER NOT NULL DEFAULT 0,
    attempts         INTEGER NOT NULL DEFAULT 0,
    question         TEXT,
    answer           TEXT,
    result           TEXT,
    worker_thread_ext TEXT,
    lease_expires_at TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_hopper_nodes_tree ON hopper_nodes(tree_id, id);
  CREATE INDEX IF NOT EXISTS idx_hopper_nodes_status ON hopper_nodes(status, priority DESC, id);
`);

// ROUTER (phase 1, 2026-09-07): per-node model/adapter chosen by the PLANNER at
// decomposition time — the tree-breakdown conversation IS the router brain, so
// there's no separate scoring service. Additive columns; null = default loadout.
// ⚡ THROTTLE §5.2: `throttle_reroute` makes a cross-provider rewrite auditable —
// spawn_tasks records `model` but no `adapter`, so without this a reroute would
// be invisible. jarvis.db is JARVIS's own local SQLite, not a Darwin production
// database, so the eggshell rule does not apply; this is the same additive
// ALTER TABLE pattern every trailing column in this schema used.
for (const col of ['adapter TEXT', 'model TEXT', 'foundry_auto_retries INTEGER NOT NULL DEFAULT 0', 'throttle_reroute TEXT']) {
  try {
    sqliteDb.exec(`ALTER TABLE hopper_nodes ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

const getTreeStmt = sqliteDb.prepare<[string], HopperTreeRow>(`SELECT * FROM hopper_trees WHERE id = ?`);
const listTreesStmt = sqliteDb.prepare<[], HopperTreeRow>(`SELECT * FROM hopper_trees ORDER BY created_at DESC LIMIT 100`);
const listAllTreesStmt = sqliteDb.prepare<[], HopperTreeRow>(`SELECT * FROM hopper_trees ORDER BY created_at DESC`);
const getNodeStmt = sqliteDb.prepare<[number], HopperNodeRow>(`SELECT * FROM hopper_nodes WHERE id = ?`);
const treeNodesStmt = sqliteDb.prepare<[string], HopperNodeRow>(`SELECT * FROM hopper_nodes WHERE tree_id = ? ORDER BY id`);
const childrenStmt = sqliteDb.prepare<[number], HopperNodeRow>(`SELECT * FROM hopper_nodes WHERE parent_id = ? ORDER BY id`);
const runningCountStmt = sqliteDb.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM hopper_nodes WHERE status = 'running'`);
const runningAdaptersStmt = sqliteDb.prepare<[], { adapter: string | null }>(
  `SELECT adapter FROM hopper_nodes WHERE status = 'running'`,
);
const historyByModelStmt = sqliteDb.prepare<[], {
  model: string;
  done: number;
  blocked: number;
  split: number;
  avg_attempts: number;
}>(`
  SELECT
    COALESCE(model, 'default') AS model,
    SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
    SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
    SUM(CASE WHEN status = 'split' THEN 1 ELSE 0 END) AS split,
    AVG(attempts) AS avg_attempts
  FROM hopper_nodes
  WHERE status IN ('done', 'blocked', 'split')
  GROUP BY COALESCE(model, 'default')
  ORDER BY (done + blocked + split) DESC
`);
const historyRecentStmt = sqliteDb.prepare<[], {
  id: number;
  tree_id: string;
  title: string;
  model: string | null;
  attempts: number;
  status: HopperNodeStatus;
  updated_at: string;
}>(`
  SELECT id, tree_id, title, model, attempts, status, updated_at
  FROM hopper_nodes
  WHERE status IN ('done', 'blocked', 'split')
  ORDER BY updated_at DESC
  LIMIT 30
`);

// A node is DISPATCHABLE only if it's a pending LEAF (no children) in an active
// tree — parents are containers that auto-complete off their children.
const readyLeavesStmt = sqliteDb.prepare<[], HopperNodeRow>(`
  SELECT n.* FROM hopper_nodes n
  JOIN hopper_trees t ON t.id = n.tree_id AND t.status = 'active'
  WHERE n.status = 'pending'
    AND NOT EXISTS (SELECT 1 FROM hopper_nodes c WHERE c.parent_id = n.id)
  ORDER BY n.priority DESC, n.id ASC
`);

const claimStmt = sqliteDb.prepare<[string, string, number]>(`
  UPDATE hopper_nodes
  SET status = 'running', attempts = attempts + 1, worker_thread_ext = ?,
      lease_expires_at = datetime('now', ?), updated_at = datetime('now')
  WHERE id = ? AND status = 'pending'
`);

const expiredLeasesStmt = sqliteDb.prepare<[], HopperNodeRow>(`
  SELECT * FROM hopper_nodes WHERE status = 'running' AND lease_expires_at < datetime('now')
`);

function emitNode(action: HopperNodeEvent['action'], node: HopperNodeRow): void {
  sseBus.emit('sse', { type: 'hopper_node', action, node } satisfies HopperNodeEvent);
}

function isFoundryTree(tree: HopperTreeRow | null | undefined): boolean {
  return !!tree && tree.topic.startsWith('foundry:');
}

// GOALS integration (CONTRACT.md §7) — a goal machine-leaf node can link a
// hopper tree via tree_id. Rather than importing goals.ts here (which would
// create an import cycle, since goals.ts imports createHopperTree/etc from
// this file), goals.ts registers a listener at module load. No-op when no
// listener is registered (e.g. goals.ts never loaded) or no goal node
// references the tree — callers must be defensive either way.
type TreeStatusListener = (treeId: string, status: 'done' | 'blocked' | 'active') => void;
const treeStatusListeners: TreeStatusListener[] = [];
export function registerTreeStatusListener(fn: TreeStatusListener): void {
  treeStatusListeners.push(fn);
}
// NIGHT SHIFT (CONTRACT §4.4, decision §12.16) — while a night run is PAUSED,
// nothing new starts anywhere in the run: dispatchTick skips pending nodes of
// the run's trees. night-shift.ts registers the provider at module init; a
// setter (not an import) so the engine never imports night-shift.ts back.
type PausedTreesProvider = () => ReadonlySet<string>;
let pausedTreesProvider: PausedTreesProvider | null = null;
export function setNightShiftPausedTreesProvider(fn: PausedTreesProvider | null): void {
  pausedTreesProvider = fn;
}
const NO_PAUSED_TREES: ReadonlySet<string> = new Set<string>();
// The throttle's status endpoint needs the same set to report a `night_paused`
// hold. Handing it the accessor (rather than having throttle.ts import this
// module) keeps the dependency edge one-directional.
setThrottlePausedTreesProvider(() => pausedTreeIds());
function pausedTreeIds(): ReadonlySet<string> {
  if (!pausedTreesProvider) return NO_PAUSED_TREES;
  try {
    return pausedTreesProvider();
  } catch (err) {
    console.error('[hopper-engine] night-shift paused-tree provider failed', err);
    return NO_PAUSED_TREES;
  }
}

function notifyTreeStatusListeners(treeId: string, status: 'done' | 'blocked' | 'active'): void {
  for (const fn of treeStatusListeners) {
    try {
      fn(treeId, status);
    } catch (err) {
      console.error('[hopper-engine] tree status listener failed', err);
    }
  }
}

/** True if `treeId` has no node left in blocked/blocked_question. Used to
 *  decide whether clearing one blocked node returns the tree to 'active'. */
function treeHasNoBlockedNodes(treeId: string): boolean {
  return !listTreeNodes(treeId).some((n) => n.status === 'blocked' || n.status === 'blocked_question');
}

function setNode(id: number, fields: Partial<Record<keyof HopperNodeRow, unknown>>): HopperNodeRow | null {
  const keys = Object.keys(fields);
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    sqliteDb
      .prepare(`UPDATE hopper_nodes SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k]), id);
  }
  const row = getNodeStmt.get(id) ?? null;
  if (row) emitNode('updated', row);
  return row;
}

export function getHopperTree(id: string): HopperTreeRow | null {
  return getTreeStmt.get(id) ?? null;
}
export function listHopperTrees(): HopperTreeRow[] {
  return listTreesStmt.all();
}
/** Unbounded — Mission Control's contract is "every tree," not the most-recent
 *  100 `listHopperTrees()` caps at for its existing (unrelated) callers. */
export function listAllHopperTrees(): HopperTreeRow[] {
  return listAllTreesStmt.all();
}
export function getHopperNode(id: number): HopperNodeRow | null {
  return getNodeStmt.get(id) ?? null;
}
export function listTreeNodes(treeId: string): HopperNodeRow[] {
  return treeNodesStmt.all(treeId);
}

export function updateHopperNodeSpec(id: number, spec: string): HopperNodeRow | null {
  return setNode(id, { spec });
}

/** Foundry auto-decision retry prep. This intentionally does not emit while the
 *  node is still blocked; retryHopperNode emits the re-pended state after the
 *  amendment is in place, which keeps the first auto-resolution quiet.
 *
 *  The claim is an atomic compare-and-swap on the DB row (status must still be
 *  blocked/blocked_question AND foundry_auto_retries must still be 0) rather
 *  than trusting the caller's (possibly stale/replayed) in-memory node
 *  snapshot — a duplicated hopper_node SSE event carrying an earlier
 *  foundry_auto_retries value must not be able to win a second claim. Returns
 *  null if this call did not win the claim (already retried, or the node
 *  moved on before this ran). */
export function prepareFoundryAutoRetry(
  id: number,
  amendedSpec: string,
  adapter: string,
  model: string,
): HopperNodeRow | null {
  const info = sqliteDb.prepare(`
    UPDATE hopper_nodes
    SET spec = ?,
        adapter = ?,
        model = ?,
        foundry_auto_retries = foundry_auto_retries + 1,
        updated_at = datetime('now')
    WHERE id = ?
      AND status IN ('blocked', 'blocked_question')
      AND COALESCE(foundry_auto_retries, 0) = 0
  `).run(amendedSpec, adapter, model, id);
  if (info.changes !== 1) return null;
  return getNodeStmt.get(id) ?? null;
}

export interface HopperHistoryByModel {
  model: string;
  done: number;
  blocked: number;
  split: number;
  avg_attempts: number;
}

export interface HopperHistoryRecentNode {
  id: number;
  tree_id: string;
  title: string;
  model: string;
  attempts: number;
  status: HopperNodeStatus;
  updated_at: string;
}

export interface HopperHistory {
  by_model: HopperHistoryByModel[];
  recent: HopperHistoryRecentNode[];
}

/**
 * DECISION MEMORY — the planner reads this before decomposing a new tree to
 * route models based on real outcomes, not guesswork. Only settled nodes
 * (done/blocked/split) count; running/pending/draft/blocked_question are
 * still in flight and would skew the averages.
 */
export function getHopperHistory(): HopperHistory {
  const by_model = historyByModelStmt.all().map((r) => ({
    ...r,
    avg_attempts: Math.round(r.avg_attempts * 100) / 100,
  }));
  const recent = historyRecentStmt.all().map((r) => ({
    ...r,
    model: r.model ?? 'default',
  }));
  return { by_model, recent };
}

export interface NewNodeInput {
  title: string;
  spec?: string | null;
  parent_index?: number | null;      // reserved for a future explicit nested-tree API mode
  depends_on_indexes?: number[];     // indexes into the same input array
  priority?: number;
  adapter?: string | null;           // router: planner-assigned worker loadout
  model?: string | null;             // null → hopper_worker_model setting/env default
}

/** Create a tree + its draft nodes in one shot (the breakdown chat calls this). */
export function createHopperTree(topic: string, originThreadExt: string | null, nodes: NewNodeInput[]): {
  tree: HopperTreeRow;
  nodes: HopperNodeRow[];
} {
  const treeId = `tree-${randomUUID().slice(0, 8)}`;
  sqliteDb
    .prepare(`INSERT INTO hopper_trees (id, topic, origin_thread_ext) VALUES (?, ?, ?)`)
    .run(treeId, topic.slice(0, 300), originThreadExt);
  const ids: number[] = [];
  const insert = sqliteDb.prepare(
    `INSERT INTO hopper_nodes (tree_id, parent_id, title, spec, priority, adapter, model) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const n of nodes) {
    if (n.parent_index != null) {
      console.warn(
        `[hopper-engine] createHopperTree ignored parent_index=${n.parent_index} for "${n.title.slice(0, 80)}"; use depends_on_indexes for planner DAG ordering`,
      );
    }
    const info = insert.run(
      treeId, null, n.title.slice(0, 300), n.spec ?? null, n.priority ?? 0, n.adapter ?? null, n.model ?? null,
    );
    ids.push(Number(info.lastInsertRowid));
  }
  // Second pass: map depends_on indexes → real ids (forward refs allowed).
  const setDeps = sqliteDb.prepare(`UPDATE hopper_nodes SET depends_on = ? WHERE id = ?`);
  nodes.forEach((n, i) => {
    const deps = (n.depends_on_indexes ?? []).filter((d) => d >= 0 && d < ids.length && d !== i).map((d) => ids[d]);
    if (deps.length) setDeps.run(JSON.stringify(deps), ids[i]);
  });
  const created = listTreeNodes(treeId);
  created.forEach((n) => emitNode('created', n));
  return { tree: getHopperTree(treeId)!, nodes: created };
}

function sanitizeInitialDagParentIds(treeId: string): number {
  const nodes = listTreeNodes(treeId);
  if (!nodes.some((n) => n.parent_id != null)) return 0;
  // Split parents are the one legitimate current use of parent_id: the children
  // created by outcome='split' must stay nested so ancestor bubbling still works.
  if (nodes.some((n) => n.status === 'split')) return 0;
  if (!nodes.some((n) => n.status === 'draft' || n.status === 'pending')) return 0;
  const info = sqliteDb
    .prepare(`UPDATE hopper_nodes SET parent_id = NULL, updated_at = datetime('now') WHERE tree_id = ? AND parent_id IS NOT NULL`)
    .run(treeId);
  if (info.changes) {
    console.warn(`[hopper-engine] sanitized ${info.changes} stale parent_id value(s) on initial DAG tree ${treeId}`);
  }
  return Number(info.changes ?? 0);
}

/** Kevin's "yep that looks good" — flips the whole tree live and starts dispatch. */
export function agreeHopperTree(treeId: string): HopperTreeRow | null {
  const tree = getHopperTree(treeId);
  if (!tree) return null;
  sanitizeInitialDagParentIds(treeId);
  sqliteDb.prepare(`UPDATE hopper_trees SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(treeId);
  sqliteDb
    .prepare(`UPDATE hopper_nodes SET status = 'pending', updated_at = datetime('now') WHERE tree_id = ? AND status = 'draft'`)
    .run(treeId);
  listTreeNodes(treeId).forEach((n) => emitNode('updated', n));
  // The tree is live again. Listeners need this transition: tree-cue re-arms its
  // one-cue-per-(tree,status) guard here, so a tree that already finished and was
  // re-agreed for a repair / continuation run still cues its origin thread when
  // it finishes the SECOND time (goals' listener no-ops unless it was blocked).
  notifyTreeStatusListeners(treeId, 'active');
  queueMicrotask(() => void dispatchTick('tree_agreed'));
  return getHopperTree(treeId);
}

function depsSatisfied(node: HopperNodeRow): boolean {
  if (!node.depends_on) return true;
  try {
    const deps = JSON.parse(node.depends_on) as number[];
    return deps.every((d) => {
      const dep = getNodeStmt.get(d);
      // 'split' is terminal for the parent but its children are still working;
      // settleAncestors flips the parent to 'done' once every child settles, so
      // only 'done' releases a dependent (foundry review #3/#4).
      return !dep || dep.status === 'done';
    });
  } catch {
    return true;
  }
}

function depResults(node: HopperNodeRow): Array<{ title: string; result: string }> {
  if (!node.depends_on) return [];
  try {
    const deps = JSON.parse(node.depends_on) as number[];
    return deps
      .map((d) => getNodeStmt.get(d))
      .filter((d): d is HopperNodeRow => !!d && !!d.result)
      .map((d) => ({ title: d.title, result: d.result! }));
  } catch {
    return [];
  }
}

/** The one prompt a worker is born with: guardrails + the leaf + the finish contract. */
function composeWorkerPrompt(node: HopperNodeRow, tree: HopperTreeRow): string {
  const deps = depResults(node);
  const lines: string[] = [
    `You are a SPAWNED HOPPER-ENGINE WORKER — an ephemeral JARVIS instance born to complete ONE task, report the result, and stop. You are not a conversation; nobody will reply to your messages. Kevin sees your work through the tree, not this thread.`,
    '',
    `**Project (tree ${tree.id}):** ${tree.topic}`,
    `**Your task (node #${node.id}):** ${node.title}`,
  ];
  if (node.spec) lines.push('', '**Spec:**', node.spec);
  if (node.answer) lines.push('', `**Kevin answered a previous blocking question on this task:**`, `Q: ${node.question ?? '(see spec)'}`, `A: ${node.answer}`);
  if (deps.length) {
    lines.push('', '**Results from tasks this one depends on:**');
    for (const d of deps) lines.push(`- ${d.title}: ${d.result.slice(0, 1500)}`);
  }
  lines.push(
    '',
    '**Guardrails (hard):** no touching live production systems/databases, no merging to main, no external sends (Slack/email/PRs) under Kevin\'s identity, no new spend, and NO API KEYS for model calls — subscription CLI binaries only.',
    '',
    '**FINISH CONTRACT — mandatory.** Your final act MUST be exactly one curl to the hopper engine (bearer key = JARVIS_COCKPIT_KEY in /home/kevin/paperclip/jarvis-command-center/.env). Ending your turn without calling it counts as a failed attempt.',
    '```',
    `KEY=$(grep -E '^JARVIS_COCKPIT_KEY=' /home/kevin/paperclip/jarvis-command-center/.env | head -1 | cut -d= -f2)`,
    `curl -s -X POST http://localhost:3201/api/v1/hopper-nodes/${node.id}/finish -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '<PAYLOAD>'`,
    '```',
    'If the finish curl fails, retry the same exact curl up to three times with a few seconds between attempts. If it still fails, print the exact JSON payload as your final assistant message so the reconciler can recover it. Never invent a successful finish: either the POST succeeds or the payload is visible for recovery.',
    '',
    'Pick ONE payload:',
    `- Task complete → {"outcome":"done","result":"<what you did + artifacts/paths/commits, concise but complete — dependents read this>"}`,
    `- Task too big for one worker → {"outcome":"split","children":[{"title":"...","spec":"...","depends_on_prev":false}, ...]} — make NO changes yourself; you exited as a planner. Set depends_on_prev true on a child that must wait for the one before it.`,
    `- You need ONE decision only Kevin can make → {"outcome":"blocked_question","question":"<the single question, with enough context to answer cold>"} — then stop; a fresh worker resumes with his answer.`,
    `- Genuinely stuck (missing access, broken dependency) → {"outcome":"blocked","result":"<why, precisely>"}`,
    '',
    'Work efficiently, verify what you build, and do not gold-plate. Begin now.',
  );
  return lines.join('\n');
}

let processMessageRef: ((input: string, conversationId: string, messageId?: string) => Promise<string>) | null = null;

/** index.ts hands us processMessage at startup — avoids a circular import with agent.ts. */
export function startHopperEngine(processMessage: (input: string, conversationId: string, messageId?: string) => Promise<string>): void {
  processMessageRef = processMessage;
  setInterval(() => void dispatchTick('interval'), 60_000).unref?.();
  queueMicrotask(() => void dispatchTick('startup'));
  console.log(`[hopper-engine] started · slots=${maxSlots()} lease=${LEASE_MINUTES}m maxAttempts=${MAX_ATTEMPTS}`);
}

const spawnTaskInsert = sqliteDb.prepare(`
  INSERT OR IGNORE INTO spawn_tasks (thread_ext, conversation_id, parent_thread_ext, label, task_prompt, status, hopper_tree_id, hopper_node_id)
  VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
`);

// Marks the EXPIRED attempt's spawn_tasks row with why it's being rerouted —
// informational history only; the node's own row is what actually re-dispatches.
const spawnTaskMarkRerouted = sqliteDb.prepare<[string, string]>(`
  UPDATE spawn_tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE thread_ext = ?
`);

async function spawnWorker(node: HopperNodeRow, tree: HopperTreeRow): Promise<void> {
  if (!processMessageRef) return;
  const ext = node.worker_thread_ext!;
  const conv = getOrCreateConversation(ext);
  renameConversation(conv.id, `⚙️ ${node.title.slice(0, 100)}`);
  // Router: node's planner-assigned loadout wins; else the default worker model.
  const model = node.model ?? defaultWorkerModel();
  if (model) setThreadModelOverride(conv.id, node.adapter ?? WORKER_ADAPTER, model);
  const prompt = composeWorkerPrompt(node, tree);
  // Stamp hopper_tree_id/hopper_node_id at spawn time — the bulletproof grouping
  // key for spawn-monitor, so a retried node's attempts don't rely solely on
  // parsing the ext pattern (see src/spawn-monitor.ts).
  spawnTaskInsert.run(ext, conv.id, tree.origin_thread_ext, `hopper #${node.id}: ${node.title.slice(0, 80)}`, prompt.slice(0, 2000), tree.id, node.id);
  try {
    await processMessageRef(prompt, ext, `turn:${conv.id}:0`);
  } catch (err) {
    // Spawn itself failed (busy/adapter error) — release the claim so the node
    // re-dispatches rather than burning its lease doing nothing.
    console.error(`[hopper-engine] spawn failed for node ${node.id}:`, err);
    setNode(node.id, { status: 'pending', worker_thread_ext: null, lease_expires_at: null });
  }
}

/** Bubble completion up the tree: a parent with all children settled flips done. */
function settleAncestors(node: HopperNodeRow): void {
  if (node.parent_id == null) {
    maybeFinishTree(node.tree_id);
    return;
  }
  const parent = getNodeStmt.get(node.parent_id);
  if (!parent || parent.status === 'done') return;
  const kids = childrenStmt.all(parent.id);
  // A 'split' child only counts once ITS children have bubbled it to 'done'.
  const allSettled = kids.every((k) => k.status === 'done');
  if (allSettled) {
    const updated = setNode(parent.id, {
      status: 'done',
      result: kids.map((k) => `[${k.title}] ${k.result ?? '(split into subtasks)'}`).join('\n').slice(0, 8000),
    });
    if (updated) settleAncestors(updated);
  } else {
    maybeFinishTree(node.tree_id);
  }
}

function maybeFinishTree(treeId: string): void {
  const tree = getHopperTree(treeId);
  if (!tree || tree.status !== 'active') return;
  const nodes = listTreeNodes(treeId);
  if (nodes.length && nodes.every((n) => n.status === 'done' || n.status === 'split')) {
    sqliteDb.prepare(`UPDATE hopper_trees SET status = 'done', updated_at = datetime('now') WHERE id = ?`).run(treeId);
    createNotification({
      severity: 'success',
      title: `🌳 Hopper tree complete: ${tree.topic.slice(0, 120)}`,
      body: `All ${nodes.length} tasks are done. Tree ${treeId}.`,
      source: 'hopper-engine',
    });
    notifyTreeStatusListeners(treeId, 'done');
  }
}

/** Worker report-back — the ONE place execution writes tree state. */
export function finishHopperNode(
  id: number,
  outcome: 'done' | 'split' | 'blocked_question' | 'blocked',
  payload: { result?: string; question?: string; children?: Array<{ title: string; spec?: string; depends_on_prev?: boolean }> },
): HopperNodeRow | null {
  const node = getNodeStmt.get(id);
  if (!node || node.status !== 'running') return node ?? null;
  const tree = getHopperTree(node.tree_id);

  if (outcome === 'done') {
    const updated = setNode(id, { status: 'done', result: payload.result ?? '(no result text)', lease_expires_at: null });
    if (updated) settleAncestors(updated);
  } else if (outcome === 'split' && payload.children?.length) {
    const insert = sqliteDb.prepare(
      `INSERT INTO hopper_nodes (tree_id, parent_id, title, spec, status, depends_on, adapter, model)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    );
    let prevId: number | null = null;
    for (const c of payload.children.slice(0, 12)) {
      const deps = c.depends_on_prev && prevId != null ? JSON.stringify([prevId]) : null;
      const info = insert.run(node.tree_id, node.id, c.title.slice(0, 300), c.spec ?? null, deps, node.adapter, node.model);
      prevId = Number(info.lastInsertRowid);
      const created = getNodeStmt.get(prevId);
      if (created) emitNode('created', created);
    }
    setNode(id, { status: 'split', lease_expires_at: null });
  } else if (outcome === 'blocked_question') {
    setNode(id, { status: 'blocked_question', question: payload.question ?? '(no question text)', lease_expires_at: null });
    const latest = getNodeStmt.get(id) ?? null;
    if (latest?.status === 'blocked_question' && !isFoundryTree(tree)) {
      createNotification({
        severity: 'warning',
        title: `❓ Hopper worker needs your call: ${node.title.slice(0, 100)}`,
        body: `${payload.question ?? ''}\n\n(Answer from any JARVIS chat: "answer hopper node ${id}: <your answer>" — a fresh worker resumes with it.)`,
        source: 'hopper-engine',
      });
    }
    notifyTreeStatusListeners(node.tree_id, 'blocked');
  } else {
    setNode(id, { status: 'blocked', result: payload.result ?? null, lease_expires_at: null });
    const latest = getNodeStmt.get(id) ?? null;
    if (latest?.status === 'blocked' && !isFoundryTree(tree)) {
      createNotification({
        severity: 'error',
        title: `🚧 Hopper task blocked: ${node.title.slice(0, 100)}`,
        body: `${payload.result ?? 'No reason given.'}\nNode ${id}, tree ${node.tree_id}.`,
        source: 'hopper-engine',
      });
    }
    notifyTreeStatusListeners(node.tree_id, 'blocked');
  }
  queueMicrotask(() => void dispatchTick('node_finished'));
  return getNodeStmt.get(id) ?? null;
}

/** Kevin answers a blocking question → node re-queues with the answer injected. */
export function answerHopperNode(id: number, answer: string): HopperNodeRow | null {
  const node = getNodeStmt.get(id);
  if (!node || node.status !== 'blocked_question') return node ?? null;
  const updated = setNode(id, { status: 'pending', answer, worker_thread_ext: null });
  if (updated && treeHasNoBlockedNodes(updated.tree_id)) notifyTreeStatusListeners(updated.tree_id, 'active');
  queueMicrotask(() => void dispatchTick('question_answered'));
  return updated;
}

/** Foundry retry hook: put a blocked/question node back on the queue cleanly. */
export function retryHopperNode(id: number): HopperNodeRow | null {
  const node = getNodeStmt.get(id);
  if (!node || (node.status !== 'blocked' && node.status !== 'blocked_question')) return node ?? null;
  const updated = setNode(id, {
    status: 'pending',
    attempts: 0,
    question: null,
    answer: null,
    result: null,
    worker_thread_ext: null,
    lease_expires_at: null,
  });
  if (updated && treeHasNoBlockedNodes(updated.tree_id)) notifyTreeStatusListeners(updated.tree_id, 'active');
  queueMicrotask(() => void dispatchTick('node_retry'));
  return updated;
}

let ticking = false;

/** The dispatcher. Plain code, no model calls: requeue expired leases, then fill free slots. */
export async function dispatchTick(reason: string): Promise<void> {
  if (ticking || !processMessageRef) return; // no re-entrancy; engine not started = no-op
  ticking = true;
  try {
    // 1) Expired leases → non-destructive recovery (max MAX_ATTEMPTS, then park).
    for (const node of expiredLeasesStmt.all()) {
      if (node.attempts >= MAX_ATTEMPTS) {
        setNode(node.id, { status: 'blocked', lease_expires_at: null });
        const latest = getNodeStmt.get(node.id) ?? null;
        const tree = getHopperTree(node.tree_id);
        if (latest?.status === 'blocked' && !isFoundryTree(tree)) {
          createNotification({
            severity: 'error',
            title: `🚧 Hopper task exhausted retries: ${node.title.slice(0, 100)}`,
            body: `${node.attempts} attempts, lease expired without a finish report. Node ${node.id}, tree ${node.tree_id}. Needs a human.`,
            source: 'hopper-engine',
          });
        }
        notifyTreeStatusListeners(node.tree_id, 'blocked');
      } else {
        // Retry rides one rung up: Claude keeps its tier ladder; non-Claude
        // hops provider so a provider-specific failure doesn't repeat itself.
        const retry = retryRouteFor(node);
        if (node.worker_thread_ext) {
          spawnTaskMarkRerouted.run(
            `HOPPER_RETRY_REROUTE: node ${node.id} attempt ${node.attempts} lease expired; ${retry.note}; next attempt ${node.attempts + 1}`,
            node.worker_thread_ext,
          );
        }
        console.log(`[hopper-engine] node ${node.id} ${retry.note}`);
        setNode(node.id, {
          status: 'pending',
          worker_thread_ext: null,
          lease_expires_at: null,
          adapter: retry.adapter,
          model: retry.model,
        });
      }
    }

    // 2) Fill free slots with ready leaves (deps satisfied), priority order.
    //    The governor gates every NEW claim per-node by that node's provider so
    //    a maxed Claude window holds claude leaves while auggie/codex leaves in
    //    the same tree still dispatch (lease recovery above always runs; running
    //    workers are never interrupted). Held node = skip it, try the next.
    //
    // ⚡ THROTTLE §2.2 call site 2 (MANDATORY): enforce
    // `max_concurrent_auto_turns >= hopper_slots + 2` once per tick, before
    // `free` is computed. Slots above the admission cap produce workers that
    // CLAIM a node, start its 30-minute lease, then block in
    // acquireAutomatedSlot for up to 10 minutes and give up silently. Doing it
    // here (not only on API writes) is what catches a hand-edited sqlite write,
    // a stale value surviving a restart, or someone lowering admission out from
    // under a running pool — and Kevin turns these dials by hand, which is the
    // entire reason the invariant exists.
    enforceAdmissionFloor();
    let free = maxSlots() - (runningCountStmt.get()?.n ?? 0);
    if (free <= 0) return;
    // While Kevin is active, non-Claude lanes stay open (separate plans) but
    // narrowed by gov_concurrency_cap so the box he's working on isn't hosting
    // a full worker pool behind his back. Claude lanes are governed entirely
    // by governorCheck's kevin_active gate above, not this cap.
    const daytime = kevinActive();
    const cap = daytime ? concurrencyCap() : Infinity;
    let daytimeRunning = daytime
      ? runningAdaptersStmt.all().filter((r) => providerFor(r.adapter ?? WORKER_ADAPTER) !== 'claude').length
      : 0;
    let cappedLogged = false;
    // One governor eval per adapter per tick. Holds the whole VERDICT now (not
    // just `allow`) because the throttle's cross-provider fallback needs the
    // hold REASON to decide whether a reroute is even permitted.
    const verdicts = new Map<string, GovernorVerdict>();
    // NIGHT SHIFT §4.4 — one lookup per tick; an empty set when no run is paused.
    const nightPaused = pausedTreeIds();
    // ⚡ THROTTLE §3 — per-GOAL and per-TREE caps. Built ONCE per tick from the
    // running nodes and then incremented IN-LOOP as nodes are claimed (exactly
    // like daytimeRunning below): building the maps and never updating them
    // would let six ready leaves of one goal all pass a per-goal cap of 2 inside
    // a single tick. Both caps default to 0 = unlimited, in which case
    // `caps.check()` is never consulted and dispatch is identical to before.
    const caps = throttleCapsForTick();
    let capHoldLogged = false;
    for (const node of readyLeavesStmt.all()) {
      if (free <= 0) break;
      if (nightPaused.size && nightPaused.has(node.tree_id)) continue;
      if (!depsSatisfied(node)) continue;
      let adapter = node.adapter ?? WORKER_ADAPTER;
      let verdict = verdicts.get(adapter);
      if (verdict === undefined) {
        verdict = governorCheck(adapter);
        verdicts.set(adapter, verdict);
      }
      if (!verdict.allow) {
        // ⚡ THROTTLE §5 — cross-provider fallback. OFF by default, in which case
        // this is a plain `continue` and no adapter is ever rewritten. When ON,
        // a Claude node held on a CAPACITY reason (never usage_stale — flying
        // blind still holds; never kevin_active — that is "his turn", not "we
        // are out") may be rerouted to the next metered pool with headroom. The
        // rewrite happens on a PENDING node, before claimStmt: a running worker
        // is never re-provisioned (§5.3).
        // §5.1 rule 5 operates on the EFFECTIVE model, not the raw column.
        // A node with `model = null` spawns on defaultWorkerModel() — which is
        // `hopper_worker_model`, and falls back to env HOPPER_WORKER_MODEL
        // (claude-opus-5 on this box). Testing `node.model` raw would see an
        // empty string, skip the frontier refusal, and silently demote an
        // Opus-default review node onto a codex worker tier — exactly the
        // "green review that reviewed nothing" the rule exists to prevent
        // (review node #719).
        const effectiveModel = node.model ?? defaultWorkerModel();
        const outcome = throttleRerouteFor({ adapter: node.adapter, model: effectiveModel }, verdict.reason, (p) => {
          // The provider name IS a valid adapter label (providerFor('codex') ===
          // 'codex'), so the per-adapter verdict cache is reused as-is.
          let v = verdicts.get(p);
          if (v === undefined) {
            v = governorCheck(p);
            verdicts.set(p, v);
          }
          return v.allow;
        });
        if (outcome.kind === 'refused') {
          console.log(
            `[throttle] node ${node.id} reroute_refused: ${outcome.why} (model ${effectiveModel ?? 'default'}) — holding on ${verdict.reason}`,
          );
          continue;
        }
        if (outcome.kind !== 'reroute') continue;
        const line = rerouteAuditLine('claude', outcome.provider, verdict.reason, effectiveModel, outcome.model);
        setNode(node.id, { adapter: outcome.adapter, model: outcome.model, throttle_reroute: line });
        console.log(`[throttle] reroute node ${node.id} ${line}`);
        notifyReroute(node.id, outcome.provider, verdict.reason);
        const rerouted = getNodeStmt.get(node.id);
        if (!rerouted || rerouted.status !== 'pending') continue;
        node.adapter = rerouted.adapter;
        node.model = rerouted.model;
        adapter = outcome.adapter;
      }
      const nonClaude = providerFor(adapter) !== 'claude';
      if (daytime && nonClaude && daytimeRunning >= cap) {
        if (!cappedLogged) {
          console.log(`[hopper-engine] concurrency cap: ${daytimeRunning}/${cap} non-claude workers running while Kevin is active — holding the rest`);
          cappedLogged = true;
        }
        continue;
      }
      // ⚡ THROTTLE §3.4 — the caps sit AFTER the governor/daytime gates on
      // purpose: a governor hold is GLOBAL ("the Claude lane is shut") while a
      // cap is LOCAL to one goal, and reporting "per-goal cap" while the whole
      // subscription is stopped out would send Kevin to the wrong dial.
      // §3.5 — SKIP, never park: status stays `pending`, no attempt consumed, no
      // notification, no lease. A sibling finishing picks it up on a later tick.
      const capHold = caps.check(node.tree_id);
      if (capHold) {
        if (!capHoldLogged) {
          console.log(`[throttle] ${capHold}: ${caps.detail(node.tree_id, capHold)} — holding node ${node.id}`);
          capHoldLogged = true;
        }
        continue;
      }
      const ext = `cockpit:hopper-node-${node.id}-${randomUUID().slice(0, 8)}`;
      const claimed = claimStmt.run(ext, `+${LEASE_MINUTES} minutes`, node.id);
      if (claimed.changes !== 1) continue; // raced — someone else claimed it
      const fresh = getNodeStmt.get(node.id)!;
      emitNode('updated', fresh);
      const tree = getHopperTree(node.tree_id)!;
      free -= 1;
      if (nonClaude) daytimeRunning += 1;
      caps.record(node.tree_id);
      console.log(`[hopper-engine] dispatch node ${node.id} (${reason}) → ${ext}`);
      void spawnWorker(fresh, tree);
    }
  } finally {
    ticking = false;
  }
}
