// RELAY CUE (tree-3b42c6e2, node #919)
//
// Turns a newly-mirrored inbound message from `mike` into EXACTLY ONE governed
// JARVIS turn in `cockpit:relay-mike`, subject to:
//   - eligibility (mike only, never jarvis/kevin, never an ack/read-receipt)
//   - 24h content-hash dedupe
//   - server-side caps (exchanges/thread, messages/hour, messages/day) that
//     auto-pause the THREAD on breach
//   - the relay_enabled kill switch
//
// Registers itself on src/relay.ts's `registerRelayInboundListener` seam — the
// same shape src/tree-cue.ts uses for hopper-engine's
// registerTreeStatusListener, and the cue POST itself is the exact same seam
// tree-cue.ts / goals.ts `postCue` use (getInFlightMessageId → enqueueMessage,
// else processMessage, catch ConversationBusyError → enqueue). agent.js /
// thread-message-queue.js are DYNAMIC imports so there is no import cycle and
// a scratch-DB test can intercept them — same rationale as tree-cue.ts.
//
// CRASH SAFETY: the eligibility/dedupe/caps decision AND the cue_fired_at
// stamp happen inside ONE sqlite transaction (decideCueTxn below). Only after
// that transaction commits do we kick off the async cue POST. So the worst a
// crash between "stamped" and "posted" can do is swallow a cue — it can never
// double-fire one, because a retried poll's upsertMessage is itself idempotent
// (ON CONFLICT(message_id) DO NOTHING → returns null → this listener never
// runs a second time for that row).

import { sqliteDb, getSetting, getConversation, getOrCreateConversation, renameConversation } from './conversation-db.js';
import {
  registerRelayInboundListener,
  ensureSettingDefault,
  isRelayEnabled,
  type RelayMessageRow,
  type RelayThreadRow,
} from './relay.js';

// -- settings-KV caps (item 3) — read from settings, never hard-coded -------

const CAP_EXCHANGES_PER_THREAD_KEY = 'relay_cap_exchanges_per_thread';
const CAP_MESSAGES_PER_HOUR_KEY = 'relay_cap_messages_per_hour';
const CAP_MESSAGES_PER_DAY_KEY = 'relay_cap_messages_per_day';

const DEFAULT_CAP_EXCHANGES_PER_THREAD = '8';
const DEFAULT_CAP_MESSAGES_PER_HOUR = '12';
const DEFAULT_CAP_MESSAGES_PER_DAY = '40';

ensureSettingDefault(CAP_EXCHANGES_PER_THREAD_KEY, DEFAULT_CAP_EXCHANGES_PER_THREAD);
ensureSettingDefault(CAP_MESSAGES_PER_HOUR_KEY, DEFAULT_CAP_MESSAGES_PER_HOUR);
ensureSettingDefault(CAP_MESSAGES_PER_DAY_KEY, DEFAULT_CAP_MESSAGES_PER_DAY);

function numSetting(key: string, fallback: number): number {
  const raw = Number(getSetting(key));
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : fallback;
}

function capExchangesPerThread(): number {
  return numSetting(CAP_EXCHANGES_PER_THREAD_KEY, Number(DEFAULT_CAP_EXCHANGES_PER_THREAD));
}
function capMessagesPerHour(): number {
  return numSetting(CAP_MESSAGES_PER_HOUR_KEY, Number(DEFAULT_CAP_MESSAGES_PER_HOUR));
}
function capMessagesPerDay(): number {
  return numSetting(CAP_MESSAGES_PER_DAY_KEY, Number(DEFAULT_CAP_MESSAGES_PER_DAY));
}

// -- additive columns (self-contained, same PRAGMA-checked pattern as
//    tree-cue.ts's `last_cue_status` on hopper_trees) ------------------------

function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  try {
    sqliteDb.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch {
    /* column already exists — raced with another loader */
  }
}

addColumnIfMissing('relay_messages', 'cue_skip_reason', 'cue_skip_reason TEXT');
addColumnIfMissing('relay_threads', 'pause_reason', 'pause_reason TEXT');

// -- queries -----------------------------------------------------------------

const getThreadStmt = sqliteDb.prepare<[string], RelayThreadRow>(
  `SELECT * FROM relay_threads WHERE id = ?`,
);
const getMessageStmt = sqliteDb.prepare<[number], RelayMessageRow>(
  `SELECT * FROM relay_messages WHERE id = ?`,
);
const countThreadMessagesStmt = sqliteDb.prepare<[string], { n: number }>(
  `SELECT COUNT(*) AS n FROM relay_messages WHERE thread_id = ?`,
);
const countMessagesSinceStmt = sqliteDb.prepare<[string], { n: number }>(
  `SELECT COUNT(*) AS n FROM relay_messages WHERE mirrored_at >= datetime('now', ?)`,
);
// Excludes the message's own row; window is our LOCAL mirrored_at clock (not
// the remote created_at) so the dedupe window can't be gamed by clock skew.
const countDuplicateContentStmt = sqliteDb.prepare<[string, number], { n: number }>(
  `SELECT COUNT(*) AS n FROM relay_messages
   WHERE content_hash = ? AND id != ? AND mirrored_at >= datetime('now', '-24 hours')`,
);

const stampCueFiredStmt = sqliteDb.prepare<[number]>(
  `UPDATE relay_messages SET cue_fired_at = datetime('now') WHERE id = ?`,
);
const stampSkipReasonStmt = sqliteDb.prepare<[string, number]>(
  `UPDATE relay_messages SET cue_skip_reason = ? WHERE id = ?`,
);
const pauseThreadStmt = sqliteDb.prepare<[string, string]>(
  `UPDATE relay_threads SET status = 'paused', pause_reason = ?, updated_at = datetime('now') WHERE id = ?`,
);

