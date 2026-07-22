import {
  sqliteDb,
  getOrCreateConversation,
  initGroupChatConversation,
  ungroupMembers,
  setConversationStatus,
  type ConversationRow,
} from './conversation-db.js';
import { sseBus, type ThreadGroupEvent } from './sse-bus.js';

// DAR-742 — thread groups (folders). One home per thread (not tags, per
// Kevin's 2026-07-21 decision — see skills/jarvis-cockpit-groups/SKILL.md).
// Each group auto-creates its own "cover" chat, a real conversations row
// (external_id `cockpit:group:<id>`, is_group_chat=1) that flows through the
// normal processMessage() seam like any other thread — group-chat-specific
// behavior (member-summary context injection, get_member_thread tool) is
// gated on that row's is_group_chat/group_id, not on anything here.

export interface ConversationGroupRow {
  id: number;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS conversation_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    color      TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const stmts = {
  list: sqliteDb.prepare<[], ConversationGroupRow>(
    `SELECT * FROM conversation_groups ORDER BY sort_order ASC, created_at ASC`,
  ),
  getById: sqliteDb.prepare<[number], ConversationGroupRow>(
    `SELECT * FROM conversation_groups WHERE id = ?`,
  ),
  insert: sqliteDb.prepare<[string, string | null]>(
    `INSERT INTO conversation_groups (name, color) VALUES (?, ?)`,
  ),
  rename: sqliteDb.prepare<[string, number]>(
    `UPDATE conversation_groups SET name = ?, updated_at = datetime('now') WHERE id = ?`,
  ),
  setColor: sqliteDb.prepare<[string | null, number]>(
    `UPDATE conversation_groups SET color = ?, updated_at = datetime('now') WHERE id = ?`,
  ),
  remove: sqliteDb.prepare<[number]>(
    `DELETE FROM conversation_groups WHERE id = ?`,
  ),
};

export function listGroups(): ConversationGroupRow[] {
  return stmts.list.all();
}

export function getGroupById(id: number): ConversationGroupRow | undefined {
  return stmts.getById.get(id);
}

function groupChatExternalId(groupId: number): string {
  return `cockpit:group:${groupId}`;
}

/** Create a group and its cover chat (auto-created, same conversations row family as any thread). */
export function createGroup(name: string, color?: string | null): { group: ConversationGroupRow; groupChat: ConversationRow } {
  const info = stmts.insert.run(name, color ?? null);
  const groupId = Number(info.lastInsertRowid);
  const group = stmts.getById.get(groupId);
  if (!group) throw new Error('Failed to load conversation group after insert');

  const groupChat = getOrCreateConversation(groupChatExternalId(groupId));
  initGroupChatConversation(groupChat.id, groupId);

  sseBus.emit('sse', {
    type: 'thread_group',
    action: 'created',
    groupId,
    group: { id: group.id, name: group.name, color: group.color, sort_order: group.sort_order },
  } satisfies ThreadGroupEvent);

  return { group, groupChat };
}

export function renameGroup(id: number, name: string): ConversationGroupRow | undefined {
  stmts.rename.run(name, id);
  const group = stmts.getById.get(id);
  if (group) {
    sseBus.emit('sse', {
      type: 'thread_group',
      action: 'updated',
      groupId: id,
      group: { id: group.id, name: group.name, color: group.color, sort_order: group.sort_order },
    } satisfies ThreadGroupEvent);
  }
  return group;
}

export function setGroupColor(id: number, color: string | null): ConversationGroupRow | undefined {
  stmts.setColor.run(color, id);
  const group = stmts.getById.get(id);
  if (group) {
    sseBus.emit('sse', {
      type: 'thread_group',
      action: 'updated',
      groupId: id,
      group: { id: group.id, name: group.name, color: group.color, sort_order: group.sort_order },
    } satisfies ThreadGroupEvent);
  }
  return group;
}

/**
 * Delete a group: ungroups every member (threads are never deleted — DAR-742
 * locked requirement), archives the group's own cover chat rather than
 * deleting it (so its transcript stays reachable), then drops the group row.
 */
export function deleteGroup(id: number): void {
  ungroupMembers(id);
  const groupChat = getOrCreateConversation(groupChatExternalId(id));
  setConversationStatus(groupChat.id, 'archived');
  stmts.remove.run(id);
  sseBus.emit('sse', {
    type: 'thread_group',
    action: 'deleted',
    groupId: id,
  } satisfies ThreadGroupEvent);
}
