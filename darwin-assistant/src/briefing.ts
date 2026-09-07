import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query, DARWIN_COMPANY_ID } from './db.js';
import { getMutedSourceIds } from './mute-check.js';
import { sqliteDb } from './conversation-db.js';
import { createHopperItem } from './hopper.js';

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

// ─── Morning Debrief ─────────────────────────────────────────────────────────
//
// Lineage: the original fixed brief (calendar + Paperclip issue-counts + top-3
// SHIM tasks) was retired 2026-08-01 for the "Build Standup" — a synthesis of
// yesterday's cockpit build threads. Kevin retired THAT on 2026-09-07 ("dump it
// entirely") once the Hopper Engine started doing real autonomous overnight
// work: the standup narrated threads *he* drove, and was blind to what JARVIS
// built while he slept. The morning message is now a MORNING DEBRIEF — JARVIS
// reporting on its own overnight autonomous runs, in five sections:
//
//   1. Overnight autonomous work — hopper trees/nodes that moved in the last 16h,
//      per node: outcome, model it ran on, attempts (from hopper_nodes + spawn_tasks).
//   2. Decisions I made — synthesized from node results + governor/engine bells.
//   3. Follow-on candidates — 2-3 next trees the overnight work suggests. These
//      are ALSO filed into the Task Hopper (source 'morning-debrief') so each is
//      one click from becoming a real tree in /hopper.
//   4. Needs your call — open owner:kevin todos + blocked/blocked_question nodes.
//   5. I'd start with — the single highest-leverage pick.
//
// Composed by the local `claude` CLI (NO ANTHROPIC_API_KEY — see the NO API KEYS
// rule), mirroring the jarvis-brief.ts / vision-critique.ts pattern, with a
// deterministic fallback that renders the SAME five-section shape from raw data
// so the morning message can never hard-fail. Weekend-aware; silent on Sundays.

const CLAUDE_BIN = process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';
// The debrief prompt carries far more raw signal than the old standup (a whole
// night of node results), so it needs a longer leash than the 90s that fit the
// standup — a timeout here silently demotes Kevin to the fallback render.
const STANDUP_TIMEOUT_MS = 180 * 1000;
/** How far back "overnight" reaches. 16h covers an 8am fire back through the
 *  prior afternoon — the whole window Kevin was away from the keyboard. */
const OVERNIGHT_HOURS = 16;

interface FollowOn {
  title: string;
  summary?: string;
}

