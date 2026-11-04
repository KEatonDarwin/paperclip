/**
 * MIKE RADAR — the ingest sweep. Archive JSONL on disk → `mike_*` rows.
 *
 * READ-ONLY on everything of Mike's: the only input is the Lovable Watcher's
 * archive directory, which is already on this box. No Lovable call, no Supabase
 * call, no network. The watcher runs hourly on the hour; this sweep runs ~20
 * minutes behind it so it always reads a settled file.
 *
 * TWO IDEMPOTENCY LAYERS, on purpose:
 *  1. A per-file high-water mark (`mike_ingest_marks.lines_read`). The archive
 *     files are append-only, so a line offset is a valid resume point and the
 *     hourly sweep only reads the handful of new lines.
 *  2. The unique `(project_id, message_id)` index. This is what makes a `full`
 *     sweep — re-reading all 27 MB from line 0 — safe to run at any moment, and
 *     it is also the safety net if a file is ever rewritten rather than appended
 *     (the mark is dropped whenever the file SHRINKS, see `shouldResetMark`).
 *
 * A malformed line is counted (`rows_bad`) and skipped. It never throws: today
 * exactly one line in the archive is not JSON at all, and one bad byte must not
 * cost us the sweep.
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  MIKE_ARCHIVE_DIR,
  createMikeIngestRun,
  finishMikeIngestRun,
  ensureMikeProject,
  applyMikeProjectName,
  insertMikeActivity,
  recomputeMikeProjectCounts,
  getMikeIngestMark,
  setMikeIngestMark,
  getMikeActivity,
  getMikeProject,
  queueMikeReport,
  emitMikeProject,
  emitMikeActivity,
  emitMikeReport,
  listMikeActiveDays,
  mikeReportDate,
  type MikeIngestRun,
  type MikeRole,
} from './mike-radar.js';
import {
  classifyArchiveLine,
  parseToolUses,
  normalizeDiff,
  deriveHeadline,
  guardProjectName,
  diffFilePaths,
  shortId,
  type MikeChange,
} from './mike-radar-parse.js';

const PROJECT_META_FILE = '_new_projects.jsonl';
const UUID_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface MikeIngestOptions {
  /** Re-read every file from line 0 and ignore the high-water marks. */
  full?: boolean;
  /** Suppress the per-row `mike_activity` events (a full sweep would emit
   *  thousands); one `mike_project` per touched project is emitted instead. */
  quiet?: boolean;
  /** Override the archive directory — the test fixtures use this. */
  archiveDir?: string;
}

export interface MikeIngestResult {
  run: MikeIngestRun;
  /** Per-project detail, handy in tests and in the health strip. */
  projects_touched: string[];
  reports_queued: number;
}

interface SweepStats {
  files_seen: number;
  rows_seen: number;
  rows_new: number;
  rows_bad: number;
  projects_new: number;
  capped_projects: number;
}

/**
 * The watcher's hard limit, from lovable-watch/prompt.txt step 3a: "walk back
 * until you reach the stored last_message_id (exclusive) or 30 messages,
 * whichever first." If Mike does 40 messages on one project in an hour, 10 are
 * lost from the archive forever.
 */
export const WATCHER_MESSAGE_CAP = 30;

/**
 * A mark is only a valid resume point while the file is still an append of what
 * we read. If it SHRANK (truncated, rotated, rewritten) the offset is
 * meaningless and we re-read from 0 — the unique index makes that free.
 */
function shouldResetMark(mark: { bytes_read: number } | null, sizeBytes: number): boolean {
  if (!mark) return true;
  return sizeBytes < mark.bytes_read;
}

/** The change set for one message: tool-use blocks first (the real signal, on
 *  1,118 of 1,400 assistant rows), with any diff-only file paths folded in so a
 *  row that carried a diff but no recognisable tool call still shows its files. */
function changesFor(text: string | undefined, diff: ReturnType<typeof normalizeDiff>): MikeChange[] {
  const changes = parseToolUses(text);
  const known = new Set(changes.map((c) => c.path).filter((p): p is string => !!p));
  for (const path of diffFilePaths(diff.diff)) {
    if (known.has(path)) continue;
    known.add(path);
    changes.push({ action: 'edit', tool: 'diff', path, note: null });
  }
  return changes;
}

