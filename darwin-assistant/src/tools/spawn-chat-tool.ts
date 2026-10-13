// SPAWN CHAT (overnight 2026-10-12, pick 4) — "spawn a new chat for Opus 5.0 on
// Claude B and give it everything it needs to start helping me".
//
// Two tools, registered in tools/index.ts ONLY when SPAWN_CHAT_ENABLED=1:
//
//   spawn_chat  — JARVIS writes a structured brief; this tool CHECKS it (pure
//                 checkBrief below), creates a fresh cockpit chat, pins its
//                 model + Claude account, queues the brief as the child's first
//                 message, records a chat_spawns row and (report_back=true) a
//                 `chat_report` watch_commitments row so the watchdog notices a
//                 child that never reports. Zero model calls of its own.
//   report_back — called FROM the child: posts `[report:<child ext>] <summary>`
//                 into the origin thread (the tree-cue seam) and stamps
//                 reported_at. The watchdog's chat_report check is satisfied by
//                 exactly that marker turn on the origin.
//
// agent.js + thread-message-queue.js are imported DYNAMICALLY, same as
// tree-cue.ts: agent.ts statically imports tools/index.ts, so a static import
// here would be a cycle, and the scratch-DB check intercepts just this module's
// `import('../agent.js')` with a scoped ESM hook — the dispatch is asserted on,
// never actually run.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { ToolDef } from './index.js';
import {
  sqliteDb,
  getConversation,
  getConversationById,
  getOrCreateConversation,
  renameConversation,
  setThreadModelOverride,
  setThreadClaudeAccount,
} from '../conversation-db.js';
import { findClaudeAccount, listClaudeAccounts } from '../claude-accounts.js';

// ─── Schema ──────────────────────────────────────────────────────────────────

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS chat_spawns (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    child_conversation_id  INTEGER NOT NULL REFERENCES conversations(id),
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    reported_at            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chat_spawns_origin ON chat_spawns(origin_conversation_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_spawns_child ON chat_spawns(child_conversation_id);
`);

// The watchdog (scripts/jarvis-watchdog.py ensure_schema) owns this table; it
// already exists on the live DB. Mirrored verbatim so a fresh/scratch DB can
// take the commitment row instead of silently dropping it.
sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS watch_commitments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    thread_ext TEXT,
    check_type TEXT NOT NULL DEFAULT 'manual',
    check_ref TEXT,
    due_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    recovery_attempts INTEGER NOT NULL DEFAULT 0,
    last_checked TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    notes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_watch_commitments_status
    ON watch_commitments(status, due_at);
`);

export interface ChatSpawnRow {
  id: number;
  origin_conversation_id: number;
  child_conversation_id: number;
  created_at: string;
  reported_at: string | null;
}

const insertSpawnStmt = sqliteDb.prepare<[number, number]>(
  `INSERT INTO chat_spawns (origin_conversation_id, child_conversation_id) VALUES (?, ?)`,
);
const countRecentStmt = sqliteDb.prepare<[number], { n: number }>(
  `SELECT COUNT(*) AS n FROM chat_spawns
   WHERE origin_conversation_id = ? AND created_at > datetime('now', '-1 hour')`,
);
const spawnByChildStmt = sqliteDb.prepare<[number], ChatSpawnRow>(
  `SELECT * FROM chat_spawns WHERE child_conversation_id = ?`,
);
const markReportedStmt = sqliteDb.prepare<[number]>(
  `UPDATE chat_spawns SET reported_at = datetime('now') WHERE id = ?`,
);
const insertCommitmentStmt = sqliteDb.prepare<[string, string, string, string]>(
  `INSERT INTO watch_commitments (subject, thread_ext, check_type, check_ref, due_at, status)
   VALUES (?, ?, 'chat_report', ?, ?, 'open')`,
);

export const SPAWN_LIMIT_PER_HOUR = 5;
export const BRIEF_MAX_CHARS = 12_000;
const DEFAULT_REPORT_DUE_HOURS = 4;

// ─── Brief checker (pure) ────────────────────────────────────────────────────

export interface SpawnBrief {
  goal: string;
  context: string;
  constraints: string;
  done_means: string;
}

export interface BriefCheckOptions {
  /** Injected for purity/testing; defaults to fs.existsSync. */
  pathExists?: (p: string) => boolean;
}

export interface BriefCheckResult {
  ok: boolean;
  errors: string[];
}

const SECRET_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'sk-', re: /\bsk-[A-Za-z0-9_-]{6,}/ },
  { kind: 'ghp_', re: /\bghp_[A-Za-z0-9]{6,}/ },
  { kind: 'xox', re: /\bxox[abposr]-[A-Za-z0-9-]+/ },
  { kind: 'AKIA', re: /\bAKIA[0-9A-Z]{12,}/ },
  { kind: 'pem', re: /-----BEGIN [A-Z0-9 ]+-----/ },
];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Absolute filesystem paths named in the text. A candidate counts only when its
 * first segment is a real top-level directory (`/home/…`, `/tmp/…`, `/etc/…`) —
 * so an API route like `/api/v1/threads` or a URL path is not mistaken for a
 * file. Starts at line start or after whitespace/quote/bracket, so the path
 * inside `https://host/x` (preceded by ':' or a host) is never picked up.
 */
