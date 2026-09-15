import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './spawn-tasks.js'; // side-effect: guarantees the spawn_tasks DDL ran before we prepare against it
import { sqliteDb, getOrCreateConversation, renameConversation, setThreadModelOverride, getSetting } from './conversation-db.js';
import { sseBus, type HopperNodeEvent } from './sse-bus.js';
import { createNotification } from './notifications.js';
import { governorCheck, governorStatus, kevinActive, providerFor, concurrencyCap, type GovernorProvider } from './hopper-governor.js';

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
  original_ask: string | null;
  deferred_scope: string | null;
  continuation_of: string | null;
  handoff: string | null;
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
  is_finishline: number;
  remediation_of: number | null;
  created_at: string;
  updated_at: string;
}

const MAX_SLOTS = Math.max(1, parseInt(process.env.HOPPER_ENGINE_SLOTS ?? '2', 10) || 2);
const LEASE_MINUTES = Math.max(5, parseInt(process.env.HOPPER_ENGINE_LEASE_MIN ?? '30', 10) || 30);
const MAX_ATTEMPTS = 2;
const FINISHLINE_TITLE = 'FINISH-LINE AUDIT';
const FINISHLINE_DEFAULT_MODEL = 'claude-sonnet-5';
const FINISHLINE_DEFAULT_ADAPTER = 'claude';
const TEXT_FIELD_LIMIT = 20_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

export const UNBLOCKER_MODEL_ALLOWLIST = [
  'claude-opus-5',
  'claude-fable-5',
  'opus4.8',
] as const;
const UNBLOCKER_DEFAULT_MODEL = 'claude-opus-5';
type UnblockerModel = (typeof UNBLOCKER_MODEL_ALLOWLIST)[number];

interface UnblockerLoadout extends WorkerLoadout {
  adapter: 'claude' | 'auggie';
  model: UnblockerModel;
  configuredModel: UnblockerModel;
}

