import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query, DARWIN_COMPANY_ID } from './db.js';

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
    return formatCalendarEvents(events);
  } catch {
    return '(could not fetch calendar)';
  }
}

// ─── Paperclip helpers ────────────────────────────────────────────────────────

async function getPaperclipSnapshot(): Promise<string> {
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

async function getShimSnapshot(): Promise<{ tasks: string; sessions: string }> {
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

async function getTopPriorities(): Promise<string> {
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

    const sorted = [...tasks].sort((a, b) => b.priority - a.priority).slice(0, 3);
    if (!sorted.length) return 'No open tasks.';
    return sorted.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
  } catch {
    return '(could not fetch priorities)';
  }
}

// ─── Main briefing builder ─────────────────────────────────────────────────────

export async function buildMorningBriefing(): Promise<string> {
  const dateStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: TZ,
  }).format(new Date());

  const [calendar, paperclip, shim, priorities] = await Promise.all([
    getTodayCalendarEvents(),
    getPaperclipSnapshot(),
    getShimSnapshot(),
    getTopPriorities(),
  ]);

  return [
    `☀️ *Good morning, Kevin. ${dateStr}.*`,
    '',
    `*📅 Calendar today:*`,
    calendar,
    '',
    `*🤖 Paperclip:* ${paperclip}`,
    '',
    `*📌 SHIM:* ${shim.tasks}`,
    shim.sessions ? `*🍅 Focus:* ${shim.sessions}` : '',
    '',
    `*Your top 3 right now:*`,
    priorities,
    '',
    `What do you want to tackle first?`,
  ]
    .filter((line) => line !== null)
    .join('\n');
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

  const timed = events.filter((ev) => ev.startIso && ev.endIso && !ev.allDay);
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
