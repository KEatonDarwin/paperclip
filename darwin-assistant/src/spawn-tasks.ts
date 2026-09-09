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
  adapter: string | null;
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

for (const col of ['adapter TEXT']) {
  try {
    sqliteDb.exec(`ALTER TABLE spawn_tasks ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

const listStmt = sqliteDb.prepare<[number], SpawnTaskRow>(`
  SELECT * FROM spawn_tasks ORDER BY created_at DESC, id DESC LIMIT ?
`);

/** All spawn-task rows, newest first. The cockpit tree groups them by parent. */
export function listSpawnTasks(limit = 300): SpawnTaskRow[] {
  const n = Math.max(1, Math.min(limit, 1000));
  return listStmt.all(n);
}
