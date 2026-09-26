import type { Database as DatabaseType } from 'better-sqlite3';
// Side-effect import: notepad.ts creates notepad_days/notepad_lines/
// notepad_line_state (CREATE TABLE IF NOT EXISTS) at module load. The ALTER
// TABLE migration below must run AFTER those tables exist, so this import
// has to land first.
import './notepad.js';
import { sqliteDb } from './conversation-db.js';
import { getNotepadDay, getNotepadLineState, registerLedgerKeyResolver, todayNotepadDate } from './notepad.js';
import type { NotepadDay, NotepadLineState, NotepadLineStateRow } from './notepad.js';

// Carry-forward engine (goal: "Yesterday rolls forward" — node #881).
// Copies yesterday's still-OPEN lines into a newly-opened day as fresh line
// rows, linked back to their first incarnation via `origin_line_id` so a
// thought's identity survives across day boundaries the same way a line's
// id survives an edit within one day (docs/notepad/LINE-IDENTITY.md).
//
// This module does NOT wire itself into the day-open path — it only exports
// carryForwardInto() for the next node to call from there.

// == Migration (additive only) ================================================
//
// origin_line_id / origin_day: identity of the FIRST incarnation of a
// thought. NULL on an originally-typed line (not self-referential — the
// absence of a value IS "this is day zero for this thought", mirroring how
// `unseen` in the state ledger is the absence of a row rather than a value).
// Carried lines always have both set, inherited from the source line's own
// origin if it has one, else the source line/day itself.
//
// carried_from_line_id / carried_at: the immediately-previous day's line row
// this row was copied from, and when. One-hop only — walk origin_line_id to
// follow the whole chain back to day zero.
for (const col of [
  'origin_line_id TEXT',
  'origin_day TEXT',
  'carried_from_line_id TEXT',
  'carried_at TEXT',
]) {
  try {
    sqliteDb.exec(`ALTER TABLE notepad_lines ADD COLUMN ${col}`);
  } catch {
    // column already exists — re-running the migration is a no-op
  }
}
sqliteDb.exec(`CREATE INDEX IF NOT EXISTS idx_notepad_lines_origin_line_id ON notepad_lines(origin_line_id)`);

// rolled_over_at: stamped every time carryForwardInto() runs for a day
// (whether or not it actually carried anything), so the wiring node can
// cheaply tell a rolled day from a virgin one without re-deriving it from
// the lines themselves.
let addedRolledOverAtColumn = false;
try {
  sqliteDb.exec(`ALTER TABLE notepad_days ADD COLUMN rolled_over_at TEXT`);
  addedRolledOverAtColumn = true;
} catch {
  // column already exists — re-running the migration is a no-op
}
if (addedRolledOverAtColumn) {
  // Backfill: the live DB already holds days written before this column
  // existed. Without this, every one of them looks "never rolled" and the
  // first real open of each would needlessly re-derive/rewrite it (and, pre
  // node #886's date gate, could even misfire carry-forward against a
  // decades-old day). Runs exactly once, at the moment the column is
  // added — never again on a later boot where the column already exists,
  // since addedRolledOverAtColumn is only true on the ALTER that actually
  // creates it.
  sqliteDb.prepare(`UPDATE notepad_days SET rolled_over_at = ? WHERE rolled_over_at IS NULL`).run(new Date().toISOString());
}

// == Carry-forward =============================================================

export interface CarryForwardOptions {
  /**
   * Injectable clock — an ISO timestamp, or a function returning one. This
   * is the ONLY place `new Date()` may be called (as the real-clock default
   * below); the rest of the function always reads the already-resolved
   * value, so a caller that passes `now` gets fully deterministic, replayable
   * output.
   */
  now?: string | (() => string);
}

export interface CarryForwardResult {
  targetDay: string;
  sourceDay: string | null;
  carried: number;
  skipped: number;
  lineIds: number[];
}

interface SourceLineRow {
  id: number;
  idx: number;
  text: string;
  origin_line_id: string | null;
  origin_day: string | null;
  state: NotepadLineState | null;
}