export function extractAbsolutePaths(text: string, pathExists: (p: string) => boolean = fs.existsSync): string[] {
  const out = new Set<string>();
  const re = /(?:^|[\s`'"(\[<=])(\/[A-Za-z0-9._~@+\-/]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1].replace(/[.,:;)\]>'"`]+$/, '').replace(/\/+$/, '') || '/';
    const top = p.split('/')[1];
    if (!top) continue;
    if (!pathExists(`/${top}`)) continue;
    out.add(p);
  }
  return [...out];
}

/** Compose the child's first message. The 12k cap is measured on THIS text. */
export function composeBriefMessage(
  title: string,
  brief: SpawnBrief,
  meta?: { originExt?: string; reportBack?: boolean },
): string {
  const lines = [
    `🧭 Spawned chat: ${title}`,
    meta?.originExt ? `Opened by JARVIS from ${meta.originExt}.` : null,
    '',
    '## Goal',
    brief.goal.trim(),
    '',
    '## Context',
    brief.context.trim() || '(none given)',
    '',
    '## Constraints',
    brief.constraints.trim() || '(none given)',
    '',
    '## Done means',
    brief.done_means.trim(),
  ];
  if (meta?.reportBack) {
    lines.push(
      '',
      '## When you are done',
      'Call the `report_back` tool with a short plain-language summary (what you did, where it is, anything Kevin must decide). That posts it back to the chat that opened you.',
    );
  }
  return lines.filter((l) => l !== null).join('\n');
}

/**
 * Pure brief check. Named errors:
 *   missing_goal · missing_done_means · path_not_found:<path> ·
 *   secret_detected:<kind> · brief_too_long:<chars>
 */
export function checkBrief(
  rawBrief: unknown,
  opts: BriefCheckOptions & { title?: string } = {},
): BriefCheckResult {
  const pathExists = opts.pathExists ?? fs.existsSync;
  const b = (rawBrief && typeof rawBrief === 'object' ? rawBrief : {}) as Record<string, unknown>;
  const brief: SpawnBrief = {
    goal: str(b.goal),
    context: str(b.context),
    constraints: str(b.constraints),
    done_means: str(b.done_means),
  };
  const errors: string[] = [];

  if (!brief.goal.trim()) errors.push('missing_goal');
  if (!brief.done_means.trim()) errors.push('missing_done_means');

  const allText = [opts.title ?? '', brief.goal, brief.context, brief.constraints, brief.done_means].join('\n');

  for (const p of extractAbsolutePaths(allText, pathExists)) {
    if (!pathExists(p)) errors.push(`path_not_found:${p}`);
  }
  for (const { kind, re } of SECRET_PATTERNS) {
    if (re.test(allText)) errors.push(`secret_detected:${kind}`);
  }
  const composed = composeBriefMessage(opts.title ?? '', brief, { reportBack: true });
  if (composed.length > BRIEF_MAX_CHARS) errors.push(`brief_too_long:${composed.length}`);

  return { ok: errors.length === 0, errors };
}

// ─── Model / account resolution ──────────────────────────────────────────────

type AdapterShelf = Record<string, { id: string; models: Array<{ id: string }> }>;

/** 'opus-5' → claude/claude-opus-5; a full id on any adapter's shelf → that adapter. */
function resolveModel(adapters: AdapterShelf, raw: string): { adapter: string; model: string } | null {
  const want = raw.trim();
  const candidates = want.startsWith('claude-') ? [want] : [want, `claude-${want}`];
  for (const c of candidates) {
    for (const a of Object.values(adapters)) {
      if (a.models.some((m) => m.id === c)) return { adapter: a.id, model: c };
    }
  }
  return null;
}

