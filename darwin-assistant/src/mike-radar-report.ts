/**
 * MIKE RADAR — the daily engineering report.
 *
 * One report per project per CT day, written from the day's archived messages by
 * the SUBSCRIPTION claude CLI. There is no API key anywhere in this path: the
 * one-shot goes through `laymanFreeform()` in layman-summary.ts, which strips
 * ANTHROPIC_API_KEY/OPENAI_API_KEY from the child env, spawns the `claude`
 * binary, is sim-guarded against scratch DBs, and never throws (null = failed).
 *
 * WHY laymanFreeform AND NOT A FRESH SPAWN: one spawn pattern in the codebase
 * means one place where the no-API-key rule, the stream-json parsing and the
 * timeout live. Its DEFAULTS are all wrong for this job though (haiku, 45 s,
 * 2,000-char cap would silently chop the report mid-section), so all four
 * overrides below are mandatory, not optional.
 *
 * COST GATE: reports are generated SERIALLY, one claude process at a time, and
 * only for `watched` projects that are on Kevin's key shortlist or had >= 3
 * messages that day. Mike has 100 projects and most are dormant.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { laymanFreeform } from './layman-summary.js';
import { createNotification } from './notifications.js';
import {
  MIKE_OUTBOX_DIR,
  getMikeProject,
  getMikeProjectByRef,
  getMikeReport,
  updateMikeReport,
  requeueMikeReport,
  listMikeReports,
  listMikeDayActivity,
  countMikeDayChanges,
  mikeDisplayName,
  mikeReportDate,
  emitMikeReport,
  type MikeProject,
  type MikeReport,
  type MikeActivity,
} from './mike-radar.js';
import { stripToolUses, riskFlagsFromChanges, type MikeChange } from './mike-radar-parse.js';

/** Sonnet, not haiku: haiku under-reads diffs and the report is the whole point.
 *  Not opus either — this is a daily log, not a design review. */
export const MIKE_REPORT_MODEL = process.env['MIKE_RADAR_REPORT_MODEL'] ?? 'claude-sonnet-5';
const MIKE_REPORT_TIMEOUT_MS = 300_000;
const MIKE_REPORT_MAX_CHARS = 16_000;
/** Prompt input budget. Over this, user messages are kept whole and the
 *  assistant side collapses to changes-only (see `buildReportInput`). */
const MIKE_REPORT_INPUT_BUDGET = 60_000;
const PER_MESSAGE_PROSE_CAP = 4_000;

function ctTime(ts: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ts));
  } catch {
    return ts.slice(11, 16);
  }
}

function changeLine(changes: MikeChange[]): string {
  if (!changes.length) return '';
  const byAction = new Map<string, string[]>();
  for (const c of changes) {
    const label = c.path ?? c.note ?? c.tool;
    const list = byAction.get(c.action) ?? [];
    if (!list.includes(label)) list.push(label);
    byAction.set(c.action, list);
  }
  return [...byAction.entries()]
    .map(([action, items]) => `${action}: ${items.slice(0, 12).join(', ')}`)
    .join(' | ');
}

export interface MikeReportInput {
  text: string;
  chars: number;
  msg_count: number;
  change_count: number;
  risk_flags: string[];
  /** True when the assistant prose had to be dropped to fit the budget. */
  truncated: boolean;
}

/**
 * Turn one project-day into an affordable prompt body. Raw assistant messages
 * are 5-15 KB of `<lov-tool-use>` payload each; `stripToolUses` collapses every
 * block to a `[tool: name path]` marker, which is ~10× smaller and still says
 * what was touched.
 */
export function buildReportInput(rows: MikeActivity[]): MikeReportInput {
  const allChanges: MikeChange[] = [];
  for (const r of rows) allChanges.push(...r.changes);

  const render = (assistantProse: boolean): string => {
    const parts: string[] = [];
    for (const row of rows) {
      const who = row.role === 'user' ? 'MIKE' : 'LOVABLE';
      const head = `[${ctTime(row.ts)} ${who}]`;
      const changes = changeLine(row.changes);
      if (row.role === 'user' || assistantProse) {
        const prose = stripToolUses(row.text).slice(0, PER_MESSAGE_PROSE_CAP);
        parts.push([head, prose, changes ? `CHANGED → ${changes}` : ''].filter(Boolean).join('\n'));
      } else {
        // Changes-only fallback: the headline plus what was touched.
        parts.push([head, row.headline ?? '', changes ? `CHANGED → ${changes}` : ''].filter(Boolean).join('\n'));
      }
    }
    return parts.join('\n\n');
  };

  let text = render(true);
  let truncated = false;
  if (text.length > MIKE_REPORT_INPUT_BUDGET) {
    text = render(false);
    truncated = true;
    if (text.length > MIKE_REPORT_INPUT_BUDGET) {
      text = `${text.slice(0, MIKE_REPORT_INPUT_BUDGET)}\n\n[input truncated at ${MIKE_REPORT_INPUT_BUDGET} chars]`;
    }
  }

  return {
    text,
    chars: text.length,
    msg_count: rows.length,
    change_count: rows.filter((r) => r.change_count > 0).length,
    risk_flags: riskFlagsFromChanges(allChanges),
    truncated,
  };
}

