// INTEL DESK — store access for the CLI/timer runner.
//
// The real store (table schema + CRUD + SSE emit) is `src/intel-desk.ts`,
// built by a parallel hopper node per docs/intel-desk/CONTRACT.md. This file
// tries to use that module first; if it hasn't landed yet, it falls back to a
// local implementation against the EXACT same schema, so:
//   - the runner works today, before the backend module exists
//   - data lands in the same tables/columns, so nothing needs migrating once
//     the real module ships (CREATE TABLE IF NOT EXISTS makes table creation
//     order irrelevant)
//   - once `src/intel-desk.ts` exists and exports the same function names,
//     this file picks it up automatically and the fallback goes dormant.
//
// Do not edit `src/intel-desk.ts` from here — that file belongs to the
// backend node building in parallel.

import { sqliteDb } from '../../src/conversation-db.js';
import { sseBus } from '../../src/sse-bus.js';
// Side-effect import only: makes sure `hopper_items` exists before our
// `intel_items.promoted_hopper_id` foreign key is declared. Harmless if this
// module has already run elsewhere in the process.
import '../../src/hopper.js';

export type IntelLane = 'providers' | 'harvest' | 'tooling' | 'stack' | 'social';
export type IntelVerdict = 'act' | 'watch' | 'fyi';
export type IntelRunStatus = 'queued' | 'running' | 'done' | 'failed';
export type IntelSourceKind =
  | 'official_docs' | 'pricing' | 'release_notes' | 'blog' | 'github'
  | 'reddit' | 'x' | 'youtube' | 'paper' | 'other';

export const INTEL_LANES: IntelLane[] = ['providers', 'harvest', 'tooling', 'stack', 'social'];

export interface IntelRun {
  id: number;
  run_date: string;
  status: IntelRunStatus;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
  created_at?: string | null;
}

export interface IntelItem {
  id: number;
  run_id: number;
  lane: IntelLane;
  title: string;
  summary: string;
  why_it_matters: string;
  verdict: IntelVerdict;
  source_url: string | null;
  source_kind: IntelSourceKind | null;
  tags: string[];
  created_at: string;
  promoted_hopper_id: number | null;
}

export interface NewIntelItem {
  lane: IntelLane;
  title: string;
  summary: string;
  why_it_matters: string;
  verdict: IntelVerdict;
  source_url: string | null;
  source_kind: IntelSourceKind;
  tags: string[];
}

export interface IntelRunStatusFields {
  started_at?: string | null;
  finished_at?: string | null;
  summary?: string | null;
  error?: string | null;
}

export interface IntelStoreModule {
  createIntelRun(runDate: string): IntelRun;
  updateIntelRunStatus(id: number, status: IntelRunStatus, fields?: IntelRunStatusFields): IntelRun | null;
  getIntelRun(id: number): IntelRun | null;
  /** Optional (real backend only): the single queued/running run, after
   *  expiring stale ones. The fallback store has no stale sweep, so it omits it. */
  getActiveIntelRun?(): IntelRun | null;
  createIntelItems(runId: number, items: NewIntelItem[]): IntelItem[];
}

// ---------------------------------------------------------------------------
// Local fallback — schema copied verbatim from docs/intel-desk/CONTRACT.md.
// ---------------------------------------------------------------------------

