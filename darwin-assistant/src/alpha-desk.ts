// ALPHA DESK (2026-10-15) — the read surface behind the cockpit /alpha-desk page.
//
// Alpha JARVIS (cockpit:jarvis-alpha) is a second-Kevin coworker: it does not do the
// work itself, it writes briefs, spawns chats, reads their reports, verifies and
// follows up. This module answers the one question Kevin has when he looks at that:
// "what did Alpha hand out, and is it going the right way?"
//
// Everything here is DERIVED from rows that already exist — chat_spawns, the child's
// own turns, and the chat_report watch_commitments row — with exactly one exception:
// Alpha's own verdict per child, which lives in a plain JSON file Alpha writes with
// no deploy (see VERDICTS_PATH). A child missing from that file is `pending`, so a
// brand-new spawn shows up on the page immediately.
//
// Read-only and model-free by construction: SELECTs with explicit columns (never
// SELECT * on `turns` — claude_input/claude_output are huge) plus one small JSON
// read. Nothing here writes anything.
//
// The "is this child running right now" check is INJECTED rather than imported.
// In production the route passes JARVIS's own in-process `getInFlightMessageId`
// (the same signal the thread status pill uses). Keeping it a parameter means this
// whole module can be exercised OUTSIDE the JARVIS process - which is how the
// preview proved it against the real database before any deploy.

import fs from 'node:fs';
import path from 'node:path';
import { sqliteDb, getConversation } from './conversation-db.js';

/** The orchestrator whose delegations this desk shows, unless overridden. */
export const DEFAULT_ORIGIN_EXT = 'cockpit:jarvis-alpha';

const VAULT_ROOT = process.env.ALPHA_DESK_VAULT_ROOT?.trim() || '/home/kevin/obsidian/paperclip-wiki';
export const VERDICTS_PATH = path.join(VAULT_ROOT, 'agent-memory/jarvis-alpha/desk/verdicts.json');

/** Alpha's judgement on one child. Anything unrecognised degrades to 'pending'. */
export type VerdictKind = 'accepted' | 'follow-up' | 'rejected' | 'pending';
const VERDICT_KINDS: VerdictKind[] = ['accepted', 'follow-up', 'rejected', 'pending'];

export interface Verdict {
  verdict: VerdictKind;
  note: string;
  next_step: string;
  updated_at: string | null;
}

/**
 * How the work is going, in one word:
 *   running  — a turn is in flight in the child right now
 *   reported — the child called report_back
 *   overdue  — past the commitment's due_at with no report
 *   quiet    — not running, no report, not yet due
 */
export type SpawnState = 'running' | 'reported' | 'overdue' | 'quiet';

export interface AlphaDeskRow {
  spawn_id: number;
  external_id: string;
  conversation_id: number;
  title: string | null;
  spawned_at: string;
  reported_at: string | null;
  state: SpawnState;
  running: boolean;
  /** From the chat_report commitment, when one was registered. */
  due_at: string | null;
  commitment_status: string | null;
  /** The child's first user-role turn — the brief Alpha wrote. */
  brief: string | null;
  /** report_back's `summary` argument. */
  report_summary: string | null;
  report_at: string | null;
  /** The child's last assistant message, full text. */
  final_reply: string | null;
  final_reply_at: string | null;
  turn_count: number;
  verdict: Verdict;
}

export interface AlphaDeskPayload {
  origin: { external_id: string; conversation_id: number | null; title: string | null };
  counts: { total: number; open: number; running: number; reported_today: number; overdue: number };
  rows: AlphaDeskRow[];
  verdicts_path: string;
  /** Set when verdicts.json is missing or unparseable — the page says so out loud
   *  rather than silently showing every child as pending. */
  verdicts_error: string | null;
  generated_at: string;
}

