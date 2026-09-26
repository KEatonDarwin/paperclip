import crypto from 'node:crypto';
import { sqliteDb } from './conversation-db.js';

// Cockpit Notepad — one free-form note per calendar day (US/Central), backed
// by per-LINE identity rather than a single text blob. PUT diffs the incoming
// full text against the stored lines and reuses row ids for lines that are
// unchanged/reworded/moved, so a client can attach comments/state to a
// specific line and have it survive edits elsewhere in the note.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Cost caps for the line diff (see applyLineDiff). Both are deliberately well
// above any realistic single edit and only bite on a wholesale rewrite or a
// note built almost entirely out of one repeated line.
const PAIR_WORK_CAP = 20_000;
const GROUP_SCAN_CAP = 20_000;

export interface NotepadLine {
  id: number;
  idx: number;
  text: string;
}

export interface NotepadDay {
  day: string;
  text: string;
  lines: NotepadLine[];
}

export interface NotepadDaySummary {
  day: string;
  line_count: number;
  updated_at: string;
}

type NotepadLineRow = NotepadLine;

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS notepad_days (
    day        TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notepad_lines (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    day        TEXT NOT NULL REFERENCES notepad_days(day),
    idx        INTEGER NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_notepad_lines_day ON notepad_lines(day, idx);

  -- Per-line state ledger (docs/notepad/LINE-IDENTITY.md). line_id is BOTH the
  -- primary key AND the foreign key: a line can hold at most one ledger row,
  -- which is what structurally guarantees a line can never carry two
  -- independent actions (an UPSERT on an already-'acted' line updates that
  -- same row rather than ever inserting a second one). ON DELETE CASCADE
  -- relies on 'PRAGMA foreign_keys = ON', which conversation-db.ts already
  -- sets on this exact connection (sqliteDb re-exports that same 'db') — so a
  -- deleted line's ledger row is removed automatically, never left orphaned.
  CREATE TABLE IF NOT EXISTS notepad_line_state (
    line_id    INTEGER PRIMARY KEY REFERENCES notepad_lines(id) ON DELETE CASCADE,
    state      TEXT NOT NULL,
    hash       TEXT NOT NULL,
    scanned_at TEXT,
    action_ref TEXT,
    note       TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const upsertDayStmt = sqliteDb.prepare<[string]>(`
  INSERT INTO notepad_days (day) VALUES (?)
  ON CONFLICT(day) DO NOTHING
`);

const touchDayStmt = sqliteDb.prepare<[string]>(`
  UPDATE notepad_days SET updated_at = datetime('now') WHERE day = ?
`);

const listLinesStmt = sqliteDb.prepare<[string], NotepadLineRow>(`
  SELECT id, idx, text FROM notepad_lines WHERE day = ? ORDER BY idx ASC, id ASC
`);

const insertLineStmt = sqliteDb.prepare<[string, number, string]>(`
  INSERT INTO notepad_lines (day, idx, text) VALUES (?, ?, ?)
`);

const updateLineStmt = sqliteDb.prepare<[number, string, number]>(`
  UPDATE notepad_lines SET idx = ?, text = ?, updated_at = datetime('now') WHERE id = ?
`);

const deleteLineStmt = sqliteDb.prepare<[number]>(`DELETE FROM notepad_lines WHERE id = ?`);

const listDaysStmt = sqliteDb.prepare<[], NotepadDaySummary>(`
  SELECT d.day AS day,
         COUNT(l.id) AS line_count,
         d.updated_at AS updated_at
  FROM notepad_days d
  LEFT JOIN notepad_lines l ON l.day = d.day
  GROUP BY d.day
  ORDER BY d.day DESC
`);

export function isValidNotepadDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  // Reject syntactically-shaped-but-impossible dates (e.g. 2026-13-40).
  const [y, m, d] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

/** Today's date as YYYY-MM-DD in US/Central — the default day for the notepad. */
export function todayNotepadDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

/** Read one day's note. An absent/empty day returns an empty note, never a 404. */
export function getNotepadDay(day: string): NotepadDay {
  const lines = listLinesStmt.all(day);
  return { day, text: lines.map((l) => l.text).join('\n'), lines };
}

export function listNotepadDays(): NotepadDaySummary[] {
  return listDaysStmt.all();
}

/**
 * Diff `newTexts` (the incoming full note, split into lines) against the
 * currently-stored lines for `day` and reuse row ids wherever possible:
 *
 *   1. Content match — lines whose TRIMMED text is unchanged (anywhere in the
 *      note, including moved to a different position) keep their id. When a
 *      trimmed text appears more than once, the nearest-index old candidate
 *      wins for each new occurrence.
 *   2. Positional reword — old lines left unconsumed by (1) are paired with
 *      new lines left unmatched by (1) by NEAREST INDEX (closest pairs claimed
 *      first), not by ordinal position. Ordinal pairing looks right until one
 *      save both deletes a line above and rewords a line below: the reworded
 *      line then inherits the deleted line's id and its own id is destroyed.
 *      Nearest-index pairing keeps "the line at roughly this spot got
 *      reworded" true even when the note shifted around it.
 *   3. Anything left over on the new side is a genuine insert (new id);
 *      anything left over on the old side is a genuine delete.
 *
 * Both phases are cost-capped (PAIR_WORK_CAP / GROUP_SCAN_CAP): a wholesale
 * rewrite or a note of thousands of identical lines degrades to in-order
 * pairing — semantically identical for indistinguishable lines, and it keeps
 * a save off the O(n^2) path that would stall the shared event loop.
 */
function applyLineDiff(day: string, oldLines: NotepadLineRow[], newTexts: string[]): void {
  const oldGroups = new Map<string, NotepadLineRow[]>();
  for (const line of oldLines) {
    const key = line.text.trim();
    const bucket = oldGroups.get(key);
    if (bucket) bucket.push(line);
    else oldGroups.set(key, [line]);
  }

  const newGroups = new Map<string, number[]>();
  newTexts.forEach((text, i) => {
    const key = text.trim();
    const bucket = newGroups.get(key);
    if (bucket) bucket.push(i);
    else newGroups.set(key, [i]);
  });

  const matchedNewToOld = new Map<number, NotepadLineRow>();
  const consumedOldIds = new Set<number>();

  for (const [key, newIdxs] of newGroups) {
    const candidates = oldGroups.get(key);
    if (!candidates || candidates.length === 0) continue;
    const available = candidates.slice(); // already idx-ascending
    // Lines with identical text are interchangeable, so for a huge bucket
    // (thousands of blank or repeated lines) in-order pairing is just as
    // correct as nearest-index and avoids an O(n^2) scan on every autosave.
    const scanNearest = candidates.length * newIdxs.length <= GROUP_SCAN_CAP;
    for (const newIdx of newIdxs) {
      if (available.length === 0) break;
      let bestPos = 0;
      if (scanNearest) {
        let bestDist = Math.abs(available[0].idx - newIdx);
        for (let p = 1; p < available.length; p++) {
          const dist = Math.abs(available[p].idx - newIdx);
          if (dist < bestDist) {
            bestDist = dist;
            bestPos = p;
          }
        }
      }
      const chosen = available.splice(bestPos, 1)[0];
      matchedNewToOld.set(newIdx, chosen);
      consumedOldIds.add(chosen.id);
    }
  }

  const leftoverOld = oldLines.filter((l) => !consumedOldIds.has(l.id));
  const leftoverNewIdxs: number[] = [];
  for (let i = 0; i < newTexts.length; i++) {
    if (!matchedNewToOld.has(i)) leftoverNewIdxs.push(i);
  }

  const rewordMap = new Map<number, NotepadLineRow>();
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();

  if (leftoverOld.length * leftoverNewIdxs.length <= PAIR_WORK_CAP) {
    // Nearest-index pairing: build every (old, new) candidate, then claim the
    // closest pairs first. A line reworded in place is always nearer to its
    // own old row than to a row that was deleted somewhere else in the note.
    //
    // This same mechanism, with no special-casing, is what decides SPLIT and
    // MERGE:
    //   - SPLIT (one line becomes two): the fragment left occupying the
    //     original line's index has distance 0 and wins the pairing, so the
    //     LEADING fragment keeps the original id; the trailing fragment has
    //     no old candidate left to claim and becomes a genuine insert.
    //   - MERGE (two lines become one): the merged line lands at the FIRST
    //     source line's old index, which is distance 0 away, so the FIRST
    //     (topmost) line's id survives; the second source line is left
    //     unclaimed and is deleted.
    // See scripts/notepad-check.mjs cases (3) and (4) for the proof.
    const pairs: Array<[number, number, number]> = []; // [distance, oldPos, newPos]
    for (let a = 0; a < leftoverOld.length; a++) {
      for (let b = 0; b < leftoverNewIdxs.length; b++) {
        pairs.push([Math.abs(leftoverOld[a].idx - leftoverNewIdxs[b]), a, b]);
      }
    }
    // Ties resolve by original order so the result is fully deterministic.
    pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    for (const [, a, b] of pairs) {
      if (usedOld.has(a) || usedNew.has(b)) continue;
      usedOld.add(a);
      usedNew.add(b);
      rewordMap.set(leftoverNewIdxs[b], leftoverOld[a]);
    }
  } else {
    // Wholesale rewrite — nothing is "roughly in the same spot", so pair in
    // order and keep the save cheap.
    const rewordCount = Math.min(leftoverOld.length, leftoverNewIdxs.length);
    for (let i = 0; i < rewordCount; i++) {
      rewordMap.set(leftoverNewIdxs[i], leftoverOld[i]);
      usedOld.add(i);
      usedNew.add(i);
    }
  }

  const insertIdxs = leftoverNewIdxs.filter((_, b) => !usedNew.has(b));
  const deletes = leftoverOld.filter((_, a) => !usedOld.has(a));

  for (const line of deletes) deleteLineStmt.run(line.id);

  for (const [newIdx, old] of matchedNewToOld) {
    const text = newTexts[newIdx];
    if (old.idx !== newIdx || old.text !== text) updateLineStmt.run(newIdx, text, old.id);
  }

  for (const [newIdx, old] of rewordMap) {
    updateLineStmt.run(newIdx, newTexts[newIdx], old.id);
  }

  for (const newIdx of insertIdxs) {
    insertLineStmt.run(day, newIdx, newTexts[newIdx]);
  }
}

const putTx = sqliteDb.transaction((day: string, newTexts: string[]): void => {
  upsertDayStmt.run(day);
  const oldLines = listLinesStmt.all(day);
  applyLineDiff(day, oldLines, newTexts);
  touchDayStmt.run(day);
});

/** Save the full text for a day, diffing against the stored lines. */
export function putNotepadDay(day: string, text: string): NotepadDay {
  const newTexts = text === '' ? [] : text.split('\n');
  putTx(day, newTexts);
  return getNotepadDay(day);
}

// == Per-line state ledger (docs/notepad/LINE-IDENTITY.md) ===================
//
// This section implements the contract's §2 (normalized hash), §3 (the four
// states), and §4 (the decision table) on top of the line identity that
// applyLineDiff() above already guarantees. It does not change anything
// about diffing/identity — it only tracks, per line id, whether JARVIS has
// looked at that line's CURRENT text yet.

export type NotepadLineState = 'seen' | 'acted' | 'dismissed' | 'done';

export interface NotepadLineStateRow {
  line_id: number;
  state: NotepadLineState;
  hash: string;
  scanned_at: string | null;
  action_ref: string | null;
  note: string | null;
  updated_at: string;
}

/**
 * A line that a re-scan should look at, per the decision table (§4):
 *   - 'first_look'  : unseen (no row), OR seen/dismissed whose text changed.
 *                     There is no prior action to reconcile against.
 *   - 'reconcile'    : acted, and the text changed since the action was
 *                      taken. Always carries the original action_ref — the
 *                      consumer re-examines whether that action still
 *                      matches, it never files a second, independent one.
 */
export interface UnscannedNotepadLine {
  line_id: number;
  idx: number;
  text: string;
  kind: 'first_look' | 'reconcile';
  action_ref: string | null;
}

// == Lineage-aware ledger key resolution (node #886) ==========================
//
// notepad-rollover.ts carries a line forward as a NEW row with a NEW id, so a
// naive ledger lookup on that id always finds nothing -- the line looks
// brand-new even though a prior incarnation already has state recorded. The
// fix is to resolve a line's ledger key through its origin (origin_line_id)
// before reading notepad_line_state -- notepad-rollover.ts owns that column
// and the resolution logic (resolveLedgerKey), and registers it here at
// module load via registerLedgerKeyResolver so getNotepadLineState() and
// unscannedLines() below pick it up automatically.
//
// This is a runtime registration, not a static import of notepad-rollover.ts,
// because notepad-rollover.ts's own migration relies on THIS module's CREATE
// TABLE statements (above) running before its ALTER TABLE ones -- a static
// import cycle here would risk notepad-rollover.ts's top-level code running
// first whenever some other module imports notepad.js before it imports
// notepad-rollover.js (verified empirically; see node #886's finish note).
type LedgerKeyResolver = (lineId: number) => number;
let ledgerKeyResolver: LedgerKeyResolver | null = null;

/** Registered by notepad-rollover.ts (registerLedgerKeyResolver(resolveLedgerKey)) at module load. */
export function registerLedgerKeyResolver(resolver: LedgerKeyResolver): void {
  ledgerKeyResolver = resolver;
}

function resolveLedgerKey(lineId: number): number {
  return ledgerKeyResolver ? ledgerKeyResolver(lineId) : lineId;
}

const BULLET_MARKER_RE = /^[-*•]\s*/;

/**
 * Normalization per LINE-IDENTITY.md §2.1, in the exact order specified:
 * trim -> strip a leading bullet marker (+ its trailing whitespace) ->
 * collapse internal whitespace runs to a single space -> casefold.
 *
 * This is the ONE place normalization happens. Every marker (markLineSeen/
 * markLineActed/markLineDismissed) and the reader (unscannedLines) call
 * THIS function for their hash — never a re-implementation of these steps —
 * because two copies that drift by even a trimmed space would make every
 * line look changed forever (§4's "load-bearing reasoning").
 */
export function normalizeLineText(text: string): string {
  const trimmed = text.trim();
  const withoutBullet = trimmed.replace(BULLET_MARKER_RE, '');
  const collapsed = withoutBullet.replace(/\s+/g, ' ');
  return collapsed.toLowerCase();
}

/** sha256 of the normalized text, hex-encoded (§2.2). */
export function lineTextHash(text: string): string {
  return crypto.createHash('sha256').update(normalizeLineText(text), 'utf8').digest('hex');
}

const getLineByIdStmt = sqliteDb.prepare<[number], NotepadLineRow>(`
  SELECT id, idx, text FROM notepad_lines WHERE id = ?
`);

/** Fetch a single line by id (any day). Used by routes to 404 on an unknown id. */
export function getNotepadLine(lineId: number): NotepadLineRow | undefined {
  return getLineByIdStmt.get(lineId);
}

const getLineDayStmt = sqliteDb.prepare<[number], { day: string }>(`
  SELECT day FROM notepad_lines WHERE id = ?
`);

/** Which day a line belongs to. Used by the marker-dismiss route to hand
 *  back the same day's full GET /notepad shape after a dismiss. */
export function getNotepadLineDay(lineId: number): string | undefined {
  return getLineDayStmt.get(lineId)?.day;
}

// line_id is the PRIMARY KEY, so this UPSERT can only ever hold one row per
// line — an already-'acted' line that gets marked acted again UPDATES that
// same row (the reconciliation-resolved path), it never inserts a sibling.
const upsertLineStateStmt = sqliteDb.prepare<[number, NotepadLineState, string, string | null, string | null]>(`
  INSERT INTO notepad_line_state (line_id, state, hash, scanned_at, action_ref, note, updated_at)
  VALUES (?, ?, ?, datetime('now'), ?, ?, datetime('now'))
  ON CONFLICT(line_id) DO UPDATE SET
    state      = excluded.state,
    hash       = excluded.hash,
    scanned_at = excluded.scanned_at,
    action_ref = excluded.action_ref,
    note       = excluded.note,
    updated_at = excluded.updated_at
`);

function markLine(lineId: number, state: NotepadLineState, actionRef: string | null, note: string | null): void {
  const line = getNotepadLine(lineId);
  if (!line) throw new Error(`notepad line ${lineId} not found`);
  // Stamp the hash of the text that was ACTUALLY examined right now — never
  // a hash computed later — per §3's closing paragraph.
  const hash = lineTextHash(line.text);
  // Writes resolve lineage exactly like the reads do (getNotepadLineState,
  // unscannedLines): the ledger holds ONE row per origin thought, keyed by
  // origin_line_id (CARRY-FORWARD.md §2.3). Writing under a carried line's
  // own id would create a second row that no reader ever looks at -- the
  // state would be silently lost and the thought re-acted on.
  upsertLineStateStmt.run(resolveLedgerKey(lineId), state, hash, actionRef, note);
}

/** JARVIS examined the line's current text and judged it not actionable right now. */
export function markLineSeen(lineId: number): void {
  markLine(lineId, 'seen', null, null);
}

/**
 * JARVIS took a real action because of this line. actionRef points into
 * whatever system received the work (thread external_id, hopper tree id,
 * goal node id, hopper item id, workstream id, commitment id, ...).
 */
export function markLineActed(lineId: number, actionRef: string): void {
  if (!actionRef || !actionRef.trim()) {
    throw new Error('actionRef is required for markLineActed');
  }
  markLine(lineId, 'acted', actionRef, null);
}

/** The line was explicitly ruled out as not needing further tracking. */
export function markLineDismissed(lineId: number, note?: string): void {
  markLine(lineId, 'dismissed', null, note && note.trim() ? note : null);
}

/**
 * Kevin (or JARVIS) has finished with the line entirely -- unlike `acted`
 * (JARVIS did something, but the thought may still be open), `done` means
 * there is nothing left to track: notepad-rollover.ts's carry-forward will
 * not carry it, and it will not resurface via unscannedLines.
 *
 * There is no UI affordance for setting this state yet (node #886) -- it is
 * ledger-only for now, exercised by scripts/notepad-rollover-check.mjs. A UI
 * button is a later node (see docs/notepad/CARRY-FORWARD.md §6).
 */
export function markLineDone(lineId: number, note?: string): void {
  markLine(lineId, 'done', null, note && note.trim() ? note : null);
}

const listLineStatesForDayStmt = sqliteDb.prepare<
  [string],
  { id: number; idx: number; text: string; state: NotepadLineState | null; hash: string | null; action_ref: string | null }
>(`
  SELECT l.id AS id, l.idx AS idx, l.text AS text,
         s.state AS state, s.hash AS hash, s.action_ref AS action_ref
  FROM notepad_lines l
  LEFT JOIN notepad_line_state s ON s.line_id = l.id
  WHERE l.day = ?
  ORDER BY l.idx ASC, l.id ASC
`);

/**
 * Every line a scanner should look at for `day`, per the decision table
 * (§4): every line with no state row ('unseen' is the absence of a row, not
 * a value), plus every seen/acted/dismissed line whose CURRENT normalized
 * hash no longer matches the hash recorded when that state was last set.
 * Unchanged lines (hash still matches) are skipped entirely.
 */
export function unscannedLines(day: string): UnscannedNotepadLine[] {
  const rows = listLineStatesForDayStmt.all(day);
  const out: UnscannedNotepadLine[] = [];
  for (const row of rows) {
    let state = row.state;
    let hash = row.hash;
    let actionRef = row.action_ref;
    if (state === null) {
      // No ledger row under this line's OWN id. Before treating it as
      // genuinely 'unseen', resolve through its origin (node #886) -- a
      // carried line has a brand-new id but may have a prior incarnation's
      // state recorded under origin_line_id.
      const resolvedKey = resolveLedgerKey(row.id);
      if (resolvedKey !== row.id) {
        const originState = getLineStateStmt.get(resolvedKey);
        if (originState) {
          state = originState.state;
          hash = originState.hash;
          actionRef = originState.action_ref;
        }
      }
    }
    if (state === null || hash === null) {
      // No ledger row at all (own or origin's) -> 'unseen'. No recorded hash
      // to compare against, so it always surfaces as a first look.
      out.push({ line_id: row.id, idx: row.idx, text: row.text, kind: 'first_look', action_ref: null });
      continue;
    }
    const currentHash = lineTextHash(row.text);
    if (currentHash === hash) continue; // unchanged since last recorded -> skip
    if (state === 'acted') {
      // Hash changed on an acted line -> reconciliation, carrying the
      // existing action_ref. Never a bare first-look for this state.
      out.push({ line_id: row.id, idx: row.idx, text: row.text, kind: 'reconcile', action_ref: actionRef });
    } else {
      // seen/dismissed/done judged specific prior text; different text has
      // never been judged -> first look, not "already seen/dismissed/done".
      out.push({ line_id: row.id, idx: row.idx, text: row.text, kind: 'first_look', action_ref: null });
    }
  }
  return out;
}

const getLineStateStmt = sqliteDb.prepare<[number], NotepadLineStateRow>(`
  SELECT * FROM notepad_line_state WHERE line_id = ?
`);

/**
 * Read the raw ledger row for one line, if any. Resolves
 * through the registered ledger key resolver first (node #886) so a carried
 * line finds its origin's ledger row instead of always looking unseen.
 */
export function getNotepadLineState(lineId: number): NotepadLineStateRow | undefined {
  return getLineStateStmt.get(resolveLedgerKey(lineId));
}
