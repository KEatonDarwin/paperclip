import { sqliteDb } from './conversation-db.js';
import { sseBus, type DispatchEvent } from './sse-bus.js';

export type WaitMode = 'all' | 'any' | 'specific';
export type WakeMode = 'active' | 'passive';
export type DispatchStatus = 'waiting' | 'complete' | 'acknowledged';

export interface DispatchRow {
  id: number;
  orchestrator_conversation_id: number;
  wait_mode: WaitMode;
  wake_mode: WakeMode;
  status: DispatchStatus;
  label: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface DispatchWorkerRow {
  id: number;
  dispatch_id: number;
  worker_conversation_id: number;
  role_label: string | null;
  done: number;
  done_at: string | null;
  is_gate: number;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS dispatches (
    id                            INTEGER PRIMARY KEY AUTOINCREMENT,
    orchestrator_conversation_id  INTEGER NOT NULL REFERENCES conversations(id),
    wait_mode                     TEXT NOT NULL DEFAULT 'all' CHECK (wait_mode IN ('all', 'any', 'specific')),
    wake_mode                     TEXT NOT NULL DEFAULT 'active' CHECK (wake_mode IN ('active', 'passive')),
    status                        TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'complete', 'acknowledged')),
    label                         TEXT,
    created_at                    TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at                  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_dispatches_orchestrator
    ON dispatches(orchestrator_conversation_id, status);