export function buildReportPrompt(project: MikeProject, date: string, input: MikeReportInput): string {
  const name = mikeDisplayName(project);
  const gaps = input.truncated
    ? '\nNOTE: this day was too large to include in full, so the agent-side prose was dropped and only the file/table/function changes are shown for those messages. Say so if it limits what you can conclude.'
    : '';
  return `You are Kevin's engineer reviewing ONE DAY of another engineer's work on a Lovable project. The other engineer is Mike; the project is "${name}" (id ${project.project_id}${project.supabase_ref ? `, Supabase ${project.supabase_ref}` : ''}). Write the day's report for Kevin, who did not watch it happen.

Four sections, markdown, no preamble, in this order:

## What changed
The actual behaviour that is different, and the files / tables / functions it lives in.

## How it works now
The mechanism, in the terms a maintainer needs — not a changelog.

## Risk & blast radius
Migrations, secrets, edge functions, SQL run against live data, anything touching auth or money, anything that looks half-finished or abandoned mid-way.

## If it breaks
Where to look first, which table or function, what to query.

Then, on the very last line and nowhere else, one line starting exactly \`SUMMARY:\` followed by 2-4 plain sentences a non-engineer would understand.

Rules: be specific — name files, tables, functions. Say "I can't tell from this" rather than guessing. Do not invent a commit, a table or a file that is not in the log below. Do not repeat this instruction back.${gaps}

=== DAY ${date} (America/Chicago) · ${input.msg_count} messages, ${input.change_count} with changes ===
${input.text}
=== END OF DAY ===`;
}

const SUMMARY_RE = /^\s*SUMMARY\s*:\s*(.+)$/ims;

/** Split the trailing `SUMMARY:` line off the body. A model that forgot the
 *  line still produces a usable report — the summary just stays null and the
 *  LaymanBlock falls back to the markdown. */
export function splitReportOutput(raw: string): { markdown: string; summary: string | null } {
  const trimmed = raw.trim();
  const m = SUMMARY_RE.exec(trimmed);
  if (!m) return { markdown: trimmed, summary: null };
  const summary = m[1].trim().replace(/\s+/g, ' ');
  const markdown = (trimmed.slice(0, m.index) + trimmed.slice(m.index + m[0].length)).trim();
  return { markdown: markdown || trimmed, summary: summary || null };
}

export interface GenerateMikeReportOpts {
  /** Write the row even when the day has zero messages (status 'skipped'). */
  allowEmpty?: boolean;
}

/**
 * Generate (or regenerate) one project-day report. Serial by construction — the
 * caller loops. Never throws: a failure lands as `status:'failed'` + `error` on
 * the row plus one `warning` notification, and there is NO auto-retry (tomorrow
 * does not re-try yesterday; Kevin's Regenerate button does).
 */
