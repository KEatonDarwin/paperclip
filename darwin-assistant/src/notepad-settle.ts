import { sqliteDb, getSetting } from './conversation-db.js';

// Notepad settle detection (docs/notepad/LINE-IDENTITY.md §5 — "what a
// settle event is"), derived SERVER-SIDE from the existing autosave stream.
// The cockpit notepad UI already debounces saves and saves on blur, so
// "Kevin pressed Enter", "focus left the notepad", and "typing paused" all
// already arrive here as a putNotepadDay() call that bumps
// notepad_days.updated_at. A save followed by no further save for
// `notepad_settle_seconds` IS the settle — there is no separate client-side
// settle event to build.
//
// This module answers exactly one question: has the note been quiet long
// enough, and have we already said so for THIS write? It does not decide
// whether the note is worth reading (that is node #98's model gate) and it
// does not run itself on a timer (see the bottom of this file).

const DEFAULT_SETTLE_SECONDS = 20;

sqliteDb.exec(`
  -- Idempotence marker for settle detection. Keyed by day, storing the
  -- last_write_at value a settle was already emitted for. Deliberately NOT a
  -- boolean: a boolean can't distinguish "already fired for this write" from
  -- "re-armed by a newer write since" -- storing the write timestamp itself
  -- makes the re-arm check a plain inequality against the current
  -- notepad_days.updated_at.
  CREATE TABLE IF NOT EXISTS notepad_settle_marks (
    day           TEXT PRIMARY KEY REFERENCES notepad_days(day) ON DELETE CASCADE,
    last_write_at TEXT NOT NULL,
    settled_at    TEXT NOT NULL
  );
`);

export interface NotepadSettle {
  day: string;
  settled_at: string;
  last_write_at: string;
  quiet_seconds: number;
}

const getDayUpdatedAtStmt = sqliteDb.prepare<[string], { updated_at: string }>(`
  SELECT updated_at FROM notepad_days WHERE day = ?
`);

const getMarkStmt = sqliteDb.prepare<[string], { last_write_at: string }>(`
  SELECT last_write_at FROM notepad_settle_marks WHERE day = ?
`);

const upsertMarkStmt = sqliteDb.prepare<[string, string, string]>(`
  INSERT INTO notepad_settle_marks (day, last_write_at, settled_at) VALUES (?, ?, ?)
  ON CONFLICT(day) DO UPDATE SET last_write_at = excluded.last_write_at, settled_at = excluded.settled_at
`);

function settleSecondsSetting(): number {
  const raw = getSetting('notepad_settle_seconds');
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTLE_SECONDS;
}

// notepad_days.updated_at and settled_at are both SQLite `datetime('now')`
// strings ('YYYY-MM-DD HH:MM:SS', UTC, no offset) -- parse as UTC explicitly
// so this is stable regardless of the host's local timezone.
function parseSqliteDatetime(value: string): number {
  return Date.parse(`${value.replace(' ', 'T')}Z`);
}

/**
 * Has `day`'s note been quiet (no save) for at least the configured
 * `notepad_settle_seconds` (settings-KV, read UNCACHED so Kevin can retune it
 * live; default 20), AND has a settle not already been emitted for the exact
 * write currently on file?
 *
 * Returns the NotepadSettle on the first qualifying call for a given
 * last-write value, and null on every subsequent call until a NEW write
 * moves notepad_days.updated_at forward. A day with no notepad_days row (or
 * an empty note -- putNotepadDay still touches the row even for an empty
 * save, but a day that was never saved at all has no row) returns null.
 *
 * Deterministic: zero model calls, zero network, no timers, no randomness.
 * `now` defaults to the real clock but can be injected for testing.
 */
export function checkNotepadSettle(day: string, now: Date = new Date()): NotepadSettle | null {
  const dayRow = getDayUpdatedAtStmt.get(day);
  if (!dayRow) return null;

  const lastWriteAt = dayRow.updated_at;
  const lastWriteMs = parseSqliteDatetime(lastWriteAt);
  const quietSeconds = settleSecondsSetting();
  const elapsedSeconds = (now.getTime() - lastWriteMs) / 1000;
  if (elapsedSeconds < quietSeconds) return null;

  const mark = getMarkStmt.get(day);
  if (mark && mark.last_write_at === lastWriteAt) return null; // already settled for this exact write

  const settledAt = now.toISOString();
  upsertMarkStmt.run(day, lastWriteAt, settledAt);
  return { day, settled_at: settledAt, last_write_at: lastWriteAt, quiet_seconds: quietSeconds };
}

// -- No periodic caller is wired here. -----------------------------------
// darwin-assistant's existing sweep timers (checkin-worker, monitors,
// night-shift, hopper-engine, goals-autopilot, thread-reminders) each own a
// specific different domain -- none of them is an obvious home for a
// notepad-specific cadence, and inventing a new systemd timer / setInterval
// for it is explicitly out of scope for this node (#97). checkNotepadSettle
// is exported and callable; the next node in this chain -- #98, "JARVIS
// speaks only when it has something worth saying" (the model gate) -- is
// where a periodic caller (or an on-save hook that re-checks after the
// debounce window) should live, since that is the first consumer that
// actually needs to run on a cadence at all.
