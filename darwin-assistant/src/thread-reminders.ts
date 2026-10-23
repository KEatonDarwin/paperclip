import { sqliteDb, addTurn, touchConversation, getConversationById } from './conversation-db.js';
import { sseBus, type ThreadReminderEvent } from './sse-bus.js';

export type ThreadReminderStatus = 'active' | 'fired' | 'cancelled';

export interface ThreadReminderRow {
  id: number;
  conversation_id: number;
  /** UTC 'YYYY-MM-DD HH:MM:SS' — when this next bumps the thread. */
  fire_at: string;
  /** Optional "why am I being reminded" note, shown on the bump card. */
  note: string | null;
  /** Null → one-shot. Set → re-arms this many minutes after each fire. */
  repeat_minutes: number | null;
  status: ThreadReminderStatus;
  last_fired_at: string | null;
  fire_count: number;
  /**
   * When Kevin dismissed the current alert. A reminder is "alerting" (glowing in
   * the sidebar) while fire_count > 0 and acknowledged_at is null-or-older than
   * last_fired_at. Dismissing a REPEATING reminder only clears the current
   * round — it re-alerts on the next fire. Cancelling is what turns it off.
   */
  acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS thread_reminders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    fire_at         TEXT NOT NULL,
    note            TEXT,
    repeat_minutes  INTEGER,
    status          TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'fired', 'cancelled')),
    last_fired_at   TEXT,
    fire_count      INTEGER NOT NULL DEFAULT 0,
    acknowledged_at TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_thread_reminders_due
    ON thread_reminders(status, fire_at);

  CREATE INDEX IF NOT EXISTS idx_thread_reminders_conversation
    ON thread_reminders(conversation_id, status);
`);

const getByIdStmt = sqliteDb.prepare<[number], ThreadReminderRow>(
  `SELECT * FROM thread_reminders WHERE id = ?`,
);

const activeForConvStmt = sqliteDb.prepare<[number], ThreadReminderRow>(`
  SELECT * FROM thread_reminders
  WHERE conversation_id = ? AND status = 'active'
  ORDER BY fire_at ASC
  LIMIT 1
`);

const insertStmt = sqliteDb.prepare<[number, string, string | null, number | null]>(`
  INSERT INTO thread_reminders (conversation_id, fire_at, note, repeat_minutes)
  VALUES (?, ?, ?, ?)
`);

const cancelForConvStmt = sqliteDb.prepare<[number]>(`
  UPDATE thread_reminders
  SET status = 'cancelled', updated_at = datetime('now')
  WHERE conversation_id = ? AND status = 'active'
`);

const dueStmt = sqliteDb.prepare<[], ThreadReminderRow>(`
  SELECT * FROM thread_reminders
  WHERE status = 'active' AND fire_at <= datetime('now')
  ORDER BY fire_at ASC
  LIMIT 25
`);

const markFiredOneShotStmt = sqliteDb.prepare<[number]>(`
  UPDATE thread_reminders
  SET status = 'fired',
      last_fired_at = datetime('now'),
      fire_count = fire_count + 1,
      updated_at = datetime('now')
  WHERE id = ?
`);

const rearmStmt = sqliteDb.prepare<[number, number]>(`
  UPDATE thread_reminders
  SET fire_at = datetime('now', '+' || ? || ' minutes'),
      last_fired_at = datetime('now'),
      fire_count = fire_count + 1,
      updated_at = datetime('now')
  WHERE id = ?
`);

const acknowledgeStmt = sqliteDb.prepare<[number]>(`
  UPDATE thread_reminders
  SET acknowledged_at = datetime('now'), updated_at = datetime('now')
  WHERE id = ?
`);

const cancelByIdStmt = sqliteDb.prepare<[number]>(`
  UPDATE thread_reminders
  SET status = 'cancelled', updated_at = datetime('now')
  WHERE id = ?
