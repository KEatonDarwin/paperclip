import { execFile } from 'node:child_process';
import {
  sqliteDb,
  getOrCreateConversation,
  getConversation,
  getConversationById,
  getSetting,
  renameConversation,
  setConversationStatus,
  setThreadDisplay,
  addTurn,
} from './conversation-db.js';
import { createNotification, type NotificationRow } from './notifications.js';
import { sseBus, type NudgeEvent } from './sse-bus.js';

export const NUDGE_THREAD_EXTERNAL_ID = 'cockpit:jarvis-nudges';
const NUDGE_THREAD_TITLE = 'JARVIS Nudges';
const DEFAULT_WHY =
  'the source workflow marked this as needing your decision, and guessing would change the requested scope or behavior.';

const VALID_SOURCES = ['blocked_question', 'unblocker', 'finishline_shortfall', 'commitment', 'manual'] as const;
export type NudgeSource = (typeof VALID_SOURCES)[number];
export type NudgeStatus = 'pending' | 'delivered' | 'resolved';

export interface NudgeAnswerRoute {
  method: string;
  path: string;
  body_template?: Record<string, unknown>;
}

export interface NudgeContext {
  summary?: string;
  why_jarvis_could_not_clear?: string;
  answer_route?: NudgeAnswerRoute;
  source_link?: string;
  notification_id?: number;
  [key: string]: unknown;
}

export interface NudgeRow {
  id: number;
  source: NudgeSource;
  subject_ref: string;
  context_json: string;
  status: NudgeStatus;
  turn_id: number | null;
  created_at: string;
  resolved_at: string | null;
}

