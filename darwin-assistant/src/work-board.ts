// WORK BOARD (tree-afe07b31, node #1547) — replaces Kevin's notepad list of
// chat links. Auto-populates from any cockpit:* conversation with a recent
// user turn (excluding ephemeral hopper-node/unblocker/shift/workstream
// chats); Kevin can also pin any thread explicitly via POST. See the ORIGINAL
// ASK captured on the hopper node for the full product spec.

import { sqliteDb, getConversation, type ConversationRow, getSetting, setSetting} from './conversation-db.js';
import { getInFlightMessageId } from './agent.js';

export interface WorkBoardItemRow {
  id: number;
  external_id: string;
  title_override: string | null;
  pinned: number;
  done_at: string | null;
  importance: number | null;
  watch: number;
  created_at: string;
  updated_at: string;
}

/** Three levels, deliberately — 1 cool, 2 normal, 3 hot. */
export type WorkBoardImportance = 1 | 2 | 3;

/** Whose move it is: 'jarvis' once Kevin has spoken (or a reply is running),
 *  'kevin' once JARVIS has answered, null for an empty thread. */
export type WorkBoardTurn = 'kevin' | 'jarvis' | null;

export interface WorkBoardItem {
  external_id: string;
  title: string | null;
  title_override: string | null;
  // Resolved display value: title_override, else the thread's title, else the
  // external_id itself (rule 6: topic = title unless Kevin typed an override).
  topic: string;
  last_activity: string;
  done_at: string | null;
  pinned: boolean;
  // true only on THIS read, when a done row was just auto-reopened because
  // Kevin sent a new message after it was marked done.
  reopened: boolean;
  link: string;
  // -- importance (3 levels) + turn state, see the IMPORTANCE block below ---
  importance: WorkBoardImportance;        // the level actually in force
  importance_auto: WorkBoardImportance;   // what the signals say on their own
  importance_source: 'auto' | 'manual';   // 'manual' once Kevin has overridden
  waiting_on: WorkBoardTurn;
  running: boolean;
  watch: boolean;           // Kevin's explicit one-shot "ping me when this lands"
  watch_effective: boolean; // watch OR a hand-set hot level — hot always pings
}

// Ephemeral cockpit threads that should never auto-populate the board, even
// though they share the `cockpit:` prefix (data rule in the spec). Goal node
// chats (`cockpit:goal-...`) are deliberately NOT in this list — they're kept.
const EPHEMERAL_COCKPIT_PREFIXES = [
  'cockpit:hopper-node-',
  'cockpit:unblocker-',
  'cockpit:shift-',
  'cockpit:workstream-',
];

function isEphemeralCockpitId(externalId: string): boolean {
  return EPHEMERAL_COCKPIT_PREFIXES.some((p) => externalId.startsWith(p));
}

/**
 * FIXED START POINT (Kevin, 2026-10-07): the board auto-includes a chat only if
 * Kevin typed in it AT OR AFTER a fixed watermark. The watermark is set ONCE on
 * first use to "now minus WORK_BOARD_INITIAL_HOURS" and then never moves on its
 * own (NOT a rolling window — old chats stay out, new activity comes in
 * forever). It is persisted in settings-KV as an ISO-ish sqlite timestamp plus
 * the first user turn id at/after it, and can be moved via resetWorkBoardSince().
 */
const WORK_BOARD_INITIAL_HOURS = 5;
const SINCE_KEY = 'work_board_since';
const SINCE_TURN_KEY = 'work_board_since_turn_id';

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS work_board_items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id    TEXT NOT NULL UNIQUE,
    title_override TEXT,
    pinned         INTEGER NOT NULL DEFAULT 0,
    done_at        TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_work_board_items_pinned ON work_board_items(pinned);