function ingestMessageFile(
  dir: string,
  fileName: string,
  projectId: string,
  opts: MikeIngestOptions,
  stats: SweepStats,
  touched: Set<string>,
): void {
  const fullPath = join(dir, fileName);
  let size = 0;
  try {
    size = statSync(fullPath).size;
  } catch {
    return;
  }

  const mark = opts.full ? null : getMikeIngestMark(fileName);
  const reset = opts.full || shouldResetMark(mark, size);
  const startLine = reset ? 0 : mark!.lines_read;

  // The whole archive is 27 MB across 100 files and the largest file is a few
  // hundred KB — reading one file whole is cheaper and simpler than a stream,
  // and the sweep finishes in seconds either way.
  let content: string;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch (err) {
    console.error(`[mike-ingest] unreadable ${fileName}:`, err);
    return;
  }

  const lines = content.split('\n');
  // A trailing newline yields a final empty element — not a line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  stats.files_seen++;
  const { created } = ensureMikeProject(projectId);
  if (created) stats.projects_new++;

  let touchedThisFile = false;
  let newThisFile = 0;

  for (let i = startLine; i < lines.length; i++) {
    const classified = classifyArchiveLine(lines[i]);
    if (!classified) continue;
    if (classified.kind === 'bad') {
      stats.rows_bad++;
      continue;
    }
    if (classified.kind === 'project_meta') {
      // A metadata row inside a project file: free name, no network.
      const guarded = guardProjectName(classified.row.name, classified.row.description);
      const updated = applyMikeProjectName(
        projectId,
        guarded.name,
        guarded.description,
        guarded.name ? 'archive_meta' : 'short_id',
      );
      if (updated) emitMikeProject('updated', updated);
      continue;
    }

    const row = classified.row;
    const role = row.role === 'assistant' ? 'assistant' : row.role === 'user' ? 'user' : null;
    if (!role || !row.message_id || !row.project_id) {
      stats.rows_bad++;
      continue;
    }
    stats.rows_seen++;

    // 17 rows carry `project_name` — a free, guarded name source.
    if (row.project_name) {
      const guarded = guardProjectName(row.project_name, null);
      if (guarded.name) {
        const updated = applyMikeProjectName(projectId, guarded.name, null, 'archive_meta');
        if (updated) emitMikeProject('updated', updated);
      }
    }

    const diff = normalizeDiff(row.diff);
    const text = row.text ?? '';
    const changes = changesFor(text, diff);
    const ts = row.created_at || row.captured_at || new Date().toISOString();

    const newId = insertMikeActivity({
      project_id: projectId,
      message_id: row.message_id,
      role: role as MikeRole,
      ts,
      captured_at: row.captured_at ?? null,
      text,
      headline: deriveHeadline(text),
      commit_sha: row.commit_sha ?? null,
      changes,
      diff_kind: diff.kind,
      diff_json: diff.diff ? JSON.stringify(diff.diff) : null,
      diff_raw: diff.raw,
      source_file: fileName,
      source_line: i + 1,
    });

    if (newId !== null) {
      stats.rows_new++;
      newThisFile++;
      touchedThisFile = true;
      if (!opts.quiet) {
        const detail = getMikeActivity(newId);
        if (detail) emitMikeActivity(detail.item);
      }
    }
  }

  setMikeIngestMark({ source_file: fileName, lines_read: lines.length, bytes_read: size });

  // DESIGN §10 asked for gap detection off the message-id sequence. Measured
  // 2026-10-05: that does NOT work — only 10% of consecutive `main:user` ids and
  // 0% of `main:agent` ids step by exactly 1 (Lovable allocates ids across the
  // whole workspace, not per project), so a +1 test reports ~1,300 "gaps" on a
  // perfectly healthy 2,773-row archive. A false alarm on every row is worse
  // than no alarm, so the sequence check is gone and this is the honest signal
  // instead: hitting the watcher's own 30-message cap in a single incremental
  // sweep is exactly the condition under which messages were dropped.
  if (!reset && newThisFile >= WATCHER_MESSAGE_CAP) {
    stats.capped_projects++;
    console.warn(
      `[mike-ingest] ${fileName} delivered ${newThisFile} new rows (>= the watcher's ` +
        `${WATCHER_MESSAGE_CAP}-message cap) — this hour may be missing messages.`,
    );
  }

  if (touchedThisFile || created) touched.add(projectId);
}