interface HopperUnblockPassRow {
  id: number;
  node_id: number;
  tree_id: string;
  worker_ext: string | null;
  worker_thread_ext: string | null;
  adapter: string;
  model: string;
  status: 'waiting_for_juice' | 'running' | 'done' | 'needs_kevin' | 'failed';
  blocked_result: string | null;
  result: string | null;
  nudge_id: string | null;
  spawned_at: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface AppendHopperNodeInput {
  title: string;
  spec: string;
  depends_on?: number[];
  adapter: string;
  model: string;
}

export interface HopperRemediationResult {
  blocked_node: HopperNodeRow;
  fix_nodes: HopperNodeRow[];
}

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
for (const col of ['original_ask TEXT', 'deferred_scope TEXT', 'continuation_of TEXT', 'handoff TEXT']) {
  try {
    sqliteDb.exec(`ALTER TABLE hopper_trees ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

for (const col of [
  'adapter TEXT',
  'model TEXT',
  'foundry_auto_retries INTEGER NOT NULL DEFAULT 0',
  'is_finishline INTEGER NOT NULL DEFAULT 0',
  // Review #223 finding 1: FIX nodes planted by a Smart Unblocker pass carry
  // the id of the ROOT node whose one-pass fuse they belong to (walked flat
  // at insert time, so FIX-of-FIX still resolves to a single root). A node
  // with this set must never trigger a fresh unblocker spawn of its own.
  'remediation_of INTEGER',
]) {
  try {
    sqliteDb.exec(`ALTER TABLE hopper_nodes ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS hopper_unblock_passes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id           INTEGER NOT NULL UNIQUE,
    tree_id           TEXT NOT NULL,
    worker_ext        TEXT,
    worker_thread_ext TEXT,
    adapter           TEXT NOT NULL,
    model             TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('waiting_for_juice','running','done','needs_kevin','failed')),
    blocked_result    TEXT,
    result            TEXT,
    nudge_id          TEXT,
    spawned_at        TEXT NOT NULL DEFAULT (datetime('now')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_hopper_unblock_passes_tree ON hopper_unblock_passes(tree_id);
`);

for (const col of [
  'tree_id TEXT',
  'worker_ext TEXT',
  'worker_thread_ext TEXT',
  'adapter TEXT',
  'model TEXT',
  'status TEXT',
  'blocked_result TEXT',
  'result TEXT',
  'nudge_id TEXT',
  'spawned_at TEXT',
  'created_at TEXT',
  'updated_at TEXT',
  'finished_at TEXT',
]) {
  try {
    sqliteDb.exec(`ALTER TABLE hopper_unblock_passes ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

const getTreeStmt = sqliteDb.prepare<[string], HopperTreeRow>(`SELECT * FROM hopper_trees WHERE id = ?`);
const listTreesStmt = sqliteDb.prepare<[], HopperTreeRow>(`SELECT * FROM hopper_trees ORDER BY created_at DESC LIMIT 100`);
const listAllTreesStmt = sqliteDb.prepare<[], HopperTreeRow>(`SELECT * FROM hopper_trees ORDER BY created_at DESC`);
const setTreeHandoffStmt = sqliteDb.prepare<[string, string]>(
  `UPDATE hopper_trees SET handoff = ?, updated_at = datetime('now') WHERE id = ?`,
);
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
const insertFinishLineNode = sqliteDb.prepare<[string, string, string, string | null, string, string]>(`
  INSERT INTO hopper_nodes (tree_id, parent_id, title, spec, status, depends_on, priority, adapter, model, is_finishline)
  VALUES (?, NULL, ?, ?, 'pending', ?, 1000, ?, ?, 1)
`);
// Review #184: one open continuation per parent. An audit worker that planted a
// continuation and then lost its lease is retried — without this, the retry
// plants a second sibling continuation doing the same gap work twice.
const openContinuationOfStmt = sqliteDb.prepare<[string], HopperTreeRow>(`
  SELECT * FROM hopper_trees WHERE continuation_of = ? AND status IN ('draft', 'active') ORDER BY created_at ASC LIMIT 1
`);
const getUnblockPassStmt = sqliteDb.prepare<[number], HopperUnblockPassRow>(
  `SELECT * FROM hopper_unblock_passes WHERE node_id = ?`,
);
const insertUnblockPassStmt = sqliteDb.prepare<[number, string, string, string, string, string, string | null]>(`
  INSERT INTO hopper_unblock_passes (node_id, tree_id, worker_ext, worker_thread_ext, adapter, model, status, blocked_result)
  VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
`);
const claimWaitingUnblockPassStmt = sqliteDb.prepare<[string, string, string, string, string | null, number]>(`
  UPDATE hopper_unblock_passes
  SET worker_ext = ?, worker_thread_ext = ?, adapter = ?, model = ?, status = 'running',
      blocked_result = COALESCE(?, blocked_result),
      spawned_at = COALESCE(spawned_at, datetime('now')),
      updated_at = datetime('now')
  WHERE node_id = ? AND worker_ext IS NULL AND status = 'waiting_for_juice'
`);
const markUnblockPassNeedsKevinStmt = sqliteDb.prepare<[string | null, number]>(`
  UPDATE hopper_unblock_passes
  SET status = 'needs_kevin', result = COALESCE(?, result), updated_at = datetime('now')
  WHERE node_id = ?
`);
const setUnblockPassNudgeStmt = sqliteDb.prepare<[string, number]>(`
  UPDATE hopper_unblock_passes SET nudge_id = ?, updated_at = datetime('now') WHERE node_id = ?
`);
// Finding 4: a spawn that never actually started (adapter busy, CLI error) did
// not consume the one pass — reset the marker so the waiting-for-juice sweep
// (finding 5) can retry it, instead of permanently burning the fuse.
const resetUnblockPassToWaitingStmt = sqliteDb.prepare<[string, number]>(`
  UPDATE hopper_unblock_passes
  SET status = 'waiting_for_juice', worker_ext = NULL, worker_thread_ext = NULL,
      result = ?, updated_at = datetime('now')
  WHERE node_id = ?
`);
// Finding 5: gate-fail (juice closed) and finding 3: concurrency-capped both
// park the node here instead of silently doing nothing — `dispatchTick`'s
// sweep is the only producer that makes `claimWaitingUnblockPassStmt` reachable.
const insertWaitingForJuiceStmt = sqliteDb.prepare<[number, string, string, string | null]>(`
  INSERT INTO hopper_unblock_passes (node_id, tree_id, adapter, model, status, blocked_result)
  VALUES (?, ?, 'claude', ?, 'waiting_for_juice', ?)
`);
const updateWaitingForJuiceStmt = sqliteDb.prepare<[string | null, number]>(`
  UPDATE hopper_unblock_passes
  SET blocked_result = COALESCE(?, blocked_result), updated_at = datetime('now')
  WHERE node_id = ? AND status = 'waiting_for_juice' AND worker_ext IS NULL
`);
const runningUnblockPassCountStmt = sqliteDb.prepare<[], { n: number }>(
  `SELECT COUNT(*) AS n FROM hopper_unblock_passes WHERE status = 'running'`,
);
const waitingUnblockPassNodeIdsStmt = sqliteDb.prepare<[], { node_id: number }>(
  `SELECT node_id FROM hopper_unblock_passes WHERE status = 'waiting_for_juice' AND worker_ext IS NULL`,
);

function emitNode(action: HopperNodeEvent['action'], node: HopperNodeRow): void {
  sseBus.emit('sse', { type: 'hopper_node', action, node } satisfies HopperNodeEvent);
}

function isFoundryTree(tree: HopperTreeRow | null | undefined): boolean {
  return !!tree && tree.topic.startsWith('foundry:');
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

export interface CreateHopperTreeOptions {
  originalAsk?: string | null;
  deferredScope?: string | null;
  continuationOf?: string | null;
}

interface FinishLineVerdict {
  finishline_verdict?: unknown;
  summary?: unknown;
  gaps?: unknown;
  continuation_tree_id?: unknown;
  continuation_nodes?: unknown;
}

function boundedText(value: string | null | undefined, limit = TEXT_FIELD_LIMIT): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, limit);
}

const REQUIRED_HANDOFF_HEADINGS = [
  '## What was built',
  '## Branches & how to install',
  '## How to use it',
  '## Next steps / deferred',
  '## Full report',
];
export const FINISHLINE_FULL_MISSING_HANDOFF_RESULT = 'finishline FULL rejected: no handoff on tree';

export type HandoffValidation =
  | { ok: true; handoff: string }
  | { ok: false; message: string };

export function validateHopperTreeHandoff(value: unknown): HandoffValidation {
  if (typeof value !== 'string') {
    return { ok: false, message: 'handoff is required and must be a non-empty markdown string' };
  }
  const handoff = boundedText(value);
  if (!handoff) {
    return { ok: false, message: 'handoff is required and must be a non-empty markdown string' };
  }

  let cursor = -1;
  for (const heading of REQUIRED_HANDOFF_HEADINGS) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const idx = handoff.search(new RegExp(`^${escaped}\\s*$`, 'm'));
    if (idx === -1) return { ok: false, message: `handoff is missing required section: ${heading}` };
    if (idx < cursor) return { ok: false, message: `handoff sections must appear in the required order: ${heading}` };
    cursor = idx;
  }

  if (/\/home\/kevin\//.test(handoff) || /\/tmp\//.test(handoff) || /(^|[\s"'`([:])~\//m.test(handoff)) {
    return { ok: false, message: 'handoff must not include absolute local filesystem paths; use wiki-relative paths instead' };
  }
  return { ok: true, handoff };
}

export function setHopperTreeHandoff(
  treeId: string,
  handoff: string,
  opts: { force?: boolean } = {},
): HopperTreeRow | null {
  const tree = getTreeStmt.get(treeId);
  if (!tree) return null;
  if (tree.handoff?.trim() && !opts.force) return tree;
  const normalized = boundedText(handoff);
  if (!normalized) return tree;
  setTreeHandoffStmt.run(normalized, treeId);
  return getTreeStmt.get(treeId) ?? null;
}

function finishLineAuditModel(): string {
  return getSetting('finishline_audit_model')?.trim() || FINISHLINE_DEFAULT_MODEL;
}

function finishLineAuditAdapter(): string {
  return getSetting('finishline_audit_adapter')?.trim() || FINISHLINE_DEFAULT_ADAPTER;
}

/** The open (draft/active) continuation already planted for a parent tree, if any. */
export function findOpenContinuationOf(parentTreeId: string): HopperTreeRow | null {
  return openContinuationOfStmt.get(parentTreeId) ?? null;
}

/** Root-first chain of ancestor trees this continuation descends from (cycle-safe). */
function continuationAncestors(tree: HopperTreeRow): HopperTreeRow[] {
  const chain: HopperTreeRow[] = [];
  const seen = new Set<string>([tree.id]);
  let cursor = tree.continuation_of ? getTreeStmt.get(tree.continuation_of) ?? null : null;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.continuation_of ? getTreeStmt.get(cursor.continuation_of) ?? null : null;
  }
  return chain;
}

function isFinishLineNode(node: HopperNodeRow): boolean {
  return node.is_finishline === 1 || node.title.startsWith(FINISHLINE_TITLE);
}

function continuationDepth(tree: HopperTreeRow, seen = new Set<string>()): number {
  if (!tree.continuation_of || seen.has(tree.id)) return 0;
  seen.add(tree.id);
  const parent = getTreeStmt.get(tree.continuation_of);
  if (!parent) return 1;
  return 1 + continuationDepth(parent, seen);
}

export function nextContinuationDepth(parentTreeId: string): number | null {
  const parent = getHopperTree(parentTreeId);
  if (!parent) return null;
  return continuationDepth(parent) + 1;
}

function shouldAppendFinishLineAudit(tree: HopperTreeRow, nodes: HopperNodeRow[]): boolean {
  return Boolean(tree.original_ask?.trim())
    && nodes.length > 0
    && nodes.every((n) => n.status === 'done' || n.status === 'split')
    && !nodes.some(isFinishLineNode);
}

function resultExcerpt(result: string | null | undefined, limit = 900): string {
  const text = result?.trim();
  if (!text) return '(no result text)';
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function compactNodeDigest(nodes: HopperNodeRow[]): string {
  return nodes
    .filter((n) => !isFinishLineNode(n))
    .map((n) => {
      const loadout = `${n.adapter ?? WORKER_ADAPTER}/${n.model ?? defaultWorkerModel() ?? 'default'}`;
      return `- #${n.id} ${n.title} [${n.status}, ${loadout}]: ${resultExcerpt(n.result).replace(/\n+/g, ' ')}`;
    })
    .join('\n') || '- (no non-audit nodes recorded)';
}

function intSetting(key: string, fallback: number): number {
  const raw = getSetting(key)?.trim();
  const n = raw != null ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function smartUnblockerEnabled(): boolean {
  return getSetting('unblocker_enabled')?.trim().toLowerCase() !== 'off';
}

function smartUnblockerMax5h(): number {
  return intSetting('unblocker_max_5h', 60);
}

// Finding 3: nothing routed the unblocker through dispatchTick's slot/governor
// loop, so N simultaneous blocks spawned N parallel Opus workers. Default 1 —
// a real incident is almost always the same root cause fanning out across
// every leaf of a module (e.g. the Foundation Gate anti-shim rule tripping on
// every module of a project at once); one pass diagnoses it for all of them
// via the needs_kevin escalation once the fuse is spent.
function unblockerMaxConcurrent(): number {
  return Math.max(1, intSetting('unblocker_max_concurrent', 1));
}

function normalizeUnblockerModel(): UnblockerModel {
  const raw = getSetting('unblocker_model')?.trim();
  return UNBLOCKER_MODEL_ALLOWLIST.includes(raw as UnblockerModel)
    ? (raw as UnblockerModel)
    : UNBLOCKER_DEFAULT_MODEL;
}

function resolveUnblockerLoadout(): UnblockerLoadout {
  const configuredModel = normalizeUnblockerModel();
  if (configuredModel === 'opus4.8') {
    const auggie = governorStatus('auggie');
    if (auggie.allow) {
      return { adapter: 'auggie', model: 'opus4.8', configuredModel };
    }
    return { adapter: 'claude', model: UNBLOCKER_DEFAULT_MODEL, configuredModel };
  }
  return { adapter: 'claude', model: configuredModel, configuredModel };
}

function unblockerGate(): { ok: true; loadout: UnblockerLoadout } | { ok: false; reason: string } {
  if (!smartUnblockerEnabled()) return { ok: false, reason: 'unblocker_enabled=off' };
  if (!processMessageRef) return { ok: false, reason: 'hopper engine has no processMessage hook yet' };

  const claude = governorStatus('claude');
  if (!claude.allow) return { ok: false, reason: `claude governor held: ${claude.reason} (${claude.detail})` };

  const max5h = smartUnblockerMax5h();
  if (typeof claude.five_hour !== 'number' || !Number.isFinite(claude.five_hour)) {
    return { ok: false, reason: 'claude 5h usage is unknown' };
  }
  if (claude.five_hour >= max5h) {
    return { ok: false, reason: `claude 5h ${claude.five_hour}% >= unblocker_max_5h ${max5h}%` };
  }

  const loadout = resolveUnblockerLoadout();
  const selected = governorStatus(loadout.adapter);
  if (!selected.allow) {
    return { ok: false, reason: `${loadout.adapter} governor held: ${selected.reason} (${selected.detail})` };
  }
  return { ok: true, loadout };
}

function interpolateUnblockerPlaybook(node: HopperNodeRow, tree: HopperTreeRow): string {
  const fallback = [
    `You are a Smart Unblocker worker for Hopper node ${node.id} in tree ${tree.id}.`,
    'Your job is to unstick ONE red-blocked node, then stop.',
    '',
    'If the fix is inside JARVIS\'s standing autonomy bar, insert the smallest useful FIX node or nodes into the SAME tree, keep FIX nodes flat with depends_on only, re-pend the original blocked node behind the new FIX node ids, and finish with a concise remediation summary.',
    'If the fix genuinely requires Kevin, do not plant speculative work; finish with the exact decision needed.',
  ].join('\n');
  try {
    const contractPath = path.resolve(__dirname, '..', '..', 'docs', 'hopper', 'UNBLOCKER.md');
    const raw = readFileSync(contractPath, 'utf8');
    const fenceStart = '```md\nYou are a Smart Unblocker worker';
    const start = raw.indexOf(fenceStart);
    if (start === -1) return fallback;
    const bodyStart = raw.indexOf('\n', start);
    const end = raw.indexOf('\n```', bodyStart + 1);
    if (bodyStart === -1 || end === -1) return fallback;
    return raw
      .slice(bodyStart + 1, end)
      .replaceAll('<node_id>', String(node.id))
      .replaceAll('<tree_id>', tree.id);
  } catch {
    return fallback;
  }
}

function compactTreeRows(treeId: string): string {
  return listTreeNodes(treeId)
    .map((n) => `- #${n.id} ${n.title} [${n.status}] deps=${n.depends_on ?? '[]'} worker=${n.worker_thread_ext ?? '(none)'}`)
    .join('\n');
}

function composeSmartUnblockerPrompt(
  node: HopperNodeRow,
  tree: HopperTreeRow,
  loadout: UnblockerLoadout,
  workerExt: string,
): string {
  const playbook = interpolateUnblockerPlaybook(node, tree);
  return [
    'You are a SPAWNED SMART-UNBLOCKER WORKER — an ephemeral high-thought JARVIS instance born to unstick ONE red-blocked Hopper node and stop. Nobody will reply to this thread.',
    '',
    '**Guardrails (hard):** no touching live production systems/databases, no merging to main, no external sends (Slack/email/PRs) under Kevin\'s identity, no new spend, and NO API KEYS for model calls — subscription CLI binaries only. Never restart `jarvis.service`.',
    '',
    `**Unblocker thread:** ${workerExt}`,
    `**Selected loadout:** ${loadout.adapter}/${loadout.model}${loadout.configuredModel !== loadout.model ? ` (configured ${loadout.configuredModel} fell back)` : ''}`,
    '',
    '**Contract Playbook (from docs/hopper/UNBLOCKER.md, ids interpolated):**',
    playbook,
    '',
    '**Current blocked node snapshot:**',
    '```json',
    JSON.stringify(node, null, 2),
    '```',
    '',
    '**Tree context snapshot:**',
    `Tree ${tree.id}: ${tree.topic}`,
    `Origin thread: ${tree.origin_thread_ext ?? '(none recorded)'}`,
    compactTreeRows(tree.id),
    '',
    '**Safe remediation API available to you:**',
    `POST /api/v1/hopper-nodes/${node.id}/remediate`,
    'Body:',
    '```json',
    JSON.stringify({
      nodes: [
        {
          title: 'FIX: <short remediation task>',
          spec: '<self-contained fix spec with done-checks>',
          adapter: 'claude',
          model: 'claude-sonnet-5',
        },
      ],
    }, null, 2),
    '```',
    'This helper inserts flat FIX nodes, extends this blocked node behind the final FIX node, appends the prior blocked result to the spec, and clears runtime fields. Use it instead of writing SQLite by hand.',
    '',
    'When you are done, reply in this thread with only the concise summary of what you planted or the single Kevin decision needed. The spawn-task reconciler tracks this one-shot thread.',
  ].join('\n');
}

const spawnUnblockerTaskInsert = sqliteDb.prepare<
  [string, number, string | null, string, string, string, string, number]
>(`
  INSERT OR IGNORE INTO spawn_tasks
    (thread_ext, conversation_id, parent_thread_ext, label, task_prompt, model, status, hopper_tree_id, hopper_node_id)
  VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
`);

async function spawnSmartUnblockerWorker(
  node: HopperNodeRow,
  tree: HopperTreeRow,
  loadout: UnblockerLoadout,
  workerExt: string,
): Promise<void> {
  if (!processMessageRef) return;
  const conv = getOrCreateConversation(workerExt);
  renameConversation(conv.id, `unblocker #${node.id}: ${node.title.slice(0, 80)}`);
  setThreadModelOverride(conv.id, loadout.adapter, loadout.model);
  const prompt = composeSmartUnblockerPrompt(node, tree, loadout, workerExt);
  spawnUnblockerTaskInsert.run(
    workerExt,
    conv.id,
    tree.origin_thread_ext,
    `unblocker #${node.id}: ${node.title.slice(0, 80)}`,
    prompt.slice(0, 2000),
    loadout.model,
    tree.id,
    node.id,
  );
  try {
    await processMessageRef(prompt, workerExt, `turn:${conv.id}:0`);
  } catch (err) {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[hopper-unblocker] spawn failed for node ${node.id}:`, err);
    // Finding 4: the worker never actually claimed the pass (adapter busy,
    // CLI error) — that is not a used pass. Reset to waiting_for_juice
    // (worker_ext cleared) so the sweep in dispatchTick retries it instead of
    // stranding the node with a permanently burned fuse.
    resetUnblockPassToWaitingStmt.run(detail.slice(0, 4000), node.id);
    createNotification({
      severity: 'error',
      title: `Hopper unblocker failed to start (will retry): ${node.title.slice(0, 100)}`,
      body: `${detail.slice(0, 1200)}\nNode ${node.id}, tree ${node.tree_id}.`,
      source: 'hopper-unblocker',
      link: `/spawn-tree?tree=${encodeURIComponent(tree.id)}&node=${node.id}`,
    });
    queueMicrotask(() => void dispatchTick('unblocker_spawn_failed_retry'));
  }
}

function notifyUnblockerNeedsKevin(node: HopperNodeRow, tree: HopperTreeRow, body: string, passNodeId: number = node.id): void {
  const notification = createNotification({
    severity: 'error',
    source: 'hopper-unblocker',
    title: `Hopper node still needs Kevin: ${node.title.slice(0, 100)}`,
    body,
    link: `/spawn-tree?tree=${encodeURIComponent(tree.id)}&node=${node.id}`,
  });
  setUnblockPassNudgeStmt.run(String(notification.id), passNodeId);
}

/** Finding 5: park a node whose unblocker attempt couldn't run right now (gate
 *  closed / concurrency-capped) so `dispatchTick`'s sweep can pick it back up
 *  the moment capacity/juice reopens, instead of silently no-op'ing forever. */
function recordWaitingForJuice(node: HopperNodeRow, tree: HopperTreeRow, reason: string): void {
  const existing = getUnblockPassStmt.get(node.id) ?? null;
  if (existing) {
    // Any status other than an unclaimed waiting_for_juice marker means the
    // fuse is already spent or a worker is already in flight — never clobber it.
    if (existing.status === 'waiting_for_juice' && !existing.worker_ext) {
      updateWaitingForJuiceStmt.run(node.result ?? reason, node.id);
    }
    return;
  }
  try {
    insertWaitingForJuiceStmt.run(node.id, tree.id, UNBLOCKER_DEFAULT_MODEL, node.result ?? reason);
  } catch {
    /* raced with another writer inserting the marker first — it exists now, fine */
  }
}

function maybeTriggerSmartUnblocker(nodeId: number): void {
  const node = getNodeStmt.get(nodeId);
  if (!node || node.status !== 'blocked') return;
  const tree = getHopperTree(node.tree_id);
  if (!tree || tree.status === 'draft' || tree.status === 'archived') return;

  // Finding 1: a FIX node planted by a prior unblocker pass must never spawn
  // a fresh unblocker of its own — that is the unbounded-recursion cascade.
  // Escalate straight to the root pass's needs_kevin instead.
  if (node.remediation_of) {
    const rootId = node.remediation_of;
    const body = [
      `FIX node #${node.id} (planted to remediate node #${rootId}) blocked again: ${node.result ?? '(no result)'}`,
      '',
      `Smart Unblocker already spent its one pass on node ${rootId}. Kevin needs to decide the next move.`,
    ].join('\n');
    markUnblockPassNeedsKevinStmt.run(body, rootId);
    notifyUnblockerNeedsKevin(node, tree, body, rootId);
    return;
  }

  const existing = getUnblockPassStmt.get(node.id) ?? null;
  if (existing?.worker_ext || existing?.worker_thread_ext) {
    const body = [
      `${node.result ?? 'The node blocked again after a Smart Unblocker pass was already claimed.'}`,
      '',
      `Smart Unblocker already used its one pass for node ${node.id} (${existing.worker_ext ?? existing.worker_thread_ext}). Kevin needs to decide the next move.`,
    ].join('\n');
    markUnblockPassNeedsKevinStmt.run(body, node.id);
    notifyUnblockerNeedsKevin(node, tree, body);
    return;
  }

  const gate = unblockerGate();
  if (!gate.ok) {
    console.log(`[hopper-unblocker] hold node ${node.id}: ${gate.reason}`);
    recordWaitingForJuice(node, tree, gate.reason);
    return;
  }

  // Finding 3: route through a concurrency cap instead of spawning one
  // high-tier worker per simultaneous block — a real incident is usually the
  // same root cause fanning out across many leaves at once.
  const runningNow = runningUnblockPassCountStmt.get()?.n ?? 0;
  const maxConcurrent = unblockerMaxConcurrent();
  if (runningNow >= maxConcurrent) {
    console.log(`[hopper-unblocker] hold node ${node.id}: concurrency cap ${runningNow}/${maxConcurrent} reached`);
    recordWaitingForJuice(node, tree, `concurrency cap ${runningNow}/${maxConcurrent} reached`);
    return;
  }

  const workerExt = `cockpit:unblocker-${node.id}-${randomUUID().slice(0, 8)}`;
  if (existing?.status === 'waiting_for_juice') {
    const claimed = claimWaitingUnblockPassStmt.run(
      workerExt,
      workerExt,
      gate.loadout.adapter,
      gate.loadout.model,
      node.result ?? null,
      node.id,
    );
    if (claimed.changes !== 1) return;
  } else {
    try {
      insertUnblockPassStmt.run(
        node.id,
        tree.id,
        workerExt,
        workerExt,
        gate.loadout.adapter,
        gate.loadout.model,
        node.result ?? null,
      );
    } catch {
      const refreshed = getUnblockPassStmt.get(node.id);
      if (refreshed?.worker_ext || refreshed?.worker_thread_ext) {
        maybeTriggerSmartUnblocker(node.id);
      } else if (refreshed?.status === 'waiting_for_juice') {
        maybeTriggerSmartUnblocker(node.id);
      } else {
        console.warn(`[hopper-unblocker] could not claim pass for node ${node.id}; marker exists without a worker`);
      }
      return;
    }
  }

  console.log(`[hopper-unblocker] spawn node ${node.id} → ${workerExt} (${gate.loadout.adapter}/${gate.loadout.model})`);
  void spawnSmartUnblockerWorker(node, tree, gate.loadout, workerExt);
}

/** Finding 5's producer-side complement: sweep every parked waiting_for_juice
 *  marker on each dispatch tick and give it another shot at the gate/cap. */
function sweepWaitingUnblockPasses(): void {
  for (const row of waitingUnblockPassNodeIdsStmt.all()) {
    const node = getNodeStmt.get(row.node_id);
    if (node && node.status === 'blocked') maybeTriggerSmartUnblocker(row.node_id);
  }
}

function parseDependencyIds(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0)
      : [];
  } catch {
    return [];
  }
}

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids.filter((v) => Number.isInteger(v) && v > 0))];
}

