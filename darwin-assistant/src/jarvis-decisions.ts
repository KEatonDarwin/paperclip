import { sqliteDb } from './conversation-db.js';
import { sseBus, type JarvisDecisionEvent } from './sse-bus.js';
import { currentToolExecutionContext, type ToolExecutionContext } from './autonomy-ledger.js';

// DAR-676 (added scope 2026-07-03) — the Decision Ledger.
// Sibling to the autonomy ledger: that one records ACTIONS JARVIS took; this one
// records CHOICES JARVIS made or would have escalated — every fork point where
// JARVIS would previously have asked Kevin a question or offered a multiple
// choice. It is the audit trail that makes higher autonomy safe: Kevin can
// scroll back and see which decisions needed making, what was chosen, by whom,
// and why — without being the real-time bottleneck.

export type DecidedBy = 'kevin' | 'jarvis';

export interface JarvisDecisionRow {
  id: number;
  conversation_id: number | null;
  conversation_external_id: string | null;
  source_message_id: string | null;
  question: string;
  options_json: string | null;
  decided_by: DecidedBy;
  decision: string | null;
  rationale: string | null;
  related_issue: string | null;
  related_action_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface JarvisDecisionInsert {
  question: string;
  options?: string[] | null;
  decidedBy: DecidedBy;
  decision?: string | null;
  rationale?: string | null;
  relatedIssue?: string | null;
  relatedActionId?: number | null;
}

export interface JarvisDecisionFilter {
  conversationId?: number;
  decidedBy?: DecidedBy;
  limit?: number;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS jarvis_decisions (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id          INTEGER REFERENCES conversations(id),
    conversation_external_id TEXT,
    source_message_id        TEXT,
    question                 TEXT NOT NULL,
    options_json             TEXT,
    decided_by               TEXT NOT NULL DEFAULT 'jarvis' CHECK (decided_by IN ('kevin', 'jarvis')),
    decision                 TEXT,
    rationale                TEXT,
    related_issue            TEXT,
    related_action_id        INTEGER,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_jarvis_decisions_created_at
    ON jarvis_decisions(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jarvis_decisions_conversation
    ON jarvis_decisions(conversation_id, created_at DESC);
`);

const insertStmt = sqliteDb.prepare<[
  number | null,
  string | null,
  string | null,
  string,
  string | null,
  DecidedBy,
  string | null,
  string | null,
  string | null,
  number | null,
]>(`
  INSERT INTO jarvis_decisions (
    conversation_id,
    conversation_external_id,
    source_message_id,
    question,
    options_json,
    decided_by,
    decision,
    rationale,
    related_issue,
    related_action_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getByIdStmt = sqliteDb.prepare<[number], JarvisDecisionRow>(
  `SELECT * FROM jarvis_decisions WHERE id = ?`,
);

const updateOutcomeStmt = sqliteDb.prepare<[DecidedBy, string | null, string | null, number]>(`
  UPDATE jarvis_decisions
  SET decided_by = ?, decision = ?, rationale = COALESCE(?, rationale), updated_at = datetime('now')
  WHERE id = ?
`);

export function getJarvisDecision(id: number): JarvisDecisionRow | null {
  return getByIdStmt.get(id) ?? null;
}

export function insertJarvisDecision(entry: JarvisDecisionInsert, context?: ToolExecutionContext): JarvisDecisionRow {
  const ctx = context ?? currentToolExecutionContext();
  const info = insertStmt.run(
    ctx?.conversationId ?? null,
    ctx?.externalId ?? null,
    ctx?.sourceMessageId ?? null,
    entry.question,
    entry.options && entry.options.length ? JSON.stringify(entry.options) : null,
    entry.decidedBy,
    entry.decision ?? null,
    entry.rationale ?? null,
    entry.relatedIssue ?? null,
    entry.relatedActionId ?? null,
  );
  const created = getJarvisDecision(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to load jarvis decision after insert');
  sseBus.emit('sse', { type: 'jarvis_decision', action: 'created', decision: created } satisfies JarvisDecisionEvent);
  return created;
}

/** Record a later answer / correction to a decision (e.g. Kevin overrides JARVIS). */
export function updateJarvisDecisionOutcome(
  id: number,
  decidedBy: DecidedBy,
  decision: string,
  rationale?: string | null,
): JarvisDecisionRow | null {
  updateOutcomeStmt.run(decidedBy, decision, rationale ?? null, id);
  const updated = getJarvisDecision(id);
  if (updated) {
    sseBus.emit('sse', { type: 'jarvis_decision', action: 'updated', decision: updated } satisfies JarvisDecisionEvent);
  }
  return updated;
}

export function listJarvisDecisions(filter: JarvisDecisionFilter = {}): JarvisDecisionRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.conversationId !== undefined) {
    where.push('conversation_id = ?');
    params.push(filter.conversationId);
  }
  if (filter.decidedBy) {
    where.push('decided_by = ?');
    params.push(filter.decidedBy);
  }
  const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
  const sql = `
    SELECT *
    FROM jarvis_decisions
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `;
  params.push(limit);
  return sqliteDb.prepare(sql).all(...params) as JarvisDecisionRow[];
}

/** Serialize a row for the API — parses options_json into an array. */
export function serializeDecision(row: JarvisDecisionRow): Record<string, unknown> {
  let options: string[] = [];
  if (row.options_json) {
    try {
      const parsed = JSON.parse(row.options_json);
      if (Array.isArray(parsed)) options = parsed.map((o) => String(o));
    } catch {
      options = [];
    }
  }
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    conversation_external_id: row.conversation_external_id,
    source_message_id: row.source_message_id,
    question: row.question,
    options,
    decided_by: row.decided_by,
    decision: row.decision,
    rationale: row.rationale,
    related_issue: row.related_issue,
    related_action_id: row.related_action_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
