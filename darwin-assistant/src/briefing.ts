import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query, DARWIN_COMPANY_ID } from './db.js';
import { getMutedSourceIds } from './mute-check.js';
import { sqliteDb } from './conversation-db.js';

const execFileAsync = promisify(execFile);

const GOG_BIN = '/usr/local/bin/gog';
const TZ = 'America/Chicago';

// ─── Calendar helpers ─────────────────────────────────────────────────────────

export interface CalendarEvent {
  summary: string;
  startIso: string | null;
  endIso: string | null;
  allDay: boolean;
  eventId?: string;
}

function todayCST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '?';
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: TZ,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export async function fetchTodayCalendarEvents(): Promise<CalendarEvent[]> {
  const dateStr = todayCST();
  const from = `${dateStr}T00:00:00Z`;
  const to = `${dateStr}T23:59:59Z`;
  const account = process.env.GOG_ACCOUNT?.trim() || 'kevineatonfx@gmail.com';
  const calId = process.env.GOG_CALENDAR_ID?.trim() || 'primary';

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GOG_KEYRING_BACKEND: 'file',
    GOG_KEYRING_PASSWORD: '',
  };

  const { stdout } = await execFileAsync(
    GOG_BIN,
    ['calendar', 'events', calId, '--from', from, '--to', to, '--no-input', '-a', account, '--json', '--results-only'],
    { env },
  );
  if (!stdout.trim()) return [];

  const raw = JSON.parse(stdout) as Array<{
    id?: string;
    summary?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
  }>;

  return raw.map((ev) => ({
    summary: ev.summary ?? '(no title)',
    startIso: ev.start?.dateTime ?? null,
    endIso: ev.end?.dateTime ?? null,
    allDay: !ev.start?.dateTime && !!ev.start?.date,
    eventId: ev.id,
  }));
}

function formatCalendarEvents(events: CalendarEvent[]): string {
  if (!events.length) return 'Nothing on the calendar today.';
  return events
    .map((ev) => {
      const start = ev.startIso ? formatTime(ev.startIso) : ev.allDay ? 'all day' : '?';
      const end = ev.endIso ? ` – ${formatTime(ev.endIso)}` : '';
      return `• ${start}${end}: ${ev.summary}`;
    })
    .join('\n');
}

async function getTodayCalendarEvents(): Promise<string> {
  try {
    const events = await fetchTodayCalendarEvents();
    const mutedIds = await getMutedSourceIds('calendar');
    const visible = events.filter(
      (ev) => !ev.eventId || !isMutedCalendarEvent(ev.eventId, mutedIds),
    );
    return formatCalendarEvents(visible);
  } catch {
    return '(could not fetch calendar)';
  }
}

function isMutedCalendarEvent(eventId: string, mutedIds: Set<string>): boolean {
  if (mutedIds.has(eventId)) return true;
  for (const mid of mutedIds) {
    if (eventId.startsWith(mid)) return true;
  }
  return false;
}

// ─── Paperclip helpers ────────────────────────────────────────────────────────

export async function getPaperclipSnapshot(): Promise<string> {
  try {
    const rows = await query<Record<string, string>>(
      `SELECT
        (SELECT COUNT(*) FROM agents WHERE company_id = $1 AND status = 'running') AS running,
        (SELECT COUNT(*) FROM agents WHERE company_id = $1 AND status = 'error') AS errored,
        (SELECT COUNT(*) FROM issues WHERE company_id = $1 AND status = 'in_progress') AS in_progress,
        (SELECT COUNT(*) FROM issues WHERE company_id = $1 AND status = 'in_review') AS in_review,
        (SELECT COUNT(*) FROM issues WHERE company_id = $1 AND status = 'blocked') AS blocked,
        (SELECT COUNT(*) FROM approvals WHERE company_id = $1 AND status = 'pending') AS approvals`,
      [DARWIN_COMPANY_ID],
    );
    const s = rows[0];
    const lines: string[] = [];
    if (Number(s.running) > 0) lines.push(`${s.running} agent(s) running`);
    if (Number(s.in_progress) > 0) lines.push(`${s.in_progress} issue(s) in progress`);
    if (Number(s.in_review) > 0) lines.push(`${s.in_review} in review`);
    if (Number(s.blocked) > 0) lines.push(`⚠️ ${s.blocked} blocked`);
    if (Number(s.errored) > 0) lines.push(`🔴 ${s.errored} agent(s) errored`);
    if (Number(s.approvals) > 0) lines.push(`🔔 ${s.approvals} approval(s) waiting on you`);
    return lines.length ? lines.join(' · ') : 'All quiet in Paperclip.';
  } catch {
    return '(could not reach Paperclip DB)';
  }
}

// ─── SHIM helpers ─────────────────────────────────────────────────────────────