`);

// Added 2026-10-08 with the importance meter; existing rows keep importance
// NULL, which means "no override — use the auto level".
for (const col of [
  'importance INTEGER',
  'watch INTEGER NOT NULL DEFAULT 0',
]) {
  try { sqliteDb.exec(`ALTER TABLE work_board_items ADD COLUMN ${col}`); } catch {}
}

const stmts = {
  cockpitConversations: sqliteDb.prepare<[], Pick<ConversationRow, 'id' | 'external_id' | 'title' | 'updated_at'>>(
    `SELECT id, external_id, title, updated_at FROM conversations WHERE external_id LIKE 'cockpit:%'`,
  ),
  turnAgg: sqliteDb.prepare<[number], { last_any: string | null; last_user: string | null }>(
    `SELECT MAX(created_at) AS last_any,
            MAX(CASE WHEN role = 'user' THEN created_at END) AS last_user
     FROM turns WHERE conversation_id = ?`,
  ),
  // Last user-or-assistant turn — tool rows are skipped so a mid-run tool
  // call can't read as "JARVIS answered".
  lastSpeaker: sqliteDb.prepare<[number], { role: string }>(
    `SELECT role FROM turns
      WHERE conversation_id = ? AND role IN ('user', 'assistant')
      ORDER BY turn_index DESC, id DESC LIMIT 1`,
  ),
  pinnedExternalIds: sqliteDb.prepare<[], { external_id: string }>(
    `SELECT external_id FROM work_board_items WHERE pinned = 1`,
  ),
  getItemRow: sqliteDb.prepare<[string], WorkBoardItemRow>(
    `SELECT * FROM work_board_items WHERE external_id = ?`,
  ),
  insertDefault: sqliteDb.prepare<[string]>(
    `INSERT INTO work_board_items (external_id) VALUES (?)`,
  ),
  insertPinned: sqliteDb.prepare<[string]>(
    `INSERT INTO work_board_items (external_id, pinned) VALUES (?, 1)`,
  ),
  setPinned: sqliteDb.prepare<[number, string]>(
    `UPDATE work_board_items SET pinned = ?, updated_at = datetime('now') WHERE external_id = ?`,
  ),
  setDoneAt: sqliteDb.prepare<[string | null, string]>(
    `UPDATE work_board_items SET done_at = ?, updated_at = datetime('now') WHERE external_id = ?`,
  ),
  setTitleOverride: sqliteDb.prepare<[string | null, string]>(
    `UPDATE work_board_items SET title_override = ?, updated_at = datetime('now') WHERE external_id = ?`,
  ),
  setImportance: sqliteDb.prepare<[number | null, string]>(
    `UPDATE work_board_items SET importance = ?, updated_at = datetime('now') WHERE external_id = ?`,
  ),
  setWatch: sqliteDb.prepare<[number, string]>(
    `UPDATE work_board_items SET watch = ?, updated_at = datetime('now') WHERE external_id = ?`,
  ),
  now: sqliteDb.prepare<[], { now: string }>(`SELECT datetime('now') AS now`),
  firstUserTurnSince: sqliteDb.prepare<[string], { id: number | null }>(
    `SELECT MIN(id) AS id FROM turns WHERE role = 'user' AND created_at >= ?`,
  ),
  maxTurnId: sqliteDb.prepare<[], { id: number | null }>(`SELECT MAX(id) AS id FROM turns`),
};

function sqliteNow(): string {
  return stmts.now.get()!.now;
}

function hoursAgoStr(hours: number): string {
  const d = new Date(Date.now() - hours * 3_600_000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export interface WorkBoardSince {
  since: string;          // sqlite 'YYYY-MM-DD HH:MM:SS' (UTC) — user turns at/after this count
  since_turn_id: number;  // first user turn id at/after `since` when it was set (informational)
}

/** The fixed start point; set once (now − 5h) on first use, then never moves on its own. */
export function getWorkBoardSince(): WorkBoardSince {
  const existing = getSetting(SINCE_KEY);
  if (existing) {
    return { since: existing, since_turn_id: Number(getSetting(SINCE_TURN_KEY) ?? 0) };
  }
  return resetWorkBoardSince({ hours: WORK_BOARD_INITIAL_HOURS });
}

/** Move the start point: to now − hours, or to an explicit sqlite timestamp. Persisted. */
export function resetWorkBoardSince(opts: { hours?: number; at?: string }): WorkBoardSince {
  const since = opts.at && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(opts.at)
    ? opts.at
    : hoursAgoStr(Math.max(0, Number(opts.hours ?? WORK_BOARD_INITIAL_HOURS)));
  const first = stmts.firstUserTurnSince.get(since)?.id;
  const sinceTurnId = first ?? (stmts.maxTurnId.get()?.id ?? 0) + 1;
  setSetting(SINCE_KEY, since);
  setSetting(SINCE_TURN_KEY, String(sinceTurnId));
  return { since, since_turn_id: sinceTurnId };
}

function getItemRow(externalId: string): WorkBoardItemRow | undefined {
  return stmts.getItemRow.get(externalId);
}

function getOrCreateItemRow(externalId: string): WorkBoardItemRow {
  const existing = getItemRow(externalId);
  if (existing) return existing;
  stmts.insertDefault.run(externalId);
  return getItemRow(externalId)!;
}

function toLink(externalId: string): string {
  return `/threads?open=${encodeURIComponent(externalId)}`;
}

// == IMPORTANCE (Kevin, 2026-10-08) =========================================
// Three levels and only three, because only three behaviours exist: 3 = hot
// (ping the moment a reply lands), 2 = normal (sit high in the list), 1 =
// cool (silent, visible only if he goes looking). A level Kevin sets by hand
// wins and sticks until he clears it; everything else is derived every read
// from signals already in the DB, so the meter can't rot from neglect.
// NOT capped — Kevin's call; if "everything is hot" becomes real, cap later.
//
// The auto level is deliberately timid: pinning a chat is the one unambiguous
// "this matters" signal he already gives, and going a day cold is the one
// unambiguous "it doesn't". Everything else sits at normal and waits for him.
// Guessing hot from recent typing was considered and rejected — every chat he
// touches would go hot, and hot is what pings.
const AUTO_COOL_IDLE_HOURS = 24;

function parseSqliteMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const norm = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts.replace(' ', 'T')}Z`;
  const ms = Date.parse(norm);
  return Number.isFinite(ms) ? ms : null;
}