export interface CreateNudgeArgs {
  source: NudgeSource;
  subject_ref: string;
  context?: NudgeContext;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS nudges (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source       TEXT NOT NULL CHECK (
      source IN ('blocked_question','unblocker','finishline_shortfall','commitment','manual')
    ),
    subject_ref  TEXT NOT NULL,
    context_json TEXT NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','resolved')),
    turn_id      INTEGER,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at  TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_nudges_open_subject
    ON nudges(source, subject_ref)
    WHERE status != 'resolved';

  CREATE INDEX IF NOT EXISTS idx_nudges_status_created
    ON nudges(status, created_at DESC, id DESC);
`);

const insertStmt = sqliteDb.prepare<[NudgeSource, string, string]>(`
  INSERT INTO nudges (source, subject_ref, context_json)
  VALUES (?, ?, ?)
`);

const getByIdStmt = sqliteDb.prepare<[number], NudgeRow>(`SELECT * FROM nudges WHERE id = ?`);
const getOpenBySubjectStmt = sqliteDb.prepare<[NudgeSource, string], NudgeRow>(`
  SELECT * FROM nudges
  WHERE source = ? AND subject_ref = ? AND status != 'resolved'
  ORDER BY id DESC
  LIMIT 1
`);
// M-4: DB-level single-writer guard — only the first materializer to reach this
// UPDATE wins (turn_id IS NULL). A late concurrent writer gets changes === 0 and
// discards its (now-orphan) turn instead of overwriting the winner's turn_id.
const setTurnStmt = sqliteDb.prepare<[number, number]>(`
  UPDATE nudges SET turn_id = ? WHERE id = ? AND turn_id IS NULL
`);
const deleteTurnStmt = sqliteDb.prepare<[number]>(`DELETE FROM turns WHERE id = ?`);
const turnIdByIndexStmt = sqliteDb.prepare<[number, number], { id: number }>(`
  SELECT id FROM turns WHERE conversation_id = ? AND turn_index = ?
`);
const listAllStmt = sqliteDb.prepare<[number], NudgeRow>(`
  SELECT * FROM nudges ORDER BY created_at DESC, id DESC LIMIT ?
`);
const listStatusStmt = sqliteDb.prepare<[NudgeStatus, number], NudgeRow>(`
  SELECT * FROM nudges WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?
`);
const listOpenStmt = sqliteDb.prepare<[number], NudgeRow>(`
  SELECT * FROM nudges
  WHERE status IN ('pending', 'delivered')
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`);
const countsStmt = sqliteDb.prepare<[], { open: number; pending: number }>(`
  SELECT
    SUM(CASE WHEN status IN ('pending', 'delivered') THEN 1 ELSE 0 END) AS open,
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
  FROM nudges
`);
const markDeliveredStmt = sqliteDb.prepare<[number]>(`
  UPDATE nudges
  SET status = 'delivered'
  WHERE id = ? AND status = 'pending'
`);
const markResolvedStmt = sqliteDb.prepare<[number]>(`
  UPDATE nudges
  SET status = 'resolved', resolved_at = COALESCE(resolved_at, datetime('now'))
  WHERE id = ? AND status != 'resolved'
`);
const deleteStmt = sqliteDb.prepare<[number]>(`DELETE FROM nudges WHERE id = ?`);

export function isNudgeSource(value: unknown): value is NudgeSource {
  return typeof value === 'string' && (VALID_SOURCES as readonly string[]).includes(value);
}

export function isNudgeStatus(value: unknown): value is NudgeStatus {
  return value === 'pending' || value === 'delivered' || value === 'resolved';
}

export function parseNudgeContext(row: NudgeRow): NudgeContext {
  try {
    const parsed = JSON.parse(row.context_json) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as NudgeContext : {};
  } catch {
    return {};
  }
}

function emit(action: NudgeEvent['action'], nudge: NudgeRow): void {
  sseBus.emit('sse', { type: 'nudge', action, nudge } satisfies NudgeEvent);
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(500, Number.isFinite(limit ?? NaN) ? Math.trunc(limit!) : 100));
}

export function nudgeCounts(): { open: number; pending: number } {
  const row = countsStmt.get();
  return { open: row?.open ?? 0, pending: row?.pending ?? 0 };
}

export function listNudges(status?: NudgeStatus | 'open', limit?: number): NudgeRow[] {
  const safeLimit = clampLimit(limit);
  if (status === 'open') return listOpenStmt.all(safeLimit);
  if (status) return listStatusStmt.all(status, safeLimit);
  return listAllStmt.all(safeLimit);
}

export function getNudge(id: number): NudgeRow | null {
  return getByIdStmt.get(id) ?? null;
}

// M-1: the reply loop is server-owned. On every turn in the nudge thread we
// splice a fresh <jarvis_nudges> block (open nudges, newest first) plus the
// NUDGE.md §Reply Loop instructions into the prompt, so the replying model knows
// exactly which nudge Kevin is answering and how to apply + resolve it. This
// works identically on transcript-replay and on --resume, because it is rebuilt
// from the DB each turn rather than relying on an out-of-band assistant turn
// that a resumed session never re-sees. The DB footer stays for audit.
export function buildNudgeReplyContext(externalId: string): string {
  if (externalId !== NUDGE_THREAD_EXTERNAL_ID) return '';
  const open = listNudges('open', 50);
  const lines: string[] = [
    '<jarvis_nudges>',
    'You are in the global JARVIS Nudges thread (cockpit:jarvis-nudges). Kevin opens',
    'this to answer things you flagged as needing him — each one below could not be',
    'cleared without his call.',
    '',
  ];
  if (open.length === 0) {
    lines.push('There are no open nudges right now. Respond normally.');
    lines.push('</jarvis_nudges>');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('Open nudges (newest first):');
  for (const n of open) {
    const ctx = parseNudgeContext(n);
    const route = normalizeAnswerRoute(ctx.answer_route);
    const summary = cleanString(ctx.summary, 500) ?? n.subject_ref;
    const why = cleanString(ctx.why_jarvis_could_not_clear, 1000) ?? DEFAULT_WHY;
    lines.push(
      `- nudge #${n.id} [${n.source}] subject=${n.subject_ref} status=${n.status} created=${n.created_at}`,
      `    summary: ${summary}`,
      `    why I could not clear it: ${why}`,
      `    answer_route: ${route.method} ${route.path || '(none)'} body=${JSON.stringify(route.body_template ?? { answer: '$KEVIN_REPLY' })}`,
    );
  }
  lines.push(
    '',
    'Reply loop (apply Kevin\'s answer, then resolve):',
    '1. Match Kevin\'s reply to the most recent open nudge above, unless he names',
    '   another one by its subject.',
    '2. Call that nudge\'s answer_route, substituting Kevin\'s reply for the',
    '   "$KEVIN_REPLY" placeholder in body_template. If answer_route.method is',
    '   "manual" (or the path is empty), do not call an endpoint — just confirm',
    '   receipt and, if appropriate, resolve it manually or open a follow-up task.',
    '3. If the answer route succeeds, PATCH /api/v1/nudges/<id> {"status":"resolved"}.',
    '4. Add a short first-person confirmation here in this thread.',
    '5. If the reply is ambiguous, ask one short clarifying question here and do',
    '   nothing else. If applying the answer fails, leave the nudge delivered, tell',
    '   Kevin plainly, and do not PATCH it resolved.',
    '</jarvis_nudges>',
    '',
  );
  return lines.join('\n');
}