interface DebriefSignal {
  dateStr: string;
  weekday: string;
  isWeekend: boolean;
  isSunday: boolean;
  calendar: string;
  paperclip: string;
  threads: string;
  kevinTodos: string;
  /** Rendered overnight hopper activity (section 1 raw material). */
  overnight: string;
  /** True when nothing ran overnight — lets both renderers say so in one line. */
  overnightEmpty: boolean;
  /** hopper-engine notifications from the window (governor holds, blocks, completions). */
  engineEvents: string;
  /** Nodes currently parked blocked / blocked_question (any age). */
  blockedNodes: string;
  /** Deterministic follow-on guesses — the fallback's section 3. */
  fallbackFollowOns: FollowOn[];
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

// ─── Overnight hopper signal ─────────────────────────────────────────────────

interface OvernightNodeRow {
  id: number;
  tree_id: string;
  tree_topic: string;
  tree_status: string;
  title: string;
  status: string;
  model: string | null;
  adapter: string | null;
  attempts: number;
  result: string | null;
  question: string | null;
  worker_thread_ext: string | null;
  updated_at: string;
  spawn_status: string | null;
  turn_count: number | null;
  spawn_error: string | null;
}

const NODE_ICON: Record<string, string> = {
  done: '✅',
  split: '🌿',
  running: '⏳',
  blocked: '🔴',
  blocked_question: '❓',
  pending: '·',
};

function trim(text: string | null | undefined, max: number): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Hopper nodes that actually moved in the overnight window, grouped by tree,
 *  with the model each ran on and its attempt count — section 1's raw material.
 *  Joins spawn_tasks (the attempt ledger) for worker-side status/errors. */
function overnightHopperActivity(): { text: string; empty: boolean; rows: OvernightNodeRow[] } {
  try {
    const rows = sqliteDb
      .prepare<[string], OvernightNodeRow>(
        `SELECT n.id, n.tree_id, n.title, n.status, n.model, n.adapter, n.attempts,
                n.result, n.question, n.worker_thread_ext, n.updated_at,
                t.topic AS tree_topic, t.status AS tree_status,
                s.status AS spawn_status, s.turn_count, s.error AS spawn_error
           FROM hopper_nodes n
           JOIN hopper_trees t ON t.id = n.tree_id
           LEFT JOIN spawn_tasks s ON s.thread_ext = n.worker_thread_ext
          WHERE n.updated_at > datetime('now', ?)
            AND n.status IN ('done','split','running','blocked','blocked_question')
          ORDER BY n.tree_id, n.id`,
      )
      .all(`-${OVERNIGHT_HOURS} hours`);

    if (!rows.length) return { text: 'No overnight runs.', empty: true, rows: [] };

    const byTree = new Map<string, OvernightNodeRow[]>();
    for (const r of rows) {
      const list = byTree.get(r.tree_id) ?? [];
      list.push(r);
      byTree.set(r.tree_id, list);
    }

    const blocks: string[] = [];
    for (const [treeId, nodes] of byTree) {
      const head = nodes[0];
      blocks.push(`Tree ${treeId} — "${head.tree_topic}" [tree status: ${head.tree_status}]`);
      for (const n of nodes) {
        const icon = NODE_ICON[n.status] ?? '•';
        const bits = [n.model ?? 'default model', `attempt ${n.attempts}`];
        if (n.spawn_status && n.spawn_status !== 'done') bits.push(`worker ${n.spawn_status}`);
        if (n.turn_count) bits.push(`${n.turn_count} turns`);
        let line = `  ${icon} #${n.id} ${n.title} (${bits.join(', ')})`;
        const detail = n.question ?? n.result ?? n.spawn_error;
        if (detail) line += `\n      → ${trim(detail, 260)}`;
        blocks.push(line);
      }
    }
    return { text: blocks.join('\n'), empty: false, rows };
  } catch (err) {
    return { text: `(could not read hopper activity: ${(err as Error).message})`, empty: true, rows: [] };
  }
}

/** hopper-engine bells from the overnight window — governor holds, tree
 *  completions, blocked escalations. The "decisions I made" corroboration. */
function overnightEngineEvents(): string {
  try {
    const rows = sqliteDb
      .prepare<[string], { severity: string; title: string; body: string | null; created_at: string }>(
        `SELECT severity, title, body, created_at
           FROM notifications
          WHERE source = 'hopper-engine' AND created_at > datetime('now', ?)
          ORDER BY created_at DESC LIMIT 20`,
      )
      .all(`-${OVERNIGHT_HOURS} hours`);
    if (!rows.length) return '(no hopper-engine events)';
    return rows.map((r) => `- [${r.severity}] ${r.title}${r.body ? ` — ${trim(r.body, 200)}` : ''}`).join('\n');
  } catch (err) {
    return `(could not read engine events: ${(err as Error).message})`;
  }
}

/** Every node currently parked needing a human — NOT window-limited, because a
 *  node blocked three days ago still needs Kevin today. */
function blockedHopperNodes(): { text: string; rows: OvernightNodeRow[] } {
  try {
    const rows = sqliteDb
      .prepare<[], OvernightNodeRow>(
        `SELECT n.id, n.tree_id, n.title, n.status, n.model, n.adapter, n.attempts,
                n.result, n.question, n.worker_thread_ext, n.updated_at,
                t.topic AS tree_topic, t.status AS tree_status,
                NULL AS spawn_status, NULL AS turn_count, NULL AS spawn_error
           FROM hopper_nodes n
           JOIN hopper_trees t ON t.id = n.tree_id
          WHERE n.status IN ('blocked','blocked_question')
          ORDER BY n.updated_at DESC LIMIT 10`,
      )
      .all();
    if (!rows.length) return { text: '(none)', rows: [] };
    const text = rows
      .map((r) => {
        const what = r.status === 'blocked_question' ? `QUESTION: ${trim(r.question, 300)}` : `BLOCKED: ${trim(r.result, 300)}`;
        return `- #${r.id} "${r.title}" (tree ${r.tree_id}) — ${what}`;
      })
      .join('\n');
    return { text, rows };
  } catch (err) {
    return { text: `(could not read blocked nodes: ${(err as Error).message})`, rows: [] };
  }
}

/** Deterministic follow-on guesses from raw data — used by the fallback render,
 *  and as the filing set if the model's block is unparseable. */
function deriveFollowOns(overnight: OvernightNodeRow[], blocked: OvernightNodeRow[]): FollowOn[] {
  const out: FollowOn[] = [];
  for (const b of blocked.slice(0, 2)) {
    out.push({
      title: `Unblock hopper node #${b.id}: ${b.title}`,
      summary: b.status === 'blocked_question' ? trim(b.question, 300) : trim(b.result, 300),
    });
  }
  const finishedTrees = new Map<string, string>();
  for (const n of overnight) {
    if (n.tree_status === 'done') finishedTrees.set(n.tree_id, n.tree_topic);
  }
  for (const [treeId, topic] of finishedTrees) {
    if (out.length >= 3) break;
    out.push({ title: `Deploy / review the output of ${treeId}`, summary: `Tree "${topic}" finished overnight — review the branch and decide on deploy.` });
  }
  const retried = overnight.filter((n) => n.attempts > 1).slice(0, 1);
  for (const r of retried) {
    if (out.length >= 3) break;
    out.push({ title: `Investigate retry on "${r.title}"`, summary: `Node #${r.id} needed ${r.attempts} attempts — worth understanding why before the next tree.` });
  }
  return out.slice(0, 3);
}

// ─── Follow-on candidates → Task Hopper ──────────────────────────────────────

const FOLLOWON_MARKER = '---FOLLOWONS---';

/** Split the model's output into the Slack message and its machine-readable
 *  follow-on block. A missing/garbled block is non-fatal — we just get no
 *  model-authored candidates and fall back to the derived ones. */
function parseFollowOnBlock(raw: string): { message: string; followOns: FollowOn[] } {
  const idx = raw.indexOf(FOLLOWON_MARKER);
  if (idx === -1) return { message: raw.trim(), followOns: [] };
  const message = raw.slice(0, idx).trim();
  const tail = raw
    .slice(idx + FOLLOWON_MARKER.length)
    .replace(/```(?:json)?/g, '')
    .trim();
  try {
    const parsed = JSON.parse(tail) as unknown;
    if (!Array.isArray(parsed)) return { message, followOns: [] };
    const followOns = parsed
      .filter((x): x is { title: unknown; summary?: unknown } => !!x && typeof x === 'object')
      .map((x) => ({ title: String((x as { title: unknown }).title ?? '').trim(), summary: (x as { summary?: unknown }).summary ? String((x as { summary?: unknown }).summary) : undefined }))
      .filter((x) => x.title.length > 0)
      .slice(0, 3);
    return { message, followOns };
  } catch {
    return { message, followOns: [] };
  }
}

/** File each follow-on into the Task Hopper so it shows up in /hopper for a
 *  one-click yes/no. Deduped against anything this debrief already filed in the
 *  last day — the morning message can be re-fired on demand ("good morning"). */
function fileFollowOnCandidates(followOns: FollowOn[]): number {
  let filed = 0;
  for (const f of followOns) {
    try {
      const dupe = sqliteDb
        .prepare<[string], { n: number }>(
          `SELECT COUNT(*) AS n FROM hopper_items
            WHERE source = 'morning-debrief' AND title = ?
              AND created_at > datetime('now','-20 hours')`,
        )
        .get(f.title);
      if ((dupe?.n ?? 0) > 0) continue;
      createHopperItem({
        title: f.title.slice(0, 200),
        summary: f.summary ? f.summary.slice(0, 1000) : null,
        source: 'morning-debrief',
        source_ref: 'JARVIS overnight debrief',
      });
      filed++;
    } catch (err) {
      console.error('[briefing] could not file follow-on candidate:', (err as Error).message);
    }
  }
  return filed;
}

function buildDebriefPrompt(s: DebriefSignal): string {
  return [
    "You are JARVIS, Kevin's chief of staff — and you now do real autonomous work overnight",
    'through the Hopper Engine (work trees of tasks dispatched to ephemeral worker threads).',
    `Write his MORNING DEBRIEF (a Slack DM) for ${s.dateStr}. This is YOU reporting on YOUR OWN`,
    'overnight runs — not a task list, not a calendar recap. Kevin retired both of those.',
    '',
    'Write exactly these five short sections, in order, using Slack formatting only',
    '(*single-asterisk bold*, `code`; NO ## headers, NO **double** bold, no tables):',
    '',
    '1. *Overnight autonomous work* — what your trees actually did while he slept. Per tree:',
    '   what finished, what blocked, and note the model a node ran on when it is interesting',
    "   (a retry that escalated, an expensive node). Synthesize — don't paste the raw log.",
    s.overnightEmpty
      ? '   NOTHING RAN OVERNIGHT — make this section exactly one line saying so, and keep the whole message shorter.'
      : '   Keep it to a handful of lines; he wants the outcome, not the transcript.',
    '2. *Decisions I made* — the judgment calls you made without him (design choices in node',
    '   results, governor holds, retries/escalations, things you chose not to do). This is the',
    '   audit surface for autonomy — be honest and specific, one line each. If there were none,',
    '   say so in one line.',
    '3. *Follow-on candidates* — 2-3 concrete NEXT trees the overnight work suggests. Each one',
    '   line. Tell him they are already filed in the hopper for a one-click yes/no.',
    '4. *Needs your call* — ONLY what genuinely waits on Kevin: a blocked node, a worker',
    '   question, a merge/deploy decision, a Kevin-owned todo. Filter hard. If nothing truly',
    '   needs him, say "Nothing waiting on you." The Paperclip "in review" pile is his own async',
    '   queue — at most a one-liner, never a to-do dump.',
    "5. *I'd start with:* — the SINGLE highest-leverage next move, and offer to run it. ONE",
    '   thing. Actually choose, like a human collaborator sizing up the day — do not hedge.',
    '',
    'Voice: warm, direct, broad strokes (no root-cause detail), concise — he reads this on a',
    'phone. Open with a one-line greeting that includes the date. Keep the whole thing tight.',
    s.isSunday
      ? 'IT IS SUNDAY — his rest day. Do NOT push work. Keep it to a warm one-liner; skip the five sections entirely (at most note what is parked for Monday if something is genuinely time-sensitive).'
      : s.isWeekend
        ? 'It is the WEEKEND — lead lighter and do not pressure. Still give the debrief if there was real overnight momentum, but keep the tone easy and optional.'
        : 'It is a weekday — this is his work-focused debrief.',
    '',
    `=== OVERNIGHT HOPPER ACTIVITY (last ${OVERNIGHT_HOURS}h — trees, nodes, model, attempts, results) ===\n${s.overnight}`,
    '',
    `=== HOPPER ENGINE EVENTS (last ${OVERNIGHT_HOURS}h — governor holds, completions, blocks) ===\n${s.engineEvents}`,
    '',
    `=== NODES PARKED NEEDING A HUMAN (any age) ===\n${s.blockedNodes}`,
    '',
    `=== OPEN TODOS ASSIGNED TO KEVIN ===\n${s.kevinTodos}`,
    '',
    `=== RECENT COCKPIT THREAD ACTIVITY (context for what he was driving himself) ===\n${s.threads}`,
    '',
    `=== CALENDAR TODAY ===\n${s.calendar}`,
    '',
    `=== PAPERCLIP SNAPSHOT (counts only — do not just recite these) ===\n${s.paperclip}`,
    '',
    'Output the finished Slack message text first — no preamble, no code fences, no explanation.',
    `Then, on its own line, output exactly ${FOLLOWON_MARKER} followed by a JSON array of the`,
    '2-3 follow-on candidates from section 3, each {"title": "...", "summary": "..."}, where the',
    'title reads as a task Kevin would agree to and the summary is one or two sentences of',
    'context. Output an empty array [] if there are genuinely no sensible follow-ons.',
  ].join('\n');
}

/** Compose via the LOCAL claude CLI on subscription auth — NO API KEY, ever
 *  (the key is stripped from the child env). Same shape as jarvis-brief.ts. */
function runDebrief(prompt: string): Promise<string> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    const child = execFile(
      CLAUDE_BIN,
      ['-p', prompt, '--output-format', 'json'],
      { timeout: STANDUP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`claude debrief failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 200)}` : ''}`));
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
    // The whole prompt rides in argv; close stdin so the CLI doesn't burn its
    // 3s "waiting for piped input" grace period on every morning fire.
    child.stdin?.end();
  });
}

