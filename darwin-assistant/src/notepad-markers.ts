import { sqliteDb } from './conversation-db.js';
import { getNotepadLine, lineTextHash } from './notepad.js';

// The marker store (goal 6, node #104 — "A marker belongs to the line,
// survives edits, and never fires twice"). notepad-moves.ts's own module
// doc is explicit that it "does NOT persist a marker anywhere" and hands
// that job to this node; this file is that job, and nothing more than that
// job. It does not decide WHAT a marker should say (decideNotepadMoves in
// notepad-moves.ts does) and it does not wire itself into the
// settle-and-reread pass or expose an HTTP route (the next node in this
// chain does that, once it has something real to prove end-to-end).
//
// The two guarantees the done_means asks for, and how this file provides
// each of them:
//
//   "editing an acted line reconciles its existing marker instead of
//   creating a second one" — `line_id` is the PRIMARY KEY of
//   `notepad_markers`, the exact same trick `notepad_line_state` uses in
//   src/notepad.ts (see that table's comment). A line can structurally hold
//   at most one marker row ever; reconcileNotepadMarker() always UPSERTs
//   into that one row rather than inserting a sibling.
//
//   "dismissals keyed by text hash" — a marker's `dismissed` flag is paired
//   with `dismissed_hash`, the normalized-text hash (src/notepad.ts's
//   lineTextHash — reused, never re-implemented) of exactly what was
//   dismissed. reconcileNotepadMarker() checks that hash, not a bare
//   boolean, before it will turn a dismissed marker back into an active
//   one: the SAME text Kevin dismissed never resurfaces a marker, but any
//   text that is genuinely different from what was dismissed is free to
//   raise a fresh one. This is what makes an already-acted-on, then
//   dismissed, line stay quiet through an edit-and-settle cycle that keeps
//   landing back on the same wording, while still letting a real change to
//   that line speak up.

/** The four kinds of real move a marker can represent — identical to
 *  notepad-moves.ts's NotepadMoveKind, kept as its own type here so this
 *  module has no compile-time dependency on notepad-moves.ts (the store
 *  should not need to change if the decision layer does). */
export type NotepadMarkerKind = 'take_it' | 'question' | 'already_done' | 'context';

const MARKER_KINDS: ReadonlySet<string> = new Set<NotepadMarkerKind>([
  'take_it',
  'question',
  'already_done',
  'context',
]);

/** The persisted shape of one line's marker. `dismissed_hash`/`dismissed_at`
 *  are null until the marker has been dismissed at least once. */
