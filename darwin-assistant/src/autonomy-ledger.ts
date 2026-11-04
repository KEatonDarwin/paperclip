import { AsyncLocalStorage } from 'node:async_hooks';
import { sqliteDb } from './conversation-db.js';
import { sseBus, type AutonomyLedgerEvent, type AutonomyLedgerReviewEvent } from './sse-bus.js';

export type ReviewStatus =
  | 'needs_review'
  | 'approved'
  | 'corrected'
  | 'reverted'
  | 'follow_up_needed';

export interface ToolExecutionContext {
  conversationId: number;
  externalId: string;
  sourceMessageId: string;
  sourceTimestamp: string;
  originalText: string;
}

export interface AutonomyLedgerRow {
  id: number;
  conversation_id: number | null;
  conversation_external_id: string | null;
  source_message_id: string | null;
  source_message_ts: string | null;
  source_user_text: string | null;
  tool_name: string;
  action_type: string;
  target_system: string;
  target_artifact_id: string | null;
  target_artifact_label: string | null;
  target_artifact_url: string | null;
  title: string;
  summary: string | null;
  rationale: string | null;
  risk_grade: string | null;
  reversibility_note: string | null;
  result_status: string;
  review_status: ReviewStatus;
  review_note: string | null;
  reviewed_at: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface AutonomyLedgerFilter {
  from?: string;
  to?: string;
  conversationId?: number;
  conversationExternalId?: string;
  actionType?: string;
  targetQuery?: string;
  needsReview?: boolean;
  limit?: number;
}

interface AutonomyLedgerInsert {
  toolName: string;
  actionType: string;
  targetSystem: string;
  targetArtifactId?: string | null;
  targetArtifactLabel?: string | null;
  targetArtifactUrl?: string | null;
  title: string;
  summary?: string | null;
  rationale?: string | null;
  riskGrade?: string | null;
  reversibilityNote?: string | null;
  resultStatus: string;
  reviewStatus?: ReviewStatus;
  metadata?: unknown;
}

interface DerivedActionSpec {
  actionType: string;
  targetSystem: string;
  title: string;
  summary: string;
  rationale: string;
  riskGrade: 'low' | 'medium' | 'high';
  reversibilityNote: string;
  targetArtifactId?: string | null;
  targetArtifactLabel?: string | null;
  targetArtifactUrl?: string | null;
}

const toolContextStorage = new AsyncLocalStorage<ToolExecutionContext>();

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS autonomy_ledger (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id       INTEGER REFERENCES conversations(id),
    conversation_external_id TEXT,
    source_message_id     TEXT,
    source_message_ts     TEXT,
    source_user_text      TEXT,
    tool_name             TEXT NOT NULL,
    action_type           TEXT NOT NULL,
    target_system         TEXT NOT NULL,
    target_artifact_id    TEXT,
    target_artifact_label TEXT,
    target_artifact_url   TEXT,
    title                 TEXT NOT NULL,
    summary               TEXT,
    rationale             TEXT,
    risk_grade            TEXT,
    reversibility_note    TEXT,
    result_status         TEXT NOT NULL,
    review_status         TEXT NOT NULL DEFAULT 'needs_review',
    review_note           TEXT,
    reviewed_at           TEXT,
    metadata_json         TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_autonomy_ledger_created_at
    ON autonomy_ledger(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_autonomy_ledger_conversation
    ON autonomy_ledger(conversation_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_autonomy_ledger_review_status
    ON autonomy_ledger(review_status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_autonomy_ledger_action_type
    ON autonomy_ledger(action_type, created_at DESC);
`);

const insertStmt = sqliteDb.prepare<[
  number | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string,
  string,
  string,
  string | null,
  string | null,
  string | null,
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  string,
  ReviewStatus,
  string | null,
]>(`
  INSERT INTO autonomy_ledger (
    conversation_id,
    conversation_external_id,
    source_message_id,
    source_message_ts,
    source_user_text,
    tool_name,
    action_type,
    target_system,
    target_artifact_id,
    target_artifact_label,
    target_artifact_url,
    title,
    summary,
    rationale,
    risk_grade,
    reversibility_note,
    result_status,
    review_status,
    metadata_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getByIdStmt = sqliteDb.prepare<[number], AutonomyLedgerRow>(
  `SELECT * FROM autonomy_ledger WHERE id = ?`,
);

const updateReviewStmt = sqliteDb.prepare<[ReviewStatus, string | null, number]>(`
  UPDATE autonomy_ledger
  SET review_status = ?,
      review_note = ?,
      reviewed_at = datetime('now')
  WHERE id = ?
`);

export function withToolExecutionContext<T>(context: ToolExecutionContext, fn: () => Promise<T>): Promise<T> {
  return toolContextStorage.run(context, fn);
}

export function currentToolExecutionContext(): ToolExecutionContext | undefined {
  return toolContextStorage.getStore();
}

function deriveResultStatus(result: unknown): string {
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) return 'error';
    if (record.ok === false) return 'error';
    if (record.cancelled === true) return 'cancelled';
  }
  return 'success';
}

function safeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function issueUrl(identifier: string | null | undefined): string | null {
  const id = safeString(identifier);
  if (!id) return null;
  const prefix = id.split('-')[0];
  return prefix ? `/${prefix}/issues/${id}` : null;
}

function truncate(value: string, max = 600): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return truncate(value, 1000);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 30);
    return Object.fromEntries(entries.map(([key, val]) => [key, sanitize(val)]));
  }
  return value;
}

function resultPreview(result: unknown): string {
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.error === 'string') return `Error: ${record.error}`;
    if (typeof record.identifier === 'string') return record.identifier;
    if (typeof record.id === 'string') return record.id;
  }
  return typeof result === 'string' ? truncate(result, 240) : 'Recorded action';
}