export function ensureNudgeThread() {
  // M-3(b): if the auto-hide sweep (or anything else) archived the nudge thread,
  // reactivate the SAME row. Otherwise getOrCreateConversation() falls through to
  // INSERT and hits `UNIQUE constraint failed: conversations.external_id`, which
  // is the 500 that leaves ghost open nudges behind. Only reactivate 'archived';
  // a 'closed' row is intentional and handled by getOrCreateConversation.
  const prior = getConversation(NUDGE_THREAD_EXTERNAL_ID);
  if (prior && prior.status === 'archived') {
    setConversationStatus(prior.id, 'active');
  }
  const conv = getOrCreateConversation(NUDGE_THREAD_EXTERNAL_ID);
  if (!conv.title) renameConversation(conv.id, NUDGE_THREAD_TITLE);
  if (!conv.headline || !conv.border_color) {
    setThreadDisplay(conv.id, { headline: 'JARVIS needs your call', borderColor: '#f59e0b' });
  }
  return getConversationById(conv.id) ?? conv;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanString(value: unknown, max = 2000): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function normalizeAnswerRoute(value: unknown): NudgeAnswerRoute {
  const obj = asObject(value);
  const method = cleanString(obj?.method, 20) ?? 'manual';
  const path = cleanString(obj?.path, 1000) ?? '';
  const bodyTemplate = asObject(obj?.body_template);
  return {
    method,
    path,
    body_template: bodyTemplate ?? { answer: '$KEVIN_REPLY' },
  };
}

function summaryFor(context: NudgeContext, subjectRef: string): string {
  return cleanString(context.summary, 500) ?? subjectRef;
}

function whyFor(context: NudgeContext): string {
  return cleanString(context.why_jarvis_could_not_clear, 1000) ?? DEFAULT_WHY;
}

function deterministicVisibleText(context: NudgeContext, subjectRef: string): string {
  return [
    `Kevin, I need your input on ${summaryFor(context, subjectRef)}.`,
    '',
    `I could not clear this myself because ${whyFor(context)}.`,
    '',
    "Reply here with the answer you want me to apply. I'll send it back to the original workflow and mark this nudge resolved.",
  ].join('\n');
}

function buildFooter(nudge: NudgeRow, context: NudgeContext): string {
  const footer = {
    nudge_id: nudge.id,
    source: nudge.source,
    subject_ref: nudge.subject_ref,
    answer_route: normalizeAnswerRoute(context.answer_route),
  };
  return `<!-- jarvis-nudge\n${JSON.stringify(footer)}\n-->`;
}

function nudgePrompt(nudge: NudgeRow, context: NudgeContext): string {
  return [
    'You are JARVIS, Kevin Eaton\'s personal AI chief of staff.',
    'Write one short first-person message asking Kevin for the exact input needed.',
    '',
    'Rules:',
    '- Sound like JARVIS, not a system alert.',
    '- Keep it under 150 words.',
    '- Explain what needs Kevin, why you could not clear it yourself, and what he can answer here.',
    '- Do not include markdown code fences.',
    '- Do not include machine-readable routing metadata or HTML comments.',
    '- Output only the visible message text.',
    '',
    'Nudge:',
    JSON.stringify({
      id: nudge.id,
      source: nudge.source,
      subject_ref: nudge.subject_ref,
      context,
    }, null, 2),
  ].join('\n');
}

function parseClaudeJson(stdout: string): string | null {
  // S-2: malformed JSON, an is_error result, or a non-string `result` must fall
  // through to the deterministic fallback — never surface raw stdout (stream-json
  // lines, CLI diagnostics) as the visible nudge message. cleanString() already
  // returns null for a non-string result.
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown; is_error?: unknown };
    if (parsed.is_error) return null;
    return cleanString(parsed.result, 4000);
  } catch {
    return null;
  }
}