function resolveNow(now: CarryForwardOptions['now']): string {
  if (typeof now === 'function') return now();
  if (typeof now === 'string' && now) return now;
  return new Date().toISOString();
}

/**
 * Copy the most recent prior day's still-OPEN lines into `targetDay` as new
 * line rows, preserving order and linking identity back via
 * origin_line_id/origin_day (docs/notepad/LINE-IDENTITY.md's identity model,
 * extended across days).
 *
 * "Open" = a line with no state-ledger row, `seen` (examined but judged not
 * actionable — still an open thought, not a resolved one), or `acted`
 * (JARVIS took real action, but that does NOT mean Kevin is finished with
 * the thought — acting on a line is not the same as being done with it, and
 * silently dropping it because JARVIS did something is the exact failure
 * that sends Kevin back to a plain .txt file). "Closed" (not carried) =
 * `dismissed` (explicitly ruled out) or `done` (explicitly finished — node
 * #886; there is no UI affordance for setting it yet, see
 * docs/notepad/CARRY-FORWARD.md §6).
 *
 * Idempotent: running this twice for the same targetDay carries nothing new
 * the second time. This is enforced structurally — before inserting, a
 * source line is skipped if its resolved origin_line_id already has a row on
 * targetDay — not by a boolean flag alone. notepad_days.rolled_over_at is
 * ALSO stamped on every call as a separate, cheap marker for the wiring
 * node; it is not itself what prevents duplication.
 *
 * Pure with respect to `db`: every read and write goes through the handle
 * passed in, never the module's own singleton import, so a caller (e.g. a
 * check script against a scratch database) gets fully isolated behavior.
 */
