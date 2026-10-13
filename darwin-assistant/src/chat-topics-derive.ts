import { spawn } from 'node:child_process';
import {
  getConversationById,
  getTurnsLean,
  listAllConversations,
  sqliteDb,
  type TurnRow,
} from './conversation-db.js';
import {
  isTopicEligible,
  upsertTopic,
  addConversationTopic,
  listTopics,
  listTopicsForConversation,
} from './chat-topics-store.js';

// tree-c9800208 node #1579 — living-topic derivation. Reads a conversation's
// recent turns, asks the subscription claude CLI (haiku) to either cluster
// onto an existing topic label or propose a new one, and writes the result
// through the add-only store built in node #1578 (chat-topics-store.ts).
//
// Same one-shot subscription-CLI spawn shape as thread-autogroup.ts's
// runClaudeClassifier and layman-summary.ts's runClaudeSummarizer — no API
// key, --print/--output-format stream-json/--verbose/--model. Deliberately
// NOT routed through layman-summary's sim-guarded helper: that guard refuses
// in ANY scratch DB, which would make the clustering/pivot logic untestable
// hermetically. Like thread-autogroup.ts, the guard lives at the call site
// that wires this into a live trigger (future work, per spec) — this module
// only spawns when actually invoked.

const DERIVE_MODEL = 'claude-haiku-4-5-20251001';
const DERIVE_TIMEOUT_MS = 45_000;
const MAX_TURNS = 12;
const MAX_TRANSCRIPT_CHARS = 6_000;
const MAX_EXISTING_LABELS = 50;
const RECENT_TURNS_TRIGGER = 6;

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS chat_topic_derive_marks (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id),
    turns_at_derive INTEGER NOT NULL,
    derived_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const countUserTurnsStmt = sqliteDb.prepare<[number], { cnt: number }>(
  `SELECT COUNT(*) as cnt FROM turns WHERE conversation_id = ? AND role = 'user'`,
);
const countVisibleTurnsStmt = sqliteDb.prepare<[number], { cnt: number }>(
  `SELECT COUNT(*) as cnt FROM turns WHERE conversation_id = ? AND role IN ('user','assistant')`,
);
const getMarkStmt = sqliteDb.prepare<[number], { turns_at_derive: number }>(
  `SELECT turns_at_derive FROM chat_topic_derive_marks WHERE conversation_id = ?`,
);
const setMarkStmt = sqliteDb.prepare<[number, number]>(
  `INSERT INTO chat_topic_derive_marks (conversation_id, turns_at_derive, derived_at)
   VALUES (?, ?, datetime('now'))
   ON CONFLICT(conversation_id) DO UPDATE SET turns_at_derive = excluded.turns_at_derive, derived_at = datetime('now')`,
);

function countUserTurns(conversationId: number): number {
  return countUserTurnsStmt.get(conversationId)?.cnt ?? 0;
}

function countVisibleTurns(conversationId: number): number {
  return countVisibleTurnsStmt.get(conversationId)?.cnt ?? 0;
}

function markDerived(conversationId: number): void {
  setMarkStmt.run(conversationId, countVisibleTurns(conversationId));
}

/**
 * True when `conversationId` is due for a (re)derive pass: no topics yet and
 * at least 2 user turns, or at least RECENT_TURNS_TRIGGER new user+assistant
 * turns since the last derive attempt (tracked via chat_topic_derive_marks,
 * not conversation_topics.assigned_at — a rederive that re-confirms the same
 * primary topic never touches assigned_at, so it can't double as the marker).
 */
export function shouldRederive(conversationId: number): boolean {
  const existing = listTopicsForConversation(conversationId);
  if (existing.length === 0) {
    return countUserTurns(conversationId) >= 2;
  }
  const mark = getMarkStmt.get(conversationId);
  if (!mark) return true;
  return countVisibleTurns(conversationId) - mark.turns_at_derive >= RECENT_TURNS_TRIGGER;
}

function renderTranscript(turns: TurnRow[]): string {
  const convo = turns.filter((t) => t.role === 'user' || t.role === 'assistant').slice(-MAX_TURNS);
  let out = convo
    .map((t) => `${t.role === 'user' ? 'User' : 'JARVIS'}: ${(t.content ?? '').trim()}`)
    .join('\n');
  if (out.length > MAX_TRANSCRIPT_CHARS) out = out.slice(-MAX_TRANSCRIPT_CHARS);
  return out.trim();
}

interface DeriveChoice {
  primary: string;
  secondary: string | null;
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

/** Parses the model's JSON reply. Returns null on ANY malformed/missing-field
 *  output — a derive pass that can't parse a confident answer drops it rather
 *  than guessing a topic. */
function parseChoice(raw: string): DeriveChoice | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const primary = parsed.primary;
    if (typeof primary !== 'string' || !primary.trim()) return null;
    const secondaryRaw = parsed.secondary;
    const secondary =
      typeof secondaryRaw === 'string' && secondaryRaw.trim() ? secondaryRaw.trim().slice(0, 80) : null;
    return { primary: primary.trim().slice(0, 80), secondary };
  } catch {
    return null;
  }
}

