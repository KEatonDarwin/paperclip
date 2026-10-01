// TECH TASKS — Ian's "Tech Task:" email pipeline (2026-10-01, Kevin's ask).
// Monday.com is gone; company tech requests now arrive as email forwards from
// Ian (subject carries "Tech Task:"). A systemd timer (~/jarvis-tech-tasks)
// sweeps the inbox via the claude CLI + the Microsoft 365 connector and POSTs
// what it finds to /api/v1/tech-tasks/sync. Each NEW task:
//   1. gets a row here (keyed by the email's internetMessageId, so re-sweeps
//      are idempotent),
//   2. raises a cockpit notification (bell + big-board Landed),
//   3. cues JARVIS in the dedicated `cockpit:tech-tasks` thread to actually
//      attempt the task — JARVIS updates the row's status/note over REST as it
//      works (jarvis_working → handled | needs_kevin).
// Kevin's surfaces: the Big Board panel + the dashboard card read these rows;
// he flips handled/needs_kevin rows to done from the dashboard card.

import { sqliteDb, getOrCreateConversation, renameConversation } from './conversation-db.js';
import { sseBus } from './sse-bus.js';
import { createNotification } from './notifications.js';

export type TechTaskStatus = 'new' | 'jarvis_working' | 'handled' | 'needs_kevin' | 'done' | 'dismissed';

export interface TechTaskRow {
  id: number;
  msg_id: string;
  subject: string;
  sender: string;
  requester: string | null;
  received_at: string;
  body_excerpt: string | null;
  status: TechTaskStatus;
  jarvis_note: string | null;
  report_link: string | null;
  web_link: string | null;
  created_at: string;
  updated_at: string;
}

export const TECH_TASKS_THREAD_EXT = 'cockpit:tech-tasks';

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS tech_tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id        TEXT NOT NULL UNIQUE,
    subject       TEXT NOT NULL,
    sender        TEXT NOT NULL,
    requester     TEXT,
    received_at   TEXT NOT NULL,
    body_excerpt  TEXT,
    status        TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','jarvis_working','handled','needs_kevin','done','dismissed')),
    jarvis_note   TEXT,
    report_link   TEXT,
    web_link      TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tech_tasks_status ON tech_tasks(status, received_at DESC);
`);

const getByIdStmt = sqliteDb.prepare<[number], TechTaskRow>(`SELECT * FROM tech_tasks WHERE id = ?`);
const getByMsgIdStmt = sqliteDb.prepare<[string], TechTaskRow>(`SELECT * FROM tech_tasks WHERE msg_id = ?`);
const listStmt = sqliteDb.prepare<[number], TechTaskRow>(`
  SELECT * FROM tech_tasks ORDER BY received_at DESC, id DESC LIMIT ?
`);

function emit(action: 'created' | 'updated', task: TechTaskRow): void {
  sseBus.emit('event', { type: 'tech_task', action, task });
}

export function getTechTask(id: number): TechTaskRow | null {
  return getByIdStmt.get(id) ?? null;
}

export function listTechTasks(limit = 100): TechTaskRow[] {
  return listStmt.all(Math.max(1, Math.min(limit, 500)));
}

/** Board slice: everything not yet closed out, plus the last few closed rows
 *  so "done" history stays visible on the TV without a second query. */
export function listTechTasksForBoard(): { open: TechTaskRow[]; recent_closed: TechTaskRow[] } {
  const all = listTechTasks(60);
  const open = all.filter((t) => t.status === 'new' || t.status === 'jarvis_working' || t.status === 'handled' || t.status === 'needs_kevin');
  const recentClosed = all.filter((t) => t.status === 'done' || t.status === 'dismissed').slice(0, 6);
  return { open, recent_closed: recentClosed };
}

export interface TechTaskSyncItem {
  msg_id: string;
  subject: string;
  sender: string;
  requester?: string | null;
  received_at: string;
  body_excerpt?: string | null;
  web_link?: string | null;
}

/** "FW: Tech Task: X" and "Tech Task: X" are the same task — forwards must not
 *  spawn a second row/cue. */
function normalizeSubject(subject: string): string {
  return subject.replace(/^((fwd?|re):\s*)+/gi, '').replace(/^tech task:\s*/i, '').trim().toLowerCase();
}

/** Idempotent sweeper upsert. Existing msg_ids are left alone (their status is
 *  JARVIS/Kevin state, not inbox state); a forward of an already-tracked
 *  subject (≤14 days) is also treated as known; truly new ones get the full
 *  intake side effects: notification + a cue turn in the tech-tasks thread. */
export function syncTechTasks(items: TechTaskSyncItem[]): { created: TechTaskRow[]; known: number } {
  const created: TechTaskRow[] = [];
  let known = 0;
  const recent = sqliteDb.prepare(`SELECT * FROM tech_tasks WHERE received_at >= datetime('now', '-14 days')`).all() as TechTaskRow[];
  const knownSubjects = new Set(recent.map((r) => normalizeSubject(r.subject)));
  for (const item of items) {
    if (!item.msg_id || !item.subject) continue;
    if (getByMsgIdStmt.get(item.msg_id)) { known++; continue; }
    if (knownSubjects.has(normalizeSubject(item.subject))) { known++; continue; }
    knownSubjects.add(normalizeSubject(item.subject));
    const info = sqliteDb.prepare(`
      INSERT INTO tech_tasks (msg_id, subject, sender, requester, received_at, body_excerpt, web_link)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.msg_id,
      item.subject.slice(0, 300),
      item.sender.slice(0, 200),
      item.requester?.slice(0, 200) ?? null,
      item.received_at,
      item.body_excerpt?.slice(0, 4000) ?? null,
      item.web_link?.slice(0, 1000) ?? null,
    );
    const task = getByIdStmt.get(Number(info.lastInsertRowid))!;
    created.push(task);
    emit('created', task);
    createNotification({
      severity: 'warning',
      title: `📧 Tech Task: ${task.subject.replace(/^(fwd?:|re:)\s*/gi, '').replace(/^tech task:\s*/i, '').slice(0, 120)}`,
      body: `From ${task.requester ?? task.sender} — JARVIS is picking it up now.`,
      source: 'tech-tasks',
      link: '/big-board',
    });
    cueJarvisOnTask(task);
  }
  return { created, known };
}