// -- the decision, atomically with the stamp (crash safety above) -----------

export type RelayCueSkipReason =
  | 'relay_disabled'
  | 'not_mike'
  | 'ack'
  | 'thread_paused'
  | 'duplicate_24h'
  | 'cap_thread_exchanges'
  | 'cap_messages_per_hour'
  | 'cap_messages_per_day';

export type RelayCueDecision = { fire: true } | { fire: false; reason: RelayCueSkipReason };

function decideCue(message: RelayMessageRow): RelayCueDecision {
  if (!isRelayEnabled()) return { fire: false, reason: 'relay_disabled' };
  if (message.author !== 'mike') return { fire: false, reason: 'not_mike' };
  if (message.kind === 'ack') return { fire: false, reason: 'ack' };

  const thread = getThreadStmt.get(message.thread_id);
  if (thread?.status === 'paused') return { fire: false, reason: 'thread_paused' };

  const dup = countDuplicateContentStmt.get(message.content_hash, message.id);
  if ((dup?.n ?? 0) > 0) return { fire: false, reason: 'duplicate_24h' };

  const threadCount = countThreadMessagesStmt.get(message.thread_id)?.n ?? 0;
  if (threadCount > capExchangesPerThread()) return { fire: false, reason: 'cap_thread_exchanges' };

  const hourCount = countMessagesSinceStmt.get('-1 hour')?.n ?? 0;
  if (hourCount > capMessagesPerHour()) return { fire: false, reason: 'cap_messages_per_hour' };

  const dayCount = countMessagesSinceStmt.get('-1 day')?.n ?? 0;
  if (dayCount > capMessagesPerDay()) return { fire: false, reason: 'cap_messages_per_day' };

  return { fire: true };
}

/** The decision AND its stamp (cue_fired_at, or cue_skip_reason + a thread
 *  pause on cap breach) happen inside one transaction — see file header. */
const decideAndStampTxn = sqliteDb.transaction((message: RelayMessageRow): RelayCueDecision => {
  const decision = decideCue(message);
  if (decision.fire) {
    stampCueFiredStmt.run(message.id);
    return decision;
  }
  stampSkipReasonStmt.run(decision.reason, message.id);
  // Nothing is silently dropped (item 3): the message stays mirrored either
  // way; a cap breach additionally pauses the thread so Kevin can see WHY the
  // next several inbound messages stop cueing too, instead of guessing.
  if (
    decision.reason === 'cap_thread_exchanges' ||
    decision.reason === 'cap_messages_per_hour' ||
    decision.reason === 'cap_messages_per_day'
  ) {
    pauseThreadStmt.run(decision.reason, message.thread_id);
  }
  return decision;
});

// -- composing + posting the cue (the dispatch seam itself) ------------------

export const RELAY_CUE_EXTERNAL_ID = 'cockpit:relay-mike';

function firstLine(text: string | null | undefined, max = 200): string {
  if (!text) return '';
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function composeCueText(message: RelayMessageRow, thread: RelayThreadRow | undefined): string {
  const title = thread?.title ? `"${firstLine(thread.title, 120)}"` : '(untitled thread)';
  const header = `[relay — new ${message.kind} from mike in thread ${message.thread_id} ${title}]`;
  const subjectLine = message.subject ? `subject: ${message.subject}` : null;
  const body = message.body.length > 1500 ? `${message.body.slice(0, 1499)}…` : message.body;
  return [header, subjectLine, '', body].filter((l): l is string => l !== null).join('\n');
}

let ensuredConv = false;
function ensureRelayConversation() {
  const existing = getConversation(RELAY_CUE_EXTERNAL_ID);
  if (existing) return existing;
  const conv = getOrCreateConversation(RELAY_CUE_EXTERNAL_ID);
  if (!ensuredConv) {
    ensuredConv = true;
    try {
      renameConversation(conv.id, '🔗 Relay — Mike');
    } catch {
      /* best effort — a missing title never blocks the cue */
    }
  }
  return conv;
}

/** Same seam as tree-cue.ts `treeCueOnTreeStatus` / goals.ts `postCue`:
 *  in-flight → enqueue; busy → enqueue; else a real processMessage turn. */
function postRelayCue(text: string, correlationKey: string): void {
  const conv = ensureRelayConversation();
  const convId = conv.id;
  Promise.all([import('./agent.js'), import('./thread-message-queue.js')])
    .then(([agent, queue]) => {
      if (agent.getInFlightMessageId(convId)) {
        queue.enqueueMessage(convId, text);
        return;
      }
      agent.processMessage(text, RELAY_CUE_EXTERNAL_ID, correlationKey).catch((err: unknown) => {
        if (err instanceof agent.ConversationBusyError) queue.enqueueMessage(convId, text);
        else console.error('[relay-cue] cue post failed', err);
      });
    })
    .catch((err) => console.error('[relay-cue] cue import failed', err));
}

/** The registered listener (item 1). Called once per newly-mirrored non-jarvis
 *  message by src/relay.ts's notifyInbound — see that file's inbound-listener
 *  seam. Exported directly (not just side-effect-registered) so a scratch
 *  test can drive it without a full poll cycle. */
export function relayCueOnInboundMessage(message: RelayMessageRow): void {
  const decision = decideAndStampTxn(message);
  if (!decision.fire) {
    console.log(`[relay-cue] message #${message.id} (thread ${message.thread_id}) skipped: ${decision.reason}`);
    return;
  }
  const thread = getThreadStmt.get(message.thread_id);
  const text = composeCueText(message, thread);
  postRelayCue(text, `relay-cue:${message.id}`);
}

registerRelayInboundListener(relayCueOnInboundMessage);