const PENDING: Verdict = { verdict: 'pending', note: '', next_step: '', updated_at: null };

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Read Alpha's verdict file. Never throws — a bad file is reported, not fatal. */
export function readVerdicts(): { verdicts: Record<string, Verdict>; error: string | null } {
  let raw: string;
  try {
    raw = fs.readFileSync(VERDICTS_PATH, 'utf8');
  } catch {
    return { verdicts: {}, error: 'verdicts.json not found — every child reads as pending' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { verdicts: {}, error: `verdicts.json is not valid JSON (${(err as Error).message})` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { verdicts: {}, error: 'verdicts.json must be a JSON object keyed by child external_id' };
  }
  const out: Record<string, Verdict> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const kind = str(v.verdict).trim().toLowerCase() as VerdictKind;
    out[key] = {
      verdict: VERDICT_KINDS.includes(kind) ? kind : 'pending',
      note: str(v.note),
      next_step: str(v.next_step),
      updated_at: str(v.updated_at) || null,
    };
  }
  return { verdicts: out, error: null };
}

// ─── Queries ─────────────────────────────────────────────────────────────────
// Prepared lazily: chat_spawns is created on first use by the spawn_chat tool, so a
// top-level prepare would throw on a build where nobody has spawned anything yet.

interface SpawnJoinRow {
  spawn_id: number;
  child_conversation_id: number;
  created_at: string;
  reported_at: string | null;
  external_id: string;
  title: string | null;
}

function selectSpawns(originConversationId: number): SpawnJoinRow[] {
  try {
    return sqliteDb
      .prepare(
        `SELECT s.id AS spawn_id,
                s.child_conversation_id,
                s.created_at,
                s.reported_at,
                c.external_id,
                c.title
           FROM chat_spawns s
           JOIN conversations c ON c.id = s.child_conversation_id
          WHERE s.origin_conversation_id = ?
          ORDER BY s.id DESC`,
      )
      .all(originConversationId) as SpawnJoinRow[];
  } catch {
    // No chat_spawns table yet — nothing has ever been delegated.
    return [];
  }
}

const SQL_BRIEF = `SELECT content, created_at FROM turns
                    WHERE conversation_id = ? AND role = 'user'
                    ORDER BY id ASC LIMIT 1`;

const SQL_REPORT = `SELECT tool_args, created_at FROM turns
                     WHERE conversation_id = ? AND role = 'tool_call' AND tool_name = 'report_back'
                     ORDER BY id DESC LIMIT 1`;

const SQL_FINAL = `SELECT content, created_at FROM turns
                    WHERE conversation_id = ? AND role = 'assistant'
                      AND content IS NOT NULL AND TRIM(content) <> ''
                    ORDER BY id DESC LIMIT 1`;

const SQL_TURNS = `SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?`;

const SQL_COMMITMENT = `SELECT due_at, status FROM watch_commitments
                         WHERE check_type = 'chat_report' AND check_ref = ?
                         ORDER BY id DESC LIMIT 1`;

/** report_back's summary, pulled out of the recorded tool_args JSON. */
function reportSummaryFrom(toolArgs: string | null): string | null {
  if (!toolArgs) return null;
  try {
    const parsed = JSON.parse(toolArgs) as Record<string, unknown>;
    const summary = str(parsed.summary).trim();
    return summary || null;
  } catch {
    return null;
  }
}

/** `datetime('now')`-style strings are UTC without a zone marker; make that explicit
 *  so Date parsing doesn't silently read them as local time. due_at is already ISO. */
function parseDbTime(value: string | null): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function stateOf(args: {
  running: boolean;
  reportedAt: string | null;
  dueAt: string | null;
  now: number;
}): SpawnState {
  if (args.running) return 'running';
  if (args.reportedAt) return 'reported';
  const due = parseDbTime(args.dueAt);
  if (due != null && args.now > due) return 'overdue';
  return 'quiet';
}

/**
 * The whole desk in one read. `originExt` defaults to Alpha's own chat but is a
 * parameter so the same page can supervise any orchestrator later.
 */
/** Is a turn in flight in this child right now? See the note at the top of the file. */
export type IsRunning = (conversationId: number) => boolean;

/** Fallback when no in-flight signal is available: nothing reads as running, so a
 *  child falls through to reported / overdue / quiet rather than claiming activity. */
const NEVER_RUNNING: IsRunning = () => false;

export function buildAlphaDesk(
  originExt: string = DEFAULT_ORIGIN_EXT,
  isRunning: IsRunning = NEVER_RUNNING,
): AlphaDeskPayload {
  const origin = getConversation(originExt);
  const { verdicts, error: verdictsError } = readVerdicts();
  const now = Date.now();
  const generatedAt = new Date().toISOString();

  if (!origin) {
    return {
      origin: { external_id: originExt, conversation_id: null, title: null },
      counts: { total: 0, open: 0, running: 0, reported_today: 0, overdue: 0 },
      rows: [],
      verdicts_path: VERDICTS_PATH,
      verdicts_error: verdictsError,
      generated_at: generatedAt,
    };
  }

  const briefStmt = sqliteDb.prepare(SQL_BRIEF);
  const reportStmt = sqliteDb.prepare(SQL_REPORT);
  const finalStmt = sqliteDb.prepare(SQL_FINAL);
  const turnsStmt = sqliteDb.prepare(SQL_TURNS);
  const commitmentStmt = sqliteDb.prepare(SQL_COMMITMENT);

  const rows: AlphaDeskRow[] = selectSpawns(origin.id).map((s) => {
    const brief = briefStmt.get(s.child_conversation_id) as { content: string | null } | undefined;
    const report = reportStmt.get(s.child_conversation_id) as
      | { tool_args: string | null; created_at: string }
      | undefined;
    const final = finalStmt.get(s.child_conversation_id) as
      | { content: string | null; created_at: string }
      | undefined;
    const turns = turnsStmt.get(s.child_conversation_id) as { n: number };
    const commitment = commitmentStmt.get(s.external_id) as
      | { due_at: string; status: string }
      | undefined;

    const running = isRunning(s.child_conversation_id);
    // reported_at is stamped by report_back; fall back to the marker turn itself so a
    // report that landed before the stamp existed still reads as reported.
    const reportedAt = s.reported_at ?? report?.created_at ?? null;

    return {
      spawn_id: s.spawn_id,
      external_id: s.external_id,
      conversation_id: s.child_conversation_id,
      title: s.title ?? null,
      spawned_at: s.created_at,
      reported_at: reportedAt,
      state: stateOf({ running, reportedAt, dueAt: commitment?.due_at ?? null, now }),
      running,
      due_at: commitment?.due_at ?? null,
      commitment_status: commitment?.status ?? null,
      brief: brief?.content ?? null,
      report_summary: reportSummaryFrom(report?.tool_args ?? null),
      report_at: report?.created_at ?? null,
      final_reply: final?.content ?? null,
      final_reply_at: final?.created_at ?? null,
      turn_count: turns?.n ?? 0,
      verdict: verdicts[s.external_id] ?? PENDING,
    };
  });

  const todayUtc = new Date().toISOString().slice(0, 10);
  const counts = {
    total: rows.length,
    open: rows.filter((r) => r.state !== 'reported').length,
    running: rows.filter((r) => r.state === 'running').length,
    reported_today: rows.filter((r) => {
      const ms = parseDbTime(r.reported_at);
      return ms != null && new Date(ms).toISOString().slice(0, 10) === todayUtc;
    }).length,
    overdue: rows.filter((r) => r.state === 'overdue').length,
  };

  return {
    origin: { external_id: originExt, conversation_id: origin.id, title: origin.title ?? null },
    counts,
    rows,
    verdicts_path: VERDICTS_PATH,
    verdicts_error: verdictsError,
    generated_at: generatedAt,
  };
}
