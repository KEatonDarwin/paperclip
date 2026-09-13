import { sqliteDb } from './conversation-db.js';
import { createHopperItem, getHopperItem, type HopperItemRow } from './hopper.js';
import { sseBus, type IntelItemEvent, type IntelRunEvent } from './sse-bus.js';

export type IntelLane = 'providers' | 'harvest' | 'tooling' | 'stack' | 'social';
export type IntelVerdict = 'act' | 'watch' | 'fyi';
export type IntelRunStatus = 'queued' | 'running' | 'done' | 'failed';
export type IntelSourceKind =
  | 'official_docs'
  | 'pricing'
  | 'release_notes'
  | 'blog'
  | 'github'
  | 'reddit'
  | 'x'
  | 'youtube'
  | 'paper'
  | 'other';

export interface IntelRun {
  id: number;
  run_date: string;
  status: IntelRunStatus;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
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

interface IntelItemDbRow extends Omit<IntelItem, 'tags'> {
  tags: string;
}

export const INTEL_LANES: IntelLane[] = ['providers', 'harvest', 'tooling', 'stack', 'social'];
export const INTEL_VERDICTS: IntelVerdict[] = ['act', 'watch', 'fyi'];
export const INTEL_SOURCE_KINDS: IntelSourceKind[] = [
  'official_docs',
  'pricing',
  'release_notes',
  'blog',
  'github',
  'reddit',
  'x',
  'youtube',
  'paper',
  'other',
];

const LANE_SET = new Set<string>(INTEL_LANES);
const VERDICT_SET = new Set<string>(INTEL_VERDICTS);
const SOURCE_KIND_SET = new Set<string>(INTEL_SOURCE_KINDS);
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS intel_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'failed')),
    started_at  TEXT,
    finished_at TEXT,
    summary     TEXT,
    error       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_intel_runs_date
    ON intel_runs(run_date DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_intel_runs_status_date
    ON intel_runs(status, run_date DESC, id DESC);

  CREATE TABLE IF NOT EXISTS intel_items (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id             INTEGER NOT NULL REFERENCES intel_runs(id) ON DELETE CASCADE,
    lane               TEXT NOT NULL
                         CHECK (lane IN ('providers', 'harvest', 'tooling', 'stack', 'social')),
    title              TEXT NOT NULL,
    summary            TEXT NOT NULL,
    why_it_matters     TEXT NOT NULL,
    verdict            TEXT NOT NULL
                         CHECK (verdict IN ('act', 'watch', 'fyi')),
    source_url         TEXT,
    source_kind        TEXT
                         CHECK (
                           source_kind IN (
                             'official_docs', 'pricing', 'release_notes', 'blog', 'github',
                             'reddit', 'x', 'youtube', 'paper', 'other'
                           )
                           OR source_kind IS NULL
                         ),
    tags               TEXT NOT NULL DEFAULT '[]',
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    promoted_hopper_id INTEGER REFERENCES hopper_items(id)
  );

  CREATE INDEX IF NOT EXISTS idx_intel_items_run_lane
    ON intel_items(run_id, lane, id);

  CREATE INDEX IF NOT EXISTS idx_intel_items_verdict_created
    ON intel_items(verdict, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_intel_items_promoted
    ON intel_items(promoted_hopper_id);
`);

for (const col of [
  'summary TEXT',
  'error TEXT',
]) {
  try { sqliteDb.exec(`ALTER TABLE intel_runs ADD COLUMN ${col}`); } catch {}
}

for (const col of [
  'source_url TEXT',
  'source_kind TEXT',
  "tags TEXT NOT NULL DEFAULT '[]'",
  'promoted_hopper_id INTEGER REFERENCES hopper_items(id)',
]) {
  try { sqliteDb.exec(`ALTER TABLE intel_items ADD COLUMN ${col}`); } catch {}
}

const getRunStmt = sqliteDb.prepare<[number], IntelRun>(`SELECT * FROM intel_runs WHERE id = ?`);
const activeRunStmt = sqliteDb.prepare<[], IntelRun>(`
  SELECT * FROM intel_runs
  WHERE status IN ('queued', 'running')
  ORDER BY id ASC
  LIMIT 1
`);
const listRunsStmt = sqliteDb.prepare<[number], IntelRun>(`
  SELECT * FROM intel_runs
  ORDER BY run_date DESC, id DESC
  LIMIT ?
`);
const listRunsByStatusStmt = sqliteDb.prepare<[IntelRunStatus, number], IntelRun>(`
  SELECT * FROM intel_runs
  WHERE status = ?
  ORDER BY run_date DESC, id DESC
  LIMIT ?
`);
const insertRunStmt = sqliteDb.prepare<[string, IntelRunStatus]>(`
  INSERT INTO intel_runs (run_date, status)
  VALUES (?, ?)
`);
const updateRunStmt = sqliteDb.prepare<[
  IntelRunStatus,
  string | null,
  string | null,
  string | null,
  string | null,
  number,
]>(`
  UPDATE intel_runs
  SET status = ?,
      started_at = ?,
      finished_at = ?,
      summary = ?,
      error = ?
  WHERE id = ?
`);

const getItemStmt = sqliteDb.prepare<[number], IntelItemDbRow>(`SELECT * FROM intel_items WHERE id = ?`);
const listItemsStmt = sqliteDb.prepare<[number], IntelItemDbRow>(`
  SELECT * FROM intel_items
  WHERE run_id = ?
  ORDER BY CASE verdict WHEN 'act' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, lane ASC, id ASC
`);
const listItemsByLaneStmt = sqliteDb.prepare<[number, IntelLane], IntelItemDbRow>(`
  SELECT * FROM intel_items
  WHERE run_id = ? AND lane = ?
  ORDER BY CASE verdict WHEN 'act' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, id ASC
`);
const listItemsByVerdictStmt = sqliteDb.prepare<[number, IntelVerdict], IntelItemDbRow>(`
  SELECT * FROM intel_items
  WHERE run_id = ? AND verdict = ?
  ORDER BY lane ASC, id ASC
`);
const listItemsByLaneVerdictStmt = sqliteDb.prepare<[number, IntelLane, IntelVerdict], IntelItemDbRow>(`
  SELECT * FROM intel_items
  WHERE run_id = ? AND lane = ? AND verdict = ?
  ORDER BY id ASC
`);
const insertItemStmt = sqliteDb.prepare<[
  number,
  IntelLane,
  string,
  string,
  string,
  IntelVerdict,
  string | null,
  IntelSourceKind | null,
  string,
]>(`
  INSERT INTO intel_items (
    run_id, lane, title, summary, why_it_matters, verdict, source_url, source_kind, tags
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const setItemPromotedStmt = sqliteDb.prepare<[number, number]>(`
  UPDATE intel_items
  SET promoted_hopper_id = ?
  WHERE id = ?
`);

function nowIso(): string {
  return new Date().toISOString();
}

export function intelRunDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isIntelLane(value: unknown): value is IntelLane {
  return typeof value === 'string' && LANE_SET.has(value);
}

export function isIntelVerdict(value: unknown): value is IntelVerdict {
  return typeof value === 'string' && VERDICT_SET.has(value);
}

export function isIntelRunStatus(value: unknown): value is IntelRunStatus {
  return value === 'queued' || value === 'running' || value === 'done' || value === 'failed';
}

function isIntelSourceKind(value: unknown): value is IntelSourceKind {
  return typeof value === 'string' && SOURCE_KIND_SET.has(value);
}

function emitRun(action: IntelRunEvent['action'], run: IntelRun): void {
  sseBus.emit('sse', { type: 'intel_run', action, run } satisfies IntelRunEvent);
}

function emitItem(action: IntelItemEvent['action'], item: IntelItem): void {
  sseBus.emit('sse', { type: 'intel_item', action, item } satisfies IntelItemEvent);
}

function cleanText(value: string, max: number): string {
  return value.replace(CONTROL_CHARS, '').trim().slice(0, max);
}

function normalizeUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeTags(tags: string[] | null | undefined): string[] {
  return (tags ?? [])
    .map((tag) => tag.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter((tag, idx, all) => tag.length > 0 && all.indexOf(tag) === idx)
    .slice(0, 8);
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? normalizeTags(parsed.filter((tag): tag is string => typeof tag === 'string')) : [];
  } catch {
    return [];
  }
}

function hydrateItem(row: IntelItemDbRow | null): IntelItem | null {
  if (!row) return null;
  return {
    ...row,
    source_url: normalizeUrl(row.source_url),
    source_kind: isIntelSourceKind(row.source_kind) ? row.source_kind : null,
    tags: parseTags(row.tags),
  };
}

function requireRun(id: number): IntelRun {
  const run = getRunStmt.get(id);
  if (!run) throw new Error(`intel run ${id} not found`);
  return run;
}

export function getIntelRun(id: number): IntelRun | null {
  return getRunStmt.get(id) ?? null;
}

export function getActiveIntelRun(): IntelRun | null {
  return activeRunStmt.get() ?? null;
}

export function listIntelRuns(args: { status?: IntelRunStatus | 'all'; limit?: number } = {}): IntelRun[] {
  const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
  if (args.status && args.status !== 'all') return listRunsByStatusStmt.all(args.status, limit);
  return listRunsStmt.all(limit);
}

export function createIntelRun(args: {
  run_date?: string;
  status?: IntelRunStatus;
} | string = {}): IntelRun {
  const runDate = typeof args === 'string' ? args : args.run_date;
  const status = typeof args === 'string' ? 'queued' : args.status ?? 'queued';
  if (!isIntelRunStatus(status)) throw new Error('invalid intel run status');
  const info = insertRunStmt.run(runDate ?? intelRunDate(), status);
  const created = getIntelRun(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to load intel run after insert');
  emitRun('created', created);
  return created;
}

export function updateIntelRunStatus(
  id: number,
  status: IntelRunStatus,
  patch: { started_at?: string | null; finished_at?: string | null; summary?: string | null; error?: string | null } = {},
): IntelRun | null {
  const existing = getIntelRun(id);
  if (!existing) return null;
  const startedAt = patch.started_at !== undefined
    ? patch.started_at
    : status === 'running' && !existing.started_at
      ? nowIso()
      : existing.started_at;
  const finishedAt = patch.finished_at !== undefined
    ? patch.finished_at
    : (status === 'done' || status === 'failed') && !existing.finished_at
      ? nowIso()
      : existing.finished_at;
  const summary = patch.summary !== undefined ? patch.summary : existing.summary;
  const error = patch.error !== undefined ? patch.error : existing.error;
  updateRunStmt.run(status, startedAt, finishedAt, summary, error, id);
  const updated = getIntelRun(id);
  if (updated) emitRun('updated', updated);
  return updated;
}

export function getIntelItem(id: number): IntelItem | null {
  return hydrateItem(getItemStmt.get(id) ?? null);
}

export function listIntelItems(args: {
  run_id: number;
  lane?: IntelLane;
  verdict?: IntelVerdict;
}): IntelItem[] {
  if (args.lane && args.verdict) return listItemsByLaneVerdictStmt.all(args.run_id, args.lane, args.verdict).map(hydrateItem).filter((item): item is IntelItem => item !== null);
  if (args.lane) return listItemsByLaneStmt.all(args.run_id, args.lane).map(hydrateItem).filter((item): item is IntelItem => item !== null);
  if (args.verdict) return listItemsByVerdictStmt.all(args.run_id, args.verdict).map(hydrateItem).filter((item): item is IntelItem => item !== null);
  return listItemsStmt.all(args.run_id).map(hydrateItem).filter((item): item is IntelItem => item !== null);
}

export function createIntelItems(
  runId: number,
  items: Array<{
    lane: IntelLane;
    title: string;
    summary: string;
    why_it_matters: string;
    verdict: IntelVerdict;
    source_url?: string | null;
    source_kind?: IntelSourceKind | null;
    tags?: string[];
  }>,
): IntelItem[] {
  requireRun(runId);
  const createdIds: number[] = [];
  const insertMany = sqliteDb.transaction(() => {
    const seen = new Set<string>();
    for (const item of items) {
      if (!isIntelLane(item.lane)) throw new Error(`invalid intel lane: ${String(item.lane)}`);
      if (!isIntelVerdict(item.verdict)) throw new Error(`invalid intel verdict: ${String(item.verdict)}`);
      const title = cleanText(item.title, 160);
      const summary = cleanText(item.summary, 700);
      const why = cleanText(item.why_it_matters, 700);
      if (!title || !summary || !why) throw new Error('intel item title, summary, and why_it_matters are required');
      const sourceUrl = normalizeUrl(item.source_url);
      const sourceKind = isIntelSourceKind(item.source_kind) ? item.source_kind : null;
      const tags = JSON.stringify(normalizeTags(item.tags));
      const key = `${sourceUrl ?? ''}::${title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const info = insertItemStmt.run(
        runId,
        item.lane,
        title,
        summary,
        why,
        item.verdict,
        sourceUrl,
        sourceKind,
        tags,
      );
      createdIds.push(Number(info.lastInsertRowid));
    }
  });
  insertMany();
  const created = createdIds.map((id) => getIntelItem(id)).filter((item): item is IntelItem => item !== null);
  created.forEach((item) => emitItem('created', item));
  return created;
}

export function promoteIntelItem(id: number): { item: IntelItem; hopper_item: HopperItemRow | null } | null {
  const item = getIntelItem(id);
  if (!item) return null;
  if (item.promoted_hopper_id) {
    return { item, hopper_item: getHopperItem(item.promoted_hopper_id) };
  }

  const run = requireRun(item.run_id);
  const hopper = createHopperItem({
    title: item.title,
    summary: item.why_it_matters,
    source: 'intel-desk',
    source_ref: item.source_url ?? `${run.run_date}/${item.lane}/${item.id}`,
    raw_message: item.summary,
    suggested_model: item.verdict === 'act' ? 'claude-sonnet-5' : null,
  });
  setItemPromotedStmt.run(hopper.id, id);
  const updated = getIntelItem(id);
  if (!updated) throw new Error('Failed to load intel item after promotion');
  emitItem('updated', updated);
  return { item: updated, hopper_item: hopper };
}
