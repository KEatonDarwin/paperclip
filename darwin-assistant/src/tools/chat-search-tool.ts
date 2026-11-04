import type { ToolDef } from './index.js';
import {
  sqliteDb,
  getConversation,
  getConversationById,
  getConversationsByIds,
  getTurnsLean,
  type ConversationRow,
} from '../conversation-db.js';
import { getLatestThreadSummary } from '../thread-summaries.js';
import { catchUp as ftsCatchUp, searchCandidates, lastUserTurnAt } from '../thread-fts.js';
import { fullOnly } from '../reply-brevity.js';

// find_chats + read_chat (lean/harness-gaps, 2026-10-17). Until now JARVIS could
// only reach another chat by shelling into jarvis.db with sqlite (works only
// because CLI permissions are off) — Kevin's Find Any Chat index was wired to the
// cockpit search box alone. These two tools put that same index, and a capped
// transcript reader, in the model's hands. Read-only. Password-locked chats give
// up their title and nothing else, exactly like the cockpit search route.

const READ_DEFAULT_CHARS = 12000;
const READ_MAX_CHARS = 24000;
const TURN_MAX_CHARS = 4000;

const WORKER_PREFIXES = ['cockpit:hopper-node-', 'cockpit:unblocker-'];
// Private lanes (the job-search desk): never in the unprompted "recent chats" list — Kevin
// screen-shares — but still found when a search names them.
const PRIVATE_PREFIXES = ['cockpit:pp-'];

export function chatLink(externalId: string): string {
  return `/threads?open=${encodeURIComponent(externalId)}`;
}

function hidden(c: ConversationRow, includeWorkers: boolean): boolean {
  if (c.external_id.startsWith('ephemeral:') || c.external_id.startsWith('checkin:')) return true;
  if (!includeWorkers && WORKER_PREFIXES.some((p) => c.external_id.startsWith(p))) return true;
  return false;
}

function firstUserLine(conversationId: number): string | null {
  const row = sqliteDb
    .prepare<[number], { content: string | null }>(
      `SELECT content FROM turns WHERE conversation_id = ? AND role = 'user' ORDER BY turn_index LIMIT 1`,
    )
    .get(conversationId);
  const s = (row?.content ?? '').replace(/\s+/g, ' ').trim();
  return s ? (s.length > 80 ? `${s.slice(0, 77)}...` : s) : null;
}

export function chatTitle(c: ConversationRow): string {
  return c.title || c.headline || (c.password_hash ? null : firstUserLine(c.id)) || c.external_id;
}

/** Accepts an external_id, a bare cockpit uuid, a numeric conversation id, or a
 *  pasted `/threads?open=…` link. */
