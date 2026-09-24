import { sqliteDb } from './conversation-db.js';

// Cockpit Notepad — one free-form note per calendar day (US/Central), backed
// by per-LINE identity rather than a single text blob. PUT diffs the incoming
// full text against the stored lines and reuses row ids for lines that are
// unchanged/reworded/moved, so a client can attach comments/state to a
// specific line and have it survive edits elsewhere in the note.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
 *   2. Positional reword — old lines left unconsumed by (1) are paired, in
 *      original relative order, with new lines left unmatched by (1). This is
 *      "the line at roughly this spot got reworded" — same id, new text.
 *   3. Anything left over on the new side is a genuine insert (new id);
 *      anything left over on the old side is a genuine delete.
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
    for (const newIdx of newIdxs) {
      if (available.length === 0) break;
      let bestPos = 0;
      let bestDist = Math.abs(available[0].idx - newIdx);
      for (let p = 1; p < available.length; p++) {
        const dist = Math.abs(available[p].idx - newIdx);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = p;
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

  const rewordCount = Math.min(leftoverOld.length, leftoverNewIdxs.length);
  const rewordMap = new Map<number, NotepadLineRow>();
  for (let i = 0; i < rewordCount; i++) rewordMap.set(leftoverNewIdxs[i], leftoverOld[i]);
  const insertIdxs = leftoverNewIdxs.slice(rewordCount);
  const deletes = leftoverOld.slice(rewordCount);

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
