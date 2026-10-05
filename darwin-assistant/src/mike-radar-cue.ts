// MIKE RADAR — the daily report CUE (DESIGN §6b, node #1342).
//
// The report generator writes a markdown report per project per day and a
// roll-up into the wiki outbox. On its own that is a file nobody opens: the
// reports land at 23:40 CT and nothing wakes JARVIS to read them, so "what did
// Mike change yesterday" stays a question Kevin has to think to ask.
//
// This module closes that gap the same way tree-cue.ts does for a finished
// hopper tree: once the nightly pass has written the day's reports, it posts ONE
// short cue into Kevin's dedicated Mike-oversight thread (conversation 3396,
// `cockpit:2571a43a-…`) listing what each project did, and raises one cockpit
// notification. One cue per day covering every project — never one per report,
// which would be a JARVIS turn per project in the same thread.
//
// The agent.js / thread-message-queue.js imports are DYNAMIC on purpose, for the
// two reasons tree-cue.ts documents: no import cycle (agent.ts pulls in the
// mike-radar graph via the per-turn chat context), and the scratch-DB check can
// intercept exactly this module's `import('./agent.js')` with a scoped ESM
// loader hook — proving the cue is composed and "sent" with NO model call and
// NO API keys.

import { getConversation, getSetting, setSetting } from './conversation-db.js';
import { createNotification } from './notifications.js';
import {
  listMikeReports,
  mikeDisplayName,
  getMikeProject,
  mikeReportDate,
  MIKE_OUTBOX_DIR,
  type MikeReport,
} from './mike-radar.js';

/** Kevin's dedicated engineering chat on Mike's work (conversation 3396).
 *  Overridable live via the `mike_report_cue_thread` setting so the cue can be
 *  pointed at a different thread without a deploy. */
export const MIKE_OVERSIGHT_THREAD_EXT = 'cockpit:2571a43a-5311-417b-8835-d23b74f3bfc3';

/** One cue per report-date. Written BEFORE the async post so a second pass for
 *  the same date (a re-run, a backfill) can't double-wake the thread while the
 *  first post's promise is still in flight. */
function cueGuardKey(date: string): string {
  return `mike_report_cue:${date}`;
}

export function mikeOversightThreadExt(): string {
  const override = (getSetting('mike_report_cue_thread') ?? '').trim();
  return override || MIKE_OVERSIGHT_THREAD_EXT;
}

/** Live kill switch, no restart needed. Default on. */
function cueEnabled(): boolean {
  return (getSetting('mike_report_cue') ?? 'on').trim().toLowerCase() !== 'off';
}

function firstSentence(text: string | null, max = 240): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

function label(report: MikeReport): string {
  const project = getMikeProject(report.project_id);
  return project ? mikeDisplayName(project) : report.short_id;
}

export interface MikeCueDigest {
  date: string;
  /** Reports with a written summary — the ones the cue is actually about. */
  written: MikeReport[];
  /** Reports the generator couldn't write. Kevin needs to know about a hole. */
  failed: MikeReport[];
  projects: number;
  changes: number;
  msgs: number;
  risk_flags: string[];
}

/** What the day amounts to, read once and shared by the cue text and the
 *  notification so the two can never disagree. */
export function buildMikeCueDigest(date: string): MikeCueDigest {
  const reports = listMikeReports({ date, limit: 200 });
  const written = reports.filter((r) => r.status === 'done' && r.summary);
  const failed = reports.filter((r) => r.status === 'failed');
  const risk = new Set<string>();
  for (const r of written) for (const f of r.risk_flags) risk.add(f);
  return {
    date,
    written,
    failed,
    projects: written.length,
    changes: written.reduce((n, r) => n + r.change_count, 0),
    msgs: written.reduce((n, r) => n + r.msg_count, 0),
    risk_flags: [...risk].sort(),
  };
}

/** The cue text. A fixed `[mike radar — …]` header so the thread's own history
 *  is greppable and an automated turn is obvious at a glance. */
