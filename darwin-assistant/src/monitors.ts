import { sqliteDb } from './conversation-db.js';
import {
  getConversation,
  getOrCreateConversation,
  renameConversation,
  setConversationStatus,
  setThreadDisplay,
  setThreadGroup,
  setThreadModelOverride,
  countTurns,
  type ConversationRow,
} from './conversation-db.js';
import { createGroup, listGroups } from './conversation-groups.js';
import { createNotification } from './notifications.js';
import { sseBus, type MonitorEvent, type MonitorRunEvent } from './sse-bus.js';

export type MonitorStatus = 'active' | 'paused' | 'completed';
export type MonitorOutcome = 'pass' | 'fail' | 'error';

export interface MonitorRow {
  id: number;
  name: string;
  prompt: string;
  cadence_minutes: number;
  adapter: string;
  model: string;
  expires_at: string | null;
  status: MonitorStatus;
  last_run_at: string | null;
  consecutive_fails: number;
  created_at: string;
  updated_at: string;
  monitor_thread_ext: string | null;
  last_outcome: MonitorOutcome | null;
  last_state_key: string | null;
  last_state_changed_at: string | null;
}

export interface MonitorRunRow {
  id: number;
  monitor_id: number;
  started_at: string;
  finished_at: string | null;
  outcome: MonitorOutcome | null;
  summary: string | null;
  detail: string | null;
  raw: string | null;
  created_at: string;
  scheduled_for: string | null;
  message_id: string | null;
  error: string | null;
}

export interface MonitorDigestEntry {
  id: number;
  name: string;
  status: MonitorStatus;
  cadence_minutes: number;
  expires_at: string | null;
  last_run_at: string | null;
  last_outcome: MonitorOutcome | null;
  last_summary: string | null;
  consecutive_fails: number;
  runs: number;
  passes: number;
  fails: number;
  errors: number;
}

type ProcessMessageFn = (input: string, conversationId: string, messageId?: string) => Promise<string>;
type AbortConversationRunFn = (conversationId: number) => boolean;

