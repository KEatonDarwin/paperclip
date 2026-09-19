import { sqliteDb } from './conversation-db.js';

// JARVIS WORKER PROTOCOL — the parent/child spawn ledger. Every worker thread an
// orchestrator spawns gets a row here: who its parent is, what model it runs on,
// where it is in its work (status), and its result. The 5-minute heartbeat
// reconciler (/usr/local/bin-class jarvis-spawn-reconcile) keys off server-owned
// run-state to flip stuck/dead workers. This module is the READ surface the
// cockpit sub-agent tree widget renders from. See skills/jarvis-worker-protocol.
// The table is created by the reconciler/orchestrator; this DDL is idempotent so
// a fresh install still has it.

export type SpawnStatus = 'running' | 'done' | 'stuck' | 'failed' | 'released';

export interface SpawnTaskRow {
  id: number;
  thread_ext: string;
  conversation_id: number | null;
  parent_thread_ext: string | null;
  parent_conversation_id: number | null;
  group_id: number | null;
  label: string | null;
  task_prompt: string | null;
  model: string | null;
  status: SpawnStatus;
  pid: number | null;
  result: string | null;
  error: string | null;
  message_id: string | null;
  turn_count: number;
  last_seen_running: number;
  created_at: string;
  updated_at: string;
  last_heartbeat: string | null;
  hopper_tree_id: string | null;
  hopper_node_id: number | null;
  workbench_node_id: number | null;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS spawn_tasks (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_ext             TEXT NOT NULL UNIQUE,
    conversation_id        INTEGER,
    parent_thread_ext      TEXT,
    parent_conversation_id INTEGER,
    group_id               INTEGER,
    label                  TEXT,
    task_prompt            TEXT,
    model                  TEXT,
    status                 TEXT NOT NULL DEFAULT 'running',
    pid                    INTEGER,
    result                 TEXT,
    error                  TEXT,
    message_id             TEXT,
    turn_count             INTEGER DEFAULT 0,
    last_seen_running      INTEGER DEFAULT 0,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    last_heartbeat         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_spawn_tasks_parent
    ON spawn_tasks(parent_thread_ext, created_at DESC);
`);

// SPAWN-MONITOR bulletproof grouping (2026-09-12): additive stamp columns so an
// attempt can be tied to its hopper tree/node directly, instead of relying only
// on parsing `cockpit:hopper-node-<id>-<hex>` out of thread_ext. Lazy migration,
// same pattern as hopper_nodes' adapter/model columns in hopper-engine.ts.
for (const col of ['hopper_tree_id TEXT', 'hopper_node_id INTEGER']) {
  try {
    sqliteDb.exec(`ALTER TABLE spawn_tasks ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}
sqliteDb.exec(`
  CREATE INDEX IF NOT EXISTS idx_spawn_tasks_hopper_node ON spawn_tasks(hopper_node_id);
`);

// WORKBENCH V2 dispatch (2026-09-19): a separate stamp column, deliberately NOT
// reusing hopper_node_id — that id space belongs to hopper_nodes rows, and a
// smart_todo_nodes id could collide with an unrelated hopper node id when a
// hopper-tree view's matchSpawnTasksToNodes() scopes by hopper_node_id (see
// spawn-monitor.ts). Same lazy-migration pattern as the pair above.
try {
  sqliteDb.exec(`ALTER TABLE spawn_tasks ADD COLUMN workbench_node_id INTEGER`);
} catch {
  /* column already exists */
}
sqliteDb.exec(`
  CREATE INDEX IF NOT EXISTS idx_spawn_tasks_workbench_node ON spawn_tasks(workbench_node_id);
`);

const listStmt = sqliteDb.prepare<[number], SpawnTaskRow>(`
  SELECT * FROM spawn_tasks ORDER BY created_at DESC, id DESC LIMIT ?
`);

/** All spawn-task rows, newest first. The cockpit tree groups them by parent. */
export function listSpawnTasks(limit = 300): SpawnTaskRow[] {
  const n = Math.max(1, Math.min(limit, 1000));
  return listStmt.all(n);
}

const listAllStmt = sqliteDb.prepare<[], SpawnTaskRow>(`
  SELECT * FROM spawn_tasks ORDER BY created_at ASC, id ASC
`);

/** Every spawn-task row, oldest first, uncapped — the spawn-monitor aggregator's input. */
export function listAllSpawnTasks(): SpawnTaskRow[] {
  return listAllStmt.all();
}

const latestForWorkbenchNodeStmt = sqliteDb.prepare<[number], SpawnTaskRow>(`
  SELECT * FROM spawn_tasks WHERE workbench_node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
`);

/** The most recent dispatch attempt for one Workbench node, or null if it has
 *  never been dispatched. Drives GET /workbench/nodes/:id/dispatch's badge and
 *  the 409-while-running guard on POST .../dispatch. */
export function getLatestSpawnTaskForWorkbenchNode(nodeId: number): SpawnTaskRow | null {
  return latestForWorkbenchNodeStmt.get(nodeId) ?? null;
}

const insertWorkbenchDispatchStmt = sqliteDb.prepare<
  [string, number, string | null, string, string, string, number]
>(`
  INSERT INTO spawn_tasks (thread_ext, conversation_id, parent_thread_ext, label, task_prompt, model, status, workbench_node_id)
  VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
`);

const getByIdStmt = sqliteDb.prepare<[number], SpawnTaskRow>(`SELECT * FROM spawn_tasks WHERE id = ?`);

/** Record a freshly-spawned Workbench dispatch worker. Mirrors hopper-engine's
 *  spawnTaskInsert (src/hopper-engine.ts) but stamps workbench_node_id instead
 *  of hopper_tree_id/hopper_node_id — same ledger, different owner. */
export function recordWorkbenchDispatch(args: {
  threadExt: string;
  conversationId: number;
  parentThreadExt: string | null;
  label: string;
  taskPrompt: string;
  model: string;
  workbenchNodeId: number;
}): SpawnTaskRow {
  const info = insertWorkbenchDispatchStmt.run(
    args.threadExt,
    args.conversationId,
    args.parentThreadExt,
    args.label,
    args.taskPrompt.slice(0, 2000),
    args.model,
    args.workbenchNodeId,
  );
  const row = getByIdStmt.get(Number(info.lastInsertRowid));
  if (!row) throw new Error('failed to load spawn_tasks row after insert');
  return row;
}

const markSpawnTaskFailedStmt = sqliteDb.prepare<[string, string]>(`
  UPDATE spawn_tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE thread_ext = ?
`);

/** Release a dispatch that failed to spawn (busy/adapter error) so it doesn't
 *  sit as a phantom 'running' row forever — mirrors hopper-engine's catch path. */
export function markSpawnTaskFailed(threadExt: string, error: string): void {
  markSpawnTaskFailedStmt.run(error.slice(0, 500), threadExt);
}
