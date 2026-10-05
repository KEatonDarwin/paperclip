// COMPANION THREAD — persistent kind registration + Opus model pin (node #1375).
//
// `cockpit:companion-<id>` is her own linked AI chat (wish-catalog pilot,
// tree-08657e8d). Two things this module registers, mirroring the Mike Radar /
// Night Shift precedents (mike-radar.ts, night-shift.ts ensureNightThread):
//
//   1. PERSISTENT, not a quick chat. The 48h quick-chat TTL
//      (quick-chat-profiles.ts) is entirely self-scoped to the
//      `quick:<profile_id>:<uuid>` prefix and `quick_chat_sessions` table —
//      a thread on its own `cockpit:companion-` prefix is never inserted into
//      that table, so it is never subject to the TTL sweep. Nothing to
//      bypass; staying off that prefix IS the opt-out. `COMPANION_KIND_ROW`
//      below records `persistent = 1` so that fact is queryable, not just
//      implicit in which module a thread's find-or-create went through.
//   2. Opus model pin. `conversations.thread_adapter` / `thread_model`
//      (DAR-680 AC#4) already carry a per-thread provider/model override,
//      resolved every turn by `resolveConversationRuntime` (agent.ts). This
//      module applies that override ONCE at thread creation — exactly like
//      `ensureNightThread` — to `claude-opus-5`. It is a default, not a hard
//      lock: Kevin's model picker can still change it afterward (a hard lock
//      is unbuilt behavior, flagged in COMPANION-THREAD-RECON.md §c(4), not
//      this node's job). The enforcing guard that rejects a non-opus pin on
//      this kind is #277 — this module only ever sets the opus default.
//
// No thread is created by this module yet — that's a future node's job
// (the wish-catalog chat bootstrap). This just makes the kind real and
// queryable so that node has something to call.

import {
  getConversation,
  getOrCreateConversation,
  renameConversation,
  setThreadModelOverride,
  sqliteDb,
} from './conversation-db.js';

export const COMPANION_THREAD_PREFIX = 'cockpit:companion-';

/** Hard rule: companion's model pin is always a claude-opus-* id — never
 *  Fable, never a frontier/gpt id. #277 enforces this against user edits;
 *  this is just the default applied at creation. */
export const COMPANION_DEFAULT_ADAPTER = 'claude';
export const COMPANION_DEFAULT_MODEL = 'claude-opus-5';

// Registers the companion kind as a queryable row, mirroring the
// quick_chat_profiles seed pattern (one row per kind, IIFE'd IF NOT EXISTS +
// INSERT OR IGNORE so re-running this module on every boot is a no-op once
// seeded). Unlike quick_chat_profiles there is no TTL column here — the
// absence of one *is* the persistence: this kind has nothing that expires it.
sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS companion_thread_kind (
    prefix          TEXT PRIMARY KEY,
    persistent      INTEGER NOT NULL DEFAULT 1,
    default_adapter TEXT NOT NULL,
    default_model   TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

sqliteDb
  .prepare(
    `INSERT OR IGNORE INTO companion_thread_kind (prefix, persistent, default_adapter, default_model)
     VALUES (?, 1, ?, ?)`,
  )
  .run(COMPANION_THREAD_PREFIX, COMPANION_DEFAULT_ADAPTER, COMPANION_DEFAULT_MODEL);

export interface CompanionThreadKindRow {
  prefix: string;
  persistent: number;
  default_adapter: string;
  default_model: string;
  created_at: string;
}

const getCompanionThreadKindStmt = sqliteDb.prepare<[string], CompanionThreadKindRow>(
  `SELECT * FROM companion_thread_kind WHERE prefix = ?`,
);

/** Read back the registered kind row (mainly for tests/acceptance checks). */
export function getCompanionThreadKind(): CompanionThreadKindRow | undefined {
  return getCompanionThreadKindStmt.get(COMPANION_THREAD_PREFIX);
}

export function companionThreadExt(id: string): string {
  return `${COMPANION_THREAD_PREFIX}${id}`;
}

/** The companion id a thread is about, or null if this isn't one of them. */
export function companionIdFromThread(externalId: string): string | null {
  if (!externalId.startsWith(COMPANION_THREAD_PREFIX)) return null;
  const id = externalId.slice(COMPANION_THREAD_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

/**
 * Find-or-create a companion thread, mirroring `getOrCreateMikeThread` /
 * `ensureNightThread` exactly: the Opus model override is applied ONCE, only
 * when the conversation row is newly created, and never re-applied on a
 * later lookup (so a thread Kevin re-pins off Opus stays off Opus).
 */
export function getOrCreateCompanionThread(
  id: string,
): { external_id: string; created: boolean } {
  const externalId = companionThreadExt(id);
  const existing = getConversation(externalId);
  if (existing) return { external_id: externalId, created: false };

  const conv = getOrCreateConversation(externalId);
  renameConversation(conv.id, `💬 Companion`.slice(0, 120));
  try {
    setThreadModelOverride(conv.id, COMPANION_DEFAULT_ADAPTER, COMPANION_DEFAULT_MODEL);
  } catch (err) {
    console.warn('[companion-chat] could not set the companion thread model override', err);
  }
  return { external_id: externalId, created: true };
}
