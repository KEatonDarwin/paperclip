// MIKE RADAR — the per-project chat's PER-TURN context (DESIGN §6a, node #1342).
//
// A `cockpit:mike-<short_id>` thread exists so Kevin can ask "how does this
// work" / "how do I debug this" about ONE of Mike's Lovable projects. Two things
// have to be true for that to work, and only the first was built:
//
//   1. The thread has to know WHICH project it is, and that it is read-only.
//      That is the one-time seed (`composeMikeProjectSeed`, posted by the
//      /mike-radar/projects/:shortId/thread route on create).
//   2. The thread has to know the project's CURRENT state — Supabase ref, where
//      the archive and the daily reports live, what Mike shipped most recently.
//      A seed can't carry that: it is written once and Mike keeps working.
//
// So this module builds a fresh `<mike_project>` snapshot and agent.ts prefixes
// it onto every turn, exactly like `<goal_tree>` for a goal chat and
// `<workbench_scope>` for a workbench chat. The snapshot — not the transcript —
// is the chat's memory of the project, which is what makes the chat survive
// condensation and still answer correctly a week later.
//
// Everything here is a READ against jarvis.db. No Lovable call, no Supabase
// call, no model call: the live-code reads happen later, in the turn itself,
// through the read-only Lovable MCP tools this block names.

import {
  getMikeProjectByRef,
  mikeDisplayName,
  mikeReportDate,
  listMikeFeed,
  listMikeProjectReportStubs,
  MIKE_ARCHIVE_DIR,
  MIKE_OUTBOX_DIR,
  MIKE_WORKSPACE_ID,
  MIKE_READONLY_LOVABLE_TOOLS,
  MIKE_FORBIDDEN_LOVABLE_TOOLS,
  MIKE_CHAT_CALL_CONVENTION,
  type MikeProject,
  type MikeReport,
} from './mike-radar.js';

/** `cockpit:mike-<short_id>` — minted by `mikeThreadExt`. */
export const MIKE_THREAD_PREFIX = 'cockpit:mike-';

/** How many of Mike's most recent code-changing messages the snapshot lists. */
const RECENT_CHANGES = 8;
/** How many day-stubs the "which days have reports" strip carries. */
const REPORT_STUBS = 10;
/** Hard ceiling on the whole block, mirroring buildWorkbenchThreadContext's cap. */
const MAX_CHARS = 6000;

