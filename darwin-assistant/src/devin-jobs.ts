import { readFileSync, statSync } from 'node:fs';
import { sqliteDb, getSetting } from './conversation-db.js';
import { sseBus, type DevinJobEvent } from './sse-bus.js';
import { createDevinSession, sendDevinMessage, type DevinMode, type DevinSession } from './devin-client.js';

// DEVIN JOBS STORE — local ledger of Devin cloud sessions dispatched from
// JARVIS (docs/devin-jobs/CONTRACT.md section 5). Modeled on hopper.ts: a
// small SQLite-backed operational table with emit-on-write CRUD. Devin's
// `structured_output` is UNTRUSTED external-agent output — it is stored as
// opaque JSON text here and must be framed as quoted data by any caller that
// folds it into a Hopper node finish (see devin-jobs-reconciler.ts).

export type DevinJobStatus =
  | 'local_pending'
  | 'create_failed'
  | 'new'
  | 'claimed'
  | 'running'
  | 'exit'
  | 'error'
  | 'suspended'
  | 'resuming';

export interface DevinJobRow {
  id: number;
  session_id: string | null;
  title: string;
  prompt_summary: string;
  devin_mode: string;
  status: string;
  status_detail: string | null;
  acus_consumed: number;
  session_url: string | null;
  structured_output: string | null; // JSON text — untrusted, see note above
  tags: string; // JSON text array
  node_id: number | null;
  thread_ext: string | null;
  created_at: string;
  settled_at: string | null;
}