function buildPrompt(transcript: string, existingLabels: { id: number; label: string }[]): string {
  const labelLines = existingLabels.map((l) => `- id: ${l.id}; label: ${l.label}`).join('\n');
  return `You are labeling the subject of a chat thread so it can be grouped with other threads about the same thing.

Existing topic labels:
${labelLines || '(none yet)'}

Recent conversation:
"""
${transcript || '(no messages yet)'}
"""

Rules:
- If this conversation is clearly about the SAME subject as one of the existing labels, reuse that EXACT label text as "primary" and include its id in matched_existing_ids.
- Otherwise invent a new short Title-Case label, 2-4 words, naming the durable subject — not a generic verb like debug, fix, build, or question.
- If the conversation also clearly touches a second, distinct subject, name it as "secondary" (reusing an existing label if it matches); otherwise set secondary to null.
- Respond with ONLY compact JSON, no markdown, no prose.

Schema: {"primary": string, "secondary": string|null, "matched_existing_ids": number[]}`;
}

async function runClaudeTopicDeriver(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;

    const child = spawn(
      process.env.CLAUDE_CLI_PATH || 'claude',
      // --verbose is required alongside --print + stream-json (see thread-autogroup.ts).
      ['--print', '-', '--output-format', 'stream-json', '--verbose', '--model', DERIVE_MODEL],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`chat-topics-derive claude call timed out after ${DERIVE_TIMEOUT_MS}ms`));
    }, DERIVE_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`chat-topics-derive claude call exited ${code}: ${stderr.trim()}`));
        return;
      }

      let text = '';
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          const message = event.message as Record<string, unknown> | undefined;
          const content = message?.content;
          if (event.type === 'assistant' && Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              if (block.type === 'text' && typeof block.text === 'string') text += block.text;
            }
          }
          if (event.type === 'result' && typeof event.result === 'string') {
            text = event.result;
          }
        } catch {
          text += trimmed;
        }
      }
      resolve(text.trim());
    });

    // The child may exit before reading stdin — without a listener that
    // write's EPIPE is an unhandled 'error' event (see layman-summary.ts).
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

/**
 * Derives (or re-derives) topics for one conversation: skips ineligible
 * threads outright (no model call at all), otherwise reads recent turns,
 * asks the model to cluster-or-propose a label, and writes the result
 * through the add-only store. Malformed model output is dropped — never
 * guessed. Never throws: any failure is logged and the function returns.
 */
export async function deriveTopicsForConversation(conversationId: number): Promise<void> {
  const conv = getConversationById(conversationId);
  if (!conv) return;
  if (!isTopicEligible(conv.external_id)) return;

  const turns = getTurnsLean(conversationId);
  const transcript = renderTranscript(turns);
  const existingLabels = listTopics({ limit: MAX_EXISTING_LABELS }).map((t) => ({ id: t.id, label: t.label }));

  let raw: string;
  try {
    raw = await runClaudeTopicDeriver(buildPrompt(transcript, existingLabels));
  } catch (err) {
    console.error(`[chat-topics-derive] claude call failed for conversation ${conversationId}:`, err);
    return;
  }

  // Mark the attempt regardless of parse outcome below, so a run of
  // malformed output debounces against RECENT_TURNS_TRIGGER instead of
  // retrying on every subsequent call to shouldRederive.
  markDerived(conversationId);

  const choice = parseChoice(raw);
  if (!choice) {
    console.error(`[chat-topics-derive] dropped malformed model output for conversation ${conversationId}: ${raw.slice(0, 200)}`);
    return;
  }

  const primaryId = upsertTopic(choice.primary);
  addConversationTopic(conversationId, primaryId, { primary: true, source: 'auto' });

  if (choice.secondary) {
    const secondaryId = upsertTopic(choice.secondary);
    if (secondaryId !== primaryId) {
      addConversationTopic(conversationId, secondaryId, { primary: false, source: 'auto' });
    }
  }
}

/**
 * Batch entry for a future timer: processes up to `limit` eligible
 * conversations that are actually due per shouldRederive. Does NOT create
 * the systemd timer itself — that's wired in after review.
 */
export async function deriveStaleTopics(limit: number = 20): Promise<{ processed: number; conversationIds: number[] }> {
  const candidates = listAllConversations()
    .filter((c) => isTopicEligible(c.external_id))
    .filter((c) => shouldRederive(c.id))
    .slice(0, limit);

  for (const c of candidates) {
    await deriveTopicsForConversation(c.id);
  }
  return { processed: candidates.length, conversationIds: candidates.map((c) => c.id) };
}

/**
 * One-off seeding helper: topic-ifies the most-recently-active eligible
 * cockpit chats regardless of shouldRederive, so existing live threads get
 * a topic the first time this feature ships rather than waiting for their
 * next trigger.
 */
export async function backfillRecentCockpitChats(limit: number = 20): Promise<{ processed: number; conversationIds: number[] }> {
  const candidates = listAllConversations()
    .filter((c) => isTopicEligible(c.external_id))
    .slice(0, limit);

  for (const c of candidates) {
    await deriveTopicsForConversation(c.id);
  }
  return { processed: candidates.length, conversationIds: candidates.map((c) => c.id) };
}