function describeToolAction(toolName: string, args: Record<string, unknown>, result: unknown): DerivedActionSpec | null {
  const resultRecord = result && typeof result === 'object' ? result as Record<string, unknown> : null;
  switch (toolName) {
    case 'create_issue': {
      const identifier = safeString(resultRecord?.identifier);
      const title = safeString(resultRecord?.title) ?? safeString(args.title) ?? 'Created issue';
      return {
        actionType: 'issue_created',
        targetSystem: 'paperclip',
        targetArtifactId: safeString(resultRecord?.id),
        targetArtifactLabel: identifier,
        targetArtifactUrl: issueUrl(identifier),
        title,
        summary: `Created Paperclip issue ${identifier ?? '(pending id)'} to track or delegate work.`,
        rationale: 'JARVIS chose tracked work over leaving an actionable request buried in chat history.',
        riskGrade: 'medium',
        reversibilityNote: 'Issue can be edited, reassigned, blocked, or cancelled later.',
      };
    }
    case 'update_issue':
      return {
        actionType: 'issue_updated',
        targetSystem: 'paperclip',
        targetArtifactLabel: safeString(args.identifier),
        targetArtifactUrl: issueUrl(safeString(args.identifier)),
        title: `Updated ${safeString(args.identifier) ?? 'Paperclip issue'}`,
        summary: `Updated fields on ${safeString(args.identifier) ?? 'a Paperclip issue'}.`,
        rationale: 'JARVIS chose to update the tracked work item directly so the board state stayed accurate.',
        riskGrade: 'medium',
        reversibilityNote: 'Issue fields can be edited again if the update was too aggressive.',
      };
    case 'update_issue_status':
      return {
        actionType: 'issue_status_changed',
        targetSystem: 'paperclip',
        targetArtifactLabel: safeString(args.identifier),
        targetArtifactUrl: issueUrl(safeString(args.identifier)),
        title: `${safeString(args.identifier) ?? 'Issue'} → ${safeString(args.status) ?? 'updated'}`,
        summary: `Changed issue status to ${safeString(args.status) ?? 'unknown'}.`,
        rationale: 'JARVIS chose to reflect task state in Paperclip rather than keep a hidden state transition in conversation only.',
        riskGrade: 'medium',
        reversibilityNote: 'Issue status can be changed back with a follow-up update if needed.',
      };
    case 'add_comment':
      return {
        actionType: 'issue_commented',
        targetSystem: 'paperclip',
        targetArtifactLabel: safeString(args.identifier),
        targetArtifactUrl: issueUrl(safeString(args.identifier)),
        title: `Commented on ${safeString(args.identifier) ?? 'Paperclip issue'}`,
        summary: `Added a comment to ${safeString(args.identifier) ?? 'a Paperclip issue'}.`,
        rationale: 'JARVIS chose to leave durable project context on the issue instead of relying on chat memory.',
        riskGrade: 'low',
        reversibilityNote: 'Comments are durable context, but follow-up comments can clarify or correct them.',
      };
    case 'write_wiki_page':
      return {
        actionType: 'wiki_written',
        targetSystem: 'wiki',
        targetArtifactId: safeString(args.path),
        targetArtifactLabel: safeString(args.path),
        title: `Wrote wiki page ${safeString(args.path) ?? ''}`.trim(),
        summary: `Updated wiki content at ${safeString(args.path) ?? 'an unknown path'}.`,
        rationale: 'JARVIS chose durable shared documentation so the information is available outside the active chat.',
        riskGrade: 'medium',
        reversibilityNote: 'Wiki content can be edited or overwritten later.',
      };
    case 'write_memory':
      return {
        actionType: 'memory_updated',
        targetSystem: 'wiki',
        targetArtifactId: 'agent-memory/jarvis/memory.md',
        targetArtifactLabel: 'agent-memory/jarvis/memory.md',
        title: 'Updated JARVIS memory',
        summary: 'Wrote durable personal memory for future turns.',
        rationale: 'JARVIS chose memory because the information looked persistent enough to survive beyond the current thread.',
        riskGrade: 'medium',
        reversibilityNote: 'Memory file can be edited, but an incorrect overwrite may hide prior context until corrected.',
      };
    case 'create_scheduled_task':
      return {
        actionType: 'scheduled_task_created',
        targetSystem: 'paperclip',
        targetArtifactId: safeString(resultRecord?.id),
        targetArtifactLabel: safeString(resultRecord?.identifier),
        title: `Created ${safeString(resultRecord?.identifier) ?? 'scheduled task'}`,
        summary: `Scheduled "${safeString(resultRecord?.title) ?? safeString(args.title) ?? 'untitled task'}".`,
        rationale: 'JARVIS chose a tracked scheduled task so the reminder or time-bound work would be durable and reviewable.',
        riskGrade: 'medium',
        reversibilityNote: 'Scheduled tasks can be updated or cancelled later.',
      };
    case 'update_scheduled_task':
      return {
        actionType: 'scheduled_task_updated',
        targetSystem: 'paperclip',
        targetArtifactLabel: safeString(args.identifier),
        title: `Updated ${safeString(args.identifier) ?? 'scheduled task'}`,
        summary: `Updated scheduled task ${safeString(args.identifier) ?? ''}`.trim(),
        rationale: 'JARVIS chose to keep the scheduled-task record aligned with the latest plan instead of leaving it stale.',
        riskGrade: 'medium',
        reversibilityNote: 'Scheduled-task fields can be changed again if this update was premature.',
      };
    case 'cancel_scheduled_task':
      return {
        actionType: 'scheduled_task_cancelled',
        targetSystem: 'paperclip',
        targetArtifactLabel: safeString(args.identifier),
        title: `Cancelled ${safeString(args.identifier) ?? 'scheduled task'}`,
        summary: `Cancelled scheduled task ${safeString(args.identifier) ?? ''}`.trim(),
        rationale: 'JARVIS chose to remove the outdated scheduled item so follow-up systems would not keep acting on stale work.',
        riskGrade: 'medium',
        reversibilityNote: 'Cancellation is reversible only by recreating or re-scheduling the task.',
      };
    case 'create_shim_task':
      return {
        actionType: 'shim_task_created',
        targetSystem: 'shim',
        targetArtifactId: safeString(resultRecord?.id),
        title: `Created SHIM task ${safeString(resultRecord?.title) ?? safeString(args.title) ?? ''}`.trim(),
        summary: `Created SHIM task "${safeString(resultRecord?.title) ?? safeString(args.title) ?? 'untitled'}".`,
        rationale: 'JARVIS chose SHIM because the work belonged in Kevin’s personal task system rather than transient chat.',
        riskGrade: 'medium',
        reversibilityNote: 'Task can be edited or completed later in SHIM.',
      };
    case 'update_shim_task':
      return {
        actionType: 'shim_task_updated',
        targetSystem: 'shim',
        targetArtifactId: safeString(args.id),
        title: `Updated SHIM task ${safeString(args.id) ?? ''}`.trim(),
        summary: `Updated SHIM task ${safeString(args.id) ?? ''}`.trim(),
        rationale: 'JARVIS chose to keep the personal task system aligned with the active plan.',
        riskGrade: 'medium',
        reversibilityNote: 'Task updates can be corrected with another SHIM update.',
      };
    case 'create_shim_project':
      return {
        actionType: 'shim_project_created',
        targetSystem: 'shim',
        title: `Created SHIM project ${safeString(args.name) ?? ''}`.trim(),
        summary: `Created SHIM project "${safeString(args.name) ?? 'untitled'}".`,
        rationale: 'JARVIS chose to create a container for related work so follow-up tasks would have a durable home.',
        riskGrade: 'medium',
        reversibilityNote: 'Project metadata can be edited later.',
      };
    case 'create_shim_fridge_item':
      return {
        actionType: 'shim_fridge_item_created',
        targetSystem: 'shim',
        title: `Created SHIM fridge item ${safeString(args.title) ?? ''}`.trim(),
        summary: `Saved idea "${safeString(args.title) ?? 'untitled'}" to SHIM fridge.`,
        rationale: 'JARVIS chose cold-storage tracking instead of losing a not-yet-actionable idea in chat history.',
        riskGrade: 'low',
        reversibilityNote: 'Fridge items can be promoted, edited, or archived later.',
      };
    case 'start_focus_session':
      return {
        actionType: 'focus_session_started',
        targetSystem: 'shim',
        title: 'Started focus session',
        summary: `Started a focus session${safeString(args.task_description) ? ` for "${safeString(args.task_description)}"` : ''}.`,
        rationale: 'JARVIS chose a concrete focus session so execution had a tracked timer instead of only a verbal intention.',
        riskGrade: 'low',
        reversibilityNote: 'Focus sessions can be stopped or ignored if they were started too early.',
      };
    case 'stop_focus_session':
      return {
        actionType: 'focus_session_stopped',
        targetSystem: 'shim',
        title: 'Stopped focus session',
        summary: 'Stopped the active SHIM focus session.',
        rationale: 'JARVIS chose to close the active timer so tracking matched reality.',
        riskGrade: 'low',
        reversibilityNote: 'A new focus session can be started later if this stop was premature.',
      };
    case 'shim_deploy_switch':
      return {
        actionType: 'deploy_triggered',
        targetSystem: 'shim',
        targetArtifactLabel: safeString(args.branch),
        title: `Switched SHIM deploy to ${safeString(args.branch) ?? 'branch'}`,
        summary: `Triggered SHIM review deployment for ${safeString(args.branch) ?? 'unknown branch'}.`,
        rationale: 'JARVIS chose a concrete deploy action so Kevin could inspect the requested branch in a live environment.',
        riskGrade: 'high',
        reversibilityNote: 'Deployment can be rolled back or rejected, but it changes the live review target immediately.',
      };
    case 'shim_deploy_approve':
      return {
        actionType: 'deploy_approved',
        targetSystem: 'shim',
        title: 'Approved SHIM deploy',
        summary: 'Approved the active SHIM review deployment.',
        rationale: 'JARVIS chose to advance reviewed code into the approved deploy path.',
        riskGrade: 'high',
        reversibilityNote: 'Approval is durable deployment history; rollback would require a later deploy action.',
      };
    case 'shim_deploy_reject':
      return {
        actionType: 'deploy_rejected',
        targetSystem: 'shim',
        title: 'Rejected SHIM deploy',
        summary: 'Rejected the active SHIM review deployment.',
        rationale: 'JARVIS chose to roll back the review target rather than leave a bad branch live.',
        riskGrade: 'medium',
        reversibilityNote: 'Branch remains available, but the deploy target is reverted.',
      };
    case 'lovable_send_message':
      return {
        actionType: 'lovable_prompt_sent',
        targetSystem: 'lovable',
        targetArtifactId: safeString(args.project_id),
        targetArtifactLabel: safeString(args.project_id),
        title: `Sent Lovable prompt to ${safeString(args.project_id) ?? 'project'}`,
        summary: `Sent build instruction to Lovable project ${safeString(args.project_id) ?? 'unknown'}.`,
        rationale: 'JARVIS chose to hand work to the project agent immediately rather than leave the build intent unstaged.',
        riskGrade: 'medium',
        reversibilityNote: 'Lovable changes may require follow-up edits, but the prompt trail remains inspectable.',
      };
    case 'mcp_call':
      return {
        actionType: 'mcp_call',
        targetSystem: safeString(args.server) ?? 'mcp',
        targetArtifactLabel: safeString(args.tool),
        title: `Called MCP tool ${safeString(args.tool) ?? ''}`.trim(),
        summary: `Called MCP tool ${safeString(args.tool) ?? 'unknown'} on ${safeString(args.server) ?? 'unknown server'}.`,
        rationale: 'JARVIS chose to act through an external tool instead of only discussing the next step.',
        riskGrade: 'medium',
        reversibilityNote: 'Reversibility depends on the underlying MCP tool.',
      };
    case 'supabase_execute_sql':
      return {
        actionType: 'supabase_sql_executed',
        targetSystem: 'supabase',
        targetArtifactId: safeString(args.project_id),
        targetArtifactLabel: safeString(args.project_id),
        title: `Executed Supabase SQL on ${safeString(args.project_id) ?? 'project'}`,
        summary: 'Executed SQL through the Supabase MCP bridge.',
        rationale: 'JARVIS chose a direct database action rather than deferring data work to a later manual step.',
        riskGrade: 'high',
        reversibilityNote: 'Query effects depend on the SQL; DML may need manual cleanup.',
      };
    default:
      return null;
  }
}

