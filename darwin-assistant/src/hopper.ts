import { sqliteDb } from './conversation-db.js';
import { sseBus, type HopperItemEvent } from './sse-bus.js';

// TASK HOPPER — the human-in-the-loop gate between "JARVIS noticed a possible
// task" and "a cockpit thread is actively working it." Anything that MIGHT be a
// task Kevin wants done — an inbound coworker message ("Kevin can you handle
// X?"), a note he drops, an ambiguous ask — lands here as a PENDING candidate
// instead of silently spawning a thread. Kevin keeps a standalone hopper window
// open on his second monitor; new candidates stream in live. He clicks:
//   • Yes            → promote as-is → a fresh cockpit thread opens + starts
//   • Yes, but…      → add context / attach a screenshot / pick a model, THEN promote
//   • Dismiss        → not a task; drop it
// Unambiguous "Jarvis, handle this please" asks skip the hopper entirely (JARVIS
// already has the context and spins the thread directly). The hopper is only for
// the "is this a task? which task exactly?" fork. Global, not thread-scoped —
// modeled on notifications.ts.

export type HopperStatus = 'pending' | 'promoted' | 'dismissed';

export interface HopperItemRow {
  id: number;
  title: string;
  summary: string | null;
  source: string | null;          // 'teams' | 'slack' | 'jarvis' | 'manual' | ...
  source_ref: string | null;      // who/where it came from (person, channel, thread)
  raw_message: string | null;     // the original text, verbatim, if any
  status: HopperStatus;
  suggested_adapter: string | null;
  suggested_model: string | null;
  promoted_thread_ext: string | null;
  created_at: string;
  resolved_at: string | null;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS hopper_items (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    title               TEXT NOT NULL,
    summary             TEXT,
    source              TEXT,
    source_ref          TEXT,
    raw_message         TEXT,
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','promoted','dismissed')),
    suggested_adapter   TEXT,
    suggested_model     TEXT,
    promoted_thread_ext TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_hopper_status_created
    ON hopper_items(status, created_at DESC);
`);

const insertStmt = sqliteDb.prepare<
  [string, string | null, string | null, string | null, string | null, string | null, string | null]
>(`
  INSERT INTO hopper_items (title, summary, source, source_ref, raw_message, suggested_adapter, suggested_model)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getByIdStmt = sqliteDb.prepare<[number], HopperItemRow>(`SELECT * FROM hopper_items WHERE id = ?`);

const listAllStmt = sqliteDb.prepare<[number], HopperItemRow>(`
  SELECT * FROM hopper_items ORDER BY created_at DESC, id DESC LIMIT ?
`);

const listByStatusStmt = sqliteDb.prepare<[HopperStatus, number], HopperItemRow>(`
  SELECT * FROM hopper_items WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?
`);

const pendingCountStmt = sqliteDb.prepare<[], { pending: number }>(`
  SELECT COUNT(*) AS pending FROM hopper_items WHERE status = 'pending'
`);

const resolveStmt = sqliteDb.prepare<[HopperStatus, string | null, number]>(`
  UPDATE hopper_items
  SET status = ?, promoted_thread_ext = ?, resolved_at = datetime('now')
  WHERE id = ?
`);

const deleteStmt = sqliteDb.prepare<[number]>(`DELETE FROM hopper_items WHERE id = ?`);

function emit(action: HopperItemEvent['action'], item: HopperItemRow): void {
  sseBus.emit('sse', { type: 'hopper_item', action, item } satisfies HopperItemEvent);
}

export function getHopperItem(id: number): HopperItemRow | null {
  return getByIdStmt.get(id) ?? null;
}

export function listHopperItems(status: HopperStatus | 'all' = 'pending', limit = 100): HopperItemRow[] {
  const n = Math.max(1, Math.min(limit, 500));
  return status === 'all' ? listAllStmt.all(n) : listByStatusStmt.all(status, n);
}

export function pendingHopperCount(): number {
  return pendingCountStmt.get()?.pending ?? 0;
}

export function createHopperItem(args: {
  title: string;
  summary?: string | null;
  source?: string | null;
  source_ref?: string | null;
  raw_message?: string | null;
  suggested_adapter?: string | null;
  suggested_model?: string | null;
}): HopperItemRow {
  const info = insertStmt.run(
    args.title,
    args.summary ?? null,
    args.source ?? null,
    args.source_ref ?? null,
    args.raw_message ?? null,
    args.suggested_adapter ?? null,
    args.suggested_model ?? null,
  );
  const created = getHopperItem(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to load hopper item after insert');
  emit('created', created);
  return created;
}

/** Mark an item promoted, recording which cockpit thread it spun up. */
export function markHopperPromoted(id: number, threadExt: string): HopperItemRow | null {
  resolveStmt.run('promoted', threadExt, id);
  const updated = getHopperItem(id);
  if (updated) emit('updated', updated);
  return updated;
}

/** Mark an item dismissed (not a task). */
export function markHopperDismissed(id: number): HopperItemRow | null {
  resolveStmt.run('dismissed', null, id);
  const updated = getHopperItem(id);
  if (updated) emit('updated', updated);
  return updated;
}

export function deleteHopperItem(id: number): HopperItemRow | null {
  const row = getByIdStmt.get(id) ?? null;
  if (!row) return null;
  deleteStmt.run(id);
  emit('deleted', row);
  return row;
}

/** Compose the seed message a promoted item drops into its new thread — the
 *  brief JARVIS wakes up on. Kept plain so processMessage treats it as a normal
 *  Kevin-authored ask, just pre-filled from the candidate + any extra context. */
export function composeHopperSeed(item: HopperItemRow, extraContext?: string | null): string {
  const lines: string[] = [];
  lines.push(`**Task from the hopper:** ${item.title}`);
  if (item.summary && item.summary !== item.title) lines.push('', item.summary);
  if (item.source) {
    const who = item.source_ref ? ` (${item.source_ref})` : '';
    lines.push('', `_Source: ${item.source}${who}._`);
  }
  if (item.raw_message) {
    lines.push('', 'Original message:', '> ' + item.raw_message.replace(/\n/g, '\n> '));
  }
  if (extraContext && extraContext.trim()) {
    lines.push('', '**Kevin added:**', extraContext.trim());
  }
  lines.push(
    '',
    '_(This task came in through the **Task Hopper** — Kevin reviewed the candidate and clicked Yes to hand it to you. Your contract: work it end to end autonomously; only come back to Kevin if you hit a REAL blocking question, otherwise bring him the finished result. The standard escalation bar still holds — no prod changes, no merges to main, no external sends under Kevin\'s identity without his go-ahead.)_',
  );
  return lines.join('\n');
}