/** The short id a mike thread is about, or null if this isn't one of them. */
export function mikeShortIdFromThread(externalId: string): string | null {
  if (!externalId.startsWith(MIKE_THREAD_PREFIX)) return null;
  const short = externalId.slice(MIKE_THREAD_PREFIX.length).trim();
  // Only the exact `cockpit:mike-<short>` shape. A hypothetical future
  // `cockpit:mike-radar-worker-3` must NOT be treated as a project chat.
  return /^[0-9a-f]{8}$/i.test(short) ? short.toLowerCase() : null;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function trim(text: string | null | undefined, max: number): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `2026-10-04T18:22:09.000Z` → `10-04 18:22` (UTC, as stored — the day
 *  buckets are already CT, so a second timezone label here would mislead). */
function shortTs(ts: string | null): string {
  if (!ts) return '??';
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(ts);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}Z` : ts.slice(0, 16);
}

function reportLabel(r: MikeReport): string {
  const risk = r.risk_flags.length ? ` risk:${r.risk_flags.join('+')}` : '';
  return `${r.report_date} ${r.status}${risk}`;
}

/** The newest report worth quoting: the most recent one that actually has a
 *  summary. A `queued`/`failed`/`skipped` row has nothing to say, and quoting
 *  it would read as "Mike did nothing" when the truth is "we haven't written it
 *  up yet" — a difference Kevin cares about. */
function latestWrittenReport(stubs: MikeReport[]): MikeReport | null {
  return stubs.find((r) => r.status === 'done' && r.summary) ?? null;
}

/**
 * The `<mike_project>` snapshot for one turn, or `''` for every thread that
 * isn't a project chat (so agent.ts can concatenate it unconditionally).
 *
 * Never throws: a malformed row or a missing table must degrade to "no extra
 * context", never break Kevin's turn.
 */
export function buildMikeThreadContext(externalId: string): string {
  try {
    const short = mikeShortIdFromThread(externalId);
    if (!short) return '';
    const project = getMikeProjectByRef(short);
    // A chat whose project row vanished (archived/retention) gets no snapshot
    // rather than a snapshot full of nulls.
    if (!project) return '';
    return renderMikeProjectSnapshot(project);
  } catch {
    return '';
  }
}

/** Factored out so the check script can render a snapshot from a row directly. */
export function renderMikeProjectSnapshot(project: MikeProject): string {
  const name = mikeDisplayName(project);
  const stubs = listMikeProjectReportStubs(project.project_id, REPORT_STUBS);
  const latest = latestWrittenReport(stubs);
  const recent = listMikeFeed({
    project_id: project.project_id,
    limit: RECENT_CHANGES,
    changes_only: true,
  }).items;

  const attrs = [
    `short_id="${escapeAttr(project.short_id)}"`,
    `project_id="${escapeAttr(project.project_id)}"`,
    `name="${escapeAttr(name)}"`,
    `supabase="${escapeAttr(project.supabase_ref ?? 'unknown')}"`,
    `watch="${escapeAttr(project.watch_state)}"`,
    `msgs="${project.msg_count}"`,
    `changes="${project.change_count}"`,
    `last_activity="${escapeAttr(project.last_activity_at ?? 'never')}"`,
    `today="${escapeAttr(mikeReportDate())}"`,
  ].join(' ');

  const allowed = MIKE_READONLY_LOVABLE_TOOLS.join(', ');
  const forbidden = MIKE_FORBIDDEN_LOVABLE_TOOLS.join(', ');

  const lines: string[] = [
    `<mike_project ${attrs}>`,
    `This thread is about ONE Lovable project Mike owns and drives: ${name} (${project.project_id}).` +
      ` You are Kevin's engineer looking over Mike's shoulder — answer "how does this work" / "how do I` +
      ` debug this" from the REAL CODE via the read-only Lovable MCP tools, not from the archived chat text alone.`,
    `READ-ONLY, HARD RULE. Allowed on this project: ${allowed} (query_database is SELECT-only).` +
      ` NEVER call: ${forbidden}, or any Supabase write. This is Mike's live work — one write is visible to him` +
      ` and can break a running app. If answering would require changing something, say so and stop.`,
    MIKE_CHAT_CALL_CONVENTION,
  ];

  if (project.live_url) lines.push(`Live URL: ${project.live_url}`);
  if (project.supabase_ref) {
    lines.push(
      `Supabase: ${project.supabase_ref} — read-only. Schema/data questions go through the Lovable` +
        ` query_database tool (SELECT only) or a read-only Supabase query; never a write or a migration.`,
    );
  }
  if (project.description) lines.push(`What it is: ${trim(project.description, 300)}`);

  lines.push(
    'Where the facts live:',
    `- Every message Mike exchanged with Lovable: ${MIKE_ARCHIVE_DIR}/${project.project_id}.jsonl` +
      ` (appended hourly by the Lovable Watcher), and the same rows in jarvis.db \`mike_activity\`.`,
    `- Day-by-day engineering reports: ${MIKE_OUTBOX_DIR}/<date>.md and jarvis.db \`mike_reports\`` +
      ` (API: GET /api/v1/mike-radar/reports/${project.short_id}/<date>).`,
    `- The project page: /mike-radar?project=${project.short_id}`,
    `- Lovable workspace: ${MIKE_WORKSPACE_ID}`,
  );

  if (latest) {
    lines.push(
      '',
      `Latest written report — ${latest.report_date} (${latest.msg_count} msgs, ${latest.change_count}` +
        ` with changes${latest.risk_flags.length ? `, risk: ${latest.risk_flags.join(', ')}` : ''}):`,
      trim(latest.summary, 900),
    );
  } else {
    lines.push('', 'No daily report has been written for this project yet.');
  }

  if (stubs.length) {
    lines.push('', `Reports on file: ${stubs.map(reportLabel).join(' · ')}`);
  }

  if (recent.length) {
    lines.push('', `Last ${recent.length} code-changing messages (newest first):`);
    for (const a of recent) {
      const files = a.change_count === 1 ? '1 file' : `${a.change_count} files`;
      const sha = a.commit_sha ? ` ${a.commit_sha.slice(0, 8)}` : '';
      lines.push(`- ${shortTs(a.ts)}${sha} [${files}] ${trim(a.headline, 160) || '(no headline)'}`);
    }
  } else {
    lines.push('', 'No code-changing messages are archived for this project yet.');
  }

  lines.push('</mike_project>');

  const body = lines.join('\n');
  if (body.length <= MAX_CHARS) return `${body}\n`;
  // Truncate inside the element so the closing tag always survives — a snapshot
  // cut mid-attribute reads as broken markup to the model.
  const room = MAX_CHARS - '\n… (snapshot truncated — the project page has the rest)\n</mike_project>\n'.length;
  return `${body.slice(0, Math.max(0, room))}\n… (snapshot truncated — the project page has the rest)\n</mike_project>\n`;
}
