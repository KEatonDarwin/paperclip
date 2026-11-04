/**
 * MIKE RADAR — the store. Schema + row types + every read/write the REST layer,
 * the ingester and the report generator share.
 *
 * WHAT THIS IS (DESIGN.md §0): Kevin cannot read Mike's Lovable work as it
 * happens, and the raw Lovable Watcher archive is 27 MB of JSONL he will never
 * open. Mike Radar turns it into a page he actually looks at — one row per
 * project, a git-style feed of what Mike asked for and what the Lovable agent
 * changed, and a model-written daily engineering report per project.
 *
 * HARD INVARIANT: nothing under `mike_*` ever writes to Lovable or to any of
 * Mike's Supabase projects. The archive on disk is the only input; `jarvis.db`
 * is the only output.
 *
 * DDL runs on import via `sqliteDb.exec`, same as intel-desk.ts / night-shift.ts,
 * and is additive-only forever.
 */

import { sqliteDb, getConversation, getOrCreateConversation, renameConversation } from './conversation-db.js';
import { sseBus, type MikeProjectEvent, type MikeActivityEvent, type MikeReportEvent } from './sse-bus.js';
import { shortId as deriveShortId, type MikeChange, riskFlagsFromChanges } from './mike-radar-parse.js';

/** Kevin's pinned shortlist, from the node spec. Seeded `is_key = 1` the first
 *  time the ingester sees them; `watch_state`/`is_key` are his to change after. */
export const MIKE_KEY_SHORT_IDS = ['816a7a7c', 'c58c6323', '621de874', '2f4075ae', '2decdf12'] as const;

/** Mike's Lovable workspace (for the chat seed / provenance, never for a call
 *  from this module — the archive on disk is our only input). */
export const MIKE_WORKSPACE_ID = 'K6cBsTKUF3zPecLp51dx';

/** Known Supabase refs we don't need a Lovable round-trip to learn. */
export const MIKE_KNOWN_SUPABASE_REFS: Record<string, string> = {
  '816a7a7c': 'onxbfneqvjapberusidr',
};

/** The ONLY Lovable MCP tools a Mike-project chat may call — read-only by
 *  construction. Shared by the one-time seed (below) and the per-turn snapshot
 *  (mike-radar-chat.ts) so the rule can never drift between the two places a
 *  chat learns it. */
export const MIKE_READONLY_LOVABLE_TOOLS = [
  'get_project', 'list_files', 'read_file', 'list_messages', 'list_edits',
  'get_diff', 'get_project_knowledge', 'query_database',
] as const;

/** Tools that would WRITE to Mike's live work. A single one of these is visible
 *  to Mike and can break a running app, so they are named explicitly rather
 *  than left to "be careful". */
export const MIKE_FORBIDDEN_LOVABLE_TOOLS = [
  'send_message', 'create_project', 'deploy_project', 'remix_project',
  'set_project_knowledge', 'enable_database', 'respond_to_approval',
] as const;

/** HOW those tools are actually called from a JARVIS turn: there is no native
 *  `read_file` here — the Lovable MCP server is reached through the `mcp_call`
 *  escape hatch. Spelled out because a chat told only "use read_file" will
 *  report the tool as missing instead of reading Mike's code. The second
 *  sentence is the important one: `lovable_send_message` is a first-class JARVIS
 *  tool and it is EXACTLY the write path that must never fire at Mike. */
export const MIKE_CHAT_CALL_CONVENTION =
  'Call these as `mcp_call {server:"lovable", tool:"<name>", args:{project_id:"<uuid>", …}}` — ' +
  'they are not native tools in this thread. The `lovable_send_message` and `supabase_execute_sql` ' +
  'JARVIS tools are OFF LIMITS for this project: the first would message Mike\'s project agent and ' +
  'start a real build, the second is a write-capable path to his database.';

export const MIKE_ARCHIVE_DIR =
  process.env['MIKE_RADAR_ARCHIVE_DIR'] ?? '/home/kevin/perclickity-suite/lovable-watch/archive';

export const MIKE_OUTBOX_DIR =
  process.env['MIKE_RADAR_OUTBOX_DIR'] ?? '/home/kevin/obsidian/paperclip-wiki/outbox/mike-radar';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MikeWatchState = 'watched' | 'muted' | 'archived';
export type MikeNameSource = 'archive_meta' | 'lovable' | 'short_id' | 'kevin';
export type MikeReportStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';
export type MikeIngestStatus = 'running' | 'done' | 'failed';
export type MikeRole = 'user' | 'assistant';