export function insertAutonomyLedgerEntry(entry: AutonomyLedgerInsert, context?: ToolExecutionContext): AutonomyLedgerRow {
  const activeContext = context ?? currentToolExecutionContext();
  const info = insertStmt.run(
    activeContext?.conversationId ?? null,
    activeContext?.externalId ?? null,
    activeContext?.sourceMessageId ?? null,
    activeContext?.sourceTimestamp ?? null,
    activeContext?.originalText ?? null,
    entry.toolName,
    entry.actionType,
    entry.targetSystem,
    entry.targetArtifactId ?? null,
    entry.targetArtifactLabel ?? null,
    entry.targetArtifactUrl ?? null,
    entry.title,
    entry.summary ?? null,
    entry.rationale ?? null,
    entry.riskGrade ?? null,
    entry.reversibilityNote ?? null,
    entry.resultStatus,
    entry.reviewStatus ?? 'needs_review',
    entry.metadata === undefined ? null : JSON.stringify(sanitize(entry.metadata)),
  );
  const created = getAutonomyLedgerEntry(Number(info.lastInsertRowid));
  if (!created) {
    throw new Error('Failed to load autonomy ledger entry after insert');
  }
  sseBus.emit('sse', { type: 'autonomy_ledger_entry', entry: created } satisfies AutonomyLedgerEvent);
  return created;
}