  CREATE TABLE IF NOT EXISTS dispatch_workers (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    dispatch_id               INTEGER NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
    worker_conversation_id    INTEGER NOT NULL REFERENCES conversations(id),
    role_label                TEXT,
    done                      INTEGER NOT NULL DEFAULT 0,
    done_at                   TEXT,
    is_gate                   INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_dispatch_workers_dispatch
    ON dispatch_workers(dispatch_id);
  CREATE INDEX IF NOT EXISTS idx_dispatch_workers_worker
    ON dispatch_workers(worker_conversation_id, done);
`);

// --- Prepared statements ---

const insertDispatchStmt = sqliteDb.prepare<[number, WaitMode, WakeMode, string | null]>(`
  INSERT INTO dispatches (orchestrator_conversation_id, wait_mode, wake_mode, label)
  VALUES (?, ?, ?, ?)
`);

const getDispatchStmt = sqliteDb.prepare<[number], DispatchRow>(
  `SELECT * FROM dispatches WHERE id = ?`,
);

const listByOrchestratorStmt = sqliteDb.prepare<[number], DispatchRow>(`
  SELECT * FROM dispatches
  WHERE orchestrator_conversation_id = ?
  ORDER BY created_at ASC, id ASC
`);

const listByWorkerStmt = sqliteDb.prepare<[number], DispatchRow & { worker_role_label: string | null; worker_done: number }>(`
  SELECT d.*, dw.role_label AS worker_role_label, dw.done AS worker_done
  FROM dispatches d
  JOIN dispatch_workers dw ON dw.dispatch_id = d.id
  WHERE dw.worker_conversation_id = ?
  ORDER BY d.created_at ASC, d.id ASC
`);

const waitingDispatchesForWorkerStmt = sqliteDb.prepare<[number], { dispatch_id: number; worker_id: number }>(`
  SELECT dw.dispatch_id, dw.id AS worker_id
  FROM dispatch_workers dw
  JOIN dispatches d ON d.id = dw.dispatch_id
  WHERE dw.worker_conversation_id = ? AND d.status = 'waiting' AND dw.done = 0
`);

const insertWorkerStmt = sqliteDb.prepare<[number, number, string | null, number]>(`
  INSERT INTO dispatch_workers (dispatch_id, worker_conversation_id, role_label, is_gate)
  VALUES (?, ?, ?, ?)
`);

const getWorkerStmt = sqliteDb.prepare<[number], DispatchWorkerRow>(
  `SELECT * FROM dispatch_workers WHERE id = ?`,
);

const listWorkersStmt = sqliteDb.prepare<[number], DispatchWorkerRow>(`
  SELECT * FROM dispatch_workers WHERE dispatch_id = ? ORDER BY id ASC
`);

const markWorkerDoneStmt = sqliteDb.prepare<[number]>(`
  UPDATE dispatch_workers SET done = 1, done_at = datetime('now') WHERE id = ?
`);

const completeDispatchStmt = sqliteDb.prepare<[number]>(`
  UPDATE dispatches SET status = 'complete', completed_at = datetime('now') WHERE id = ? AND status = 'waiting'
`);

const ackDispatchStmt = sqliteDb.prepare<[number]>(`
  UPDATE dispatches SET status = 'acknowledged' WHERE id = ? AND status = 'complete'
`);

const deleteDispatchStmt = sqliteDb.prepare<[number]>(`DELETE FROM dispatches WHERE id = ?`);
const deleteWorkersStmt = sqliteDb.prepare<[number]>(`DELETE FROM dispatch_workers WHERE dispatch_id = ?`);

// --- Emit helpers ---

function emit(conversationId: number, action: DispatchEvent['action'], dispatch: DispatchRow, workers: DispatchWorkerRow[]): void {
  sseBus.emit('sse', { type: 'dispatch', conversationId, action, dispatch, workers } satisfies DispatchEvent);
}

// --- Public API ---

export function getDispatch(id: number): DispatchRow | null {
  return getDispatchStmt.get(id) ?? null;
}

export function listDispatchWorkers(dispatchId: number): DispatchWorkerRow[] {
  return listWorkersStmt.all(dispatchId);
}

export interface CreateDispatchInput {
  orchestratorConversationId: number;
  waitMode: WaitMode;
  wakeMode: WakeMode;
  label?: string | null;
  workers: Array<{ conversationId: number; roleLabel?: string | null; isGate?: boolean }>;
}

export function createDispatch(input: CreateDispatchInput): { dispatch: DispatchRow; workers: DispatchWorkerRow[] } {
  const info = insertDispatchStmt.run(
    input.orchestratorConversationId,
    input.waitMode,
    input.wakeMode,
    input.label ?? null,
  );
  const dispatchId = Number(info.lastInsertRowid);
  const workerRows: DispatchWorkerRow[] = [];
  for (const w of input.workers) {
    const wInfo = insertWorkerStmt.run(dispatchId, w.conversationId, w.roleLabel ?? null, w.isGate ? 1 : 0);
    const row = getWorkerStmt.get(Number(wInfo.lastInsertRowid));
    if (row) workerRows.push(row);
  }
  const dispatch = getDispatchStmt.get(dispatchId)!;
  emit(input.orchestratorConversationId, 'created', dispatch, workerRows);
  return { dispatch, workers: workerRows };
}

export function listOutboundDispatches(orchestratorConversationId: number): Array<{ dispatch: DispatchRow; workers: DispatchWorkerRow[] }> {
  const dispatches = listByOrchestratorStmt.all(orchestratorConversationId);
  return dispatches.map(d => ({ dispatch: d, workers: listDispatchWorkers(d.id) }));
}

export function listInboundDispatches(workerConversationId: number): Array<{ dispatch: DispatchRow; workers: DispatchWorkerRow[] }> {
  const rows = listByWorkerStmt.all(workerConversationId);
  const seen = new Set<number>();
  const result: Array<{ dispatch: DispatchRow; workers: DispatchWorkerRow[] }> = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const { worker_role_label: _, worker_done: __, ...dispatch } = r;
    result.push({ dispatch: dispatch as DispatchRow, workers: listDispatchWorkers(r.id) });
  }
  return result;
}

export function findWaitingDispatchesForWorker(workerConversationId: number): Array<{ dispatch_id: number; worker_id: number }> {
  return waitingDispatchesForWorkerStmt.all(workerConversationId);
}

export function markWorkerDone(workerId: number): DispatchWorkerRow | null {
  const worker = getWorkerStmt.get(workerId);
  if (!worker || worker.done) return worker ?? null;
  markWorkerDoneStmt.run(workerId);
  return getWorkerStmt.get(workerId) ?? null;
}

export function evaluateGate(dispatchId: number): boolean {
  const dispatch = getDispatchStmt.get(dispatchId);
  if (!dispatch || dispatch.status !== 'waiting') return false;
  const workers = listDispatchWorkers(dispatchId);
  switch (dispatch.wait_mode) {
    case 'all':
      return workers.every(w => w.done === 1);
    case 'any':
      return workers.some(w => w.done === 1);
    case 'specific':
      return workers.filter(w => w.is_gate === 1).every(w => w.done === 1);
    default:
      return false;
  }
}

export function completeDispatch(dispatchId: number): DispatchRow | null {
  const changes = completeDispatchStmt.run(dispatchId);
  if (changes.changes === 0) return null;
  const dispatch = getDispatchStmt.get(dispatchId);
  if (!dispatch) return null;
  const workers = listDispatchWorkers(dispatchId);
  emit(dispatch.orchestrator_conversation_id, 'completed', dispatch, workers);
  return dispatch;
}

export function acknowledgeDispatch(dispatchId: number): DispatchRow | null {
  const changes = ackDispatchStmt.run(dispatchId);
  if (changes.changes === 0) return null;
  const dispatch = getDispatchStmt.get(dispatchId);
  if (!dispatch) return null;
  const workers = listDispatchWorkers(dispatchId);
  emit(dispatch.orchestrator_conversation_id, 'acknowledged', dispatch, workers);
  return dispatch;
}

export function deleteDispatch(dispatchId: number): DispatchRow | null {
  const dispatch = getDispatchStmt.get(dispatchId);
  if (!dispatch) return null;
  const workers = listDispatchWorkers(dispatchId);
  deleteWorkersStmt.run(dispatchId);
  deleteDispatchStmt.run(dispatchId);
  emit(dispatch.orchestrator_conversation_id, 'deleted', dispatch, workers);
  return dispatch;
}
