// WORK BOARD (tree-afe07b31, node #1547) — replaces Kevin's notepad list of
// chat links. Auto-populates from any cockpit:* conversation with a recent
// user turn (excluding ephemeral hopper-node/unblocker/shift/workstream
// chats); Kevin can also pin any thread explicitly via POST. See the ORIGINAL
// ASK captured on the hopper node for the full product spec.

import { sqliteDb, getConversation, type ConversationRow } from './conversation-db.js';

export interface WorkBoardItemRow {
  id: number;
  external_id: string;
  title_override: string | null;
  pinned: number;
  done_at: string | null;
  created_at: string;
  updated_at: string;
}

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

const AUTO_POPULATE_WINDOW_DAYS = 14;

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

const stmts = {
  cockpitConversations: sqliteDb.prepare<[], Pick<ConversationRow, 'id' | 'external_id' | 'title' | 'updated_at'>>(
    `SELECT id, external_id, title, updated_at FROM conversations WHERE external_id LIKE 'cockpit:%'`,
  ),
  turnAgg: sqliteDb.prepare<[number], { last_any: string | null; last_user: string | null }>(
    `SELECT MAX(created_at) AS last_any,
            MAX(CASE WHEN role = 'user' THEN created_at END) AS last_user
     FROM turns WHERE conversation_id = ?`,
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
  now: sqliteDb.prepare<[], { now: string }>(`SELECT datetime('now') AS now`),
};

function sqliteNow(): string {
  return stmts.now.get()!.now;
}

function cutoffDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
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

  return {
    external_id: externalId,
    title: conv.title ?? null,
    title_override: titleOverride,
    topic,
    last_activity: lastActivity,
    done_at: doneAt,
    pinned: !!(itemRow && itemRow.pinned),
    reopened,
    link: toLink(externalId),
  };
}

/**
 * The board: every pinned external_id plus every non-ephemeral cockpit:*
 * conversation with a user turn in the last 14 days, sorted oldest-updated
 * first (so Kevin works from the top). Done rows are dropped unless
 * includeDone is set.
 */
export function listWorkBoardItems(includeDone: boolean): WorkBoardItem[] {
  const cutoff = cutoffDaysAgo(AUTO_POPULATE_WINDOW_DAYS);
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

  return buildItem(externalId);
}
