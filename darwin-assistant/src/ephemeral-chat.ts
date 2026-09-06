import { randomUUID } from 'node:crypto';
import { getAdapters, processMessage, isConversationActive } from './agent.js';
import {
  getConversation,
  getOrCreateConversation,
  setThreadModelOverride,
  getTurns,
  deleteConversation,
  countTurns,
  listAllConversations,
} from './conversation-db.js';

// ---------------------------------------------------------------------------
// Ephemeral chat = FULL JARVIS (same memory, same tools, same brain) running
// on a throwaway conversation that is never surfaced as a saved thread and is
// hard-deleted the moment it's closed. The ONLY difference from a normal chat
// is that nothing is meant to persist — it's for quick clarifying questions,
// one-off asks, etc. So it deliberately routes through the exact same
// `processMessage` path every real thread uses (tools included); it just lives
// under an `ephemeral:` external id that the thread list filters out, and it
// gets deleted on discard / swept if abandoned.
// ---------------------------------------------------------------------------

const PREFIX = 'ephemeral:';
const extId = (id: string) => `${PREFIX}${id}`;

export interface EphemeralChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

export interface EphemeralChatSession {
  id: string;
  adapter: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  error: string | null;
  messages: EphemeralChatMessage[];
  sessionId: string | null;
}

// Session metadata (picked model + creation time) that isn't worth a table —
// it lives only for the life of the process, which is exactly right for an
// ephemeral session. Messages/running/errors all come from the real
// conversation + its turns, so this holds only the display shell.
interface EphemeralMeta {
  adapter: string;
  model: string | null;
  createdAt: string;
}
const meta = new Map<string, EphemeralMeta>();

function nowIso(): string {
  return new Date().toISOString();
}

function validateRuntime(adapterId: string, model: string | null): { adapter: string; model: string | null } {
  const adapters = getAdapters();
  const adapter = adapters[adapterId];
  if (!adapter) {
    throw new Error(`adapter must be one of ${Object.keys(adapters).join(', ')}`);
  }
  if (model !== null && !adapter.models.some((candidate) => candidate.id === model)) {
    throw new Error(
      `model must be one of ${adapter.models.map((candidate) => candidate.id).join(', ')} for adapter ${adapter.id}`,
    );
  }
  return { adapter: adapter.id, model };
}

// Build the display snapshot the widget polls: metadata shell + real turns.
function snapshot(id: string): EphemeralChatSession | null {
  const m = meta.get(id);
  const conv = getConversation(extId(id));
  if (!m || !conv) return null;

  const turns = getTurns(conv.id).sort((a, b) => a.turn_index - b.turn_index);
  const messages: EphemeralChatMessage[] = turns
    .filter((t) => t.role === 'user' || t.role === 'assistant')
    .map((t) => ({
      id: `t${t.id}`,
      role: t.role as 'user' | 'assistant',
      text: (t.content ?? '').trim(),
      createdAt: t.created_at,
    }))
    // Drop empty assistant shells (mid-run / tool-only turns) — the widget shows
    // a "thinking" indicator from `running` instead. Always keep user turns.
    .filter((msg) => msg.role === 'user' || msg.text.length > 0);

  const lastError =
    [...turns].reverse().find((t) => t.error_detail)?.error_detail ?? null;

  return {
    id,
    adapter: m.adapter,
    model: m.model,
    createdAt: m.createdAt,
    updatedAt: conv.updated_at ?? m.createdAt,
    running: isConversationActive(conv.id),
    error: lastError,
    messages,
    sessionId: null,
  };
}

export function createEphemeralChatSession(input?: {
  adapter?: string;
  model?: string | null;
}): EphemeralChatSession {
  const adapters = getAdapters();
  const adapterInput = typeof input?.adapter === 'string' ? input.adapter : Object.keys(adapters)[0] ?? 'claude';
  const modelInput = input?.model === undefined ? null : input.model;
  const runtime = validateRuntime(adapterInput, modelInput);

  const id = randomUUID();
  const conv = getOrCreateConversation(extId(id));
  // Pin the picked provider/model for the life of this ephemeral session,
  // exactly like a per-thread override (DAR-680) — processMessage honors it.
  setThreadModelOverride(conv.id, runtime.adapter, runtime.model);

  meta.set(id, { adapter: runtime.adapter, model: runtime.model, createdAt: nowIso() });
  return snapshot(id)!;
}

export function getEphemeralChatSession(id: string): EphemeralChatSession | null {
  return snapshot(id);
}

export function sendEphemeralChatMessage(id: string, text: string): EphemeralChatSession {
  const content = text.trim();
  if (!content) throw new Error('text is required');

  const m = meta.get(id);
  const conv = getConversation(extId(id));
  if (!m || !conv) throw new Error('session not found');
  if (isConversationActive(conv.id)) throw new Error('session already running');

  const messageId = `turn:${conv.id}:${countTurns(conv.id)}`;
  // FULL JARVIS turn: same code path as a real thread, so memory is injected
  // and every tool is live. Fire-and-forget; the widget polls GET for the
  // reply. Any failure lands on the turn's error_detail, surfaced on next GET.
  void processMessage(content, extId(id), messageId).catch(() => {
    /* surfaced via turn error_detail */
  });

  return snapshot(id)!;
}

export function deleteEphemeralChatSession(id: string): boolean {
  const conv = getConversation(extId(id));
  meta.delete(id);
  if (!conv) return false;
  // Hard delete — nothing about an ephemeral chat is meant to survive.
  deleteConversation(conv.id);
  return true;
}

// Belt-and-suspenders cleanup for sessions the user closed without discarding
// (browser closed, tab abandoned). Runs off the thread-list load, same as the
// quick-chat expiry sweep. Never touches a session with a live run.
export function sweepStaleEphemeralConversations(maxAgeMs = 6 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const c of listAllConversations()) {
    if (!c.external_id.startsWith(PREFIX)) continue;
    if (isConversationActive(c.id)) continue;
    const stamp = Date.parse(c.updated_at ?? c.created_at ?? '');
    if (Number.isFinite(stamp) && stamp < cutoff) {
      meta.delete(c.external_id.slice(PREFIX.length));
      deleteConversation(c.id);
      removed++;
    }
  }
  return removed;
}