// ─── In-process post (the tree-cue seam) ─────────────────────────────────────

type AgentMod = {
  getInFlightMessageId: (convId: number) => string | undefined;
  processMessage: (text: string, externalId: string, messageId?: string) => Promise<string>;
  ConversationBusyError: new (...a: never[]) => Error;
  getAdapters: () => AdapterShelf;
};
type QueueMod = typeof import('../thread-message-queue.js');

async function loadDispatch(): Promise<{ agent: AgentMod; queue: QueueMod }> {
  const [agent, queue] = await Promise.all([import('../agent.js'), import('../thread-message-queue.js')]);
  return { agent: agent as unknown as AgentMod, queue };
}

/** Post text into a thread as a real JARVIS turn: queue it if a turn is in
 *  flight, else run it now; a lost race re-queues instead of dropping it. */
function postToThread(agent: AgentMod, queue: QueueMod, convId: number, ext: string, text: string, key: string): void {
  if (agent.getInFlightMessageId(convId)) {
    queue.enqueueMessage(convId, text);
    return;
  }
  agent.processMessage(text, ext, key).catch((err: unknown) => {
    if (err instanceof agent.ConversationBusyError) queue.enqueueMessage(convId, text);
    else console.error(`[spawn-chat] post to ${ext} failed`, err);
  });
}

// ─── spawn_chat ──────────────────────────────────────────────────────────────

export const spawnChat: ToolDef = {
  name: 'spawn_chat',
  description:
    "Open a NEW cockpit chat for a handoff ('spawn a chat for Opus 5.0 on Claude B and give it everything it needs'). You write the brief; the tool checks it (goal + done_means required, every absolute path must exist, no secrets, ≤12k chars) and refuses with named errors if it fails. On success it creates the chat, pins model + Claude account, queues the brief as its first message (the child starts working immediately), and — with report_back (default true) — registers a chat_report commitment so a child that never reports back is noticed. The child reports with the report_back tool. Limit 5 spawns per chat per hour. Returns the child's external_id and URL.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short chat title Kevin will see.' },
      model: { type: 'string', description: "Model id, e.g. 'claude-opus-5' or shorthand 'opus-5'. Omit to inherit the default." },
      account: { type: 'string', description: "Claude account key to pin ('a', 'b', …). Omit for Auto." },
      brief: {
        type: 'object',
        description: 'Everything the child needs to start cold.',
        properties: {
          goal: { type: 'string', description: 'What the child must achieve. Required.' },
          context: { type: 'string', description: 'Background, links, absolute paths, prior decisions.' },
          constraints: { type: 'string', description: 'Rules and limits (what not to touch, guardrails).' },
          done_means: { type: 'string', description: 'The concrete finish line. Required.' },
        },
        required: ['goal', 'done_means'],
      },
      report_back: { type: 'boolean', description: 'Register a chat_report commitment and ask the child to report back. Default true.' },
      report_due_hours: { type: 'number', description: 'Hours until the report is due (default 4).' },
    },
    required: ['title', 'brief'],
  },
  execute: async (args, context) => {
    const originId = context?.conversationId;
    const origin = originId ? getConversationById(originId) : undefined;
    if (!origin) return { error: 'no_origin_conversation', message: 'spawn_chat only works inside a conversation.' };

    const title = str(args.title).trim();
    if (!title) return { error: 'missing_title' };

    const check = checkBrief(args.brief, { title });
    if (!check.ok) return { error: 'brief_rejected', errors: check.errors };

    if ((countRecentStmt.get(origin.id)?.n ?? 0) >= SPAWN_LIMIT_PER_HOUR) {
      return { error: 'rate_limited', message: `max ${SPAWN_LIMIT_PER_HOUR} spawns per chat per hour` };
    }

    const { agent, queue } = await loadDispatch();

    // Validate model + account BEFORE writing anything.
    let pin: { adapter: string; model: string } | null = null;
    const rawModel = str(args.model).trim();
    if (rawModel) {
      pin = resolveModel(agent.getAdapters(), rawModel);
      if (!pin) return { error: 'unknown_model', message: `model ${rawModel} is not on any adapter's shelf` };
    }
    const account = str(args.account).trim() || null;
    if (account) {
      if (!findClaudeAccount(account)) {
        return { error: 'unknown_account', message: `account must be one of ${listClaudeAccounts().map((a) => a.key).join(', ')}` };
      }
      if (pin && pin.adapter !== 'claude') {
        return { error: 'account_needs_claude', message: 'an account pin only applies to a claude model' };
      }
    }

    const b = args.brief as Record<string, unknown>;
    const brief: SpawnBrief = {
      goal: str(b.goal),
      context: str(b.context),
      constraints: str(b.constraints),
      done_means: str(b.done_means),
    };
    const reportBack = args.report_back !== false;
    const dueHoursRaw = Number(args.report_due_hours);
    const dueHours = Number.isFinite(dueHoursRaw) && dueHoursRaw > 0 ? dueHoursRaw : DEFAULT_REPORT_DUE_HOURS;
    const text = composeBriefMessage(title, brief, { originExt: origin.external_id, reportBack });

    // Create the chat the createPageChat way (page-companion.ts).
    const childExt = `cockpit:spawn-${randomUUID()}`;
    const child = getOrCreateConversation(childExt);
    let spawnId = 0;
    sqliteDb.transaction(() => {
      renameConversation(child.id, title.slice(0, 120));
      if (pin) setThreadModelOverride(child.id, pin.adapter, pin.model);
      if (account) setThreadClaudeAccount(child.id, account);
      spawnId = Number(insertSpawnStmt.run(origin.id, child.id).lastInsertRowid);
      if (reportBack) {
        const due = new Date(Date.now() + dueHours * 3600_000).toISOString();
        insertCommitmentStmt.run(`Spawned chat reports back: ${title}`.slice(0, 200), origin.external_id, childExt, due);
      }
    })();

    // Brief = the child's first message, through the server-owned queue, then
    // drained immediately the way installQueueDrain does (nothing is running on
    // a brand-new chat, so nothing else would ever drain it).
    queue.enqueueMessage(child.id, text);
    if (!agent.getInFlightMessageId(child.id)) {
      const next = queue.shiftQueuedMessage(child.id);
      if (next) {
        agent.processMessage(next.content, childExt, `spawn-chat:${spawnId}`).catch((err: unknown) => {
          if (err instanceof agent.ConversationBusyError) queue.enqueueMessage(child.id, next.content, next.images);
          else console.error(`[spawn-chat] brief dispatch to ${childExt} failed`, err);
        });
      }
    }

    return {
      ok: true,
      external_id: childExt,
      url: `/threads?open=${encodeURIComponent(childExt)}`,
      spawn_id: spawnId,
      model: pin?.model ?? null,
      account,
      report_back: reportBack,
    };
  },
};

