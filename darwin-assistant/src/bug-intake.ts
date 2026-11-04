// BUG INTAKE — the Ctrl+Shift+B cockpit modal's modern seam (2026-10-05, Kevin's ask).
// Replaces the dead Foreman/Paperclip-worker intake (handlers/api-v1.ts's old
// /intake route forwarded to tools/paperclip.ts -> submitIntake -> the now-
// mothballed :3100 server, which returns nothing). That old route is left in
// place but superseded — see the comment at its definition.
//
// Flow: the modal POSTs here -> we insert a row, spin up a dedicated
// `cockpit:bugfix-<id>` conversation, and cue JARVIS there with everything it
// needs to triage, plant its own hopper tree, and verify. This mirrors the
// Tech Tasks seam exactly (see tech-tasks.ts's cueJarvisOnTask) — same
// getOrCreateConversation + renameConversation + lazy goals.postCue pattern.
// The cued turn's brain lives in skills/jarvis-bug-fixer/SKILL.md.

import { randomUUID } from 'node:crypto';
import { sqliteDb, getOrCreateConversation, renameConversation } from './conversation-db.js';
import { sseBus } from './sse-bus.js';

export type BugIntakeJobType = 'bug_fix' | 'build';
export type BugIntakeStatus = 'new' | 'triaging' | 'asked_question' | 'tree_planted' | 'done' | 'needs_kevin';

export interface BugIntakeRow {
  id: string;
  text: string;
  job_type: BugIntakeJobType;
  repo: string;
  page_url: string | null;
  thread_ext: string;
  tree_id: string | null;
  status: BugIntakeStatus;
  jarvis_note: string | null;
  created_at: string;
  updated_at: string;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS bug_intake (
    id            TEXT PRIMARY KEY,
    text          TEXT NOT NULL,
    job_type      TEXT NOT NULL DEFAULT 'bug_fix' CHECK (job_type IN ('bug_fix','build')),
    repo          TEXT NOT NULL DEFAULT 'darwin-assistant',
    page_url      TEXT,
    thread_ext    TEXT NOT NULL,
    tree_id       TEXT,
    status        TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','triaging','asked_question','tree_planted','done','needs_kevin')),
    jarvis_note   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bug_intake_created ON bug_intake(created_at DESC);
`);

const getByIdStmt = sqliteDb.prepare<[string], BugIntakeRow>(`SELECT * FROM bug_intake WHERE id = ?`);
const listStmt = sqliteDb.prepare<[number], BugIntakeRow>(`
  SELECT * FROM bug_intake ORDER BY created_at DESC, id DESC LIMIT ?
`);

function emit(action: 'created' | 'updated', bug: BugIntakeRow): void {
  sseBus.emit('event', { type: 'bugfix', action, bug });
}

export function getBugIntake(id: string): BugIntakeRow | null {
  return getByIdStmt.get(id) ?? null;
}

export function listBugIntake(limit = 15): BugIntakeRow[] {
  return listStmt.all(Math.max(1, Math.min(limit, 200)));
}

export interface CreateBugIntakeInput {
  text: string;
  job_type?: BugIntakeJobType;
  repo?: string;
  page_url?: string | null;
}

/** Inserts the row, spawns the dedicated triage thread, and cues JARVIS there
 *  to run skills/jarvis-bug-fixer/SKILL.md. Mirrors tech-tasks.ts's
 *  cueJarvisOnTask — same thread-per-item + lazy goals.postCue seam. */
export function createBugIntake(input: CreateBugIntakeInput): BugIntakeRow {
  const id = randomUUID();
  const jobType: BugIntakeJobType = input.job_type === 'build' ? 'build' : 'bug_fix';
  const repo = input.repo?.trim() || 'darwin-assistant';
  const threadExt = `cockpit:bugfix-${id}`;

  sqliteDb.prepare(`
    INSERT INTO bug_intake (id, text, job_type, repo, page_url, thread_ext, status)
    VALUES (?, ?, ?, ?, ?, ?, 'new')
  `).run(id, input.text, jobType, repo, input.page_url ?? null, threadExt);

  const bug = getByIdStmt.get(id)!;
  emit('created', bug);
  cueJarvisOnBug(bug);
  return bug;
}

export interface UpdateBugIntakeInput {
  status?: BugIntakeStatus;
  tree_id?: string | null;
  jarvis_note?: string | null;
}

export function updateBugIntake(id: string, patch: UpdateBugIntakeInput): BugIntakeRow | null {
  const existing = getByIdStmt.get(id);
  if (!existing) return null;
  const status = patch.status ?? existing.status;
  const treeId = patch.tree_id !== undefined ? patch.tree_id : existing.tree_id;
  const note = patch.jarvis_note !== undefined ? patch.jarvis_note : existing.jarvis_note;
  sqliteDb.prepare(`UPDATE bug_intake SET status = ?, tree_id = ?, jarvis_note = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, treeId, note, id);
  const bug = getByIdStmt.get(id)!;
  emit('updated', bug);
  return bug;
}

/** Wake JARVIS in the dedicated bugfix thread as a real (admission-gated) turn
 *  — same seam tech-tasks.ts uses (goals.ts postCue). The brief hands over
 *  exactly what skills/jarvis-bug-fixer/SKILL.md expects. */
function cueJarvisOnBug(bug: BugIntakeRow): void {
  const conv = getOrCreateConversation(bug.thread_ext);
  if (!conv.title) renameConversation(conv.id, `🐞 Bugfix: ${bug.text.slice(0, 40)}`);
  const text = [
    `🐞 BUG INTAKE CUE — Kevin submitted the Ctrl+Shift+B modal (bug_id ${bug.id}).`,
    ``,
    `text: ${bug.text}`,
    `job_type: ${bug.job_type}`,
    `repo: ${bug.repo}`,
    `page_url: ${bug.page_url ?? '(not captured)'}`,
    `bug_id: ${bug.id}`,
    ``,
    `Load and follow skills/jarvis-bug-fixer/SKILL.md (/home/kevin/obsidian/paperclip-wiki/skills/jarvis-bug-fixer/SKILL.md) now — it is the runbook for this cue: triage -> decision gate (ask at most one question, else proceed) -> plant your own hopper tree -> close the loop when it finishes.`,
    `Keep the row honest via the API as you go:`,
    `  curl -s -X PATCH http://localhost:3201/api/v1/bug-intake/${bug.id} -H "Authorization: Bearer $(grep ^JARVIS_COCKPIT_KEY= /home/kevin/paperclip/jarvis-command-center/.env | cut -d= -f2)" -H 'Content-Type: application/json' -d '{"status":"triaging"}'`,
  ].join('\n');
  // Lazy import mirrors goals.ts postCue / tech-tasks.ts — avoids a module cycle through agent.ts.
  import('./goals.js')
    .then((goals) => goals.postCue(bug.thread_ext, text, `bugfix:${bug.id}`, 'bugfix'))
    .catch((err) => console.error(`[bug-intake] cue for ${bug.id} failed`, err));
}