/** The level the signals alone argue for: pinned = hot, a full day cold =
 *  cool, everything else normal. */
function autoImportance(opts: { pinned: boolean; lastActivity: string | null }): WorkBoardImportance {
  if (opts.pinned) return 3;
  const lastActivityMs = parseSqliteMs(opts.lastActivity);
  if (lastActivityMs !== null && Date.now() - lastActivityMs >= AUTO_COOL_IDLE_HOURS * 3_600_000) return 1;
  return 2;
}

function clampImportance(value: unknown): WorkBoardImportance | null {
  const n = Number(value);
  return n === 1 || n === 2 || n === 3 ? (n as WorkBoardImportance) : null;
}

/**
 * Build the resolved board item for one conversation, applying the
 * Kevin-reopens-it-by-replying auto-undo rule. Returns null if the
 * conversation doesn't exist (e.g. a pinned external_id was later deleted).
 */
function buildItem(externalId: string): WorkBoardItem | null {
  const conv = getConversation(externalId);
  if (!conv) return null;
  const itemRow = getItemRow(externalId) ?? null;
  const agg = stmts.turnAgg.get(conv.id) ?? { last_any: null, last_user: null };
  const lastActivity = agg.last_any ?? conv.updated_at;

  let doneAt = itemRow?.done_at ?? null;
  let reopened = false;
  if (doneAt && agg.last_user && agg.last_user > doneAt) {
    stmts.setDoneAt.run(null, externalId);
    doneAt = null;
    reopened = true;
  }

  const titleOverride = itemRow?.title_override ?? null;
  const topic = titleOverride || conv.title || externalId;
  const pinned = !!(itemRow && itemRow.pinned);

  const running = getInFlightMessageId(conv.id) != null;
  const lastSpeaker = stmts.lastSpeaker.get(conv.id)?.role ?? null;
  const waitingOn: WorkBoardTurn = running
    ? 'jarvis'
    : lastSpeaker === 'user'
      ? 'jarvis'
      : lastSpeaker === 'assistant'
        ? 'kevin'
        : null;

  const importanceAuto = autoImportance({ pinned, lastActivity });
  const manual = clampImportance(itemRow?.importance ?? null);
  const importance = manual ?? importanceAuto;
  const watch = !!(itemRow && itemRow.watch);

  return {
    external_id: externalId,
    title: conv.title ?? null,
    title_override: titleOverride,
    topic,
    last_activity: lastActivity,
    done_at: doneAt,
    pinned,
    reopened,
    link: toLink(externalId),
    importance,
    importance_auto: importanceAuto,
    importance_source: manual ? 'manual' : 'auto',
    waiting_on: waitingOn,
    running,
    watch,
    // Hot implies watch (Kevin's rule 4) — but only a hot level he set by
    // hand, so the auto level can never start sending him notifications.
    watch_effective: watch || (manual === 3),
  };
}

/**
 * Does a finished reply in this chat deserve a ping? True when Kevin armed
 * the one-shot watch OR he set the chat hot by hand (rule 4: hot implies
 * watch). The one-shot watch is disarmed here so it fires exactly once; a
 * hot level is standing and keeps firing until he turns it down.
 */