function ingestProjectMetaFile(dir: string, stats: SweepStats): void {
  const fullPath = join(dir, PROJECT_META_FILE);
  if (!existsSync(fullPath)) return;
  let content: string;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch {
    return;
  }
  stats.files_seen++;

  // Last entry per id wins — the file is append-only and a later capture is the
  // fresher truth. This covers 89 of 100 archive projects with ZERO network
  // calls, which is why Lovable enrichment is best-effort rather than required.
  const latest = new Map<string, { name: string | null; description: string | null }>();
  for (const line of content.split('\n')) {
    const classified = classifyArchiveLine(line);
    if (!classified) continue;
    if (classified.kind === 'bad') { stats.rows_bad++; continue; }
    if (classified.kind !== 'project_meta' || !classified.row.id) continue;
    const guarded = guardProjectName(classified.row.name, classified.row.description);
    latest.set(classified.row.id, guarded);
  }

  for (const [projectId, guarded] of latest) {
    // Only name projects we actually have an archive for — `_new_projects.jsonl`
    // can mention a project the watcher never captured messages from.
    if (!getMikeProject(projectId)) continue;
    const updated = applyMikeProjectName(
      projectId,
      guarded.name,
      guarded.description,
      guarded.name ? 'archive_meta' : 'short_id',
    );
    if (updated) emitMikeProject('updated', updated);
  }
}

/**
 * Queue a `mike_reports` row for every project-day that has activity and no
 * report yet — including TODAY, so a mid-day report is possible on demand.
 * Cost gate (DESIGN §7.2): only `watched` projects that are either on Kevin's
 * key shortlist or had >= 3 messages that day. Mike has 100 projects and most
 * are dormant; without this the nightly run would be 100 claude calls, not ~5.
 */
export const MIKE_REPORT_MIN_MESSAGES = 3;

export function queueMikeReports(): number {
  let queued = 0;
  for (const day of listMikeActiveDays()) {
    const project = getMikeProject(day.project_id);
    if (!project || project.watch_state !== 'watched') continue;
    if (project.is_key !== 1 && day.msg_count < MIKE_REPORT_MIN_MESSAGES) continue;
    const { report, created } = queueMikeReport(day.project_id, day.report_date, {
      msg_count: day.msg_count,
      change_count: day.change_count,
    });
    if (created) {
      queued++;
      emitMikeReport('queued', report);
    }
  }
  return queued;
}

/**
 * One sweep. Pure file → SQLite: no model, no network, nothing of Mike's
 * written to. Safe to call concurrently with itself only in the sense that the
 * unique index protects the data — the driver serialises it anyway.
 */
export function runMikeIngest(opts: MikeIngestOptions = {}): MikeIngestResult {
  const dir = opts.archiveDir ?? MIKE_ARCHIVE_DIR;
  const run = createMikeIngestRun();
  const stats: SweepStats = {
    files_seen: 0, rows_seen: 0, rows_new: 0, rows_bad: 0, projects_new: 0, capped_projects: 0,
  };
  const touched = new Set<string>();

  try {
    if (!existsSync(dir)) {
      const failed = finishMikeIngestRun(run.id, 'failed', {
        ...stats,
        error: `archive directory not found: ${dir}`,
      });
      return { run: failed ?? run, projects_touched: [], reports_queued: 0 };
    }

    const entries = readdirSync(dir).sort();
    for (const name of entries) {
      const m = UUID_FILE_RE.exec(name);
      if (!m) continue;
      ingestMessageFile(dir, name, m[1].toLowerCase(), opts, stats, touched);
    }

    ingestProjectMetaFile(dir, stats);

    for (const projectId of touched) {
      const updated = recomputeMikeProjectCounts(projectId);
      if (updated) emitMikeProject('updated', updated);
    }

    const reportsQueued = queueMikeReports();
    const finished = finishMikeIngestRun(run.id, 'done', stats);
    console.log(
      `[mike-ingest] run ${run.id}: ${stats.files_seen} files, ${stats.rows_seen} rows, ` +
        `${stats.rows_new} new, ${stats.rows_bad} bad, ${stats.projects_new} new projects, ` +
        `${stats.capped_projects} cap-hits, ${reportsQueued} reports queued`,
    );
    return {
      run: finished ?? run,
      projects_touched: [...touched],
      reports_queued: reportsQueued,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mike-ingest] run ${run.id} failed:`, err);
    const failed = finishMikeIngestRun(run.id, 'failed', { ...stats, error: message });
    return { run: failed ?? run, projects_touched: [...touched], reports_queued: 0 };
  }
}

/** Convenience for the report generator / tests: today's CT date. */
export { mikeReportDate, shortId };