function normalizeFixTitle(title: string): string {
  const trimmed = title.trim();
  return /^FIX:/i.test(trimmed) ? trimmed.slice(0, 300) : `FIX: ${trimmed}`.slice(0, 300);
}

// Review #223 finding 2: a denylist can never keep pace with new frontier
// model ids (the original list missed `claude-fable-5-1`, the real Fable 5.1
// id). Inverted to an allowlist of the Standard/Heavy tiers a FIX leaf is
// actually meant to run on (skills/jarvis-router/SKILL.md); a frontier tier
// on ANY pool — including one that doesn't exist yet — is rejected by
// default instead of by name.
export const FIX_LEAF_MODEL_ALLOWLIST = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-5',
  'claude-opus-5',
  'gpt-5.5',
  'opus4.8',
  'sonnet4.6',
  'default', // auggie no-op flag: rides its own configured default, not a frontier escape hatch
]);
export function isAllowedFixLeafModel(model: string): boolean {
  return FIX_LEAF_MODEL_ALLOWLIST.has(model.trim());
}

export function appendHopperRemediationNodes(
  blockedNodeId: number,
  inputs: AppendHopperNodeInput[],
): HopperRemediationResult | null {
  const blocked = getNodeStmt.get(blockedNodeId);
  if (!blocked || blocked.status !== 'blocked' || !inputs.length) return null;
  const tree = getHopperTree(blocked.tree_id);
  if (!tree || tree.status !== 'active') return null;
  if (inputs.some((n) => !isAllowedFixLeafModel(n.model))) {
    throw new Error('FIX leaf nodes may only use allowlisted Standard/Heavy tier models, never a frontier tier');
  }

  // Finding 1: FIX nodes belong to the root node's one-pass fuse. Walk once
  // at insert time so a FIX-of-FIX (a manual remediation nested by hand)
  // still resolves flat to the original blocked node, never to an
  // intermediate FIX node.
  const remediationRoot = blocked.remediation_of ?? blocked.id;

  const priorResult = blocked.result ?? '(no blocked result recorded)';
  const originalDeps = parseDependencyIds(blocked.depends_on);
  const createdIds = sqliteDb.transaction(() => {
    const insert = sqliteDb.prepare<[string, string, string, string | null, string, string, number]>(`
      INSERT INTO hopper_nodes (tree_id, parent_id, title, spec, status, depends_on, adapter, model, remediation_of)
      VALUES (?, NULL, ?, ?, 'pending', ?, ?, ?, ?)
    `);
    const ids: number[] = [];
    inputs.slice(0, 12).forEach((input, index) => {
      const defaultDeps = index === 0 ? originalDeps : [ids[index - 1]];
      const deps = uniqueIds(input.depends_on?.length ? input.depends_on : defaultDeps);
      const info = insert.run(
        blocked.tree_id,
        normalizeFixTitle(input.title),
        input.spec.trim(),
        deps.length ? JSON.stringify(deps) : null,
        input.adapter.trim(),
        input.model.trim(),
        remediationRoot,
      );
      ids.push(Number(info.lastInsertRowid));
    });

    const finalFixId = ids[ids.length - 1];
    const nextDeps = uniqueIds([...originalDeps, finalFixId]);
    const addendum = [
      blocked.spec?.trim() ?? '',
      '',
      '---',
      '### Smart Unblocker re-review addendum',
      `Prior blocked result for node ${blocked.id}:`,
      priorResult,
      '',
      `Inserted FIX node ids: ${ids.join(', ')}`,
      'Rerun standard: verify the FIX chain resolved the blocker before reporting this node done.',
    ].join('\n').trim();

    sqliteDb.prepare(`
      UPDATE hopper_nodes
      SET status = 'pending',
          attempts = 0,
          question = NULL,
          answer = NULL,
          result = NULL,
          worker_thread_ext = NULL,
          lease_expires_at = NULL,
          depends_on = ?,
          spec = ?,
          updated_at = datetime('now')
      WHERE id = ? AND status = 'blocked'
    `).run(nextDeps.length ? JSON.stringify(nextDeps) : null, addendum, blocked.id);
    return ids;
  })();

  const fixNodes = createdIds
    .map((id) => getNodeStmt.get(id))
    .filter((n): n is HopperNodeRow => !!n);
  fixNodes.forEach((n) => emitNode('created', n));
  const updated = getNodeStmt.get(blocked.id) ?? null;
  if (updated) emitNode('updated', updated);
  queueMicrotask(() => void dispatchTick('smart_unblocker_remediation'));
  return updated ? { blocked_node: updated, fix_nodes: fixNodes } : null;
}