`);

function emit(action: ThreadReminderEvent['action'], reminder: ThreadReminderRow): void {
  sseBus.emit('sse', {
    type: 'thread_reminder',
    conversationId: reminder.conversation_id,
    action,
    // A cancelled reminder never glows, whatever its fire history says.
    reminder: {
      ...reminder,
      alerting: reminder.status === 'cancelled' ? false : isAlerting(reminder),
    },
  } satisfies ThreadReminderEvent);
}

export function getThreadReminder(id: number): ThreadReminderRow | null {
  return getByIdStmt.get(id) ?? null;
}

/** The one live reminder for a thread, if any. */
export function activeReminderForConversation(conversationId: number): ThreadReminderRow | null {
  return activeForConvStmt.get(conversationId) ?? null;
}

/**
 * True while the thread should be visually flagged: it has fired at least once
 * and Kevin hasn't dismissed that fire yet. Repeating reminders re-enter this
 * state on every fire until cancelled.
 */
export function isAlerting(r: ThreadReminderRow): boolean {
  if (r.fire_count < 1 || !r.last_fired_at) return false;
  if (!r.acknowledged_at) return true;
  return r.acknowledged_at < r.last_fired_at;
}

/**
 * Wire shape for a reminder. The one place `alerting` gets computed for HTTP
 * responses, so the descriptor, the PUT response and the ack response can't
 * drift apart.
 */
export function serializeReminder(r: ThreadReminderRow): Record<string, unknown> {
  return {
    id: r.id,
    fire_at: r.fire_at,
    note: r.note,
    repeat_minutes: r.repeat_minutes,
    fire_count: r.fire_count,
    last_fired_at: r.last_fired_at,
    alerting: r.status === 'cancelled' ? false : isAlerting(r),
  };
}

/**
 * Arm a reminder on a thread. A thread holds at most one active reminder, so
 * this cancels any existing one — re-arming from the UI is a replace, not a
 * stack of competing alarms.
 */
export function setThreadReminder(
  conversationId: number,
  fireAtUtc: string,
  note: string | null,
  repeatMinutes: number | null,
): ThreadReminderRow {
  cancelForConvStmt.run(conversationId);
  const info = insertStmt.run(conversationId, fireAtUtc, note, repeatMinutes);
  const created = getThreadReminder(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to load thread reminder after insert');
  emit('created', created);
  return created;
}

/** Clear the current alert without disarming a repeating reminder. */
export function acknowledgeThreadReminder(id: number): ThreadReminderRow | null {
  acknowledgeStmt.run(id);
  const updated = getThreadReminder(id);
  if (updated) emit('updated', updated);
  return updated;
}

/** Turn the reminder off for good. */
export function cancelThreadReminder(id: number): ThreadReminderRow | null {
  cancelByIdStmt.run(id);
  const updated = getThreadReminder(id);
  if (updated) emit('cancelled', updated);
  return updated;
}

export function cancelRemindersForConversation(conversationId: number): void {
  const active = activeReminderForConversation(conversationId);
  cancelForConvStmt.run(conversationId);
  if (active) {
    const updated = getThreadReminder(active.id);
    if (updated) emit('cancelled', updated);
  }
}

/**
 * Fire one reminder: write the bump entry into the thread's history, push the
 * thread to the top of the sidebar, then either re-arm (repeating) or retire it.
 */
function fireReminder(r: ThreadReminderRow): void {
  const conv = getConversationById(r.conversation_id);
  // Thread deleted out from under the reminder — retire it quietly.
  if (!conv) {
    cancelByIdStmt.run(r.id);
    return;
  }

  const nextFireCount = r.fire_count + 1;

  // The visible history entry. Rendered by the cockpit as a distinct bump card
  // rather than a message, so it never pollutes the conversation transcript
  // (countMessages only counts user/assistant roles).
  addTurn(
    r.conversation_id,
    'bump',
    r.note ?? 'Reminder',
    undefined,
    JSON.stringify({
      reminder_id: r.id,
      scheduled_for: r.fire_at,
      repeat_minutes: r.repeat_minutes,
      occurrence: nextFireCount,
    }),
  );

  // addTurn already touches the conversation and emits conversation_updated,
  // which is what re-sorts the sidebar. Belt-and-braces for future callers.
  touchConversation(r.conversation_id);

  if (r.repeat_minutes && r.repeat_minutes > 0) {
    rearmStmt.run(r.repeat_minutes, r.id);
  } else {
    markFiredOneShotStmt.run(r.id);
  }

  const updated = getThreadReminder(r.id);
  if (updated) emit('fired', updated);
}

/** One sweep of due reminders. Exported for tests / manual invocation. */
export function processDueReminders(): number {
  const due = dueStmt.all();
  for (const r of due) {
    try {
      fireReminder(r);
    } catch (err) {
      console.error(`[thread-reminders] failed to fire reminder ${r.id}:`, err);
      // Retire the broken one so a persistent failure can't spin the tick.
      cancelByIdStmt.run(r.id);
    }
  }
  return due.length;
}

const TICK_MS = 30_000;

let timer: NodeJS.Timeout | null = null;

/**
 * Start the reminder tick. Deliberately independent of the Slack-gated
 * check-in worker and of the Paperclip Postgres DB — a cockpit thread bump is
 * local, SQLite-only, and must run whether or not Slack creds are present.
 */
export function startThreadReminderWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      processDueReminders();
    } catch (err) {
      console.error('[thread-reminders] tick failed:', err);
    }
  }, TICK_MS);
  // Don't hold the process open on shutdown.
  timer.unref?.();
  console.log(`[thread-reminders] worker started (tick ${TICK_MS / 1000}s)`);
}