/** Deterministic Morning-Debrief render — the safety net if the claude call
 *  fails. Same five sections, straight from the raw data. */
function fallbackDebrief(s: DebriefSignal): string {
  if (s.isSunday) {
    return `☀️ *Morning, Kevin — ${s.dateStr}.*\n\nSunday — resting the build. Nothing work-side from me today. 💛`;
  }
  const lines: string[] = [
    `☀️ *Morning, Kevin — ${s.dateStr}.*`,
    '',
    '*Overnight autonomous work*',
    s.overnight,
    '',
    '*Decisions I made*',
    s.engineEvents === '(no hopper-engine events)' ? '• Nothing I had to decide on my own overnight.' : s.engineEvents,
    '',
    '*Follow-on candidates*',
  ];
  lines.push(
    s.fallbackFollowOns.length
      ? s.fallbackFollowOns.map((f) => `• ${f.title}${f.summary ? ` — ${f.summary}` : ''}`).join('\n') +
        '\n(Filed in the hopper — one click each.)'
      : '• Nothing obvious queued up next.',
  );
  lines.push('', '*Needs your call*');
  const needs: string[] = [];
  if (s.blockedNodes !== '(none)') needs.push(s.blockedNodes);
  if (s.kevinTodos !== '(none)') needs.push(s.kevinTodos);
  if (/blocked/i.test(s.paperclip)) needs.push('• Blocked items sitting in Paperclip — worth a look.');
  lines.push(needs.length ? needs.join('\n') : '• Nothing waiting on you.');
  lines.push(
    '',
    s.blockedNodes !== '(none)'
      ? "*I'd start with:* unblocking the parked node above — answer it and I'll resume the tree."
      : s.fallbackFollowOns.length
        ? `*I'd start with:* ${s.fallbackFollowOns[0].title} — say go and I'll run it.`
        : "*I'd start with:* pick a topic and I'll break it into a tree and run it.",
  );
  return lines.join('\n');
}