function composeFinishLineAuditSpec(tree: HopperTreeRow, nodes: HopperNodeRow[]): string {
  const depth = continuationDepth(tree);
  const origin = tree.origin_thread_ext ?? '(none recorded)';
  const depthRule = depth >= 2
    ? [
        'Continuation depth cap:',
        `This tree is already continuation depth ${depth}. If your verdict is SHORTFALL, do NOT plant another continuation tree.`,
        'Instead, finish this audit node with outcome=blocked_question and ask Kevin the single narrow question needed to continue, listing the gaps cold.',
      ].join('\n')
    : [
        'Continuation API, only if SHORTFALL:',
        '1. Read JARVIS_COCKPIT_KEY from /home/kevin/paperclip/jarvis-command-center/.env.',
        '2. POST /api/v1/hopper-trees with JSON:',
        '   {',
        '     "topic": "continuation: <original tree topic> - <gap summary>",',
        `     "origin_thread": ${JSON.stringify(origin === '(none recorded)' ? null : origin)},`,
        `     "origin_thread_ext": ${JSON.stringify(origin === '(none recorded)' ? null : origin)},`,
        '     "original_ask": <the original ask below>,',
        `     "continuation_of": ${JSON.stringify(tree.id)},`,
        `     "deferred_scope": "Continuation auto-planted by finish-line audit for tree ${tree.id}. Shortfall: <summary>",`,
        '     "nodes": [',
        '       {',
        '         "title": "<concrete gap-closing task>",',
        '         "spec": "<self-contained spec with guardrails and done-check>",',
        '         "depends_on_indexes": [],',
        '         "adapter": "claude",',
        '         "model": "claude-sonnet-5"',
        '       }',
        '     ]',
        '   }',
        '3. POST /api/v1/hopper-trees/:newTreeId/agree.',
        '4. If step 2 returns 409 finishline_continuation_exists, a previous attempt of this audit already planted the continuation — reuse the tree id from that response in your result and plant nothing else.',
      ].join('\n');

  // Review #184: a continuation's audit must judge the CUMULATIVE delivery of
  // the whole chain, not this tree alone — otherwise every real SHORTFALL
  // cascades into spurious continuations (the depth-1 audit sees only the
  // gap-closing node against the full original ask and re-flags the parent's
  // finished work as missing).
  const ancestors = continuationAncestors(tree);
  const ancestorBlock = ancestors.length
    ? [
        '',
        `Ancestor trees in this continuation chain (root first). This tree is continuation depth ${depth}; it was planted to close a shortfall, so judge the ask against EVERYTHING delivered across the chain, not this tree alone:`,
        ...ancestors.flatMap((a) => {
          const aNodes = listTreeNodes(a.id);
          const aVerdict = finishLineVerdictFor(aNodes);
          const verdictLine = aVerdict
            ? `  prior audit verdict: ${String(aVerdict.finishline_verdict ?? '?')} — ${finishLineSummary(aVerdict)}${stringList(aVerdict.gaps).length ? ` (gaps: ${stringList(aVerdict.gaps).join('; ')})` : ''}`
            : '  prior audit verdict: (none recorded)';
          return [`Tree ${a.id} — ${a.topic}`, compactNodeDigest(aNodes), verdictLine];
        }),
      ]
    : [];

  return [
    `You are the FINISH-LINE AUDIT for Hopper tree ${tree.id}.`,
    '',
    'Purpose:',
    "Compare what the tree actually delivered against Kevin's original ask. Do not rubber-stamp green just because every worker node reported done.",
    '',
    'Original ask:',
    tree.original_ask ?? '(none recorded)',
    '',
    'Explicit deferred/narrowed scope, if any:',
    tree.deferred_scope ?? '(none recorded)',
    ...(ancestors.length
      ? ['(For a continuation tree, deferred_scope records the shortfall this tree was planted to close — it is NOT a new deferral. Treat it as addressed if the chain below now covers it.)']
      : []),
    '',
    'Settled node inventory (this tree):',
    compactNodeDigest(nodes),
    ...ancestorBlock,
    '',
    'Rules:',
    '- Verdict FULL only if the completed tree satisfies the original ask, or every missing piece is explicitly named in deferred_scope and that deferral is visible enough that Kevin would not wake up surprised.',
    '- Verdict SHORTFALL if meaningful requested scope remains undone, hidden, ambiguous, or only mentioned in an outbox/doc that no system will consume.',
    '- NEVER verdict FULL when deferred_scope names a deferral that is still unaddressed (a continuation\'s own shortfall note counts as addressed once the chain covers it).',
    '- If SHORTFALL and the continuation depth cap has not been reached, you must plant and agree a continuation Hopper tree through the local API before finishing this audit node.',
    '- The continuation tree must be narrow, concrete, and cover only the missing scope. Use original_ask as the source of truth and include the shortfall summary in the continuation topic/specs.',
    '- Never touch production, merge to main, send external messages, or use API keys.',
    '',
    depthRule,
    '',
    'Handoff card required before any FULL verdict:',
    '1. Read JARVIS_COCKPIT_KEY from /home/kevin/paperclip/jarvis-command-center/.env.',
    `2. GET /api/v1/hopper-trees/${tree.id} with bearer auth and read the docs/push node's full \`result\` (the settled inventory above is only an excerpt). Identify the outbox report path from that full result. It must be wiki-relative, like \`outbox/<file>.md\`; never use \`/home/kevin/...\`, \`~/...\`, or \`/tmp/...\` anywhere in the handoff card.`,
    '3. Synthesize a short markdown handoff card in exactly this section order:',
    '   # <Tree topic> handoff',
    '   Tree: `<tree-id>`',
    '   Status: final',
    '   Backfilled: no',
    '   ## What was built',
    '   ## Branches & how to install',
    '   ## How to use it',
    '   ## Next steps / deferred',
    '   ## Full report',
    '4. The Branches table must use columns: Order, Repo, Branch, Head, Notes. Include every branch/manual artifact Kevin needs to pull, deploy, review, or intentionally ignore.',
    `5. POST the card to /api/v1/hopper-trees/${tree.id}/handoff with JSON \`{ "handoff": "<markdown>", "force": false }\` and bearer auth.`,
    '6. If the handoff POST fails, retry the exact POST up to three times.',
    '7. If the handoff still cannot be persisted, do NOT return a FULL verdict. Finish this audit node with outcome=blocked and a precise result explaining the handoff write failure.',
    '8. Only after the handoff POST succeeds may you finish this audit node with finishline_verdict FULL.',
    '',
    'Finish result:',
    'If FULL or if SHORTFALL with a continuation planted, finish this audit node with outcome=done. Put a single JSON object in result:',
    '{',
    '  "finishline_verdict": "FULL" | "SHORTFALL",',
    '  "summary": "<one or two sentences>",',
    '  "gaps": ["..."],',
    '  "continuation_tree_id": "<tree-id or null>",',
    '  "continuation_nodes": ["<titles planted, if any>"]',
    '}',
    '',
    'If the depth cap is reached and verdict is SHORTFALL, use outcome=blocked_question instead of outcome=done.',
  ].join('\n');
}

