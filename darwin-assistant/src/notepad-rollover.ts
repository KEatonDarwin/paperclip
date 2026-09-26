import type { Database as DatabaseType } from 'better-sqlite3';
// Side-effect import: notepad.ts creates notepad_days/notepad_lines/
// notepad_line_state (CREATE TABLE IF NOT EXISTS) at module load. The ALTER
// TABLE migration below must run AFTER those tables exist, so this import
// has to land first.
import './notepad.js';
import { sqliteDb } from './conversation-db.js';
import type { NotepadLineState } from './notepad.js';

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
try {
  sqliteDb.exec(`ALTER TABLE notepad_days ADD COLUMN rolled_over_at TEXT`);
} catch {
  // column already exists — re-running the migration is a no-op
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
 * "Open" = a line with no state-ledger row, or `seen` (examined but judged
 * not actionable — still an open thought, not a resolved one). "Closed" (not
 * carried) = `acted` (the closest existing state to "done" — JARVIS already
 * took real action because of this line) or `dismissed`. The existing
 * vocabulary (docs/notepad/LINE-IDENTITY.md §3) has no separate "done"
 * state, so `acted` is the deliberate stand-in — this is a judgment call,
 * not a discovered fact.
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
           LEFT JOIN notepad_line_state s ON s.line_id = l.id
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
        if (line.state === 'acted' || line.state === 'dismissed') continue; // closed — not carried
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