export async function buildMorningBriefing(opts?: { fileCandidates?: boolean }): Promise<string> {
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

  const overnight = overnightHopperActivity();
  const blocked = blockedHopperNodes();

  const signal: DebriefSignal = {
    dateStr,
    weekday,
    isWeekend,
    isSunday,
    calendar,
    paperclip,
    threads: recentThreadActivity(),
    kevinTodos: openKevinTodos(),
    overnight: overnight.text,
    overnightEmpty: overnight.empty,
    engineEvents: overnightEngineEvents(),
    blockedNodes: blocked.text,
    fallbackFollowOns: deriveFollowOns(overnight.rows, blocked.rows),
  };

  // Sunday is a rest day — no work push, and nothing gets filed into his hopper.
  const shouldFile = (opts?.fileCandidates ?? true) && !isSunday;

  let message: string;
  let followOns: FollowOn[];
  try {
    const raw = (await runDebrief(buildDebriefPrompt(signal))).trim();
    if (!raw) throw new Error('empty debrief');
    const parsed = parseFollowOnBlock(raw);
    if (!parsed.message) throw new Error('debrief had no message body');
    message = parsed.message;
    followOns = parsed.followOns.length ? parsed.followOns : signal.fallbackFollowOns;
  } catch (err) {
    console.error('[briefing] debrief generation failed, using fallback:', err);
    message = fallbackDebrief(signal);
    followOns = signal.fallbackFollowOns;
  }

  if (shouldFile && followOns.length) {
    const filed = fileFollowOnCandidates(followOns);
    if (filed) console.log(`[briefing] filed ${filed} follow-on candidate(s) into the task hopper`);
  }

  return message;
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