export async function getShimSnapshot(): Promise<{ tasks: string; sessions: string }> {
  const shimUrl = process.env.SHIM_MCP_URL ?? 'https://somehow.thedarwinhub.com/mcp';
  const token = process.env.SHIM_MCP_TOKEN;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  async function shimCall(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(shimUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: toolName, arguments: args } }),
    });
    if (!res.ok) throw new Error(`SHIM ${res.status}`);
    const json = (await res.json()) as { result?: { content?: Array<{ type: string; text: string }> } };
    const text = json.result?.content?.find((c) => c.type === 'text')?.text ?? 'null';
    return JSON.parse(text);
  }

  try {
    const taskData = (await shimCall('list-tasks-tool', { status: 'open', limit: 50 })) as { count?: number; tasks?: Array<{ id: number; title: string; priority: number; project_id?: number | null }> };
    const total = taskData?.count ?? 0;
    const urgent = (taskData?.tasks ?? []).filter((t) => t.priority >= 3);
    let taskSummary = `${total} open task${total === 1 ? '' : 's'}`;
    if (urgent.length) {
      taskSummary += ` (${urgent.length} high/urgent: ${urgent.slice(0, 3).map((t) => t.title).join(', ')}${urgent.length > 3 ? '…' : ''})`;
    }

    const sessionData = (await shimCall('list-focus-sessions-tool', { today_only: true, limit: 20 })) as { sessions?: Array<{ work_duration: number; status: string }> };
    const sessions = sessionData?.sessions ?? [];
    const completedToday = sessions.filter((s) => s.status === 'completed');
    const totalWorkSecs = completedToday.reduce((sum, s) => sum + (s.work_duration ?? 0), 0);
    const totalWorkMins = Math.round(totalWorkSecs / 60);
    const activeSession = sessions.find((s) => s.status === 'active' || s.status === 'paused');
    let sessionSummary = completedToday.length
      ? `${completedToday.length} pomodoro${completedToday.length === 1 ? '' : 's'} done today (${totalWorkMins} min)`
      : 'No focus sessions yet today';
    if (activeSession) sessionSummary += ` · 🍅 session active now`;

    return { tasks: taskSummary, sessions: sessionSummary };
  } catch {
    return { tasks: '(could not reach SHIM)', sessions: '' };
  }
}

// ─── Top priorities ───────────────────────────────────────────────────────────

export async function getTopPriorities(): Promise<string> {
  const shimUrl = process.env.SHIM_MCP_URL ?? 'https://somehow.thedarwinhub.com/mcp';
  const token = process.env.SHIM_MCP_TOKEN;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(shimUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: 'list-tasks-tool', arguments: { status: 'open', limit: 50 } } }),
    });
    const json = (await res.json()) as { result?: { content?: Array<{ type: string; text: string }> } };
    const text = json.result?.content?.find((c) => c.type === 'text')?.text ?? 'null';
    const data = JSON.parse(text) as { tasks?: Array<{ id: number; title: string; priority: number }> };
    const tasks = data?.tasks ?? [];

    const mutedTaskIds = await getMutedSourceIds('shim_task');
    const unmuted = tasks.filter((t) => !mutedTaskIds.has(String(t.id)));
    const sorted = [...unmuted].sort((a, b) => b.priority - a.priority).slice(0, 3);
    if (!sorted.length) return 'No open tasks.';
    return sorted.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
  } catch {
    return '(could not fetch priorities)';
  }
}

// ─── Morning "Build Standup" ────────────────────────────────────────────────
//
// Kevin retired the old fixed brief (calendar + Paperclip issue-counts + top-3
// SHIM tasks) on 2026-08-01. His actual work now flows through many parallel
// cockpit build threads (harness + Hub 2.0 accounting), not a SHIM task list or
// calendar — so that template was blind to ~everything he does and surfaced
// noise (156 "in review"). The morning message is now a "Build Standup" that
// mirrors how he works: (1) where we left off — synthesized from the most
// recent thread summaries; (2) needs your call — the short filtered set of
// things genuinely waiting on him; (3) I'd start with — JARVIS picks the single
// highest-leverage next move, like a human collaborator. Composed by the local
// `claude` CLI (NO ANTHROPIC_API_KEY — see the NO API KEYS rule), mirroring the
// jarvis-brief.ts / vision-critique.ts pattern, with a deterministic fallback
// so the morning message can never hard-fail. Weekend-aware; silent on Sundays.

const CLAUDE_BIN = process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';
const STANDUP_TIMEOUT_MS = 90 * 1000;

interface StandupSignal {
  dateStr: string;
  weekday: string;
  isWeekend: boolean;
  isSunday: boolean;
  calendar: string;
  paperclip: string;
  threads: string;
  kevinTodos: string;
}