// ─── report_back ─────────────────────────────────────────────────────────────

export const reportBack: ToolDef = {
  name: 'report_back',
  description:
    "Only inside a chat that was opened with spawn_chat: post your result back to the chat that spawned you. Posts `[report:<this chat>] <summary>` into the origin thread (which wakes JARVIS there) and marks the spawn reported. Keep the summary short and plain: what you did, where it is, what Kevin must decide.",
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Plain-language result summary.' },
    },
    required: ['summary'],
  },
  execute: async (args, context) => {
    const childId = context?.conversationId;
    const child = childId ? getConversationById(childId) : undefined;
    if (!child) return { error: 'no_conversation' };
    const spawn = spawnByChildStmt.get(child.id);
    if (!spawn) return { error: 'not_a_spawned_chat', message: 'report_back only works in a chat opened by spawn_chat.' };
    const summary = str(args.summary).trim();
    if (!summary) return { error: 'missing_summary' };
    const origin = getConversationById(spawn.origin_conversation_id);
    // A closed origin is renamed `<ext>:closed:<ts>`; post to the live thread only.
    if (!origin || origin.status !== 'active' || !getConversation(origin.external_id)) {
      return { error: 'origin_gone', message: 'the chat that spawned this one is closed' };
    }

    const text = `[report:${child.external_id}] ${summary}`;
    const { agent, queue } = await loadDispatch();
    postToThread(agent, queue, origin.id, origin.external_id, text, `spawn-report:${spawn.id}`);
    markReportedStmt.run(spawn.id);
    return { ok: true, origin_external_id: origin.external_id };
  },
};

export const SPAWN_CHAT_TOOLS: ToolDef[] = [spawnChat, reportBack];