export async function generateMikeReport(
  projectRef: string,
  date: string,
  opts: GenerateMikeReportOpts = {},
): Promise<MikeReport | null> {
  const project = getMikeProjectByRef(projectRef);
  if (!project) return null;

  const rows = listMikeDayActivity(project.project_id, date);
  const changeCount = countMikeDayChanges(project.project_id, date);

  if (!rows.length && !opts.allowEmpty) {
    const existing = getMikeReport(project.project_id, date);
    if (existing) {
      const skipped = updateMikeReport(project.project_id, date, {
        status: 'skipped',
        error: null,
        summary: "Mike didn't touch this project on this day.",
        markdown: null,
        msg_count: 0,
        change_count: 0,
        finished_at: new Date().toISOString(),
      });
      if (skipped) emitMikeReport('updated', skipped);
      return skipped;
    }
    return null;
  }

  requeueMikeReport(project.project_id, date, { msg_count: rows.length, change_count: changeCount });
  const running = updateMikeReport(project.project_id, date, {
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    model: MIKE_REPORT_MODEL,
  });
  if (running) emitMikeReport('updated', running);

  const input = buildReportInput(rows);
  const prompt = buildReportPrompt(project, date, input);

  const out = await laymanFreeform({
    prompt,
    model: MIKE_REPORT_MODEL,
    timeoutMs: MIKE_REPORT_TIMEOUT_MS,
    maxChars: MIKE_REPORT_MAX_CHARS,
    where: 'mike-radar-report',
  });

  if (!out) {
    const failed = updateMikeReport(project.project_id, date, {
      status: 'failed',
      error: 'claude one-shot returned nothing (timeout, empty output, or scratch-env refusal)',
      finished_at: new Date().toISOString(),
      input_chars: input.chars,
      msg_count: input.msg_count,
      change_count: input.change_count,
      risk_flags: input.risk_flags,
    });
    if (failed) {
      emitMikeReport('failed', failed);
      try {
        createNotification({
          severity: 'warning',
          title: `Mike Radar report failed — ${mikeDisplayName(project)} ${date}`,
          body: 'The daily engineering report could not be written. Use Regenerate on the project page to retry.',
          source: 'mike-radar',
          link: `/mike-radar?project=${project.short_id}&date=${date}`,
        });
      } catch (err) {
        console.error('[mike-report] notification failed:', err);
      }
    }
    return failed;
  }

  const { markdown, summary } = splitReportOutput(out);
  const done = updateMikeReport(project.project_id, date, {
    status: 'done',
    summary,
    markdown,
    model: MIKE_REPORT_MODEL,
    msg_count: input.msg_count,
    change_count: input.change_count,
    // Risk flags are derived DETERMINISTICALLY from the day's parsed changes,
    // never from the model's prose — a model that forgets to mention a
    // migration must not make the migration disappear from the UI.
    risk_flags: input.risk_flags,
    input_chars: input.chars,
    error: null,
    finished_at: new Date().toISOString(),
  });
  if (done) emitMikeReport('done', done);
  return done;
}

/**
 * The nightly pass: every `queued` report for `date`, serially. Returns what it
 * did so the driver can log one line. `limit` is a hard stop so a backlog can
 * never turn into 100 claude calls in one go.
 */
export async function runMikeReportPass(
  date = mikeReportDate(),
  limit = 12,
): Promise<{ date: string; attempted: number; done: number; failed: number }> {
  const queued = listMikeReports({ date, status: 'queued', limit: Math.max(1, Math.min(limit, 50)) });
  let done = 0;
  let failed = 0;
  for (const row of queued) {
    const result = await generateMikeReport(row.project_id, date);
    if (result?.status === 'done') done++;
    else if (result?.status === 'failed') failed++;
  }
  if (queued.length) {
    try {
      writeMikeDailyRollup(date);
    } catch (err) {
      console.error('[mike-report] rollup write failed:', err);
    }
  }
  console.log(`[mike-report] pass ${date}: ${queued.length} attempted, ${done} done, ${failed} failed`);
  return { date, attempted: queued.length, done, failed };
}

/**
 * The phone-readable artifact: one markdown file per day in the wiki outbox
 * with every project's summary and risk flags. Same pattern Stub Radar uses, so
 * Kevin can read the day from the vault without opening the cockpit.
 */
export function writeMikeDailyRollup(date = mikeReportDate()): string | null {
  const reports = listMikeReports({ date, limit: 200, with_markdown: true });
  if (!reports.length) return null;

  const lines: string[] = [
    `# Mike Radar — ${date}`,
    '',
    `What Mike's Lovable projects did on ${date} (America/Chicago). Written from the Lovable Watcher archive; read-only, nothing was sent to Mike.`,
    '',
  ];

  const done = reports.filter((r) => r.status === 'done');
  const other = reports.filter((r) => r.status !== 'done');

  const flagged = done.filter((r) => r.risk_flags.length);
  if (flagged.length) {
    lines.push('## ⚠ Worth a look');
    for (const r of flagged) {
      const project = getMikeProject(r.project_id);
      lines.push(`- **${project ? mikeDisplayName(project) : r.short_id}** — ${r.risk_flags.join(', ')}`);
    }
    lines.push('');
  }

  for (const r of done) {
    const project = getMikeProject(r.project_id);
    const name = project ? mikeDisplayName(project) : r.short_id;
    lines.push(`## ${name} (\`${r.short_id}\`)`);
    lines.push('');
    lines.push(`*${r.msg_count} messages, ${r.change_count} with changes${r.risk_flags.length ? ` · flags: ${r.risk_flags.join(', ')}` : ''}*`);
    lines.push('');
    lines.push(r.summary ?? '_no summary line_');
    lines.push('');
    if (r.markdown) {
      lines.push('<details><summary>Full engineer report</summary>', '', r.markdown, '', '</details>', '');
    }
  }

  if (other.length) {
    lines.push('## Not reported');
    for (const r of other) {
      lines.push(`- \`${r.short_id}\` — ${r.status}${r.error ? `: ${r.error}` : ''}`);
    }
    lines.push('');
  }

  mkdirSync(MIKE_OUTBOX_DIR, { recursive: true });
  const path = join(MIKE_OUTBOX_DIR, `${date}.md`);
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}