const DEFAULT_ADAPTER = 'claude';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const POLL_INTERVAL_MS = 60_000;
const DUE_BATCH_LIMIT = 5;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MONITOR_GROUP_NAME = 'Cockpit Monitors';

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL,
    prompt              TEXT NOT NULL,
    cadence_minutes     INTEGER NOT NULL,
    adapter             TEXT NOT NULL DEFAULT 'claude',
    model               TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
    expires_at          TEXT,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed')),
    last_run_at         TEXT,
    consecutive_fails   INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    monitor_thread_ext  TEXT UNIQUE,
    last_outcome        TEXT CHECK (last_outcome IN ('pass','fail','error') OR last_outcome IS NULL),
    last_state_key      TEXT,
    last_state_changed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_monitors_due
    ON monitors(status, last_run_at);

  CREATE INDEX IF NOT EXISTS idx_monitors_expires
    ON monitors(status, expires_at);

  CREATE TABLE IF NOT EXISTS monitor_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id    INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    started_at    TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at   TEXT,
    outcome       TEXT CHECK (outcome IN ('pass','fail','error') OR outcome IS NULL),
    summary       TEXT,
    detail        TEXT,
    raw           TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    scheduled_for TEXT,
    message_id    TEXT,
    error         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_monitor_runs_monitor_created
    ON monitor_runs(monitor_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_monitor_runs_open
    ON monitor_runs(monitor_id, outcome);
`);

// Idempotent forward-only shims for worktrees whose jarvis.db already has an
// older monitor table from a prior local experiment.
for (const col of [
  'updated_at TEXT',
  'monitor_thread_ext TEXT UNIQUE',
  'last_outcome TEXT',
  'last_state_key TEXT',
  'last_state_changed_at TEXT',
]) {
  try { sqliteDb.exec(`ALTER TABLE monitors ADD COLUMN ${col}`); } catch {}
}
for (const col of ['scheduled_for TEXT', 'message_id TEXT', 'error TEXT']) {
  try { sqliteDb.exec(`ALTER TABLE monitor_runs ADD COLUMN ${col}`); } catch {}
}

const getMonitorStmt = sqliteDb.prepare<[number], MonitorRow>(`SELECT * FROM monitors WHERE id = ?`);
const getRunStmt = sqliteDb.prepare<[number], MonitorRunRow>(`SELECT * FROM monitor_runs WHERE id = ?`);
const listOpenStmt = sqliteDb.prepare<[], MonitorRow>(`
  SELECT * FROM monitors
  WHERE status IN ('active','paused')
  ORDER BY status ASC, created_at DESC, id DESC
`);
const listAllStmt = sqliteDb.prepare<[], MonitorRow>(`
  SELECT * FROM monitors ORDER BY created_at DESC, id DESC
`);
const listByStatusStmt = sqliteDb.prepare<[MonitorStatus], MonitorRow>(`
  SELECT * FROM monitors WHERE status = ? ORDER BY created_at DESC, id DESC
`);
const listRunsStmt = sqliteDb.prepare<[number, number], MonitorRunRow>(`
  SELECT * FROM monitor_runs
  WHERE monitor_id = ?
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`);
const openRunStmt = sqliteDb.prepare<[number], MonitorRunRow>(`
  SELECT * FROM monitor_runs
  WHERE monitor_id = ? AND outcome IS NULL
  ORDER BY started_at ASC, id ASC
  LIMIT 1
`);
const insertMonitorStmt = sqliteDb.prepare<[string, string, number, string, string, string | null]>(`
  INSERT INTO monitors (name, prompt, cadence_minutes, adapter, model, expires_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const setThreadStmt = sqliteDb.prepare<[string, number]>(`
  UPDATE monitors SET monitor_thread_ext = ?, updated_at = datetime('now') WHERE id = ?
`);
const updateMonitorStmt = sqliteDb.prepare<[
  string | null,
  string | null,
  number | null,
  string | null,
  string | null,
  string | null,
  MonitorStatus | null,
  number,
]>(`
  UPDATE monitors
  SET name = COALESCE(?, name),
      prompt = COALESCE(?, prompt),
      cadence_minutes = COALESCE(?, cadence_minutes),
      adapter = COALESCE(?, adapter),
      model = COALESCE(?, model),
      expires_at = ?,
      status = COALESCE(?, status),
      updated_at = datetime('now')
  WHERE id = ?
`);
const deleteMonitorStmt = sqliteDb.prepare<[number]>(`DELETE FROM monitors WHERE id = ?`);
const dueMonitorsStmt = sqliteDb.prepare<[string, string, number], MonitorRow>(`
  SELECT m.*
  FROM monitors m
  WHERE m.status = 'active'
    AND (m.expires_at IS NULL OR m.expires_at > ?)
    AND (
      m.last_run_at IS NULL
      OR datetime(m.last_run_at, '+' || m.cadence_minutes || ' minutes') <= ?
    )
    AND NOT EXISTS (
      SELECT 1 FROM monitor_runs r
      WHERE r.monitor_id = m.id AND r.outcome IS NULL
    )
  ORDER BY COALESCE(m.last_run_at, m.created_at) ASC, m.id ASC
  LIMIT ?
`);
const insertRunStmt = sqliteDb.prepare<[number, string]>(`
  INSERT INTO monitor_runs (monitor_id, scheduled_for, started_at)
  VALUES (?, ?, datetime('now'))
`);
const markClaimedStmt = sqliteDb.prepare<[string, number]>(`
  UPDATE monitors SET last_run_at = ?, updated_at = datetime('now') WHERE id = ?
`);
const setRunMessageStmt = sqliteDb.prepare<[string, number]>(`
  UPDATE monitor_runs SET message_id = ? WHERE id = ?
`);
const completeRunStmt = sqliteDb.prepare<[MonitorOutcome, string, string | null, string | null, string | null, number]>(`
  UPDATE monitor_runs
  SET outcome = ?,
      summary = ?,
      detail = ?,
      raw = ?,
      error = ?,
      finished_at = datetime('now')
  WHERE id = ?
`);
const updateMonitorOutcomeStmt = sqliteDb.prepare<[number, MonitorOutcome, string, number]>(`
  UPDATE monitors
  SET consecutive_fails = ?,
      last_outcome = ?,
      last_state_key = ?,
      last_state_changed_at = datetime('now'),
      updated_at = datetime('now')
  WHERE id = ?
`);
const expireDueStmt = sqliteDb.prepare<[string], MonitorRow>(`
  SELECT * FROM monitors
  WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
  ORDER BY expires_at ASC, id ASC
`);
const markCompletedStmt = sqliteDb.prepare<[number]>(`
  UPDATE monitors SET status = 'completed', updated_at = datetime('now') WHERE id = ?
`);
const statsStmt = sqliteDb.prepare<[number], { runs: number; fails: number; passes: number; errors: number }>(`
  SELECT
    COUNT(*) AS runs,
    SUM(CASE WHEN outcome = 'fail' THEN 1 ELSE 0 END) AS fails,
    SUM(CASE WHEN outcome = 'pass' THEN 1 ELSE 0 END) AS passes,
    SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors
  FROM monitor_runs
  WHERE monitor_id = ? AND outcome IS NOT NULL
`);
const digestStatsStmt = sqliteDb.prepare<[number, string], { runs: number; fails: number; passes: number; errors: number }>(`
  SELECT
    COUNT(*) AS runs,
    SUM(CASE WHEN outcome = 'fail' THEN 1 ELSE 0 END) AS fails,
    SUM(CASE WHEN outcome = 'pass' THEN 1 ELSE 0 END) AS passes,
    SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors
  FROM monitor_runs
  WHERE monitor_id = ? AND outcome IS NOT NULL AND created_at >= ?
`);
const latestRunStmt = sqliteDb.prepare<[number], MonitorRunRow>(`
  SELECT * FROM monitor_runs
  WHERE monitor_id = ? AND outcome IS NOT NULL
  ORDER BY created_at DESC, id DESC
  LIMIT 1
`);
const staleOpenRunsStmt = sqliteDb.prepare<[string], MonitorRunRow>(`
  SELECT * FROM monitor_runs
  WHERE outcome IS NULL AND started_at <= ?
  ORDER BY started_at ASC
`);

let processMessageRef: ProcessMessageFn | null = null;
let abortConversationRunRef: AbortConversationRunFn | null = null;
let schedulerStarted = false;
let schedulerTicking = false;
const runningMonitorIds = new Set<number>();

function emitMonitor(action: MonitorEvent['action'], monitor: MonitorRow): void {
  sseBus.emit('sse', { type: 'monitor', action, monitor } satisfies MonitorEvent);
}

function emitRun(action: MonitorRunEvent['action'], run: MonitorRunRow): void {
  sseBus.emit('sse', { type: 'monitor_run', action, run } satisfies MonitorRunEvent);
}

function sqliteNow(date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed.includes('T') ? trimmed : `${trimmed.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed.getTime()) ? sqliteNow(parsed) : trimmed.slice(0, 19);
}

function clampCadence(value: number): number {
  return Math.max(1, Math.min(Math.floor(value), 525_600));
}

function normalizeState(summary: string): string {
  return summary.trim().replace(/\s+/g, ' ').slice(0, 180).toLowerCase();
}

function stateKey(outcome: MonitorOutcome, summary: string): string {
  return `${outcome}:${normalizeState(summary)}`;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ensureMonitorThreadExt(monitorId: number, current: string | null): string {
  if (current) return current;
  const ext = `cockpit:monitor-${monitorId}`;
  setThreadStmt.run(ext, monitorId);
  return ext;
}

function ensureMonitorGroupId(): number {
  const existing = listGroups().find((group) => group.name === MONITOR_GROUP_NAME);
  if (existing) return existing.id;
  return createGroup(MONITOR_GROUP_NAME, '#2dd4bf').group.id;
}

function ensureMonitorConversation(monitor: MonitorRow): ConversationRow {
  const ext = ensureMonitorThreadExt(monitor.id, monitor.monitor_thread_ext);
  const conv = getOrCreateConversation(ext);
  renameConversation(conv.id, `Monitor: ${monitor.name.slice(0, 110)}`);
  setThreadDisplay(conv.id, {
    headline: monitor.name.slice(0, 160),
    borderColor: '#2dd4bf',
  });
  setThreadGroup(conv.id, ensureMonitorGroupId());
  setThreadModelOverride(conv.id, monitor.adapter, monitor.model);
  return conv;
}

export function getMonitor(id: number): MonitorRow | null {
  return getMonitorStmt.get(id) ?? null;
}

export function getMonitorRun(id: number): MonitorRunRow | null {
  return getRunStmt.get(id) ?? null;
}

export function listMonitors(status: MonitorStatus | 'open' | 'all' = 'open'): MonitorRow[] {
  if (status === 'all') return listAllStmt.all();
  if (status === 'open') return listOpenStmt.all();
  return listByStatusStmt.all(status);
}

export function listMonitorRuns(monitorId: number, limit = 50): MonitorRunRow[] {
  return listRunsStmt.all(monitorId, Math.max(1, Math.min(Math.floor(limit), 500)));
}

export function createMonitor(args: {
  name: string;
  prompt: string;
  cadence_minutes: number;
  adapter?: string | null;
  model?: string | null;
  expires_at?: string | null;
}): MonitorRow {
  const info = insertMonitorStmt.run(
    args.name.trim().slice(0, 240),
    args.prompt.trim(),
    clampCadence(args.cadence_minutes),
    args.adapter?.trim() || DEFAULT_ADAPTER,
    args.model?.trim() || DEFAULT_MODEL,
    normalizeTimestamp(args.expires_at),
  );
  const id = Number(info.lastInsertRowid);
  setThreadStmt.run(`cockpit:monitor-${id}`, id);
  const created = getMonitor(id);
  if (!created) throw new Error('Failed to load monitor after insert');
  emitMonitor('created', created);
  return created;
}

export function patchMonitor(id: number, patch: {
  name?: string;
  prompt?: string;
  cadence_minutes?: number;
  adapter?: string;
  model?: string;
  expires_at?: string | null;
  status?: MonitorStatus;
}): MonitorRow | null {
  const existing = getMonitor(id);
  if (!existing) return null;
  const expiresAt = Object.prototype.hasOwnProperty.call(patch, 'expires_at')
    ? normalizeTimestamp(patch.expires_at)
    : existing.expires_at;
  updateMonitorStmt.run(
    patch.name?.trim().slice(0, 240) || null,
    patch.prompt?.trim() || null,
    patch.cadence_minutes !== undefined ? clampCadence(patch.cadence_minutes) : null,
    patch.adapter?.trim() || null,
    patch.model?.trim() || null,
    expiresAt,
    patch.status ?? null,
    id,
  );
  const updated = getMonitor(id);
  if (updated) emitMonitor('updated', updated);
  return updated;
}

export function deleteMonitor(id: number): MonitorRow | null {
  const existing = getMonitor(id);
  if (!existing) return null;
  if (existing.monitor_thread_ext) {
    const conv = getConversation(existing.monitor_thread_ext);
    if (conv) setConversationStatus(conv.id, 'archived');
  }
  deleteMonitorStmt.run(id);
  emitMonitor('deleted', existing);
  return existing;
}

function beginMonitorRun(monitor: MonitorRow, scheduledFor: string): MonitorRunRow {
  const info = insertRunStmt.run(monitor.id, scheduledFor);
  markClaimedStmt.run(scheduledFor, monitor.id);
  const run = getMonitorRun(Number(info.lastInsertRowid));
  const updatedMonitor = getMonitor(monitor.id);
  if (!run || !updatedMonitor) throw new Error('Failed to claim monitor run');
  emitRun('created', run);
  emitMonitor('updated', updatedMonitor);
  return run;
}

export function claimDueMonitorRuns(now = new Date(), limit = DUE_BATCH_LIMIT): MonitorRunRow[] {
  return sqliteDb.transaction(() => {
    const nowSql = sqliteNow(now);
    const due = dueMonitorsStmt.all(nowSql, nowSql, Math.max(1, Math.min(Math.floor(limit), 50)));
    return due.map((monitor) => beginMonitorRun(monitor, nowSql));
  })();
}

export function expireCompletedMonitors(now = new Date()): MonitorRow[] {
  const nowSql = sqliteNow(now);
  const due = expireDueStmt.all(nowSql);
  const expired: MonitorRow[] = [];
  for (const monitor of due) {
    markCompletedStmt.run(monitor.id);
    const updated = getMonitor(monitor.id);
    if (!updated) continue;
    expired.push(updated);
    emitMonitor('updated', updated);

    const stats = statsStmt.get(monitor.id) ?? { runs: 0, fails: 0, passes: 0, errors: 0 };
    const failedTotal = (stats.fails ?? 0) + (stats.errors ?? 0);
    createNotification({
      severity: 'info',
      title: `Monitor ended: ${monitor.name}`,
      body: `The monitor finished its window: ${stats.runs ?? 0} run(s), ${failedTotal} fail/error outcome(s).`,
      source: 'Monitor',
      link: `/monitors/${monitor.id}`,
    });
    if (monitor.monitor_thread_ext) {
      const conv = getConversation(monitor.monitor_thread_ext);
      if (conv) setConversationStatus(conv.id, 'completed');
    }
  }
  return expired;
}

function notifyStateChange(previous: MonitorRow, outcome: MonitorOutcome, summary: string): void {
  if (previous.last_outcome === outcome) return;
  if (previous.last_outcome == null && outcome === 'pass') return;

  if (outcome === 'pass') {
    createNotification({
      severity: 'success',
      title: `Monitor recovered: ${previous.name}`,
      body: summary,
      source: 'Monitor',
      link: `/monitors/${previous.id}`,
    });
    return;
  }

  createNotification({
    severity: outcome === 'fail' ? 'error' : 'warning',
    title: outcome === 'fail' ? `Monitor failed: ${previous.name}` : `Monitor errored: ${previous.name}`,
    body: summary,
    source: 'Monitor',
    link: `/monitors/${previous.id}`,
  });
}

export function recordMonitorRunOutcome(
  runId: number,
  args: {
    outcome: MonitorOutcome;
    summary: string;
    detail?: string | null;
    raw?: string | null;
    error?: string | null;
  },
): MonitorRunRow {
  const run = getMonitorRun(runId);
  if (!run) throw new Error(`Monitor run ${runId} not found`);
  if (run.outcome !== null) return run;
  const monitor = getMonitor(run.monitor_id);
  if (!monitor) throw new Error(`Monitor ${run.monitor_id} not found`);

  const summary = args.summary.trim().slice(0, 500) || (args.outcome === 'pass' ? 'Monitor passed' : 'Monitor did not pass');
  completeRunStmt.run(
    args.outcome,
    summary,
    args.detail?.trim().slice(0, 4000) || null,
    args.raw?.slice(0, 20_000) || null,
    args.error?.slice(0, 2000) || null,
    runId,
  );

  const fails = args.outcome === 'pass' ? 0 : monitor.consecutive_fails + 1;
  updateMonitorOutcomeStmt.run(fails, args.outcome, stateKey(args.outcome, summary), monitor.id);
  notifyStateChange(monitor, args.outcome, summary);

  const completed = getMonitorRun(runId);
  const updatedMonitor = getMonitor(monitor.id);
  if (!completed || !updatedMonitor) throw new Error('Failed to reload monitor run after update');
  emitRun('updated', completed);
  emitMonitor('updated', updatedMonitor);
  return completed;
}

function parseMonitorEnvelope(raw: string): { outcome: MonitorOutcome; summary: string; detail: string | null } {
  const finalLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!finalLine) {
    return {
      outcome: 'error',
      summary: 'Monitor reply did not contain a valid result envelope',
      detail: 'The assistant response was empty.',
    };
  }
  try {
    const parsed = JSON.parse(finalLine) as Record<string, unknown>;
    const status = parsed.status ?? parsed.outcome;
    if (status !== 'pass' && status !== 'fail' && status !== 'error') {
      return {
        outcome: 'error',
        summary: 'Monitor reply did not contain a valid result envelope',
        detail: `Invalid status in final JSON line: ${String(status)}`,
      };
    }
    if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
      return {
        outcome: 'error',
        summary: 'Monitor reply did not contain a valid result envelope',
        detail: 'Final JSON line must include a non-empty string summary.',
      };
    }
    if (parsed.detail !== undefined && parsed.detail !== null && typeof parsed.detail !== 'string') {
      return {
        outcome: 'error',
        summary: 'Monitor reply did not contain a valid result envelope',
        detail: 'Final JSON line detail must be a string when present.',
      };
    }
    return {
      outcome: status,
      summary: parsed.summary.trim(),
      detail: typeof parsed.detail === 'string' ? parsed.detail.trim() : null,
    };
  } catch (err) {
    return {
      outcome: 'error',
      summary: 'Monitor reply did not contain a valid result envelope',
      detail: toErrorMessage(err),
    };
  }
}

function composeMonitorRunPrompt(monitor: MonitorRow): string {
  return [
    'You are running a scheduled Cockpit Monitor check for Kevin.',
    '',
    `Monitor: ${monitor.name}`,
    `Cadence: every ${monitor.cadence_minutes} minute(s)`,
    `Current run time (UTC): ${new Date().toISOString()}`,
    monitor.expires_at ? `Monitor expires at (UTC): ${monitor.expires_at}` : 'Monitor expiration: none',
    '',
    'Check prompt:',
    monitor.prompt,
    '',
    'Rules:',
    '- Use only read-only inspection unless Kevin explicitly authorized a write in the monitor prompt.',
    '- Do not make external sends, production changes, data deletions, branch merges, or purchases.',
    '- Use existing JARVIS tools and local CLI/subscription auth only; never use provider API keys or SDKs.',
    '- Decide pass/fail from the prompt. If you cannot determine the answer, report fail with the ambiguity in detail.',
    '- Your final non-empty line MUST be exactly one JSON object with this shape:',
    '{"status":"pass|fail","summary":"short human-readable result","detail":"supporting detail"}',
    '- Do not put markdown fences around the JSON envelope.',
  ].join('\n');
}

function timeoutMs(): number {
  const raw = Number(process.env.MONITOR_RUN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : DEFAULT_TIMEOUT_MS;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`Monitor run timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runMonitorRun(runId: number): Promise<void> {
  const run = getMonitorRun(runId);
  if (!run || run.outcome !== null) return;
  const monitor = getMonitor(run.monitor_id);
  if (!monitor) {
    recordMonitorRunOutcome(runId, {
      outcome: 'error',
      summary: 'Monitor row disappeared before the run executed',
    });
    return;
  }
  if (runningMonitorIds.has(monitor.id)) return;
  runningMonitorIds.add(monitor.id);
  try {
    if (!processMessageRef) {
      recordMonitorRunOutcome(runId, {
        outcome: 'error',
        summary: 'Monitor scheduler is not initialized',
      });
      return;
    }
    const conv = ensureMonitorConversation(monitor);
    const messageId = `turn:${conv.id}:${countTurns(conv.id)}`;
    setRunMessageStmt.run(messageId, runId);
    const prompt = composeMonitorRunPrompt(monitor);
    const raw = await withTimeout(
      processMessageRef(prompt, conv.external_id, messageId),
      timeoutMs(),
      () => abortConversationRunRef?.(conv.id),
    );
    const parsed = parseMonitorEnvelope(raw);
    recordMonitorRunOutcome(runId, {
      outcome: parsed.outcome,
      summary: parsed.summary,
      detail: parsed.detail,
      raw,
      error: parsed.outcome === 'error' ? parsed.detail : null,
    });
  } catch (err) {
    recordMonitorRunOutcome(runId, {
      outcome: 'error',
      summary: 'Monitor run failed to execute',
      detail: toErrorMessage(err),
      error: toErrorMessage(err),
    });
  } finally {
    runningMonitorIds.delete(monitor.id);
  }
}

export function runMonitorNow(id: number): { status: 'started' | 'already_running' | 'not_found'; run?: MonitorRunRow } {
  const monitor = getMonitor(id);
  if (!monitor) return { status: 'not_found' };
  const open = openRunStmt.get(id);
  if (open) return { status: 'already_running', run: open };
  const run = beginMonitorRun(monitor, sqliteNow());
  void runMonitorRun(run.id).catch((err) => console.error(`[monitors] run-now failed for ${id}:`, err));
  return { status: 'started', run };
}

function sweepStaleRuns(now = new Date()): void {
  const cutoff = sqliteNow(new Date(now.getTime() - timeoutMs()));
  for (const run of staleOpenRunsStmt.all(cutoff)) {
    recordMonitorRunOutcome(run.id, {
      outcome: 'error',
      summary: 'Monitor run timed out before completion',
      detail: `No outcome was recorded within ${Math.round(timeoutMs() / 1000)}s.`,
      error: 'timeout',
    });
  }
}

export async function monitorSchedulerTick(reason = 'interval'): Promise<void> {
  if (schedulerTicking) return;
  schedulerTicking = true;
  try {
    sweepStaleRuns();
    expireCompletedMonitors();
    const runs = claimDueMonitorRuns();
    for (const run of runs) {
      void runMonitorRun(run.id).catch((err) =>
        console.error(`[monitors] run failed (${reason}) run=${run.id}:`, err),
      );
    }
  } finally {
    schedulerTicking = false;
  }
}

export function startMonitorScheduler(processMessage: ProcessMessageFn, abortConversationRun: AbortConversationRunFn): void {
  if (schedulerStarted) return;
  processMessageRef = processMessage;
  abortConversationRunRef = abortConversationRun;
  schedulerStarted = true;
  setInterval(() => void monitorSchedulerTick('interval'), POLL_INTERVAL_MS).unref?.();
  queueMicrotask(() => void monitorSchedulerTick('startup'));
  console.log(`[monitors] started · interval=${POLL_INTERVAL_MS / 1000}s batch=${DUE_BATCH_LIMIT}`);
}

export function getMonitorDigest(hours = 24): MonitorDigestEntry[] {
  const safeHours = Math.max(1, Math.min(Math.floor(hours), 24 * 30));
  const cutoff = sqliteNow(new Date(Date.now() - safeHours * 60 * 60 * 1000));
  return listMonitors('all').map((monitor) => {
    const stats = digestStatsStmt.get(monitor.id, cutoff) ?? { runs: 0, fails: 0, passes: 0, errors: 0 };
    const latest = latestRunStmt.get(monitor.id) ?? null;
    return {
      id: monitor.id,
      name: monitor.name,
      status: monitor.status,
      cadence_minutes: monitor.cadence_minutes,
      expires_at: monitor.expires_at,
      last_run_at: monitor.last_run_at,
      last_outcome: monitor.last_outcome,
      last_summary: latest?.summary ?? null,
      consecutive_fails: monitor.consecutive_fails,
      runs: stats.runs ?? 0,
      passes: stats.passes ?? 0,
      fails: stats.fails ?? 0,
      errors: stats.errors ?? 0,
    };
  });
}