export interface MikeProject {
  project_id: string;
  short_id: string;
  name: string | null;
  name_source: MikeNameSource | null;
  description: string | null;
  supabase_ref: string | null;
  live_url: string | null;
  is_key: number;
  watch_state: MikeWatchState;
  first_seen_at: string | null;
  last_activity_at: string | null;
  msg_count: number;
  change_count: number;
  thread_ext: string | null;
  enriched_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A project row as the rail wants it — counts for today and the latest label. */
export interface MikeProjectWithToday extends MikeProject {
  today_msg_count: number;
  today_change_count: number;
  latest_headline: string | null;
  has_report_today: boolean;
  risk_flags_today: string[];
  /** What the project is called on screen — never null. */
  display_name: string;
}

export interface MikeActivity {
  id: number;
  project_id: string;
  short_id: string;
  message_id: string;
  role: MikeRole;
  ts: string;
  captured_at: string | null;
  text: string;
  text_chars: number;
  headline: string | null;
  commit_sha: string | null;
  changes: MikeChange[];
  change_count: number;
  diff_kind: 'none' | 'parsed' | 'opaque';
  has_diff: boolean;
  source_file: string | null;
  source_line: number | null;
  created_at: string;
}

interface MikeActivityDbRow extends Omit<MikeActivity, 'changes' | 'has_diff' | 'short_id'> {
  changes: string;
  diff_json: string | null;
  diff_raw: string | null;
}

export interface MikeReport {
  id: number;
  project_id: string;
  short_id: string;
  report_date: string;
  status: MikeReportStatus;
  summary: string | null;
  markdown: string | null;
  model: string | null;
  msg_count: number;
  change_count: number;
  risk_flags: string[];
  input_chars: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

interface MikeReportDbRow extends Omit<MikeReport, 'risk_flags' | 'short_id'> {
  risk_flags: string;
}

export interface MikeIngestRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: MikeIngestStatus;
  files_seen: number;
  rows_seen: number;
  rows_new: number;
  rows_bad: number;
  projects_new: number;
  capped_projects: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS mike_projects (
    project_id       TEXT PRIMARY KEY,
    short_id         TEXT NOT NULL,
    name             TEXT,
    name_source      TEXT,
    description      TEXT,
    supabase_ref     TEXT,
    live_url         TEXT,
    is_key           INTEGER NOT NULL DEFAULT 0,
    watch_state      TEXT NOT NULL DEFAULT 'watched'
                       CHECK (watch_state IN ('watched','muted','archived')),
    first_seen_at    TEXT,
    last_activity_at TEXT,
    msg_count        INTEGER NOT NULL DEFAULT 0,
    change_count     INTEGER NOT NULL DEFAULT 0,
    thread_ext       TEXT,
    enriched_at      TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mike_projects_activity
    ON mike_projects(watch_state, last_activity_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mike_projects_short
    ON mike_projects(short_id);

  CREATE TABLE IF NOT EXISTS mike_activity (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   TEXT NOT NULL REFERENCES mike_projects(project_id) ON DELETE CASCADE,
    message_id   TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('user','assistant')),
    ts           TEXT NOT NULL,
    captured_at  TEXT,
    text         TEXT NOT NULL,
    text_chars   INTEGER NOT NULL DEFAULT 0,
    headline     TEXT,
    commit_sha   TEXT,
    changes      TEXT NOT NULL DEFAULT '[]',
    change_count INTEGER NOT NULL DEFAULT 0,
    diff_kind    TEXT NOT NULL DEFAULT 'none'
                   CHECK (diff_kind IN ('none','parsed','opaque')),
    diff_json    TEXT,
    diff_raw     TEXT,
    source_file  TEXT,
    source_line  INTEGER,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_mike_activity_msg
    ON mike_activity(project_id, message_id);
  CREATE INDEX IF NOT EXISTS idx_mike_activity_feed
    ON mike_activity(project_id, ts DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_mike_activity_day
    ON mike_activity(substr(ts,1,10), project_id);

  CREATE TABLE IF NOT EXISTS mike_reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   TEXT NOT NULL REFERENCES mike_projects(project_id) ON DELETE CASCADE,
    report_date  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','done','failed','skipped')),
    summary      TEXT,
    markdown     TEXT,
    model        TEXT,
    msg_count    INTEGER NOT NULL DEFAULT 0,
    change_count INTEGER NOT NULL DEFAULT 0,
    risk_flags   TEXT NOT NULL DEFAULT '[]',
    input_chars  INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    started_at   TEXT,
    finished_at  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_mike_reports_day
    ON mike_reports(project_id, report_date);
  CREATE INDEX IF NOT EXISTS idx_mike_reports_date
    ON mike_reports(report_date DESC, project_id);
  CREATE INDEX IF NOT EXISTS idx_mike_reports_status
    ON mike_reports(status, report_date DESC);

  CREATE TABLE IF NOT EXISTS mike_ingest_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at  TEXT,
    status       TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','done','failed')),
    files_seen   INTEGER NOT NULL DEFAULT 0,
    rows_seen    INTEGER NOT NULL DEFAULT 0,
    rows_new     INTEGER NOT NULL DEFAULT 0,
    rows_bad     INTEGER NOT NULL DEFAULT 0,
    projects_new INTEGER NOT NULL DEFAULT 0,
    -- Projects where this sweep ingested >= WATCHER_MESSAGE_CAP new rows in one
    -- go, i.e. the watcher's 30-messages-per-project cap probably truncated the
    -- hour and some of Mike's messages are gone for good (DESIGN §10).
    capped_projects INTEGER NOT NULL DEFAULT 0,
    error        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_mike_ingest_runs_started
    ON mike_ingest_runs(id DESC);

  -- Per-file high-water mark. The archive files are append-only, so a line
  -- offset is a valid resume point; a 'full' sweep ignores this and relies on
  -- the unique (project_id, message_id) index for idempotency instead.
  CREATE TABLE IF NOT EXISTS mike_ingest_marks (
    source_file  TEXT PRIMARY KEY,
    lines_read   INTEGER NOT NULL DEFAULT 0,
    bytes_read   INTEGER NOT NULL DEFAULT 0,
    last_seq     INTEGER,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Additive migrations for a DB that already has an earlier shape.
for (const col of ['capped_projects INTEGER NOT NULL DEFAULT 0']) {
  try { sqliteDb.exec(`ALTER TABLE mike_ingest_runs ADD COLUMN ${col}`); } catch { /* already there */ }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const WATCH_STATES: MikeWatchState[] = ['watched', 'muted', 'archived'];
const REPORT_STATUSES: MikeReportStatus[] = ['queued', 'running', 'done', 'failed', 'skipped'];

export function isMikeWatchState(v: unknown): v is MikeWatchState {
  return typeof v === 'string' && (WATCH_STATES as string[]).includes(v);
}
export function isMikeReportStatus(v: unknown): v is MikeReportStatus {
  return typeof v === 'string' && (REPORT_STATUSES as string[]).includes(v);
}
/** `YYYY-MM-DD` and a real calendar date. */
export function isMikeReportDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The CT calendar day — the unit a daily report is written for. */
export function mikeReportDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseChanges(raw: string): MikeChange[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MikeChange[]) : [];
  } catch {
    return [];
  }
}

function parseFlags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

export function mikeDisplayName(project: Pick<MikeProject, 'name' | 'short_id'>): string {
  return project.name?.trim() || project.short_id;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export function emitMikeProject(action: MikeProjectEvent['action'], project: MikeProject): void {
  sseBus.emit('sse', { type: 'mike_project', action, project } satisfies MikeProjectEvent);
}

export function emitMikeActivity(activity: MikeActivity): void {
  sseBus.emit('sse', {
    type: 'mike_activity',
    action: 'created',
    project_id: activity.project_id,
    short_id: activity.short_id,
    activity_id: activity.id,
    role: activity.role,
    ts: activity.ts,
    headline: activity.headline,
    change_count: activity.change_count,
  } satisfies MikeActivityEvent);
}

export function emitMikeReport(action: MikeReportEvent['action'], report: MikeReport): void {
  sseBus.emit('sse', {
    type: 'mike_report',
    action,
    project_id: report.project_id,
    short_id: report.short_id,
    report_date: report.report_date,
    status: report.status,
    summary: report.summary,
  } satisfies MikeReportEvent);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const getProjectStmt = sqliteDb.prepare<[string], MikeProject>(
  `SELECT * FROM mike_projects WHERE project_id = ?`,
);
const getProjectByShortStmt = sqliteDb.prepare<[string], MikeProject>(
  `SELECT * FROM mike_projects WHERE short_id = ?`,
);
const listAllProjectsStmt = sqliteDb.prepare<[], MikeProject>(
  `SELECT * FROM mike_projects ORDER BY project_id ASC`,
);

export function getMikeProject(projectId: string): MikeProject | null {
  return getProjectStmt.get(projectId) ?? null;
}

/** Accepts either the 8-char short id or the full uuid, so a route param can be
 *  whichever Kevin's link happened to carry. */
export function getMikeProjectByRef(ref: string): MikeProject | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  return getProjectByShortStmt.get(trimmed) ?? getProjectStmt.get(trimmed) ?? null;
}

export function listAllMikeProjects(): MikeProject[] {
  return listAllProjectsStmt.all();
}

const insertProjectStmt = sqliteDb.prepare<[string, string, number, string | null]>(`
  INSERT INTO mike_projects (project_id, short_id, is_key, supabase_ref)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(project_id) DO NOTHING
`);

/** Register a project the first time the archive mentions it. Returns true when
 *  a row was actually created (the sweep counts those as `projects_new`). */
export function ensureMikeProject(projectId: string): { project: MikeProject; created: boolean } {
  const existing = getProjectStmt.get(projectId);
  if (existing) return { project: existing, created: false };
  const short = deriveShortId(projectId);
  const isKey = (MIKE_KEY_SHORT_IDS as readonly string[]).includes(short) ? 1 : 0;
  insertProjectStmt.run(projectId, short, isKey, MIKE_KNOWN_SUPABASE_REFS[short] ?? null);
  const project = getProjectStmt.get(projectId);
  if (!project) throw new Error(`mike-radar: failed to register project ${projectId}`);
  return { project, created: true };
}

export interface MikeProjectPatch {
  name?: string | null;
  name_source?: MikeNameSource;
  description?: string | null;
  supabase_ref?: string | null;
  live_url?: string | null;
  is_key?: number;
  watch_state?: MikeWatchState;
  thread_ext?: string | null;
  enriched_at?: string | null;
}

const PATCHABLE: Array<keyof MikeProjectPatch> = [
  'name', 'name_source', 'description', 'supabase_ref', 'live_url',
  'is_key', 'watch_state', 'thread_ext', 'enriched_at',
];

/** Column names are taken from the PATCHABLE whitelist above, never from caller
 *  input, so nothing interpolated here can be attacker-shaped. */
export function updateMikeProject(projectId: string, patch: MikeProjectPatch): MikeProject | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of PATCHABLE) {
    if (!(key in patch)) continue;
    sets.push(`${key} = ?`);
    values.push(patch[key] ?? null);
  }
  if (!sets.length) return getMikeProject(projectId);
  sets.push(`updated_at = datetime('now')`);
  values.push(projectId);
  sqliteDb.prepare(`UPDATE mike_projects SET ${sets.join(', ')} WHERE project_id = ?`).run(...values);
  return getMikeProject(projectId);
}

/** Name precedence (DESIGN §7.1 step 3): a name Kevin typed is never clobbered,
 *  and a Lovable-enriched name is never downgraded by a later archive sweep. */
const NAME_RANK: Record<MikeNameSource, number> = {
  short_id: 0,
  archive_meta: 1,
  lovable: 2,
  kevin: 3,
};

export function applyMikeProjectName(
  projectId: string,
  name: string | null,
  description: string | null,
  source: MikeNameSource,
): MikeProject | null {
  const existing = getMikeProject(projectId);
  if (!existing) return null;
  const patch: MikeProjectPatch = {};
  const currentRank = existing.name_source ? NAME_RANK[existing.name_source] ?? 0 : -1;
  if (name && NAME_RANK[source] >= currentRank && name !== existing.name) {
    patch.name = name;
    patch.name_source = source;
  } else if (!existing.name_source) {
    patch.name_source = name ? source : 'short_id';
  }
  if (description && description !== existing.description) patch.description = description;
  if (!Object.keys(patch).length) return existing;
  return updateMikeProject(projectId, patch);
}

const recomputeCountsStmt = sqliteDb.prepare<[string]>(`
  UPDATE mike_projects SET
    msg_count = (SELECT COUNT(*) FROM mike_activity WHERE project_id = mike_projects.project_id),
    change_count = (SELECT COUNT(*) FROM mike_activity
                      WHERE project_id = mike_projects.project_id AND change_count > 0),
    first_seen_at = (SELECT MIN(ts) FROM mike_activity WHERE project_id = mike_projects.project_id),
    last_activity_at = (SELECT MAX(ts) FROM mike_activity WHERE project_id = mike_projects.project_id),
    updated_at = datetime('now')
  WHERE project_id = ?
`);

export function recomputeMikeProjectCounts(projectId: string): MikeProject | null {
  recomputeCountsStmt.run(projectId);
  return getMikeProject(projectId);
}

// The rail query. `today` is passed in (not computed in SQL) because `ts` is UTC
// and the day boundary Kevin cares about is America/Chicago.
const listProjectsStmt = sqliteDb.prepare<
  [string, string],
  MikeProject & {
    today_msg_count: number;
    today_change_count: number;
    latest_headline: string | null;
    today_report: number;
    today_changes_json: string | null;
  }
>(`
  SELECT p.*,
    (SELECT COUNT(*) FROM mike_activity a
       WHERE a.project_id = p.project_id AND a.ts >= ? AND a.ts < ?) AS today_msg_count,
    (SELECT COUNT(*) FROM mike_activity a
       WHERE a.project_id = p.project_id AND a.ts >= ? AND a.ts < ? AND a.change_count > 0)
      AS today_change_count,
    (SELECT a.headline FROM mike_activity a
       WHERE a.project_id = p.project_id AND a.headline IS NOT NULL
       ORDER BY a.ts DESC, a.id DESC LIMIT 1) AS latest_headline,
    (SELECT COUNT(*) FROM mike_reports r
       WHERE r.project_id = p.project_id AND r.report_date = ? AND r.status = 'done') AS today_report,
    (SELECT group_concat(a.changes, '') FROM mike_activity a
       WHERE a.project_id = p.project_id AND a.ts >= ? AND a.ts < ? AND a.change_count > 0)
      AS today_changes_json
  FROM mike_projects p
`);

export interface ListMikeProjectsOpts {
  watch_state?: MikeWatchState | 'all';
  key_only?: boolean;
  /** Only projects with activity at/after this ISO instant. */
  since?: string;
  limit?: number;
  /** CT day the `today_*` columns are computed for. Defaults to now. */
  day?: string;
}

export interface MikeProjectsResult {
  projects: MikeProjectWithToday[];
  totals: { projects: number; messages: number; changes: number; today_messages: number };
  day: string;
}

/** Window a CT calendar day into the UTC bounds `mike_activity.ts` is stored in. */
export function ctDayBoundsUtc(day: string): { start: string; end: string } {
  // Chicago is UTC-5 (CDT) or UTC-6 (CST); compute the real offset for that date
  // rather than hardcoding one, so the day doesn't slip across a DST change.
  const offsetHours = (atUtcNoon: Date): number => {
    const label = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      timeZoneName: 'shortOffset',
    }).format(atUtcNoon);
    const m = /GMT([+-]\d{1,2})/.exec(label);
    return m ? parseInt(m[1], 10) : -6;
  };
  const noon = new Date(`${day}T12:00:00Z`);
  const off = offsetHours(noon);
  const start = new Date(Date.parse(`${day}T00:00:00Z`) - off * 3_600_000);
  const end = new Date(start.getTime() + 24 * 3_600_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function listMikeProjects(opts: ListMikeProjectsOpts = {}): MikeProjectsResult {
  const day = opts.day ?? mikeReportDate();
  const { start, end } = ctDayBoundsUtc(day);
  // 7 bind slots in declaration order: today_msg ×2, today_change ×2, report ×1, today_changes ×2.
  const rows = listProjectsStmt.all(
    ...([start, end, start, end, day, start, end] as unknown as [string, string]),
  );

  const watchState = opts.watch_state ?? 'watched';
  let filtered = rows.filter((r) => (watchState === 'all' ? true : r.watch_state === watchState));
  if (opts.key_only) filtered = filtered.filter((r) => r.is_key === 1);
  if (opts.since) filtered = filtered.filter((r) => (r.last_activity_at ?? '') >= opts.since!);

  // Live projects first, then by recency; a project with no activity yet sorts last.
  filtered.sort((a, b) => {
    if (a.is_key !== b.is_key) return b.is_key - a.is_key;
    return (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? '');
  });

  const totals = {
    projects: filtered.length,
    messages: filtered.reduce((n, r) => n + r.msg_count, 0),
    changes: filtered.reduce((n, r) => n + r.change_count, 0),
    today_messages: filtered.reduce((n, r) => n + r.today_msg_count, 0),
  };

  const limit = Math.max(1, Math.min(opts.limit ?? 500, 1_000));
  const projects: MikeProjectWithToday[] = filtered.slice(0, limit).map((r) => {
    const { today_report, today_changes_json, ...rest } = r;
    // group_concat of per-row JSON arrays — `[a][b]` — becomes `[a,b]`.
    const changes = today_changes_json ? parseChanges(today_changes_json.replace(/\]\[/g, ',')) : [];
    return {
      ...(rest as MikeProject & {
        today_msg_count: number;
        today_change_count: number;
        latest_headline: string | null;
      }),
      has_report_today: today_report > 0,
      risk_flags_today: riskFlagsFromChanges(changes),
      display_name: mikeDisplayName(r),
    };
  });

  return { projects, totals, day };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const insertActivityStmt = sqliteDb.prepare<[
  string, string, MikeRole, string, string | null, string, number, string | null,
  string | null, string, number, string, string | null, string | null, string | null, number | null,
]>(`
  INSERT INTO mike_activity (
    project_id, message_id, role, ts, captured_at, text, text_chars, headline,
    commit_sha, changes, change_count, diff_kind, diff_json, diff_raw, source_file, source_line
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(project_id, message_id) DO NOTHING
`);

export interface InsertMikeActivityInput {
  project_id: string;
  message_id: string;
  role: MikeRole;
  ts: string;
  captured_at: string | null;
  text: string;
  headline: string | null;
  commit_sha: string | null;
  changes: MikeChange[];
  diff_kind: 'none' | 'parsed' | 'opaque';
  diff_json: string | null;
  diff_raw: string | null;
  source_file: string | null;
  source_line: number | null;
}

/** Idempotent insert. Returns the new row's id, or null when the unique
 *  (project_id, message_id) index already had it — which is how a `full`
 *  re-ingest of the whole archive stays safe to run at any time. */
export function insertMikeActivity(input: InsertMikeActivityInput): number | null {
  const info = insertActivityStmt.run(
    input.project_id,
    input.message_id,
    input.role,
    input.ts,
    input.captured_at,
    input.text,
    input.text.length,
    input.headline,
    input.commit_sha,
    JSON.stringify(input.changes),
    input.changes.length,
    input.diff_kind,
    input.diff_json,
    input.diff_raw,
    input.source_file,
    input.source_line,
  );
  return info.changes === 1 ? Number(info.lastInsertRowid) : null;
}

function hydrateActivity(row: MikeActivityDbRow, short: string): MikeActivity {
  const { changes, diff_json, diff_raw, ...rest } = row;
  return {
    ...rest,
    short_id: short,
    changes: parseChanges(changes),
    has_diff: row.diff_kind !== 'none',
  };
}

const getActivityStmt = sqliteDb.prepare<[number], MikeActivityDbRow & { short_id: string }>(`
  SELECT a.*, p.short_id FROM mike_activity a
    JOIN mike_projects p ON p.project_id = a.project_id
  WHERE a.id = ?
`);

export interface MikeActivityDetail {
  item: MikeActivity;
  diff: unknown | null;
  diff_raw: string | null;
}

export function getMikeActivity(id: number): MikeActivityDetail | null {
  const row = getActivityStmt.get(id);
  if (!row) return null;
  let diff: unknown = null;
  if (row.diff_json) {
    try { diff = JSON.parse(row.diff_json); } catch { diff = null; }
  }
  return { item: hydrateActivity(row, row.short_id), diff, diff_raw: row.diff_raw };
}

export interface ListMikeFeedOpts {
  project_id: string;
  limit?: number;
  /** Id cursor — return rows strictly older than this one. */
  before?: number;
  role?: MikeRole | 'all';
  changes_only?: boolean;
  /** CT calendar day filter. */
  day?: string;
}

export interface MikeFeedResult {
  items: MikeActivity[];
  next_before: number | null;
}

/**
 * The change feed, newest first. `diff_json`/`diff_raw` are deliberately NOT in
 * this payload — a single captured diff can be hundreds of KB and the list view
 * only needs to know one exists (`has_diff`). The expanded view fetches it per
 * row via `getMikeActivity`.
 */
export function listMikeFeed(opts: ListMikeFeedOpts): MikeFeedResult {
  const project = getMikeProject(opts.project_id);
  const short = project?.short_id ?? deriveShortId(opts.project_id);
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));

  const where: string[] = ['project_id = ?'];
  const params: unknown[] = [opts.project_id];
  if (opts.before !== undefined && Number.isFinite(opts.before)) {
    where.push('id < ?');
    params.push(opts.before);
  }
  if (opts.role && opts.role !== 'all') {
    where.push('role = ?');
    params.push(opts.role);
  }
  if (opts.changes_only) where.push('change_count > 0');
  if (opts.day) {
    const { start, end } = ctDayBoundsUtc(opts.day);
    where.push('ts >= ? AND ts < ?');
    params.push(start, end);
  }

  // One extra row tells us whether another page exists without a COUNT(*).
  const rows = sqliteDb
    .prepare<unknown[], MikeActivityDbRow>(
      `SELECT id, project_id, message_id, role, ts, captured_at, text, text_chars, headline,
              commit_sha, changes, change_count, diff_kind, source_file, source_line, created_at,
              NULL AS diff_json, NULL AS diff_raw
         FROM mike_activity
        WHERE ${where.join(' AND ')}
        ORDER BY ts DESC, id DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1);

  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => hydrateActivity(r, short)),
    next_before: rows.length > limit && page.length ? page[page.length - 1].id : null,
  };
}

/** Oldest→newest rows for one project-day — the daily report's input set. */
export function listMikeDayActivity(projectId: string, day: string): MikeActivity[] {
  const project = getMikeProject(projectId);
  const short = project?.short_id ?? deriveShortId(projectId);
  const { start, end } = ctDayBoundsUtc(day);
  const rows = sqliteDb
    .prepare<[string, string, string], MikeActivityDbRow>(
      `SELECT id, project_id, message_id, role, ts, captured_at, text, text_chars, headline,
              commit_sha, changes, change_count, diff_kind, source_file, source_line, created_at,
              NULL AS diff_json, NULL AS diff_raw
         FROM mike_activity
        WHERE project_id = ? AND ts >= ? AND ts < ?
        ORDER BY ts ASC, id ASC`,
    )
    .all(projectId, start, end);
  return rows.map((r) => hydrateActivity(r, short));
}

export interface MikeActiveDay {
  project_id: string;
  /** CT calendar day — the unit a report is written for. */
  report_date: string;
  msg_count: number;
  change_count: number;
}

/**
 * Project-days that have activity, newest first — what the report queue walks.
 *
 * The grouping is done in JS, not in SQL, on purpose: `ts` is UTC and the day
 * Kevin means is America/Chicago, which SQLite cannot shift correctly across a
 * DST boundary (`date(ts,'-6 hours')` is an hour wrong for half the year and
 * would file a late-evening message under the wrong report). Bounded by
 * `sinceDays` so it never walks the whole table.
 */
export function listMikeActiveDays(sinceDays = 30): MikeActiveDay[] {
  const cutoff = new Date(Date.now() - Math.max(1, sinceDays) * 86_400_000).toISOString();
  const rows = sqliteDb
    .prepare<[string], { project_id: string; ts: string; change_count: number }>(
      `SELECT project_id, ts, change_count FROM mike_activity WHERE ts >= ? ORDER BY ts ASC`,
    )
    .all(cutoff);
  const byKey = new Map<string, MikeActiveDay>();
  for (const row of rows) {
    const day = mikeReportDate(new Date(row.ts));
    const key = `${row.project_id}\u0000${day}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { project_id: row.project_id, report_date: day, msg_count: 0, change_count: 0 };
      byKey.set(key, entry);
    }
    entry.msg_count++;
    if (row.change_count > 0) entry.change_count++;
  }
  return [...byKey.values()].sort((a, b) => b.report_date.localeCompare(a.report_date));
}

/** Rows with at least one parsed change on one CT project-day. */
export function countMikeDayChanges(projectId: string, day: string): number {
  const { start, end } = ctDayBoundsUtc(day);
  const row = sqliteDb
    .prepare<[string, string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM mike_activity
        WHERE project_id = ? AND ts >= ? AND ts < ? AND change_count > 0`,
    )
    .get(projectId, start, end);
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function hydrateReport(row: MikeReportDbRow & { short_id?: string }): MikeReport {
  const { risk_flags, short_id, ...rest } = row;
  return {
    ...rest,
    short_id: short_id ?? deriveShortId(row.project_id),
    risk_flags: parseFlags(risk_flags),
  };
}

const getReportStmt = sqliteDb.prepare<[string, string], MikeReportDbRow & { short_id: string }>(`
  SELECT r.*, p.short_id FROM mike_reports r
    JOIN mike_projects p ON p.project_id = r.project_id
  WHERE r.project_id = ? AND r.report_date = ?
`);

export function getMikeReport(projectId: string, date: string): MikeReport | null {
  const row = getReportStmt.get(projectId, date);
  return row ? hydrateReport(row) : null;
}

const upsertReportStmt = sqliteDb.prepare<[string, string, MikeReportStatus, number, number]>(`
  INSERT INTO mike_reports (project_id, report_date, status, msg_count, change_count)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(project_id, report_date) DO NOTHING
`);

/** Queue (or find) the report row for one project-day. Never resets a row that
 *  already exists — a re-queue of a `done` day is the Regenerate button's job,
 *  not the hourly sweep's. */
export function queueMikeReport(
  projectId: string,
  date: string,
  counts: { msg_count: number; change_count: number },
): { report: MikeReport; created: boolean } {
  const before = getMikeReport(projectId, date);
  if (before) return { report: before, created: false };
  upsertReportStmt.run(projectId, date, 'queued', counts.msg_count, counts.change_count);
  const report = getMikeReport(projectId, date);
  if (!report) throw new Error(`mike-radar: failed to queue report ${projectId}/${date}`);
  return { report, created: true };
}

export interface MikeReportPatch {
  status?: MikeReportStatus;
  summary?: string | null;
  markdown?: string | null;
  model?: string | null;
  msg_count?: number;
  change_count?: number;
  risk_flags?: string[];
  input_chars?: number;
  error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

const REPORT_PATCHABLE: Array<keyof MikeReportPatch> = [
  'status', 'summary', 'markdown', 'model', 'msg_count', 'change_count',
  'risk_flags', 'input_chars', 'error', 'started_at', 'finished_at',
];

export function updateMikeReport(projectId: string, date: string, patch: MikeReportPatch): MikeReport | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of REPORT_PATCHABLE) {
    if (!(key in patch)) continue;
    sets.push(`${key} = ?`);
    const v = patch[key];
    values.push(key === 'risk_flags' ? JSON.stringify(v ?? []) : v ?? null);
  }
  if (!sets.length) return getMikeReport(projectId, date);
  values.push(projectId, date);
  sqliteDb
    .prepare(`UPDATE mike_reports SET ${sets.join(', ')} WHERE project_id = ? AND report_date = ?`)
    .run(...values);
  return getMikeReport(projectId, date);
}

/** Reset a report row back to `queued` so the generator picks it up again —
 *  the Regenerate button's write. */
export function requeueMikeReport(projectId: string, date: string, counts: { msg_count: number; change_count: number }): MikeReport {
  const { report } = queueMikeReport(projectId, date, counts);
  return (
    updateMikeReport(projectId, date, {
      status: 'queued',
      error: null,
      started_at: null,
      finished_at: null,
      msg_count: counts.msg_count,
      change_count: counts.change_count,
    }) ?? report
  );
}

export interface ListMikeReportsOpts {
  date?: string;
  project_id?: string;
  status?: MikeReportStatus;
  limit?: number;
  /** Include the full markdown body. Off by default — the index doesn't need it. */
  with_markdown?: boolean;
}

export function listMikeReports(opts: ListMikeReportsOpts = {}): MikeReport[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.date) { where.push('r.report_date = ?'); params.push(opts.date); }
  if (opts.project_id) { where.push('r.project_id = ?'); params.push(opts.project_id); }
  if (opts.status) { where.push('r.status = ?'); params.push(opts.status); }
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const markdownCol = opts.with_markdown ? 'r.markdown' : 'NULL AS markdown';
  const rows = sqliteDb
    .prepare<unknown[], MikeReportDbRow & { short_id: string }>(
      `SELECT r.id, r.project_id, r.report_date, r.status, r.summary, ${markdownCol}, r.model,
              r.msg_count, r.change_count, r.risk_flags, r.input_chars, r.error,
              r.started_at, r.finished_at, r.created_at, p.short_id
         FROM mike_reports r
         JOIN mike_projects p ON p.project_id = r.project_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.report_date DESC, p.is_key DESC, r.project_id ASC
        LIMIT ?`,
    )
    .all(...params, limit);
  return rows.map(hydrateReport);
}

/** The last N days of report stubs for one project — the date strip. */
export function listMikeProjectReportStubs(projectId: string, days = 14): MikeReport[] {
  return listMikeReports({ project_id: projectId, limit: days });
}

// ---------------------------------------------------------------------------
// Ingest runs + marks
// ---------------------------------------------------------------------------

export function createMikeIngestRun(): MikeIngestRun {
  const info = sqliteDb.prepare(`INSERT INTO mike_ingest_runs (status) VALUES ('running')`).run();
  const run = getMikeIngestRun(Number(info.lastInsertRowid));
  if (!run) throw new Error('mike-radar: failed to create ingest run');
  return run;
}

export function getMikeIngestRun(id: number): MikeIngestRun | null {
  return sqliteDb.prepare<[number], MikeIngestRun>(`SELECT * FROM mike_ingest_runs WHERE id = ?`).get(id) ?? null;
}

export function finishMikeIngestRun(
  id: number,
  status: MikeIngestStatus,
  stats: Partial<Pick<MikeIngestRun, 'files_seen' | 'rows_seen' | 'rows_new' | 'rows_bad' | 'projects_new' | 'capped_projects' | 'error'>>,
): MikeIngestRun | null {
  sqliteDb
    .prepare(
      `UPDATE mike_ingest_runs
          SET status = ?, finished_at = datetime('now'), files_seen = ?, rows_seen = ?,
              rows_new = ?, rows_bad = ?, projects_new = ?, capped_projects = ?, error = ?
        WHERE id = ?`,
    )
    .run(
      status,
      stats.files_seen ?? 0,
      stats.rows_seen ?? 0,
      stats.rows_new ?? 0,
      stats.rows_bad ?? 0,
      stats.projects_new ?? 0,
      stats.capped_projects ?? 0,
      stats.error ?? null,
      id,
    );
  return getMikeIngestRun(id);
}

export function listMikeIngestRuns(limit = 20): MikeIngestRun[] {
  return sqliteDb
    .prepare<[number], MikeIngestRun>(`SELECT * FROM mike_ingest_runs ORDER BY id DESC LIMIT ?`)
    .all(Math.max(1, Math.min(limit, 200)));
}

export interface MikeIngestMark {
  source_file: string;
  lines_read: number;
  bytes_read: number;
}

export function getMikeIngestMark(sourceFile: string): MikeIngestMark | null {
  return (
    sqliteDb
      .prepare<[string], MikeIngestMark>(
        `SELECT source_file, lines_read, bytes_read FROM mike_ingest_marks WHERE source_file = ?`,
      )
      .get(sourceFile) ?? null
  );
}

export function setMikeIngestMark(mark: MikeIngestMark): void {
  sqliteDb
    .prepare(
      `INSERT INTO mike_ingest_marks (source_file, lines_read, bytes_read, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(source_file) DO UPDATE SET
         lines_read = excluded.lines_read,
         bytes_read = excluded.bytes_read,
         updated_at = datetime('now')`,
    )
    .run(mark.source_file, mark.lines_read, mark.bytes_read);
}

export function clearMikeIngestMarks(): void {
  sqliteDb.prepare(`DELETE FROM mike_ingest_marks`).run();
}

// ---------------------------------------------------------------------------
// Retention (DESIGN §2) — hooked by jarvis-db-retention, not a second timer.
// ---------------------------------------------------------------------------

export const MIKE_ACTIVITY_RETENTION_DAYS = 120;

/**
 * Sweep `mike_activity` for non-key projects older than the retention window.
 * `is_key` projects are kept forever and `mike_reports` are never swept — they
 * are the durable artifact and they are small. Written in from day one because
 * jarvis.db bloat has stalled the cockpit's event loop before.
 */
export function sweepMikeActivityRetention(days = MIKE_ACTIVITY_RETENTION_DAYS): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const info = sqliteDb
    .prepare(
      `DELETE FROM mike_activity
        WHERE ts < ?
          AND project_id IN (SELECT project_id FROM mike_projects WHERE is_key = 0)`,
    )
    .run(cutoff);
  return Number(info.changes ?? 0);
}

// ---------------------------------------------------------------------------
// Per-project chat (DESIGN §6a) — the seed only. The per-turn `<mike_project>`
// snapshot and the agent.ts wiring belong to the chat-bootstrap node.
// ---------------------------------------------------------------------------

export function mikeThreadExt(short: string): string {
  return `cockpit:mike-${short}`;
}

/** The one-time orientation post for a project chat. Mirrors the goal-chat
 *  seed: it says what this thread IS and what the hard rule is, and it points
 *  at the `<mike_project>` snapshot that prefixes every turn — live counts and
 *  the latest report belong in that snapshot, NOT here, because a seed written
 *  once goes stale the first time Mike touches the project. */
export function composeMikeProjectSeed(project: MikeProject): string {
  const name = mikeDisplayName(project);
  const allowed = MIKE_READONLY_LOVABLE_TOOLS.map((t) => `\`${t}\``).join(', ');
  const forbidden = MIKE_FORBIDDEN_LOVABLE_TOOLS.map((t) => `\`${t}\``).join(', ');
  return `🛰 **MIKE RADAR — PROJECT CHAT.** This thread is about ONE Lovable project: *${name}* (\`${project.project_id}\`), owned and driven by Mike. You are Kevin's engineer looking over Mike's shoulder. Kevin will ask things like "how does X work" and "how do I debug Y" — answer from the real code, not from the archive text alone.

**READ-ONLY, HARD RULE.** You may use the Lovable MCP tools ${allowed} *(SELECT only)*. You must NEVER call ${forbidden}, or any Supabase write tool against this project. This is Mike's live work; a single write would be visible to him and could break a running app. If a question can only be answered by changing something, say so and stop.

${MIKE_CHAT_CALL_CONVENTION}

Every turn of this thread is prefixed with a \`<mike_project>\` snapshot carrying the project's live facts — Supabase ref, archive path, the latest daily report, and the changes Mike shipped most recently. That snapshot is your memory of this project; never ask Kevin to restate any of it. Lovable workspace \`${MIKE_WORKSPACE_ID}\`.`;
}

/** Find-or-create the project's dedicated chat. Mirrors `getOrCreateGoalThread`
 *  exactly: when `created` is true the CALLER posts `seed_text` to
 *  `/threads/:ext/messages`, so there is no second bootstrap mechanism. */
export function getOrCreateMikeThread(
  project: MikeProject,
): { external_id: string; created: boolean; seed_text: string | null } {
  const externalId = mikeThreadExt(project.short_id);
  const existingConv = getConversation(externalId);
  if (existingConv && project.thread_ext === externalId) {
    return { external_id: externalId, created: false, seed_text: null };
  }
  const conv = getOrCreateConversation(externalId);
  if (!existingConv) {
    renameConversation(conv.id, `🛰 ${mikeDisplayName(project)}`.slice(0, 120));
  }
  if (project.thread_ext !== externalId) {
    const updated = updateMikeProject(project.project_id, { thread_ext: externalId });
    if (updated) emitMikeProject('updated', updated);
  }
  return {
    external_id: externalId,
    created: !existingConv,
    seed_text: existingConv ? null : composeMikeProjectSeed(getMikeProject(project.project_id) ?? project),
  };
}
