import { sqliteDb } from './conversation-db.js';
import { sseBus, type SmartTodoEvent } from './sse-bus.js';

// SMART TODO TREE — Kevin's standalone, always-open "smart todo list."
//
// A separate, curated layer OUTSIDE any one cockpit thread. Kevin jots a note
// (one line, or a whole paragraph); it's decomposed into a main idea + nested
// subitems and dropped into a file-tree-style list. Every node can be edited,
// moved within its topic, elaborated ("talk it out"), collapsed, and — the key
// move — turned into a chat with one click. That chat lands in the node's group
// and ties BACK to the node (linked_thread_ext), so "Open chat" from the tree
// re-opens the SAME thread, never a new one.
//
// It is deliberately NOT a mirror of every thread — it's the smart backlog Kevin
// keeps his place in. Global (not conversation-scoped), so it's modeled on
// hopper.ts / notifications.ts, with a self-referential parent_id giving
// unlimited nesting.

export type SmartTodoStatus = 'open' | 'doing' | 'done';

export interface SmartTodoNodeRow {
  id: number;
  parent_id: number | null;   // null = a root branch (a top-level jotted idea)
  root_id: number;            // the top-level ancestor's id (self for roots) — fast whole-tree ops + group cascade
  title: string;              // the node's line
  notes: string | null;       // the expanded "talk it out" elaboration
  original_prompt: string | null; // the raw note this node/tree came from (carried on the root)
  origin: string | null;      // 'decompose' | 'manual' | 'thread' — provenance
  sort_order: number;         // ordering among siblings
  collapsed: number;          // 0/1 — per-node collapse state (persists across reloads)
  status: SmartTodoStatus;
  group_id: number | null;    // the cockpit group this branch maps to (whole tree shares it)
  linked_thread_ext: string | null; // the thread tied to THIS node, if one was opened
  created_at: string;
  updated_at: string;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS smart_todo_nodes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id         INTEGER REFERENCES smart_todo_nodes(id),
    root_id           INTEGER NOT NULL,
    title             TEXT NOT NULL,
    notes             TEXT,
    original_prompt   TEXT,
    origin            TEXT,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    collapsed         INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','doing','done')),
    group_id          INTEGER,
    linked_thread_ext TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_smart_todo_parent ON smart_todo_nodes(parent_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_smart_todo_root   ON smart_todo_nodes(root_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_smart_todo_thread ON smart_todo_nodes(linked_thread_ext);
`);

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

const getByIdStmt = sqliteDb.prepare<[number], SmartTodoNodeRow>(
  `SELECT * FROM smart_todo_nodes WHERE id = ?`,
);

const listAllStmt = sqliteDb.prepare<[], SmartTodoNodeRow>(
  `SELECT * FROM smart_todo_nodes ORDER BY root_id ASC, sort_order ASC, id ASC`,
);

const getByThreadStmt = sqliteDb.prepare<[string], SmartTodoNodeRow>(
  `SELECT * FROM smart_todo_nodes WHERE linked_thread_ext = ? LIMIT 1`,
);

const nextSortStmt = sqliteDb.prepare<[number | null], { next: number }>(`
  SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
  FROM smart_todo_nodes
  WHERE parent_id IS ?
`);

const insertStmt = sqliteDb.prepare<
  [number | null, number, string, string | null, string | null, string | null, number, number | null]
>(`
  INSERT INTO smart_todo_nodes (parent_id, root_id, title, notes, original_prompt, origin, sort_order, group_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const setRootStmt = sqliteDb.prepare<[number, number]>(
  `UPDATE smart_todo_nodes SET root_id = ? WHERE id = ?`,
);

const touchStmt = sqliteDb.prepare<[number]>(
  `UPDATE smart_todo_nodes SET updated_at = datetime('now') WHERE id = ?`,
);

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

// A tree edit can touch many nodes (decompose inserts a whole subtree, delete
// removes one, move re-parents a subtree). For correctness the client refetches
// the full tree on ANY event; 'bulk' is the signal for multi-node changes.
function emit(action: SmartTodoEvent['action'], node?: SmartTodoNodeRow): void {
  sseBus.emit('sse', { type: 'smart_todo', action, node } satisfies SmartTodoEvent);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getSmartTodoNode(id: number): SmartTodoNodeRow | null {
  return getByIdStmt.get(id) ?? null;
}

export function listSmartTodoNodes(): SmartTodoNodeRow[] {
  return listAllStmt.all();
}

export function getSmartTodoByThread(threadExt: string): SmartTodoNodeRow | null {
  return getByThreadStmt.get(threadExt) ?? null;
}

/** ids of a node + all its descendants (for cascade delete / cycle checks / root recompute). */
function subtreeIds(id: number): number[] {
  return sqliteDb
    .prepare<[number], { id: number }>(`
      WITH RECURSIVE sub(id) AS (
        SELECT id FROM smart_todo_nodes WHERE id = ?
        UNION ALL
        SELECT n.id FROM smart_todo_nodes n JOIN sub ON n.parent_id = sub.id
      )
      SELECT id FROM sub
    `)
    .all(id)
    .map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Create a single node. If parent_id is given it's appended under that parent
 *  (inheriting the parent's root_id + group); otherwise it's a new root branch. */
export function createSmartTodoNode(args: {
  parent_id?: number | null;
  title: string;
  notes?: string | null;
  original_prompt?: string | null;
  origin?: string | null;
  group_id?: number | null;
}): SmartTodoNodeRow {
  const parentId = args.parent_id ?? null;
  const parent = parentId !== null ? getSmartTodoNode(parentId) : null;
  if (parentId !== null && !parent) throw new Error(`parent node ${parentId} not found`);

  const groupId = args.group_id ?? parent?.group_id ?? null;
  const sort = nextSortStmt.get(parentId)?.next ?? 0;

  const info = insertStmt.run(
    parentId,
    parent ? parent.root_id : 0, // placeholder; roots point root_id at themselves below
    args.title.slice(0, 500),
    args.notes ?? null,
    args.original_prompt ?? null,
    args.origin ?? 'manual',
    sort,
    groupId,
  );
  const id = Number(info.lastInsertRowid);
  if (!parent) setRootStmt.run(id, id); // a root points root_id at itself

  const created = getSmartTodoNode(id);
  if (!created) throw new Error('Failed to load smart todo node after insert');
  emit('created', created);
  return created;
}

interface DecomposedNode {
  title: string;
  notes?: string | null;
  children?: DecomposedNode[];
}

/** Insert a whole decomposed tree in one transaction: a root (carrying the raw
 *  prompt) + arbitrarily-nested children. Returns the root row. Emits one bulk
 *  event. */
export function insertSmartTodoTree(
  originalPrompt: string,
  tree: DecomposedNode,
  opts: { group_id?: number | null } = {},
): SmartTodoNodeRow {
  const run = sqliteDb.transaction((): number => {
    const rootSort = nextSortStmt.get(null)?.next ?? 0;
    const rootInfo = insertStmt.run(
      null,
      0,
      tree.title.slice(0, 500),
      tree.notes ?? null,
      originalPrompt,
      'decompose',
      rootSort,
      opts.group_id ?? null,
    );
    const rootId = Number(rootInfo.lastInsertRowid);
    setRootStmt.run(rootId, rootId);

    const insertChildren = (parentId: number, children: DecomposedNode[] | undefined): void => {
      if (!children || !children.length) return;
      children.forEach((child, idx) => {
        const info = insertStmt.run(
          parentId,
          rootId,
          child.title.slice(0, 500),
          child.notes ?? null,
          null,
          'decompose',
          idx,
          opts.group_id ?? null,
        );
        insertChildren(Number(info.lastInsertRowid), child.children);
      });
    };
    insertChildren(rootId, tree.children);
    return rootId;
  });

  const rootId = run();
  const root = getSmartTodoNode(rootId);
  if (!root) throw new Error('Failed to load smart todo tree root after insert');
  emit('bulk');
  return root;
}

const updTitleStmt = sqliteDb.prepare<[string, number]>(`UPDATE smart_todo_nodes SET title = ?, updated_at = datetime('now') WHERE id = ?`);
const updNotesStmt = sqliteDb.prepare<[string | null, number]>(`UPDATE smart_todo_nodes SET notes = ?, updated_at = datetime('now') WHERE id = ?`);
const updStatusStmt = sqliteDb.prepare<[SmartTodoStatus, number]>(`UPDATE smart_todo_nodes SET status = ?, updated_at = datetime('now') WHERE id = ?`);
const updCollapsedStmt = sqliteDb.prepare<[number, number]>(`UPDATE smart_todo_nodes SET collapsed = ?, updated_at = datetime('now') WHERE id = ?`);
const updPromptStmt = sqliteDb.prepare<[string | null, number]>(`UPDATE smart_todo_nodes SET original_prompt = ?, updated_at = datetime('now') WHERE id = ?`);

/** Patch a single node's own fields (not structure — see moveSmartTodoNode). */
export function updateSmartTodoNode(
  id: number,
  patch: {
    title?: string;
    notes?: string | null;
    status?: SmartTodoStatus;
    collapsed?: boolean;
    original_prompt?: string | null;
  },
): SmartTodoNodeRow | null {
  if (!getSmartTodoNode(id)) return null;
  if (patch.title !== undefined) updTitleStmt.run(patch.title.slice(0, 500), id);
  if (patch.notes !== undefined) updNotesStmt.run(patch.notes, id);
  if (patch.status !== undefined) updStatusStmt.run(patch.status, id);
  if (patch.collapsed !== undefined) updCollapsedStmt.run(patch.collapsed ? 1 : 0, id);
  if (patch.original_prompt !== undefined) updPromptStmt.run(patch.original_prompt, id);
  const updated = getSmartTodoNode(id);
  if (updated) emit('updated', updated);
  return updated;
}

const setGroupTreeStmt = sqliteDb.prepare<[number | null, number]>(
  `UPDATE smart_todo_nodes SET group_id = ?, updated_at = datetime('now') WHERE root_id = ?`,
);

/** Set the cockpit group for a whole branch. Group is a per-branch property, so
 *  this cascades to every node sharing the root. Pass any node in the tree. */
export function setSmartTodoGroup(nodeId: number, groupId: number | null): SmartTodoNodeRow | null {
  const node = getSmartTodoNode(nodeId);
  if (!node) return null;
  setGroupTreeStmt.run(groupId, node.root_id);
  emit('bulk');
  return getSmartTodoNode(nodeId);
}

const setThreadStmt = sqliteDb.prepare<[string | null, number]>(
  `UPDATE smart_todo_nodes SET linked_thread_ext = ?, updated_at = datetime('now') WHERE id = ?`,
);

/** Tie a node to its chat thread (or clear with null). */
export function setSmartTodoThread(nodeId: number, threadExt: string | null): SmartTodoNodeRow | null {
  if (!getSmartTodoNode(nodeId)) return null;
  setThreadStmt.run(threadExt, nodeId);
  const updated = getSmartTodoNode(nodeId);
  if (updated) emit('updated', updated);
  return updated;
}

const setParentStmt = sqliteDb.prepare<[number | null, number, number, number]>(
  `UPDATE smart_todo_nodes SET parent_id = ?, root_id = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`,
);

/** Move a node (and its subtree) to a new parent and/or position. parent_id
 *  null makes it a root branch. Rejects moving a node into its own descendant. */
export function moveSmartTodoNode(
  id: number,
  newParentId: number | null,
  newSortOrder: number,
): SmartTodoNodeRow | null {
  const node = getSmartTodoNode(id);
  if (!node) return null;

  let newRootId: number;
  if (newParentId === null) {
    newRootId = id; // becomes its own root
  } else {
    const parent = getSmartTodoNode(newParentId);
    if (!parent) throw new Error(`target parent ${newParentId} not found`);
    if (subtreeIds(id).includes(newParentId)) throw new Error('cannot move a node into its own descendant');
    newRootId = parent.root_id;
  }

  const run = sqliteDb.transaction(() => {
    setParentStmt.run(newParentId, newRootId, Math.max(0, Math.floor(newSortOrder)), id);
    // Propagate the new root_id to the entire moved subtree.
    if (newRootId !== node.root_id) {
      sqliteDb
        .prepare<[number, number]>(`
          WITH RECURSIVE sub(id) AS (
            SELECT id FROM smart_todo_nodes WHERE id = ?
            UNION ALL
            SELECT n.id FROM smart_todo_nodes n JOIN sub ON n.parent_id = sub.id
          )
          UPDATE smart_todo_nodes SET root_id = ? WHERE id IN (SELECT id FROM sub)
        `)
        .run(id, newRootId);
    }
    // Re-pack siblings under the new parent so sort_order stays gap-free.
    const siblings = sqliteDb
      .prepare<[number | null, number], { id: number }>(
        `SELECT id FROM smart_todo_nodes WHERE parent_id IS ? AND id != ? ORDER BY sort_order ASC, id ASC`,
      )
      .all(newParentId, id);
    const ordered: number[] = [];
    const target = Math.max(0, Math.min(Math.floor(newSortOrder), siblings.length));
    siblings.slice(0, target).forEach((s) => ordered.push(s.id));
    ordered.push(id);
    siblings.slice(target).forEach((s) => ordered.push(s.id));
    const repack = sqliteDb.prepare<[number, number]>(`UPDATE smart_todo_nodes SET sort_order = ? WHERE id = ?`);
    ordered.forEach((nid, i) => repack.run(i, nid));
  });
  run();
  touchStmt.run(id);
  emit('bulk');
  return getSmartTodoNode(id);
}

const deleteSubtreeStmt = sqliteDb.prepare<[number]>(`
  WITH RECURSIVE sub(id) AS (
    SELECT id FROM smart_todo_nodes WHERE id = ?
    UNION ALL
    SELECT n.id FROM smart_todo_nodes n JOIN sub ON n.parent_id = sub.id
  )
  DELETE FROM smart_todo_nodes WHERE id IN (SELECT id FROM sub)
`);

/** Delete a node and its entire subtree. Returns the removed root row. */
export function deleteSmartTodoNode(id: number): SmartTodoNodeRow | null {
  const row = getSmartTodoNode(id);
  if (!row) return null;
  deleteSubtreeStmt.run(id);
  emit('deleted', row);
  return row;
}