export function resolveChat(ref: string): ConversationRow | undefined {
  let s = ref.trim();
  const m = s.match(/[?&]open=([^&#\s]+)/);
  if (m) s = decodeURIComponent(m[1]);
  const direct = getConversation(s);
  if (direct) return direct;
  if (/^\d+$/.test(s)) return getConversationById(Number(s));
  if (!s.includes(':')) return getConversation(`cockpit:${s}`);
  return undefined;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)} …[+${text.length - max} chars]` : text;
}

export const findChats: ToolDef = {
  name: 'find_chats',
  description:
    "Find other chats (cockpit/Slack/watch threads) by what was said in them — full-text over every turn, title and summary, best match first. Omit query to list the most recently used chats. Returns thread_id, title, a clickable link, last time Kevin wrote there, a matching snippet and the summary. Follow up with read_chat to read one.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to match (any order; rarer words rank higher). Omit for recent chats.' },
      limit: { type: 'number', description: 'Max chats to return (default 8, max 25).' },
      after: { type: 'string', description: "Only chats Kevin last wrote in after this date (YYYY-MM-DD or ISO)." },
      before: { type: 'string', description: "Only chats Kevin last wrote in before this date." },
      include_workers: { type: 'boolean', description: 'Also include ephemeral hopper/unblocker worker threads (default false).' },
    },
  },
  execute: async (args, context) => {
    const limit = Math.max(1, Math.min(25, Number(args.limit) || 8));
    const includeWorkers = args.include_workers === true;
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const before = typeof args.before === 'string' && args.before.trim() ? args.before.trim() : null;
    const after = typeof args.after === 'string' && args.after.trim() ? args.after.trim() : null;
    const self = context?.conversationId ?? null;

    let rows: { conv: ConversationRow; snippet: string | null; lastUserAt: string | null }[] = [];
    if (query) {
      ftsCatchUp();
      // Over-fetch: hidden/self rows are dropped after the scan.
      const hits = searchCandidates(query, { limit: limit * 3 + 5, before, after });
      const convs = new Map(getConversationsByIds(hits.map((h) => h.conversationId)).map((c) => [c.id, c]));
      for (const h of hits) {
        const conv = convs.get(h.conversationId);
        if (!conv || conv.id === self || hidden(conv, includeWorkers)) continue;
        rows.push({ conv, snippet: h.snippet, lastUserAt: h.lastUserAt });
      }
    } else {
      const recent = sqliteDb
        .prepare<[number], ConversationRow>(`SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?`)
        .all(400);
      for (const conv of recent) {
        if (conv.id === self || hidden(conv, includeWorkers)) continue;
        if (PRIVATE_PREFIXES.some((p) => conv.external_id.startsWith(p))) continue;
        const lastUserAt = lastUserTurnAt(conv.id);
        if (!lastUserAt) continue;
        if (before && !(lastUserAt < before)) continue;
        if (after && !(lastUserAt > after)) continue;
        rows.push({ conv, snippet: null, lastUserAt });
      }
      rows.sort((a, b) => (b.lastUserAt ?? '').localeCompare(a.lastUserAt ?? ''));
    }
    rows = rows.slice(0, limit);

    return {
      query: query || null,
      count: rows.length,
      chats: rows.map(({ conv, snippet, lastUserAt }) => {
        const locked = !!conv.password_hash;
        const summary = locked ? null : getLatestThreadSummary(conv.id)?.content ?? null;
        return {
          thread_id: conv.external_id,
          title: chatTitle(conv),
          link: chatLink(conv.external_id),
          status: conv.status,
          last_kevin_message_at: lastUserAt,
          ...(locked ? { locked: true } : {}),
          snippet: locked ? null : snippet,
          summary: summary ? clip(summary.replace(/\s+/g, ' ').trim(), 300) : null,
        };
      }),
      ...(rows.length === 0 && query ? { note: 'Nothing matched. Try fewer or different words, or omit query for recent chats.' } : {}),
    };
  },
};

export const readChat: ToolDef = {
  name: 'read_chat',
  description:
    "Read another chat by thread_id (or pasted /threads?open= link, or bare uuid). mode 'tail' (default) = its latest messages, 'head' = its first messages, 'summary' = cached summary only, 'full' = the whole transcript within max_chars. Optional `match` keeps only messages containing that text. Output is capped (default 12k chars, max 24k).",
  parameters: {
    type: 'object',
    properties: {
      thread_id: { type: 'string', description: 'external_id (e.g. cockpit:<uuid>), a bare uuid, or a /threads?open=… link.' },
      mode: { type: 'string', enum: ['tail', 'head', 'summary', 'full'], description: "Default 'tail'." },
      turns: { type: 'number', description: "Messages to return for tail/head (default 10)." },
      match: { type: 'string', description: 'Only messages containing this text (case-insensitive).' },
      max_chars: { type: 'number', description: `Output budget in characters (default ${READ_DEFAULT_CHARS}, max ${READ_MAX_CHARS}).` },
    },
    required: ['thread_id'],
  },
  execute: async (args) => {
    const ref = typeof args.thread_id === 'string' ? args.thread_id : '';
    if (!ref.trim()) return { error: 'thread_id is required' };
    const conv = resolveChat(ref);
    if (!conv) return { error: `No chat found for "${ref}". Use find_chats to look it up.` };

    const head = { thread_id: conv.external_id, title: chatTitle(conv), link: chatLink(conv.external_id) };
    if (conv.password_hash) {
      return { ...head, locked: true, note: 'This chat is password-locked. Its content is not readable by tools; ask Kevin.' };
    }

    const mode = ['head', 'summary', 'full'].includes(String(args.mode)) ? String(args.mode) : 'tail';
    const summaryRow = getLatestThreadSummary(conv.id);
    if (mode === 'summary') {
      return summaryRow
        ? { ...head, mode, summary: summaryRow.content, generated_at: summaryRow.created_at }
        : { ...head, mode, summary: null, note: "No summary yet — use mode 'tail' to read the latest messages." };
    }

    const budget = Math.max(1000, Math.min(READ_MAX_CHARS, Number(args.max_chars) || READ_DEFAULT_CHARS));
    const n = Math.max(1, Math.min(200, Number(args.turns) || 10));
    const needle = typeof args.match === 'string' && args.match.trim() ? args.match.trim().toLowerCase() : null;

    let msgs = getTurnsLean(conv.id)
      .filter((t) => (t.role === 'user' || t.role === 'assistant') && (t.content ?? '').trim())
      .map((t) => ({
        i: t.turn_index,
        role: t.role,
        at: t.created_at,
        // Another JARVIS reading this gets the full reply, never a brief it can't expand.
        content: t.role === 'assistant' ? fullOnly(t.content ?? '') : t.content ?? '',
      }));
    const total = msgs.length;
    if (needle) msgs = msgs.filter((m) => m.content.toLowerCase().includes(needle));
    const matched = msgs.length;
    if (mode === 'tail') msgs = msgs.slice(-n);
    if (mode === 'head') msgs = msgs.slice(0, n);

    // Fill the budget: from the newest backwards for tail/full, oldest forwards for head.
    const order = mode === 'head' ? msgs : [...msgs].reverse();
    const out: typeof msgs = [];
    let used = 0;
    let truncated = false;
    for (const m of order) {
      const content = clip(m.content, TURN_MAX_CHARS);
      if (used + content.length > budget && out.length > 0) { truncated = true; break; }
      out.push({ ...m, content });
      used += content.length;
    }
    if (mode !== 'head') out.reverse();
    if (out.length < msgs.length) truncated = true;

    return {
      ...head,
      mode,
      total_messages: total,
      ...(needle ? { matched_messages: matched } : {}),
      returned: out.length,
      truncated,
      summary: summaryRow && mode !== 'full' ? clip(summaryRow.content, 1500) : null,
      messages: out,
    };
  },
};
