import { sqliteDb } from './conversation-db.js';
import { sseBus, type NoteEvent } from './sse-bus.js';

// DAR-701 — quick-capture notes. Kevin hits a global hotkey in the cockpit, types
// a note, and JARVIS triages it async: files a Paperclip issue for concrete
// feature requests, or leaves light research/feedback for passing ideas.

export type NoteStatus = 'pending' | 'triaged' | 'error';
export type NoteKind = 'feature' | 'idea';

export interface NoteRow {
  id: number;
  content: string;
  status: NoteStatus;
  kind: NoteKind | null;
  outcome_summary: string | null;
  issue_identifier: string | null;
  issue_id: string | null;
  created_at: string;
  updated_at: string;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    content           TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'triaged', 'error')),
    kind              TEXT CHECK (kind IN ('feature', 'idea')),
    outcome_summary   TEXT,
    issue_identifier  TEXT,
    issue_id          TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);
`);

const insertStmt = sqliteDb.prepare<[string]>(`
  INSERT INTO notes (content) VALUES (?)
`);

const getByIdStmt = sqliteDb.prepare<[number], NoteRow>(`SELECT * FROM notes WHERE id = ?`);

const listStmt = sqliteDb.prepare<[number], NoteRow>(`
  SELECT * FROM notes ORDER BY created_at DESC, id DESC LIMIT ?
`);

const markTriagedStmt = sqliteDb.prepare<[NoteKind, string, string | null, string | null, number]>(`
  UPDATE notes
  SET status = 'triaged', kind = ?, outcome_summary = ?, issue_identifier = ?, issue_id = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const markErrorStmt = sqliteDb.prepare<[string, number]>(`
  UPDATE notes
  SET status = 'error', outcome_summary = ?, updated_at = datetime('now')
  WHERE id = ?
`);

export function getNote(id: number): NoteRow | null {
  return getByIdStmt.get(id) ?? null;
}

export function listNotes(limit = 100): NoteRow[] {
  return listStmt.all(Math.max(1, Math.min(limit, 500)));
}

export function createNote(content: string): NoteRow {
  const info = insertStmt.run(content);
  const created = getNote(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to load note after insert');
  sseBus.emit('sse', { type: 'note', action: 'created', note: created } satisfies NoteEvent);
  return created;
}

export function markNoteTriaged(
  id: number,
  args: { kind: NoteKind; outcomeSummary: string; issueIdentifier?: string | null; issueId?: string | null },
): NoteRow | null {
  markTriagedStmt.run(args.kind, args.outcomeSummary, args.issueIdentifier ?? null, args.issueId ?? null, id);
  const updated = getNote(id);
  if (updated) sseBus.emit('sse', { type: 'note', action: 'updated', note: updated } satisfies NoteEvent);
  return updated;
}

export function markNoteError(id: number, message: string): NoteRow | null {
  markErrorStmt.run(message, id);
  const updated = getNote(id);
  if (updated) sseBus.emit('sse', { type: 'note', action: 'updated', note: updated } satisfies NoteEvent);
  return updated;
}