function runComposer(prompt: string, model: string): Promise<string> {
  const bin = process.env.NUDGE_CLAUDE_BIN || process.env.CLAUDE_BIN || 'claude';
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // S-3: the composer only ever writes prose over untrusted embedded worker text
  // (hopper question, watchdog detail); it needs no tools and no MCP surface.
  // Lock both down, and never let a settings/env-supplied model that starts with
  // '-' be spliced in as its own argv flag (validated by the caller, defended
  // again here).
  const safeModel = model.startsWith('-') ? 'claude-sonnet-5' : model;
  const args = [
    '-p', prompt,
    '--model', safeModel,
    '--output-format', 'json',
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { env, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const parsed = parseClaudeJson(stdout);
        if (err) {
          if (parsed) resolve(parsed);
          else reject(new Error(`nudge composer failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 200)}` : ''}`));
          return;
        }
        if (!parsed) {
          reject(new Error('nudge composer returned empty or malformed output'));
          return;
        }
        resolve(parsed);
      },
    );
    child.stdin?.end();
  });
}

async function composeMessage(nudge: NudgeRow): Promise<string> {
  const context = parseNudgeContext(nudge);
  const fallback = deterministicVisibleText(context, nudge.subject_ref);
  const model = getSetting('nudge_model')?.trim() || process.env.NUDGE_MODEL || 'claude-sonnet-5';
  try {
    const visible = (await runComposer(nudgePrompt(nudge, context), model)).trim();
    return `${(visible || fallback).slice(0, 5000)}\n\n${buildFooter(nudge, context)}`;
  } catch {
    return `${fallback}\n\n${buildFooter(nudge, context)}`;
  }
}

function createdNotificationPayload(nudge: NudgeRow, context: NudgeContext): {
  severity: 'warning';
  title: string;
  body: string;
  source: string;
  link?: string;
  meta: { kind: 'needs_kevin'; sourceType: string; sourceId: string; nudgeId: number };
} {
  const sourceLink = cleanString(context.source_link, 1000);
  return {
    severity: 'warning',
    title: `JARVIS needs your call: ${summaryFor(context, nudge.subject_ref).slice(0, 100)}`,
    body: whyFor(context),
    source: 'jarvis-nudge',
    ...(sourceLink ? { link: sourceLink } : {}),
    meta: {
      kind: 'needs_kevin',
      sourceType: nudge.source,
      sourceId: nudge.subject_ref,
      nudgeId: nudge.id,
    },
  };
}

async function materializeNudge(nudge: NudgeRow): Promise<NudgeRow> {
  const conv = ensureNudgeThread();
  const message = await composeMessage(nudge);
  const turnIndex = addTurn(conv.id, 'assistant', message, undefined, undefined, undefined, {
    model: getSetting('nudge_model')?.trim() || process.env.NUDGE_MODEL || 'claude-sonnet-5',
  });
  const turnId = turnIdByIndexStmt.get(conv.id, turnIndex)?.id ?? turnIndex;
  // M-4: single-writer guard. If a concurrent materializer already claimed the
  // row (turn_id no longer NULL), our turn is an orphan — delete it so the thread
  // shows exactly one assistant turn per nudge.
  const res = setTurnStmt.run(turnId, nudge.id);
  if (res.changes === 0) deleteTurnStmt.run(turnId);
  const updated = getNudge(nudge.id);
  if (!updated) throw new Error('Failed to load nudge after materializing turn');
  return updated;
}

// M-4: coalesce concurrent materializations for one subject onto a single
// in-flight promise so three near-simultaneous POSTs against a slow composer
// compose once, not three times.
const inFlightMaterializations = new Map<string, Promise<NudgeRow>>();

function subjectKey(source: NudgeSource, subjectRef: string): string {
  return `${source} ${subjectRef}`;
}

function materializeOnce(nudge: NudgeRow): Promise<NudgeRow> {
  const key = subjectKey(nudge.source, nudge.subject_ref);
  const existing = inFlightMaterializations.get(key);
  if (existing) return existing;
  const p = materializeNudge(nudge).finally(() => {
    if (inFlightMaterializations.get(key) === p) inFlightMaterializations.delete(key);
  });
  inFlightMaterializations.set(key, p);
  return p;
}

export async function createNudge(args: CreateNudgeArgs): Promise<{
  nudge: NudgeRow;
  thread_external_id: string;
  notification?: NotificationRow;
  duplicate: boolean;
}> {
  if (!isNudgeSource(args.source)) throw new Error(`invalid nudge source: ${String(args.source)}`);
  const subjectRef = args.subject_ref.trim().slice(0, 500);
  if (!subjectRef) throw new Error('subject_ref is required');
  const context = args.context && typeof args.context === 'object' ? args.context : {};
  const existing = getOpenBySubjectStmt.get(args.source, subjectRef);
  if (existing) {
    // Heal a ghost (turn_id NULL from a prior failed compose) via the same
    // in-flight coalescer; otherwise return the existing row untouched.
    const nudge = existing.turn_id == null ? await materializeOnce(existing) : existing;
    return { nudge, thread_external_id: NUDGE_THREAD_EXTERNAL_ID, duplicate: true };
  }

  const info = insertStmt.run(args.source, subjectRef, JSON.stringify(context));
  const inserted = getNudge(Number(info.lastInsertRowid));
  if (!inserted) throw new Error('Failed to load nudge after insert');
  // M-3(c): materialize inside the same try as the insert. If the turn can never
  // be created (e.g. the thread can't be ensured), delete the just-inserted row
  // so GET /nudges?status=open never counts a ghost with no message behind it.
  let nudge: NudgeRow;
  try {
    nudge = await materializeOnce(inserted);
  } catch (err) {
    if (getNudge(inserted.id)?.turn_id == null) deleteStmt.run(inserted.id);
    throw err;
  }
  const notification =
    typeof context.notification_id === 'number'
      ? undefined
      : createNotification(createdNotificationPayload(nudge, context));
  emit('created', nudge);
  return { nudge, thread_external_id: NUDGE_THREAD_EXTERNAL_ID, notification, duplicate: false };
}

export function createNudgeAsync(args: CreateNudgeArgs): void {
  void createNudge(args).catch((err) => {
    console.error('[nudges] create failed:', err instanceof Error ? err.message : err);
  });
}

export function createBlockedQuestionNudge(args: {
  nodeId: number;
  treeId: string;
  title: string;
  question: string;
  notificationId?: number;
}): void {
  createNudgeAsync({
    source: 'blocked_question',
    subject_ref: `${args.treeId}/node-${args.nodeId}`,
    context: {
      summary: `hopper node #${args.nodeId}: ${args.title}`,
      why_jarvis_could_not_clear: args.question || DEFAULT_WHY,
      answer_route: {
        method: 'POST',
        path: `/api/v1/hopper-nodes/${args.nodeId}/answer`,
        body_template: { answer: '$KEVIN_REPLY' },
      },
      source_link: `/spawn-tree/${args.treeId}`,
      notification_id: args.notificationId,
    },
  });
}

export function createFinishLineShortfallNudge(subjectRef: string, context: NudgeContext = {}): void {
  createNudgeAsync({ source: 'finishline_shortfall', subject_ref: subjectRef, context });
}

export const createFinishlineShortfallNudge = createFinishLineShortfallNudge;

export function createUnblockerNudge(subjectRef: string, context: NudgeContext = {}): void {
  createNudgeAsync({ source: 'unblocker', subject_ref: subjectRef, context });
}

export function createCommitmentNudge(subjectRef: string, context: NudgeContext = {}): void {
  createNudgeAsync({ source: 'commitment', subject_ref: subjectRef, context });
}

export function markNudgeDelivered(id: number): NudgeRow | null {
  const existing = getNudge(id);
  if (!existing) return null;
  markDeliveredStmt.run(id);
  const updated = getNudge(id) ?? existing;
  if (updated.status !== existing.status) emit('updated', updated);
  return updated;
}

export function markNudgesDelivered(ids?: number[]): NudgeRow[] {
  const rows = ids?.length
    ? ids.map((id) => getNudge(id)).filter((row): row is NudgeRow => row !== null)
    : listNudges('pending', 500);
  return rows.map((row) => markNudgeDelivered(row.id) ?? row);
}

export function markNudgeResolved(id: number): NudgeRow | null {
  const existing = getNudge(id);
  if (!existing) return null;
  markResolvedStmt.run(id);
  const updated = getNudge(id) ?? existing;
  if (updated.status !== existing.status || updated.resolved_at !== existing.resolved_at) emit('updated', updated);
  return updated;
}

// M-2: resolve the open nudge for a producer subject when the source itself is
// answered/retried/settled, so answering at the source clears the bubble and a
// later re-block for the same subject is not deduped against a stale open row.
// Returns the resolved row (or null when there was no open nudge to resolve).
export function resolveNudgeBySubject(source: NudgeSource, subjectRef: string): NudgeRow | null {
  const ref = subjectRef.trim();
  if (!ref) return null;
  const open = getOpenBySubjectStmt.get(source, ref);
  if (!open) return null;
  return markNudgeResolved(open.id);
}

export function deleteNudge(id: number): NudgeRow | null {
  const row = getNudge(id);
  if (!row) return null;
  deleteStmt.run(id);
  emit('deleted', row);
  return row;
}