function buildFallbackStore(): IntelStoreModule {
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS intel_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'done', 'failed')),
      started_at TEXT,
      finished_at TEXT,
      summary TEXT,
      error TEXT,
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_intel_runs_date
      ON intel_runs(run_date DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_intel_runs_status_date
      ON intel_runs(status, run_date DESC, id DESC);

    CREATE TABLE IF NOT EXISTS intel_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES intel_runs(id) ON DELETE CASCADE,
      lane TEXT NOT NULL
        CHECK (lane IN ('providers', 'harvest', 'tooling', 'stack', 'social')),
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      why_it_matters TEXT NOT NULL,
      verdict TEXT NOT NULL
        CHECK (verdict IN ('act', 'watch', 'fyi')),
      source_url TEXT,
      source_kind TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      promoted_hopper_id INTEGER REFERENCES hopper_items(id)
    );

    CREATE INDEX IF NOT EXISTS idx_intel_items_run_lane
      ON intel_items(run_id, lane, id);

    CREATE INDEX IF NOT EXISTS idx_intel_items_verdict_created
      ON intel_items(verdict, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_intel_items_promoted
      ON intel_items(promoted_hopper_id);
  `);

  const insertRunStmt = sqliteDb.prepare<[string, string]>(
    `INSERT INTO intel_runs (run_date, status, created_at) VALUES (?, 'queued', ?)`,
  );
  const getRunStmt = sqliteDb.prepare<[number], IntelRun>(`SELECT * FROM intel_runs WHERE id = ?`);
  const updateRunStatusStmt = sqliteDb.prepare<
    [IntelRunStatus, string | null, string | null, string | null, string | null, number]
  >(`
    UPDATE intel_runs
    SET status = ?,
        started_at = COALESCE(?, started_at),
        finished_at = COALESCE(?, finished_at),
        summary = COALESCE(?, summary),
        error = COALESCE(?, error)
    WHERE id = ?
  `);

  interface IntelItemDbRow {
    id: number; run_id: number; lane: IntelLane; title: string; summary: string;
    why_it_matters: string; verdict: IntelVerdict; source_url: string | null;
    source_kind: IntelSourceKind | null; tags: string; created_at: string;
    promoted_hopper_id: number | null;
  }

  const insertItemStmt = sqliteDb.prepare<
    [number, IntelLane, string, string, string, IntelVerdict, string | null, IntelSourceKind, string]
  >(`
    INSERT INTO intel_items
      (run_id, lane, title, summary, why_it_matters, verdict, source_url, source_kind, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getItemStmt = sqliteDb.prepare<[number], IntelItemDbRow>(`SELECT * FROM intel_items WHERE id = ?`);

  function rowToItem(row: IntelItemDbRow): IntelItem {
    let tags: string[] = [];
    try { tags = JSON.parse(row.tags); } catch { tags = []; }
    return { ...row, tags };
  }

  function emitRun(action: 'created' | 'updated', run: IntelRun): void {
    try { sseBus.emit('sse', { type: 'intel_run', action, run }); } catch { /* best-effort */ }
  }

  function emitItem(action: 'created', item: IntelItem): void {
    try { sseBus.emit('sse', { type: 'intel_item', action, item }); } catch { /* best-effort */ }
  }

  return {
    createIntelRun(runDate: string): IntelRun {
      const info = insertRunStmt.run(runDate, new Date().toISOString());
      const run = getRunStmt.get(Number(info.lastInsertRowid));
      if (!run) throw new Error('Failed to load intel run after insert');
      emitRun('created', run);
      return run;
    },

    updateIntelRunStatus(id: number, status: IntelRunStatus, fields: IntelRunStatusFields = {}): IntelRun | null {
      updateRunStatusStmt.run(
        status,
        fields.started_at ?? null,
        fields.finished_at ?? null,
        fields.summary ?? null,
        fields.error ?? null,
        id,
      );
      const run = getRunStmt.get(id) ?? null;
      if (run) emitRun('updated', run);
      return run;
    },

    getIntelRun(id: number): IntelRun | null {
      return getRunStmt.get(id) ?? null;
    },

    createIntelItems(runId: number, items: NewIntelItem[]): IntelItem[] {
      const created: IntelItem[] = [];
      for (const it of items) {
        const info = insertItemStmt.run(
          runId, it.lane, it.title, it.summary, it.why_it_matters, it.verdict,
          it.source_url, it.source_kind, JSON.stringify(it.tags),
        );
        const row = getItemStmt.get(Number(info.lastInsertRowid));
        if (!row) continue;
        const item = rowToItem(row);
        created.push(item);
        emitItem('created', item);
      }
      return created;
    },
  };
}

let cachedStore: IntelStoreModule | null = null;

/** Prefer the real backend module (`src/intel-desk.ts`) once it exists;
 *  fall back to the local implementation above until then. */
export async function getIntelStore(): Promise<IntelStoreModule> {
  if (cachedStore) return cachedStore;
  // Built from a variable, not a string literal, so this never becomes a
  // hard static-resolution dependency on a file that may not exist yet.
  const backendSpecifier: string = '../../src/intel-desk.js';
  try {
    const mod: unknown = await import(backendSpecifier);
    const m = mod as Partial<IntelStoreModule>;
    if (
      typeof m.createIntelRun === 'function' &&
      typeof m.updateIntelRunStatus === 'function' &&
      typeof m.createIntelItems === 'function'
    ) {
      cachedStore = m as IntelStoreModule;
      return cachedStore;
    }
  } catch {
    // Not built yet (or missing an export) — use the local fallback.
  }
  cachedStore = buildFallbackStore();
  return cachedStore;
}
