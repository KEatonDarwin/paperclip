import { addTurn, getConversation, sqliteDb } from './conversation-db.js';
import { sseBus, type CrossChatSidecarEvent } from './sse-bus.js';

// CROSS-CHAT SIDECAR — node #1430, wish-catalog pilot (tree-3e526df9). A
// relayed idea (bridge_send, tools/companion-bridge.ts) landing in a bridged
// partner thread's history as a distinct card, not a conversational turn —
// same treatment as thread-reminders.ts's 'bump' role: rendered specially by
// the cockpit, excluded from countMessages (which only counts user/assistant),
// and never fed back into the model as part of the transcript.

export const CROSS_CHAT_SIDECAR_ROLE = 'cross_chat_sidecar';

export interface CrossChatSidecarPayload {
  from_thread_ext: string;
  to_thread_ext: string;
  from_label: string;
  summary: string;
  origin_turn_ref: number | null;
}

/**
 * Collapse an arbitrary "idea" string into a short digest — never the raw
 * input verbatim. Deterministic (no model call): collapses whitespace/
 * newlines to single spaces and hard-truncates with an ellipsis. bridge_send
 * is a single tool-call argument, not a transcript dump, so a cheap
 * heuristic is the right weight here — generateThreadSummary's model-backed
 * summarizer (thread-summarize.ts) is for whole-conversation digests, not this.
 */
export function summarizeForSidecar(raw: string, maxLen = 240): string {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1).trimEnd()}…`;
}

/**
 * Insert a cross_chat_sidecar card into the RECIPIENT thread (payload.to_thread_ext)
 * and emit the dedicated SSE event alongside the generic `turn` event addTurn
 * already fires. Returns null if the recipient thread has no conversations
 * row (nothing to insert into) rather than throwing — bridge_send surfaces
 * that as part of its own result, not an exception.
 */
export function insertCrossChatSidecar(payload: CrossChatSidecarPayload): { turnIndex: number } | null {
  const toConv = getConversation(payload.to_thread_ext);
  if (!toConv) return null;

  const turnIndex = addTurn(
    toConv.id,
    CROSS_CHAT_SIDECAR_ROLE,
    payload.summary,
    undefined,
    JSON.stringify(payload),
  );
  sseBus.emit('sse', {
    type: 'cross_chat_sidecar',
    conversationId: toConv.id,
    sidecar: payload,
  } satisfies CrossChatSidecarEvent);

  return { turnIndex };
}

// Accept handler support (node #1447, tree-02951798). The sidecar row is just
// a `turns` row (role = CROSS_CHAT_SIDECAR_ROLE, tool_args = the JSON
// payload) — these three columns record Kevin's accept decision on it so the
// UI can later grey the card out, same ALTER-TABLE-ADD-COLUMN-in-a-try pattern
// conversation-db.ts already uses for every other turns migration.
for (const col of [
  'sidecar_accepted_at TEXT',
  'sidecar_accept_target TEXT',
  'sidecar_accept_result_id TEXT',
]) {
  try { sqliteDb.exec(`ALTER TABLE turns ADD COLUMN ${col}`); } catch { /* already applied */ }
}

export interface SidecarTurnRow {
  id: number;
  conversation_id: number;
  role: string;
  content: string | null;
  tool_args: string | null;
  sidecar_accepted_at: string | null;
  sidecar_accept_target: string | null;
  sidecar_accept_result_id: string | null;
}

const getSidecarTurnStmt = sqliteDb.prepare(`
  SELECT id, conversation_id, role, content, tool_args,
         sidecar_accepted_at, sidecar_accept_target, sidecar_accept_result_id
  FROM turns WHERE id = ?
`);

/** Loads a turn by its global id, but only if it's actually a cross_chat_sidecar row. */
export function getSidecarTurnById(id: number): SidecarTurnRow | undefined {
  const row = getSidecarTurnStmt.get(id) as SidecarTurnRow | undefined;
  if (!row || row.role !== CROSS_CHAT_SIDECAR_ROLE) return undefined;
  return row;
}

const markSidecarAcceptedStmt = sqliteDb.prepare(`
  UPDATE turns SET sidecar_accepted_at = datetime('now'), sidecar_accept_target = ?, sidecar_accept_result_id = ?
  WHERE id = ?
`);

export function markSidecarAccepted(id: number, target: string, resultId: string | null): void {
  markSidecarAcceptedStmt.run(target, resultId, id);
}