/** Recently-active build threads + their latest summary — the "where we left
 *  off" signal. Excludes ephemeral/check-in plumbing threads. */
function recentThreadActivity(): string {
  try {
    const rows = sqliteDb
      .prepare<[], { title: string | null; external_id: string; summary: string | null }>(
        `SELECT c.title, c.external_id,
          (SELECT s.content FROM thread_summaries s
             WHERE s.conversation_id = c.id
             ORDER BY s.created_at DESC LIMIT 1) AS summary
         FROM conversations c
         WHERE c.updated_at > datetime('now','-48 hours')
           AND c.external_id NOT LIKE 'ephemeral:%'
           AND c.external_id NOT LIKE 'checkin:%'
           AND c.title IS NOT NULL AND c.title != ''
         ORDER BY c.updated_at DESC
         LIMIT 10`,
      )
      .all();
    if (!rows.length) return '(no active build threads in the last 48h)';
    return rows
      .map((r) => {
        const summ = (r.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 260);
        return `- "${r.title}"${summ ? ` — ${summ}` : ''}`;
      })
      .join('\n');
  } catch (err) {
    return `(could not read thread activity: ${(err as Error).message})`;
  }
}

/** Open todos assigned to Kevin across every cockpit thread — the real
 *  "needs your call" backlog (not the in_review pile). */
function openKevinTodos(): string {
  try {
    const rows = sqliteDb
      .prepare<[], { content: string; status: string; title: string | null; external_id: string }>(
        `SELECT t.content, t.status, c.title, c.external_id
         FROM thread_todos t
         JOIN conversations c ON c.id = t.conversation_id
         WHERE t.owner = 'kevin' AND t.status != 'done'
         ORDER BY t.updated_at DESC LIMIT 12`,
      )
      .all();
    if (!rows.length) return '(none)';
    return rows
      .map((r) => `- [${r.status}] "${r.content}" (thread: ${r.title ?? r.external_id})`)
      .join('\n');
  } catch (err) {
    return `(could not read Kevin todos: ${(err as Error).message})`;
  }
}

function buildStandupPrompt(s: StandupSignal): string {
  return [
    "You are JARVIS, Kevin's chief of staff. Write his MORNING message (a Slack DM) for",
    `${s.dateStr}. Kevin RETIRED the old brief (calendar + Paperclip issue-counts + a top-3`,
    'SHIM task list) — it was blind to how he actually works now: many parallel cockpit BUILD',
    'THREADS (his JARVIS harness + Hub 2.0 accounting). This replaces it with a "Build Standup".',
    '',
    'Write exactly three short sections, in this order, using Slack formatting only',
    '(*single-asterisk bold*, `code`; NO ## headers, NO **double** bold, no tables):',
    '',
    '1. *Where we left off* — 2-4 tight lines re-entering yesterday\'s active build fronts,',
    '   SYNTHESIZED from the thread activity below. Group by theme (e.g. harness vs accounting);',
    '   do NOT list every thread or paste summaries verbatim. Give him a running start, not a log.',
    '2. *Needs your call* — ONLY things genuinely waiting on Kevin: a merge decision, a blocked',
    '   item, a real question, or a Kevin-owned todo. Filter hard. If nothing truly needs him,',
    '   say "Nothing waiting on you." The Paperclip "in review" pile is his own async review',
    '   queue — mention it as at most a one-liner, never as a to-do dump.',
    '3. *I\'d start with:* — pick the SINGLE highest-leverage next move and offer to run it.',
    '   ONE thing. Actually choose, like a human collaborator sizing up the day — do not hedge',
    '   or give options. End by offering to jump in.',
    '',
    'Voice: warm, direct, broad strokes (no root-cause detail), concise — he reads this on a',
    'phone. Open with a one-line greeting that includes the date. Keep the whole thing tight.',
    s.isSunday
      ? 'IT IS SUNDAY — his rest day. Do NOT push work. Keep it to a warm one-liner; skip the three sections entirely (at most note what is parked for Monday if something is genuinely time-sensitive).'
      : s.isWeekend
        ? 'It is the WEEKEND — lead lighter and do not pressure. Still give the standup if there is live build momentum, but keep the tone easy and optional.'
        : 'It is a weekday — this is his work-focused standup.',
    '',
    `=== CALENDAR TODAY ===\n${s.calendar}`,
    '',
    `=== RECENT BUILD-THREAD ACTIVITY (most recent first, with latest summaries) ===\n${s.threads}`,
    '',
    `=== OPEN TODOS ASSIGNED TO KEVIN ===\n${s.kevinTodos}`,
    '',
    `=== PAPERCLIP SNAPSHOT (counts only — do not just recite these) ===\n${s.paperclip}`,
    '',
    'Output ONLY the finished Slack message text — no preamble, no code fences, no explanation.',
  ].join('\n');
}