export function composeMikeReportCue(digest: MikeCueDigest): string {
  const { date, written, failed } = digest;
  const lines: string[] = [
    `[mike radar — daily report ${date}: ${digest.projects} project${digest.projects === 1 ? '' : 's'}, ` +
      `${digest.changes} code change${digest.changes === 1 ? '' : 's'}, ${digest.msgs} messages]`,
    '',
    `What Mike's Lovable projects did on ${date} (America/Chicago), written from the hourly archive. ` +
      'Read-only — nothing was sent to Mike and nothing was changed in his estates.',
    '',
  ];

  for (const r of written) {
    const risk = r.risk_flags.length ? ` ⚠ ${r.risk_flags.join(', ')}` : '';
    lines.push(
      `**${label(r)}** (\`${r.short_id}\`) — ${r.msg_count} msgs / ${r.change_count} with changes${risk}`,
      firstSentence(r.summary),
      '',
    );
  }

  if (failed.length) {
    lines.push(
      `Reports that FAILED to write (hole in the day, retry from the project page): ` +
        `${failed.map((r) => `${label(r)} (${r.short_id})`).join(', ')}`,
      '',
    );
  }

  if (digest.risk_flags.length) {
    lines.push(`Risk flags across the day: ${digest.risk_flags.join(', ')}`, '');
  }

  lines.push(
    `Full reports: /mike-radar?date=${date} · roll-up at ${MIKE_OUTBOX_DIR}/${date}.md · per project: ` +
      `GET /api/v1/mike-radar/reports/<short_id>/${date}`,
    '',
    'Next: read the reports and tell Kevin in a few plain sentences what actually matters — anything that ' +
      "touches a live Darwin system (Hub 2.0, the clearing house, PerClickity's live tables), any migration " +
      'or RLS/auth change, and anything that conflicts with work Kevin has in flight. If nothing matters, ' +
      'say that in one line. Stay READ-ONLY on every one of Mike\'s estates: no Lovable send_message, no ' +
      'writes to his Supabase projects, no message to Mike.',
  );

  return lines.join('\n');
}

/**
 * Post the day's cue into the oversight thread + raise one notification.
 *
 * Called by `runMikeReportPass` after the nightly pass has written the reports
 * and the roll-up. Deliberately NOT called by the single-report regenerate
 * route: Kevin is sitting on the project page when he clicks Regenerate, so a
 * cue there would be a model turn telling him what he is already looking at.
 *
 * Fire-and-forget by design — the pass must not wait on a JARVIS turn.
 */
export function fireMikeReportCue(date = mikeReportDate()): void {
  if (!cueEnabled()) return;
  if (getSetting(cueGuardKey(date))) return; // already cued this date

  const digest = buildMikeCueDigest(date);
  // Nothing written and nothing broken = Mike didn't work that day. Silence is
  // the correct report; a nightly "no activity" ping trains Kevin to ignore the
  // thread. Note: no guard is written, so a late backfill for that date can
  // still cue once it has something to say.
  if (!digest.written.length && !digest.failed.length) return;

  const text = composeMikeReportCue(digest);
  const riskSuffix = digest.risk_flags.length ? ` · ⚠ ${digest.risk_flags.join(', ')}` : '';

  // Mark BEFORE the async post (see cueGuardKey).
  setSetting(cueGuardKey(date), new Date().toISOString());

  // The bell fires regardless of whether the thread can be woken — Kevin should
  // learn the day is written even if the oversight conversation is missing.
  try {
    createNotification({
      severity: digest.failed.length ? 'warning' : 'info',
      title: `🛰 Mike Radar — ${date}: ${digest.projects} project${digest.projects === 1 ? '' : 's'}, ${digest.changes} changes${riskSuffix}`,
      body: digest.written.length
        ? digest.written.map((r) => `${label(r)}: ${firstSentence(r.summary, 120)}`).join('\n')
        : `${digest.failed.length} report(s) failed to write for ${date}.`,
      source: 'mike-radar',
      link: `/mike-radar?date=${date}`,
    });
  } catch (err) {
    console.error('[mike-cue] notification failed:', err);
  }

  const originExt = mikeOversightThreadExt();
  const conv = getConversation(originExt);
  if (!conv) {
    console.warn(`[mike-cue] ${date}: no conversation for ${originExt} — notification only, no thread cue`);
    return;
  }
  const convId = conv.id;
  const correlationKey = `mike-report:${date}`;

  Promise.all([import('./agent.js'), import('./thread-message-queue.js')])
    .then(([agent, queue]) => {
      if (agent.getInFlightMessageId(convId)) {
        queue.enqueueMessage(convId, text);
        return;
      }
      agent.processMessage(text, originExt, correlationKey).catch((err: unknown) => {
        if (err instanceof agent.ConversationBusyError) queue.enqueueMessage(convId, text);
        else console.error(`[mike-cue] ${date} post failed`, err);
      });
    })
    .catch((err) => {
      console.error(`[mike-cue] ${date} import failed`, err);
      // The cue never left the building — clear the guard so the next pass for
      // this date retries instead of being deduped into permanent silence.
      try {
        setSetting(cueGuardKey(date), '');
      } catch {
        /* best effort */
      }
    });
}