function appendFinishLineAuditNode(tree: HopperTreeRow, nodes: HopperNodeRow[]): HopperNodeRow | null {
  const info = insertFinishLineNode.run(
    tree.id,
    FINISHLINE_TITLE,
    composeFinishLineAuditSpec(tree, nodes),
    null,
    finishLineAuditAdapter(),
    finishLineAuditModel(),
  );
  const created = getNodeStmt.get(Number(info.lastInsertRowid)) ?? null;
  if (created) emitNode('created', created);
  return created;
}

/** Parse the audit's verdict JSON; tolerates code fences / prose around the object. */
function parseFinishLineVerdict(raw: string | null | undefined): FinishLineVerdict | null {
  const text = raw?.trim();
  if (!text) return null;
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      if (parsed && typeof parsed === 'object' && 'finishline_verdict' in parsed) return parsed as FinishLineVerdict;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function finishLineVerdictFor(nodes: HopperNodeRow[]): FinishLineVerdict | null {
  const audit = nodes.find(isFinishLineNode);
  return parseFinishLineVerdict(audit?.result);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [];
}

function finishLineSummary(verdict: FinishLineVerdict | null): string {
  return typeof verdict?.summary === 'string' && verdict.summary.trim() ? verdict.summary.trim() : 'Finish-line audit completed.';
}

function notifyTreeComplete(tree: HopperTreeRow, nodes: HopperNodeRow[]): void {
  if (!tree.original_ask?.trim()) {
    createNotification({
      severity: 'success',
      title: `🌳 Hopper tree complete: ${tree.topic.slice(0, 120)}`,
      body: `All ${nodes.length} tasks are done. Tree ${tree.id}.`,
      source: 'hopper-engine',
    });
    return;
  }

  const verdict = finishLineVerdictFor(nodes);
  const summary = finishLineSummary(verdict);
  const normalized = verdict?.finishline_verdict === 'FULL' || verdict?.finishline_verdict === 'SHORTFALL'
    ? verdict.finishline_verdict
    : null;
  if (normalized === 'FULL') {
    createNotification({
      severity: 'success',
      title: '🏁 finish-line: FULL',
      body: `Tree ${tree.id} satisfied the original ask. ${summary}`,
      source: 'hopper-engine',
    });
    return;
  }
  if (normalized === 'SHORTFALL') {
    const continuationTreeId =
      typeof verdict?.continuation_tree_id === 'string' && verdict.continuation_tree_id.trim()
        ? verdict.continuation_tree_id.trim()
        : 'not reported';
    const gaps = stringList(verdict?.gaps).join('; ');
    createNotification({
      severity: 'warning',
      title: `⚠️ finish-line: SHORTFALL — planted ${continuationTreeId}`,
      body: `Tree ${tree.id} completed its scoped work, but the audit found gaps${gaps ? `: ${gaps}` : ''}. ${summary}`,
      source: 'hopper-engine',
    });
    return;
  }

  const audit = nodes.find(isFinishLineNode);
  createNotification({
    severity: 'warning',
    title: '⚠️ finish-line audit completed with unreadable verdict',
    body: `Tree ${tree.id} has an original ask, but its finish-line result was not parseable. Result excerpt: ${resultExcerpt(audit?.result, 1200)}`,
    source: 'hopper-engine',
  });
}

/** Create a tree + its draft nodes in one shot (the breakdown chat calls this). */
export function createHopperTree(
  topic: string,
  originThreadExt: string | null,
  nodes: NewNodeInput[],
  opts: CreateHopperTreeOptions = {},
): {
  tree: HopperTreeRow;
  nodes: HopperNodeRow[];
} {
  const treeId = `tree-${randomUUID().slice(0, 8)}`;
  sqliteDb
    .prepare(`INSERT INTO hopper_trees (id, topic, origin_thread_ext, original_ask, deferred_scope, continuation_of) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      treeId,
      topic.slice(0, 300),
      boundedText(originThreadExt, 500),
      boundedText(opts.originalAsk),
      boundedText(opts.deferredScope),
      boundedText(opts.continuationOf, 80),
    );
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
  console.log(`[hopper-engine] started · slots=${MAX_SLOTS} lease=${LEASE_MINUTES}m maxAttempts=${MAX_ATTEMPTS}`);
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
    if (shouldAppendFinishLineAudit(tree, nodes)) {
      appendFinishLineAuditNode(tree, nodes);
      queueMicrotask(() => void dispatchTick('finishline_audit_appended'));
      return;
    }
    sqliteDb.prepare(`UPDATE hopper_trees SET status = 'done', updated_at = datetime('now') WHERE id = ?`).run(treeId);
    notifyTreeComplete(tree, nodes);
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
    const verdict = isFinishLineNode(node) ? parseFinishLineVerdict(payload.result) : null;
    if (verdict?.finishline_verdict === 'FULL' && !tree?.handoff?.trim()) {
      const latest = setNode(id, { status: 'blocked', result: FINISHLINE_FULL_MISSING_HANDOFF_RESULT, lease_expires_at: null });
      if (latest?.status === 'blocked' && !isFoundryTree(tree)) {
        createNotification({
          severity: 'error',
          title: `🚧 Hopper task blocked: ${node.title.slice(0, 100)}`,
          body: `${FINISHLINE_FULL_MISSING_HANDOFF_RESULT}\nNode ${id}, tree ${node.tree_id}.`,
          source: 'hopper-engine',
        });
      }
      maybeTriggerSmartUnblocker(id);
      queueMicrotask(() => void dispatchTick('node_finished'));
      return getNodeStmt.get(id) ?? null;
    }
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
        title: isFinishLineNode(node)
          ? `⚠️ finish-line: SHORTFALL needs your call`
          : `❓ Hopper worker needs your call: ${node.title.slice(0, 100)}`,
        body: `${payload.question ?? ''}\n\n(Answer from any JARVIS chat: "answer hopper node ${id}: <your answer>" — a fresh worker resumes with it.)`,
        source: 'hopper-engine',
      });
    }
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
    maybeTriggerSmartUnblocker(id);
  }
  queueMicrotask(() => void dispatchTick('node_finished'));
  return getNodeStmt.get(id) ?? null;
}

/** Kevin answers a blocking question → node re-queues with the answer injected. */
export function answerHopperNode(id: number, answer: string): HopperNodeRow | null {
  const node = getNodeStmt.get(id);
  if (!node || node.status !== 'blocked_question') return node ?? null;
  const updated = setNode(id, { status: 'pending', answer, worker_thread_ext: null });
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

    // 1.5) Finding 5: retry any Smart Unblocker pass parked waiting_for_juice
    //      (gate closed or concurrency-capped last time it was evaluated).
    //      Runs outside the node-slot machinery — these are direct
    //      processMessageRef spawns, not hopper leaves.
    sweepWaitingUnblockPasses();

    // 2) Fill free slots with ready leaves (deps satisfied), priority order.
    //    The governor gates every NEW claim per-node by that node's provider so
    //    a maxed Claude window holds claude leaves while auggie/codex leaves in
    //    the same tree still dispatch (lease recovery above always runs; running
    //    workers are never interrupted). Held node = skip it, try the next.
    let free = MAX_SLOTS - (runningCountStmt.get()?.n ?? 0);
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
    const verdicts = new Map<string, boolean>(); // one governor eval per adapter per tick
    for (const node of readyLeavesStmt.all()) {
      if (free <= 0) break;
      if (!depsSatisfied(node)) continue;
      const adapter = node.adapter ?? WORKER_ADAPTER;
      let allowed = verdicts.get(adapter);
      if (allowed === undefined) {
        allowed = governorCheck(adapter).allow;
        verdicts.set(adapter, allowed);
      }
      if (!allowed) continue;
      const nonClaude = providerFor(adapter) !== 'claude';
      if (daytime && nonClaude && daytimeRunning >= cap) {
        if (!cappedLogged) {
          console.log(`[hopper-engine] concurrency cap: ${daytimeRunning}/${cap} non-claude workers running while Kevin is active — holding the rest`);
          cappedLogged = true;
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
      console.log(`[hopper-engine] dispatch node ${node.id} (${reason}) → ${ext}`);
      void spawnWorker(fresh, tree);
    }
  } finally {
    ticking = false;
  }
}