export interface DevinJobApi {
  id: number;
  session_id: string | null;
  title: string;
  prompt_summary: string;
  devin_mode: string;
  status: string;
  status_detail: string | null;
  acus_consumed: number;
  session_url: string | null;
  structured_output: unknown;
  tags: string[];
  node_id: number | null;
  thread_ext: string | null;
  created_at: string;
  settled_at: string | null;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS devin_jobs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          TEXT UNIQUE,
    title               TEXT NOT NULL,
    prompt_summary      TEXT NOT NULL,
    devin_mode          TEXT NOT NULL DEFAULT 'lite',
    status              TEXT NOT NULL DEFAULT 'local_pending',
    status_detail       TEXT,
    acus_consumed       REAL NOT NULL DEFAULT 0,
    session_url         TEXT,
    structured_output   TEXT,
    tags                TEXT NOT NULL DEFAULT '[]',
    node_id             INTEGER,
    thread_ext          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    settled_at          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_devin_jobs_status ON devin_jobs(status, settled_at);
  CREATE INDEX IF NOT EXISTS idx_devin_jobs_node_id ON devin_jobs(node_id);
  CREATE INDEX IF NOT EXISTS idx_devin_jobs_thread_ext ON devin_jobs(thread_ext);
`);

const DEFAULT_MAX_CONCURRENT = 2;
const DEVIN_USAGE_FILE = process.env.DEVIN_USAGE_FILE ?? '/tmp/devin-usage-live.json';

const insertLocalPendingStmt = sqliteDb.prepare<
  [string, string, string, string, number | null, string | null]
>(`
  INSERT INTO devin_jobs (title, prompt_summary, devin_mode, tags, node_id, thread_ext)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const getByIdStmt = sqliteDb.prepare<[number], DevinJobRow>(`SELECT * FROM devin_jobs WHERE id = ?`);

const listAllStmt = sqliteDb.prepare<[number], DevinJobRow>(`
  SELECT * FROM devin_jobs ORDER BY created_at DESC, id DESC LIMIT ?
`);
const listActiveStmt = sqliteDb.prepare<[number], DevinJobRow>(`
  SELECT * FROM devin_jobs WHERE settled_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?
`);
const listSettledStmt = sqliteDb.prepare<[number], DevinJobRow>(`
  SELECT * FROM devin_jobs WHERE settled_at IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT ?
`);

const countActiveStmt = sqliteDb.prepare<[], { n: number }>(`
  SELECT COUNT(*) AS n FROM devin_jobs
  WHERE settled_at IS NULL AND status NOT IN ('exit', 'error', 'suspended', 'create_failed')
`);

const listUnsettledStmt = sqliteDb.prepare<[], DevinJobRow>(`
  SELECT * FROM devin_jobs WHERE session_id IS NOT NULL AND settled_at IS NULL ORDER BY created_at ASC
`);

const attachSessionStmt = sqliteDb.prepare<
  [string, string, string | null, number, string | null, string | null, string, number]
>(`
  UPDATE devin_jobs
  SET session_id = ?, status = ?, status_detail = ?, acus_consumed = ?, session_url = ?,
      structured_output = ?, tags = ?
  WHERE id = ?
`);

const updateFromSessionStmt = sqliteDb.prepare<
  [string, string | null, number, string | null, string | null, string, number]
>(`
  UPDATE devin_jobs
  SET status = ?, status_detail = ?, acus_consumed = ?, session_url = ?, structured_output = ?, tags = ?
  WHERE id = ?
`);

const markCreateFailedStmt = sqliteDb.prepare<[string, number]>(`
  UPDATE devin_jobs SET status = 'create_failed', status_detail = ?, settled_at = datetime('now') WHERE id = ?
`);

const markSettledStmt = sqliteDb.prepare<[number]>(`
  UPDATE devin_jobs SET settled_at = datetime('now') WHERE id = ?
`);

const markGoneStmt = sqliteDb.prepare<[number]>(`
  UPDATE devin_jobs SET status = 'error', status_detail = 'session_not_found' WHERE id = ?
`);

function emit(action: DevinJobEvent['action'], job: DevinJobRow): void {
  sseBus.emit('sse', { type: 'devin_job', action, job } satisfies DevinJobEvent);
}

export function getDevinJob(id: number): DevinJobRow | null {
  return getByIdStmt.get(id) ?? null;
}

export function listDevinJobs(filter: 'active' | 'settled' | 'all' = 'all', limit = 100): DevinJobRow[] {
  const n = Math.max(1, Math.min(limit, 500));
  if (filter === 'active') return listActiveStmt.all(n);
  if (filter === 'settled') return listSettledStmt.all(n);
  return listAllStmt.all(n);
}

export function countActiveDevinJobs(): number {
  return countActiveStmt.get()?.n ?? 0;
}

export function listUnsettledDevinJobs(): DevinJobRow[] {
  return listUnsettledStmt.all();
}

function safeJsonParse(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeJsonParseArray(text: string): string[] {
  const parsed = safeJsonParse(text);
  return Array.isArray(parsed) ? (parsed as unknown[]).filter((v): v is string => typeof v === 'string') : [];
}

export function serializeDevinJob(row: DevinJobRow): DevinJobApi {
  return {
    ...row,
    structured_output: safeJsonParse(row.structured_output),
    tags: safeJsonParseArray(row.tags),
  };
}

/** System tags every job carries + hopper-linkage tags + Kevin's extra tags, deduped. */
export function buildDevinJobTags(extra: string[] | undefined, nodeId: number | null | undefined): string[] {
  const tags = new Set<string>(['jarvis', 'devin-jobs']);
  if (nodeId != null) {
    tags.add('hopper');
    tags.add(`hopper-node-${nodeId}`);
  }
  for (const t of extra ?? []) {
    const trimmed = t.trim();
    if (trimmed) tags.add(trimmed);
  }
  return Array.from(tags);
}

export interface DevinConcurrencyGate {
  active_jobs: number;
  max_concurrent: number;
  blocked: boolean;
}

/** settings-KV `devin_max_concurrent` (default 2) vs. currently-active local jobs. */
export function resolveDevinConcurrencyGate(): DevinConcurrencyGate {
  const raw = getSetting('devin_max_concurrent');
  const parsed = raw != null && raw.trim() !== '' ? parseInt(raw, 10) : NaN;
  // `0` is an explicit kill switch (no new sessions at all); unset/garbage
  // falls back to the default. Negative values are treated as garbage.
  const maxConcurrent = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_CONCURRENT;
  const activeJobs = countActiveDevinJobs();
  return { active_jobs: activeJobs, max_concurrent: maxConcurrent, blocked: activeJobs >= maxConcurrent };
}

export interface DevinAcuGate {
  cycle_acus_used: number | null;
  acu_ceiling: number | null;
  /** Per-session `max_acu_limit` to hand Devin (CONTRACT.md 4.2): the smaller
   *  of settings-KV `devin_job_max_acu` and the ACUs remaining before the
   *  ceiling. null = neither is known → don't send one. */
  session_acu_limit: number | null;
  blocked: boolean;
  /** Why `blocked` is true: the ceiling is reached, or a ceiling is configured
   *  but the usage meter is missing/stale/errored (fail-closed — the account
   *  has hit usage_limit_exceeded before, so "unknown" is not "fine"). */
  block_reason: 'ceiling_reached' | 'usage_unknown' | null;
}

// Usage snapshots older than this are treated as unknown when a ceiling is
// configured — same posture as the Claude governor's usage-staleness hold.
const DEVIN_USAGE_STALE_MS = 10 * 60 * 1000;

function readDevinUsedAcus(): number | null {
  try {
    const st = statSync(DEVIN_USAGE_FILE);
    const raw = JSON.parse(readFileSync(DEVIN_USAGE_FILE, 'utf8')) as { used_acus?: unknown; updated_at?: unknown };
    const updatedMs =
      typeof raw.updated_at === 'number' && Number.isFinite(raw.updated_at) ? raw.updated_at * 1000 : st.mtimeMs;
    if (Date.now() - updatedMs > DEVIN_USAGE_STALE_MS) return null;
    return typeof raw.used_acus === 'number' && Number.isFinite(raw.used_acus) ? raw.used_acus : null;
  } catch {
    return null;
  }
}

function positiveSetting(key: string): number | null {
  const raw = getSetting(key);
  const parsed = raw != null && raw.trim() !== '' ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** ACU ceiling resolution per CONTRACT.md section 6.2: `gov_devin_acu_ceiling`
 *  if set, else `devin_acu_pool`, else no ceiling (usage still shown, not gated).
 *  When a ceiling IS set, an unknown/stale usage reading blocks (fail-closed). */
export function resolveDevinAcuGate(): DevinAcuGate {
  const acuCeiling = positiveSetting('gov_devin_acu_ceiling') ?? positiveSetting('devin_acu_pool');
  const used = readDevinUsedAcus();
  const perJob = positiveSetting('devin_job_max_acu');
  const remaining = acuCeiling != null && used != null ? Math.max(0, acuCeiling - used) : null;
  const candidates = [perJob, remaining].filter((v): v is number => v != null && v > 0);
  const sessionAcuLimit = candidates.length ? Math.min(...candidates) : null;
  let blockReason: DevinAcuGate['block_reason'] = null;
  if (acuCeiling != null) {
    if (used == null) blockReason = 'usage_unknown';
    else if (used >= acuCeiling) blockReason = 'ceiling_reached';
  }
  return {
    cycle_acus_used: used,
    acu_ceiling: acuCeiling,
    session_acu_limit: sessionAcuLimit,
    blocked: blockReason != null,
    block_reason: blockReason,
  };
}

/** Refuses text that carries one of OUR secrets (CONTRACT.md section 12: never
 *  put DEVIN_API_KEY / JARVIS_COCKPIT_KEY / provider tokens in a Devin prompt).
 *  Cheap literal check against the live env values — catches the copy-paste
 *  accident, not a determined exfiltration. */
export function textCarriesLocalSecret(text: string): boolean {
  const secrets = [process.env.DEVIN_API_KEY, process.env.JARVIS_COCKPIT_KEY, process.env.PAPERCLIP_BOARD_API_KEY];
  for (const s of secrets) {
    const v = s?.trim();
    if (v && v.length >= 12 && text.includes(v)) return true;
  }
  return false;
}

export function insertLocalPendingDevinJob(args: {
  title: string;
  promptSummary: string;
  devinMode: DevinMode;
  tags: string[];
  nodeId: number | null;
  threadExt: string | null;
}): DevinJobRow {
  const info = insertLocalPendingStmt.run(
    args.title,
    args.promptSummary,
    args.devinMode,
    JSON.stringify(args.tags),
    args.nodeId,
    args.threadExt,
  );
  const row = getDevinJob(Number(info.lastInsertRowid));
  if (!row) throw new Error('Failed to load devin_jobs row after insert');
  emit('created', row);
  return row;
}

/** First sync after Devin's create-session response — attaches session_id. */
export function attachDevinSession(id: number, session: DevinSession): DevinJobRow | null {
  attachSessionStmt.run(
    session.session_id,
    session.status,
    session.status_detail ?? null,
    typeof session.acus_consumed === 'number' ? session.acus_consumed : 0,
    session.url ?? null,
    session.structured_output !== undefined ? JSON.stringify(session.structured_output) : null,
    JSON.stringify(session.tags ?? []),
    id,
  );
  const updated = getDevinJob(id);
  if (updated) emit('updated', updated);
  return updated;
}

/** Reconciler / message-send sync — session_id already set, field refresh only. */
export function updateDevinJobFromSession(id: number, session: DevinSession): DevinJobRow | null {
  updateFromSessionStmt.run(
    session.status,
    session.status_detail ?? null,
    typeof session.acus_consumed === 'number' ? session.acus_consumed : 0,
    session.url ?? null,
    session.structured_output !== undefined ? JSON.stringify(session.structured_output) : null,
    JSON.stringify(session.tags ?? []),
    id,
  );
  const updated = getDevinJob(id);
  if (updated) emit('updated', updated);
  return updated;
}

/** Remote create-session call failed — settle the local row so it doesn't sit
 *  as a phantom "active" job forever (it never got a session_id, so the
 *  reconciler will never see it). */
export function markDevinJobCreateFailed(id: number, reason: string): DevinJobRow | null {
  markCreateFailedStmt.run(reason.slice(0, 500), id);
  const updated = getDevinJob(id);
  if (updated) emit('updated', updated);
  return updated;
}

/** Devin reports the session no longer exists — stamp the row so the board
 *  shows WHY it settled (status error / session_not_found). Caller settles it. */
export function markDevinJobGone(id: number): DevinJobRow | null {
  markGoneStmt.run(id);
  return getDevinJob(id);
}

export function markDevinJobSettled(id: number): DevinJobRow | null {
  markSettledStmt.run(id);
  const updated = getDevinJob(id);
  if (updated) emit('updated', updated);
  return updated;
}

export class DevinSessionMissing extends Error {
  readonly code = 'devin_session_missing' as const;
  readonly status = 409 as const;
  constructor() {
    super('This job has no Devin session yet (create is still in flight or failed).');
    this.name = 'DevinSessionMissing';
  }
}

/** Full create flow: insert local_pending row → call Devin → attach the
 *  session, or mark create_failed and rethrow if the remote call errors.
 *  Callers (the route) are responsible for the concurrency/ACU gate checks
 *  BEFORE calling this — this function does not re-check them. */
export async function createDevinJobAndDispatch(args: {
  title: string;
  prompt: string;
  devinMode: DevinMode;
  schema?: Record<string, unknown> | null;
  tags?: string[];
  nodeId?: number | null;
  threadExt?: string | null;
  /** Per-session ACU cap handed to Devin (`max_acu_limit`). Omit/null = none. */
  maxAcuLimit?: number | null;
}): Promise<DevinJobRow> {
  const tags = buildDevinJobTags(args.tags, args.nodeId ?? null);
  const promptSummary = args.prompt.length > 240 ? `${args.prompt.slice(0, 237)}...` : args.prompt;
  const local = insertLocalPendingDevinJob({
    title: args.title,
    promptSummary,
    devinMode: args.devinMode,
    tags,
    nodeId: args.nodeId ?? null,
    threadExt: args.threadExt ?? null,
  });
  try {
    const session = await createDevinSession({
      title: args.title,
      prompt: args.prompt,
      devin_mode: args.devinMode,
      structured_output_schema: args.schema ?? undefined,
      tags,
      max_acu_limit: args.maxAcuLimit ?? undefined,
    });
    const attached = attachDevinSession(local.id, session);
    return attached ?? local;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Devin session create failed';
    markDevinJobCreateFailed(local.id, message);
    throw err;
  }
}

/** Sends a follow-up message on an existing job's Devin session and syncs the
 *  local row from the response. Throws DevinSessionMissing if the job never
 *  got a session_id (create still pending or failed). Caller (route) handles
 *  the 404-for-unknown-job case before calling this. */
export async function sendDevinJobMessageAndSync(id: number, message: string): Promise<DevinJobRow> {
  const job = getDevinJob(id);
  if (!job) throw new Error(`devin_jobs row ${id} not found`);
  if (!job.session_id) throw new DevinSessionMissing();
  const session = await sendDevinMessage(job.session_id, message);
  const updated = updateDevinJobFromSession(id, session);
  return updated ?? job;
}