export function updateTechTask(id: number, patch: { status?: TechTaskStatus; jarvis_note?: string | null; report_link?: string | null }): TechTaskRow | null {
  const existing = getByIdStmt.get(id);
  if (!existing) return null;
  const status = patch.status ?? existing.status;
  const note = patch.jarvis_note !== undefined ? patch.jarvis_note : existing.jarvis_note;
  const report = patch.report_link !== undefined ? patch.report_link : existing.report_link;
  sqliteDb.prepare(`UPDATE tech_tasks SET status = ?, jarvis_note = ?, report_link = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, note, report, id);
  const task = getByIdStmt.get(id)!;
  emit('updated', task);
  return task;
}

/** Wake JARVIS in the tech-tasks thread as a real (admission-gated) turn —
 *  same seam the goal/tree cues use (goals.ts postCue). */
function cueJarvisOnTask(task: TechTaskRow): void {
  const conv = getOrCreateConversation(TECH_TASKS_THREAD_EXT);
  if (!conv.title) renameConversation(conv.id, '📧 Tech Tasks');
  const text = [
    `📧 TECH TASK CUE — a new "Tech Task" email landed (task #${task.id}).`,
    ``,
    `Subject: ${task.subject}`,
    `From: ${task.requester ?? task.sender} (forwarded by ${task.sender})`,
    `Received: ${task.received_at}`,
    ``,
    task.body_excerpt ? `Body:\n${task.body_excerpt}` : `(No body captured — read it via the Microsoft 365 connector.)`,
    ``,
    `Your job: try to complete what it asks using Hub 1.0 / Smarty Pants / the systems you know. Work it like the Oxford Quantum 2 task: investigate, write the findings up, and if a reply email is warranted DRAFT it in Outlook (never send). Keep the row honest as you go via the API:`,
    `  curl -s -X PATCH http://localhost:3201/api/v1/tech-tasks/${task.id} -H "Authorization: Bearer $(grep ^JARVIS_COCKPIT_KEY= /home/kevin/paperclip/jarvis-command-center/.env | cut -d= -f2)" -H 'Content-Type: application/json' -d '{"status":"jarvis_working"}'`,
    `Finish by setting status to "handled" (you completed it — say what you did in jarvis_note, link any outbox report in report_link) or "needs_kevin" (say exactly what you need from him in jarvis_note). Then notify Kevin with the notifications tool: handled → severity success; needs_kevin → severity warning.`,
  ].join('\n');
  // Lazy import mirrors goals.ts postCue — avoids a module cycle through agent.ts.
  import('./goals.js')
    .then((goals) => goals.postCue(TECH_TASKS_THREAD_EXT, text, `tech-task:${task.id}`, 'tech-task'))
    .catch((err) => console.error(`[tech-tasks] cue for #${task.id} failed`, err));
}