export function carryForwardInto(
  db: DatabaseType,
  targetDay: string,
  opts: CarryForwardOptions = {}
): CarryForwardResult {
  const nowIso = resolveNow(opts.now);

  const runTx = db.transaction((): CarryForwardResult => {
    // The day row must exist before any notepad_lines row can reference it
    // (notepad_lines.day REFERENCES notepad_days(day)) — targetDay may be a
    // brand-new day with no prior activity at all.
    db.prepare(`INSERT INTO notepad_days (day) VALUES (?) ON CONFLICT(day) DO NOTHING`).run(targetDay);

    const sourceRow = db
      .prepare<[string], { day: string }>(
        `SELECT d.day AS day
         FROM notepad_days d
         WHERE d.day < ? AND EXISTS (SELECT 1 FROM notepad_lines l WHERE l.day = d.day)
         ORDER BY d.day DESC
         LIMIT 1`
      )
      .get(targetDay);
    const sourceDay = sourceRow?.day ?? null;

    let carried = 0;
    let skipped = 0;
    const lineIds: number[] = [];

    if (sourceDay) {
      const sourceLines = db
        .prepare<[string], SourceLineRow>(
          `SELECT l.id AS id, l.idx AS idx, l.text AS text,
                  l.origin_line_id AS origin_line_id, l.origin_day AS origin_day,
                  s.state AS state
           FROM notepad_lines l
           -- Lineage-aware join (CARRY-FORWARD.md 2.3): a carried line's state
           -- lives under its origin_line_id, never under its own id, so joining
           -- on l.id would read every carried line as having no ledger row --
           -- and a dismissed/done thought would resurrect every single day.
           LEFT JOIN notepad_line_state s
                  ON s.line_id = CAST(COALESCE(l.origin_line_id, l.id) AS INTEGER)
           WHERE l.day = ?
           ORDER BY l.idx ASC, l.id ASC`
        )
        .all(sourceDay);

      const existingOriginIds = new Set<string>(
        db
          .prepare<[string], { origin_line_id: string }>(
            `SELECT origin_line_id FROM notepad_lines WHERE day = ? AND origin_line_id IS NOT NULL`
          )
          .all(targetDay)
          .map((r) => r.origin_line_id)
      );

      const maxIdxRow = db
        .prepare<[string], { maxIdx: number }>(`SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM notepad_lines WHERE day = ?`)
        .get(targetDay)!;
      let nextIdx = maxIdxRow.maxIdx + 1;

      const insertStmt = db.prepare<[string, number, string, string, string, string, string]>(
        `INSERT INTO notepad_lines (day, idx, text, origin_line_id, origin_day, carried_from_line_id, carried_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      for (const line of sourceLines) {
        if (line.state === 'dismissed' || line.state === 'done') continue; // closed — not carried
        if (line.text.trim() === '') continue; // blank line — nothing to carry

        const originLineId = line.origin_line_id ?? String(line.id);
        if (existingOriginIds.has(originLineId)) {
          skipped++;
          continue;
        }

        const originDay = line.origin_day ?? sourceDay;
        const info = insertStmt.run(targetDay, nextIdx++, line.text, originLineId, originDay, String(line.id), nowIso);
        lineIds.push(Number(info.lastInsertRowid));
        existingOriginIds.add(originLineId);
        carried++;
      }
    }

    db.prepare(`UPDATE notepad_days SET rolled_over_at = ? WHERE day = ?`).run(nowIso, targetDay);

    return { targetDay, sourceDay, carried, skipped, lineIds };
  });

  return runTx();
}

// == Day-open wiring (node #882) ===============================================
//
// Wires carryForwardInto() into the real day-open path. A day is "opened" by
// GET /notepad (see handlers/api-v1.ts). The FIRST open of a given day (no
// notepad_days row yet, or a row with no rolled_over_at stamp -- e.g. one
// created by a PUT that landed before the day was ever opened) runs the
// carry-forward engine for it. Every subsequent open of the same day is a
// fast path: it reads notepad_days.rolled_over_at, sees it's already set,
// and returns without calling into the engine at all -- carryForwardInto's
// own structural dedupe would also make a second call a no-op, but the
// stamp check means opening a day ten times only ever does the query work
// once.

const getDayRowStmt = sqliteDb.prepare<[string], { rolled_over_at: string | null }>(
  `SELECT rolled_over_at FROM notepad_days WHERE day = ?`
);

// Same "most recent day with lines strictly before this one" lookup
// carryForwardInto uses internally -- re-run here (rather than trusting a
// carryForwardInto return value that may be from a much earlier call) so
// carriedFrom is correct on both the very first open and every fast-path
// open after it.
const sourceDayStmt = sqliteDb.prepare<[string], { day: string }>(
  `SELECT d.day AS day
   FROM notepad_days d
   WHERE d.day < ? AND EXISTS (SELECT 1 FROM notepad_lines l WHERE l.day = d.day)
   ORDER BY d.day DESC
   LIMIT 1`
);

const carriedCountStmt = sqliteDb.prepare<[string], { n: number }>(
  `SELECT COUNT(*) AS n FROM notepad_lines WHERE day = ? AND carried_from_line_id IS NOT NULL`
);

export interface NotepadDayOpened extends NotepadDay {
  /** The day carried lines on this day originated from, or null if none were carried. */
  carriedFrom: string | null;
  /** How many of this day's lines are carried-forward (not originally typed here). */
  carriedCount: number;
}

// The GET /notepad route accepts an arbitrary `?date=` (even though the UI
// never offers one), so `day` here is not trustworthy as "today" on its own.
// A PAST date must be a pure read: carrying into it would insert rows into a
// day that's done, and stamping it would make the real day it belongs to
// look "already rolled" if it's ever opened for real. A FUTURE date is worse:
// carrying into tomorrow today, and stamping tomorrow's rolled_over_at,
// makes the real morning open of that day see the stamp and skip
// carry-forward entirely -- silently losing that day's open lines. So
// carry-forward runs ONLY when the requested day IS today.
//
// `opts.now`, when provided, is treated as "today" too (not just a stamp
// value) -- consistent with this file's existing "now is the only place the
// real clock may be read" rule, and what lets a scratch-DB proof control
// "today" deterministically without touching the real system clock. The real
// HTTP route never passes `now`, so it always uses the genuine wall clock.
function isOpeningToday(day: string, now: CarryForwardOptions['now']): boolean {
  if (now === undefined) return day === todayNotepadDate();
  const iso = resolveNow(now);
  return day === new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(iso));
}

/**
 * The real day-open entry point. Ensures carryForwardInto() runs exactly
 * once per day -- and only for TODAY (see isOpeningToday above) -- then
 * returns the day's lines plus a small additive summary of what (if
 * anything) was carried, so a caller (the cockpit) can say "7 lines carried
 * from Tuesday" without a second request.
 */
export function openNotepadDay(day: string, opts: CarryForwardOptions = {}): NotepadDayOpened {
  const existing = getDayRowStmt.get(day);
  if (isOpeningToday(day, opts.now) && !existing?.rolled_over_at) {
    carryForwardInto(sqliteDb, day, opts);
  }
  const carriedCount = carriedCountStmt.get(day)?.n ?? 0;
  const carriedFrom = carriedCount > 0 ? sourceDayStmt.get(day)?.day ?? null : null;
  return { ...getNotepadDay(day), carriedFrom, carriedCount };
}

// == Lineage-aware ledger read (node #882) =====================================
//
// The per-line state ledger (notepad_line_state, docs/notepad/LINE-IDENTITY.md)
// is keyed by line_id. A carried line is a NEW row with a NEW id, so a naive
// ledger lookup on that id would always come back empty -- the thought would
// look brand-new even though yesterday's incarnation already has a
// last_seen/last_action recorded against it. Resolving through
// origin_line_id first fixes that without duplicating any ledger rows: there
// is still exactly one ledger row per origin thought, and every incarnation
// of that thought (today's and every future carried day's) resolves to it.

const getLineOriginStmt = sqliteDb.prepare<[number], { origin_line_id: string | null }>(
  `SELECT origin_line_id FROM notepad_lines WHERE id = ?`
);

/**
 * Resolve the ledger key for a line id. carryForwardInto (above) always
 * copies the source line's own origin_line_id forward as-is -- never
 * replaces it with the source line's id -- so origin_line_id already points
 * straight at the first (day-zero) incarnation of a thought no matter how
 * many days it has been carried across. This is always a single hop, never
 * a walk up a chain. A line with no origin_line_id IS its own origin and
 * resolves to itself.
 */
export function resolveLedgerKey(lineId: number): number {
  const origin = getLineOriginStmt.get(lineId)?.origin_line_id;
  if (origin) {
    const parsed = Number(origin);
    if (Number.isFinite(parsed)) return parsed;
  }
  return lineId;
}

/**
 * Lineage-aware ledger read: resolves lineId to its origin (see
 * resolveLedgerKey) before reading notepad_line_state, so a carried line
 * finds its prior incarnation's seen/acted/dismissed/done state (and
 * action_ref, if one exists) instead of always looking unseen.
 */
export function getLedgerStateForLine(lineId: number): NotepadLineStateRow | undefined {
  return getNotepadLineState(resolveLedgerKey(lineId));
}

// Wire resolveLedgerKey into the REAL scan/marker path (node #886). Before
// this, resolveLedgerKey/getLedgerStateForLine had zero production callers --
// nothing in the running system read the lineage this module writes, so a
// carried line always looked brand-new to JARVIS. notepad.ts's own
// getNotepadLineState() (used by notepad-markers.ts, notepad-dispatch.ts,
// notepad-action-resolver.ts, notepad-review.ts, the GET /notepad/lines/:id
// route, and -- via unscannedLines()'s use of the same registered resolver --
// notepad-gate.ts) is the actual chokepoint every one of those reads through,
// so registering here wires all of them at once. See registerLedgerKeyResolver
// in notepad.ts for why this is a runtime registration rather than notepad.ts
// statically importing this file.
registerLedgerKeyResolver(resolveLedgerKey);