export function maybeRecordToolAction(toolName: string, args: Record<string, unknown>, result: unknown, context?: ToolExecutionContext): AutonomyLedgerRow | null {
  const spec = describeToolAction(toolName, args, result);
  if (!spec) return null;
  return insertAutonomyLedgerEntry({
    toolName,
    actionType: spec.actionType,
    targetSystem: spec.targetSystem,
    targetArtifactId: spec.targetArtifactId,
    targetArtifactLabel: spec.targetArtifactLabel,
    targetArtifactUrl: spec.targetArtifactUrl,
    title: spec.title,
    summary: spec.summary,
    rationale: spec.rationale,
    riskGrade: spec.riskGrade,
    reversibilityNote: spec.reversibilityNote,
    resultStatus: deriveResultStatus(result),
    metadata: {
      args: sanitize(args),
      result: sanitize(result),
      resultPreview: resultPreview(result),
    },
  }, context);
}

export function getAutonomyLedgerEntry(id: number): AutonomyLedgerRow | null {
  return getByIdStmt.get(id) ?? null;
}

export function listAutonomyLedger(filter: AutonomyLedgerFilter = {}): AutonomyLedgerRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (filter.from) {
    where.push('created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('created_at <= ?');
    params.push(filter.to);
  }
  if (filter.conversationId !== undefined) {
    where.push('conversation_id = ?');
    params.push(filter.conversationId);
  }
  if (filter.conversationExternalId) {
    where.push('conversation_external_id = ?');
    params.push(filter.conversationExternalId);
  }
  if (filter.actionType) {
    where.push('action_type = ?');
    params.push(filter.actionType);
  }
  if (filter.targetQuery) {
    where.push('(COALESCE(target_artifact_id, \'\') LIKE ? OR COALESCE(target_artifact_label, \'\') LIKE ? OR COALESCE(target_artifact_url, \'\') LIKE ?)');
    const pattern = `%${filter.targetQuery}%`;
    params.push(pattern, pattern, pattern);
  }
  if (filter.needsReview) {
    where.push(`review_status IN ('needs_review', 'follow_up_needed')`);
  }

  const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
  const sql = `
    SELECT *
    FROM autonomy_ledger
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `;
  params.push(limit);
  return sqliteDb.prepare(sql).all(...params) as AutonomyLedgerRow[];
}

export function updateAutonomyLedgerReview(id: number, reviewStatus: ReviewStatus, reviewNote?: string): AutonomyLedgerRow | null {
  updateReviewStmt.run(reviewStatus, reviewNote ?? null, id);
  const updated = getAutonomyLedgerEntry(id);
  if (updated) {
    sseBus.emit('sse', { type: 'autonomy_ledger_review', entry: updated } satisfies AutonomyLedgerReviewEvent);
  }
  return updated;
}