function runStandup(prompt: string): Promise<string> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_BIN,
      ['-p', prompt, '--output-format', 'json'],
      { timeout: STANDUP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`claude standup failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 200)}` : ''}`));
          return;
        }
        try {
          const envelope = JSON.parse(stdout.trim()) as { result?: string };
          resolve(typeof envelope.result === 'string' ? envelope.result : stdout);
        } catch {
          resolve(stdout);
        }
      },
    );
  });
}

/** Deterministic Build-Standup render — the safety net if the claude call
 *  fails. Deliberately NOT the old calendar/issue-count/top-3 layout. */
function fallbackStandup(s: StandupSignal): string {
  if (s.isSunday) {
    return `☀️ *Morning, Kevin — ${s.dateStr}.*\n\nSunday — resting the build. Nothing work-side from me today. 💛`;
  }
  const lines: string[] = [`☀️ *Morning, Kevin — ${s.dateStr}.*`, '', '*Where we left off*', s.threads, '', '*Needs your call*'];
  const needs: string[] = [];
  if (/blocked/i.test(s.paperclip)) needs.push('• Blocked items sitting in Paperclip — worth a look.');
  if (s.kevinTodos !== '(none)') needs.push(s.kevinTodos);
  lines.push(needs.length ? needs.join('\n') : '• Nothing waiting on you.');
  lines.push('', "*I'd start with:* pick up the top thread above — reply and I'll jump in.");
  return lines.join('\n');
}

export async function buildMorningBriefing(): Promise<string> {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: TZ,
  }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: TZ }).format(now);
  const isSunday = weekday === 'Sunday';
  const isWeekend = isSunday || weekday === 'Saturday';

  const [calendar, paperclip] = await Promise.all([
    getTodayCalendarEvents(),
    getPaperclipSnapshot(),
  ]);

  const signal: StandupSignal = {
    dateStr,
    weekday,
    isWeekend,
    isSunday,
    calendar,
    paperclip,
    threads: recentThreadActivity(),
    kevinTodos: openKevinTodos(),
  };

  try {
    const text = (await runStandup(buildStandupPrompt(signal))).trim();
    if (!text) throw new Error('empty standup');
    return text;
  } catch (err) {
    console.error('[briefing] standup generation failed, using fallback:', err);
    return fallbackStandup(signal);
  }
}

// ─── Check-in producer: enqueue reminders for today's calendar events ─────────

export async function enqueueCalendarCheckins(): Promise<number> {
  let events: CalendarEvent[];
  try {
    events = await fetchTodayCalendarEvents();
  } catch {
    console.warn('[checkin-producer] Could not fetch calendar events');
    return 0;
  }

  const mutedIds = await getMutedSourceIds('calendar');
  const timed = events.filter(
    (ev) => ev.startIso && ev.endIso && !ev.allDay
      && !(ev.eventId && isMutedCalendarEvent(ev.eventId, mutedIds)),
  );
  if (!timed.length) return 0;

  let enqueued = 0;
  for (const ev of timed) {
    const start = new Date(ev.startIso!);
    const end = new Date(ev.endIso!);
    const durationMin = (end.getTime() - start.getTime()) / 60_000;
    if (durationMin <= 0) continue;

    const checkins: { fireAt: Date; reason: string }[] = [];

    if (durationMin < 60) {
      // Short event: one check-in at start + 10 minutes
      checkins.push({
        fireAt: new Date(start.getTime() + 10 * 60_000),
        reason: `Are you working on "${ev.summary}"? It started 10 minutes ago.`,
      });
    } else {
      // 1hr+ event: midpoint and end check-ins
      const mid = new Date(start.getTime() + (end.getTime() - start.getTime()) / 2);
      checkins.push({
        fireAt: mid,
        reason: `Midpoint check — how's "${ev.summary}" going?`,
      });
      checkins.push({
        fireAt: end,
        reason: `"${ev.summary}" is wrapping up. Did you finish what you needed?`,
      });
    }

    for (const ci of checkins) {
      if (ci.fireAt.getTime() <= Date.now()) continue;
      try {
        await query(
          `INSERT INTO jarvis_checkins (fire_at, reason, source_type, source_id)
           VALUES ($1, $2, 'calendar', $3)`,
          [ci.fireAt.toISOString(), ci.reason, ev.eventId ?? null],
        );
        enqueued++;
      } catch (err) {
        console.error(`[checkin-producer] Failed to enqueue for "${ev.summary}":`, err);
      }
    }
  }

  console.log(`[checkin-producer] Enqueued ${enqueued} check-ins for ${timed.length} calendar events`);
  return enqueued;
}