export interface NotepadMarker {
  line_id: number;
  kind: NotepadMarkerKind;
  reason: string;
  action_ref: string | null;
  hash: string;
  dismissed: boolean;
  dismissed_hash: string | null;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What a caller (the future settle-and-reread wiring) hands in to record a
 *  freshly-decided move. Mirrors notepad-moves.ts's NotepadMove, minus
 *  line_id (that's reconcileNotepadMarker's own first argument) and plus
 *  the optional action_ref the done_means calls out as a marker field. */
export interface NotepadMarkerMove {
  kind: NotepadMarkerKind;
  reason: string;
  action_ref?: string | null;
}

sqliteDb.exec(`
  -- One marker per line_id (line_id IS the primary key — same structural
  -- guarantee notepad_line_state uses in src/notepad.ts): a line can carry
  -- at most one marker row, which is what makes an UPSERT on an
  -- already-marked line update that same row rather than ever inserting a
  -- second one. ON DELETE CASCADE relies on 'PRAGMA foreign_keys = ON',
  -- already set on this exact connection by conversation-db.ts (sqliteDb
  -- re-exports that same 'db') — so a deleted line's marker is removed
  -- automatically, never left orphaned.
  CREATE TABLE IF NOT EXISTS notepad_markers (
    line_id        INTEGER PRIMARY KEY REFERENCES notepad_lines(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL,
    reason         TEXT NOT NULL,
    action_ref     TEXT,
    hash           TEXT NOT NULL,
    dismissed      INTEGER NOT NULL DEFAULT 0,
    dismissed_hash TEXT,
    dismissed_at   TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

interface MarkerRow {
  line_id: number;
  kind: string;
  reason: string;
  action_ref: string | null;
  hash: string;
  dismissed: number;
  dismissed_hash: string | null;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
}

function toMarker(row: MarkerRow): NotepadMarker {
  return {
    line_id: row.line_id,
    kind: row.kind as NotepadMarkerKind,
    reason: row.reason,
    action_ref: row.action_ref,
    hash: row.hash,
    dismissed: row.dismissed === 1,
    dismissed_hash: row.dismissed_hash,
    dismissed_at: row.dismissed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const getMarkerRowStmt = sqliteDb.prepare<[number], MarkerRow>(`
  SELECT * FROM notepad_markers WHERE line_id = ?
`);

/** Read the raw marker for one line, if any. */
export function getNotepadMarker(lineId: number): NotepadMarker | undefined {
  const row = getMarkerRowStmt.get(lineId);
  return row ? toMarker(row) : undefined;
}

// ON CONFLICT here is what "reconcile in place" IS, mechanically: the first
// call for a line_id inserts; every call after that updates the same row.
// This statement intentionally does NOT touch dismissed_hash/dismissed_at
// even when it flips `dismissed` back to 0 -- see the "remembered across
// days" note on reconcileNotepadMarker below for why that memory has to
// survive a detour through different text, not just an immediate re-read.
const upsertActiveMarkerStmt = sqliteDb.prepare<[number, string, string, string | null, string]>(`
  INSERT INTO notepad_markers (line_id, kind, reason, action_ref, hash, dismissed, dismissed_hash, dismissed_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, datetime('now'))
  ON CONFLICT(line_id) DO UPDATE SET
    kind       = excluded.kind,
    reason     = excluded.reason,
    action_ref = excluded.action_ref,
    hash       = excluded.hash,
    dismissed  = 0,
    updated_at = excluded.updated_at
`);

// The "still dismissed" branch: current text matches dismissed_hash, so
// this call is a no-op on the JUDGMENT fields (kind/reason/action_ref stay
// exactly as they were) -- only `hash` and `dismissed` are (re)synced to
// match the current, already-dismissed text.
const resyncDismissedMarkerStmt = sqliteDb.prepare<[string, number]>(`
  UPDATE notepad_markers SET dismissed = 1, hash = ?, updated_at = datetime('now') WHERE line_id = ?
`);

/**
 * Reconcile line `lineId`'s marker against a freshly-decided `move`.
 *
 * Always writes into the ONE row this line_id owns (insert on the first
 * call, update on every call after — "reconcile in place", never a second
 * row).
 *
 * "Dismissals keyed by text hash, remembered across days" means
 * `dismissed_hash` is durable memory, not a snapshot that gets wiped the
 * moment the line moves on to something else: reconcile only ever SETS
 * `dismissed_hash` inside dismissNotepadMarker(), never clears it here.
 * That is what makes this sequence come out right, which a naive
 * "clear dismissal on any edit" design gets wrong —
 *
 *   dismiss "grab milk" (dismissed_hash = hash(grab milk))
 *   edit -> "grab milk and eggs"   -- different text, marker revives (active)
 *   edit back -> "grab milk"       -- SAME text as the original dismissal
 *
 * — the last line must come back dismissed, even though something else
 * happened to the line in between. So on every call this function checks
 * the CURRENT text's hash against whatever `dismissed_hash` is currently on
 * file (which may be from days ago, unrelated to the marker's last active
 * kind/reason): if they match, this is a no-op that only resyncs
 * `hash`/`dismissed` to reflect "yes, still/again dismissed" — the exact
 * text Kevin already ruled out never gets a marker resurrected for it,
 * which is the "never fires twice" half of the done_means. If they don't
 * match (no dismissal on file yet, or the dismissal was for different
 * text), this writes the new kind/reason/action_ref/hash and marks the
 * marker active — a genuinely different judgment for genuinely different
 * text is never suppressed by a dismissal that doesn't apply to it.
 *
 * Throws if `lineId` does not name a real notepad line, or if `move` is
 * malformed (unrecognized kind, blank reason) — mirrors markLine's
 * behavior in notepad.ts: a caller passing a bad id or a bad move is a bug
 * to surface loudly, never a silent no-op.
 */
export function reconcileNotepadMarker(lineId: number, move: NotepadMarkerMove): NotepadMarker {
  const line = getNotepadLine(lineId);
  if (!line) throw new Error(`notepad line ${lineId} not found`);
  if (!MARKER_KINDS.has(move.kind)) throw new Error(`invalid marker kind '${move.kind}'`);
  const reason = move.reason?.trim();
  if (!reason) throw new Error('reason is required');

  const hash = lineTextHash(line.text);
  const existing = getMarkerRowStmt.get(lineId);

  if (existing && existing.dismissed_hash === hash) {
    // The current text is exactly what was (at some point) dismissed --
    // leave the judgment fields alone, just resync hash/dismissed.
    resyncDismissedMarkerStmt.run(hash, lineId);
    return getNotepadMarker(lineId)!;
  }

  const actionRef = move.action_ref && move.action_ref.trim() ? move.action_ref.trim() : null;
  upsertActiveMarkerStmt.run(lineId, move.kind, reason, actionRef, hash);
  return getNotepadMarker(lineId)!;
}

const dismissMarkerStmt = sqliteDb.prepare<[number]>(`
  UPDATE notepad_markers
  SET dismissed = 1, dismissed_hash = hash, dismissed_at = datetime('now'), updated_at = datetime('now')
  WHERE line_id = ?
`);

/**
 * Dismiss the current marker on `lineId`. `dismissed_hash` is stamped from
 * the marker's own already-recorded `hash` column -- the text it was
 * actually judged against -- never re-read live from the line. That keeps
 * a dismiss self-consistent with what Kevin was looking at when he
 * dismissed it, with no window for the line to have drifted between render
 * and click.
 *
 * Throws if there is no marker on this line to dismiss (same
 * no-silent-no-op discipline as reconcileNotepadMarker).
 */
export function dismissNotepadMarker(lineId: number): NotepadMarker {
  const existing = getMarkerRowStmt.get(lineId);
  if (!existing) throw new Error(`no notepad marker on line ${lineId}`);
  dismissMarkerStmt.run(lineId);
  return getNotepadMarker(lineId)!;
}

const setActionRefStmt = sqliteDb.prepare<[string, number]>(`
  UPDATE notepad_markers SET action_ref = ?, updated_at = datetime('now') WHERE line_id = ?
`);

/**
 * Attach (or overwrite) `action_ref` on an existing marker without
 * disturbing its kind/reason/hash/dismissed state. This is the seam a
 * future "clicking a marker opens a thread" node hangs its "link it back
 * to the line" behavior on -- the marker already exists (JARVIS proposed a
 * move), and this records where Kevin's click sent it.
 *
 * Throws if there is no marker on this line, or if `actionRef` is blank.
 */
export function setNotepadMarkerActionRef(lineId: number, actionRef: string): NotepadMarker {
  const existing = getMarkerRowStmt.get(lineId);
  if (!existing) throw new Error(`no notepad marker on line ${lineId}`);
  const trimmed = actionRef?.trim();
  if (!trimmed) throw new Error('actionRef is required');
  setActionRefStmt.run(trimmed, lineId);
  return getNotepadMarker(lineId)!;
}

const listMarkersForDayStmt = sqliteDb.prepare<[string], MarkerRow>(`
  SELECT m.* FROM notepad_markers m
  JOIN notepad_lines l ON l.id = m.line_id
  WHERE l.day = ?
  ORDER BY l.idx ASC, l.id ASC
`);

/** Every marker for `day`'s current lines, dismissed or not, document
 *  order. Deleting a line cascades its marker away (see the table
 *  comment), so this never returns a marker for a line that's gone. */
export function listNotepadMarkers(day: string): NotepadMarker[] {
  return listMarkersForDayStmt.all(day).map(toMarker);
}

/** Only the markers Kevin would actually see right now -- goal #105's "a
 *  day with no moves shows a completely clean notepad". Dismissed rows stay
 *  in the store (that's what makes the text-hash guarantee above possible)
 *  but are never part of what's shown. */
export function activeNotepadMarkers(day: string): NotepadMarker[] {
  return listNotepadMarkers(day).filter((m) => !m.dismissed);
}