export function consumeWorkBoardWatch(externalId: string): boolean {
  const item = buildItem(externalId);
  if (!item || !item.watch_effective) return false;
  if (item.watch) stmts.setWatch.run(0, externalId);
  return true;
}

/**
 * The board: every pinned external_id plus every non-ephemeral cockpit:*
 * conversation with a user turn at/after the fixed start point (getWorkBoardSince), sorted oldest-updated
 * first (so Kevin works from the top). Done rows are dropped unless
 * includeDone is set.
 */
export function listWorkBoardItems(includeDone: boolean): WorkBoardItem[] {
  const cutoff = getWorkBoardSince().since;
  const candidateIds = new Set<string>();

  for (const conv of stmts.cockpitConversations.all()) {
    if (isEphemeralCockpitId(conv.external_id)) continue;
    const agg = stmts.turnAgg.get(conv.id);
    if (agg?.last_user && agg.last_user >= cutoff) candidateIds.add(conv.external_id);
  }
  for (const row of stmts.pinnedExternalIds.all()) candidateIds.add(row.external_id);

  const items: WorkBoardItem[] = [];
  for (const externalId of candidateIds) {
    const item = buildItem(externalId);
    if (!item) continue;
    if (item.done_at && !includeDone) continue;
    items.push(item);
  }

  items.sort((a, b) => (a.last_activity < b.last_activity ? -1 : a.last_activity > b.last_activity ? 1 : 0));
  return items;
}

/**
 * Parse a pasted link or bare id into a canonical external_id. Handles:
 *   - a bare id, e.g. "cockpit:<uuid>"
 *   - a full/relative threads link, e.g. ".../threads?open=cockpit%3A<uuid>"
 *   - a pop-out thread path, e.g. ".../thread/cockpit:<uuid>"
 * Returns null if no cockpit external id could be extracted.
 */
export function parseWorkBoardRef(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  if (/^cockpit:[^/?]+$/.test(s)) return s;

  const openMatch = s.match(/[?&]open=([^&]+)/);
  if (openMatch) {
    const decoded = decodeURIComponent(openMatch[1]);
    return decoded.startsWith('cockpit:') ? decoded : null;
  }

  const popoutMatch = s.match(/\/thread\/(cockpit(?:%3A|:).+)$/i);
  if (popoutMatch) {
    const decoded = decodeURIComponent(popoutMatch[1]);
    return decoded.startsWith('cockpit:') ? decoded : null;
  }

  return null;
}

/** Pin a conversation onto the board explicitly. Null if it doesn't exist. */
export function pinWorkBoardItem(externalId: string): WorkBoardItem | null {
  const conv = getConversation(externalId);
  if (!conv) return null;
  const existing = getItemRow(externalId);
  if (existing) {
    if (!existing.pinned) stmts.setPinned.run(1, externalId);
  } else {
    stmts.insertPinned.run(externalId);
  }
  return buildItem(externalId);
}

export interface WorkBoardItemPatch {
  done?: boolean;
  title_override?: string | null;
  pinned?: boolean;
  /** 1|2|3 to override, null to hand the chat back to the auto level. */
  importance?: WorkBoardImportance | null;
  /** Arm/disarm the one-shot "ping me when this lands". */
  watch?: boolean;
}

/** Apply a PATCH. Null if the conversation doesn't exist. */
export function updateWorkBoardItem(externalId: string, patch: WorkBoardItemPatch): WorkBoardItem | null {
  const conv = getConversation(externalId);
  if (!conv) return null;
  getOrCreateItemRow(externalId);

  if (patch.done !== undefined) {
    stmts.setDoneAt.run(patch.done ? sqliteNow() : null, externalId);
  }
  if (patch.pinned !== undefined) {
    stmts.setPinned.run(patch.pinned ? 1 : 0, externalId);
  }
  if (patch.title_override !== undefined) {
    // Empty string = "back to the title" (rule 6), same as an explicit null.
    stmts.setTitleOverride.run(patch.title_override === '' ? null : patch.title_override, externalId);
  }
  if (patch.importance !== undefined) {
    stmts.setImportance.run(clampImportance(patch.importance), externalId);
  }
  if (patch.watch !== undefined) {
    stmts.setWatch.run(patch.watch ? 1 : 0, externalId);
  }

  return buildItem(externalId);
}
