import type { ToolDef } from './index.js';
import { getConversationById } from '../conversation-db.js';
import {
  listSmartTodoNodes,
  createSmartTodoNode,
  updateSmartTodoNode,
  deleteSmartTodoNode,
  getSmartTodoByThread,
  insertSmartTodoTree,
  type SmartTodoStatus,
} from '../smart-todos.js';
import { decomposeNote } from '../smart-todos-decompose.js';

// SMART TODO TREE tool — lets JARVIS read and maintain Kevin's standalone smart
// todo tree from inside any thread, so work done in a chat REFLECTS BACK into
// the always-open list. Deliberately light: the tree is Kevin's curated backlog,
// not a mirror of every thread — only touch it when the thread is genuinely
// about a tree item (use 'sync' to update the node this thread was opened from)
// or when Kevin asks you to add/adjust something on the list.
export const smartTodos: ToolDef = {
  name: 'smart_todos',
  description:
    "Read and maintain Kevin's standalone Smart Todo Tree — his always-open, curated backlog of nested ideas/tasks (separate from any one thread). Use 'sync' to reflect progress on THIS thread's tree item back into the list (when the thread was opened from a node). Otherwise use it when Kevin asks to add/adjust something on the list. Don't mirror routine thread work here. Operations: 'list' (the whole tree), 'jot' (a note → decomposed into a main idea + nested subitems, added as a new branch; needs note), 'add' (one node; needs title, optional parent_id), 'update' (needs node_id; optional title/notes/status), 'complete' (needs node_id), 'delete' (needs node_id; removes it + its subtree), 'sync' (update the node linked to the current thread; optional status and append_note).",
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['list', 'jot', 'add', 'update', 'complete', 'delete', 'sync'],
        description: 'What to do.',
      },
      note: { type: 'string', description: 'Raw note to decompose into a new branch. Required for jot.' },
      title: { type: 'string', description: 'Node title. Required for add.' },
      parent_id: { type: 'number', description: 'Parent node id for add (omit to add a new root branch).' },
      node_id: { type: 'number', description: 'Target node id. Required for update/complete/delete.' },
      notes: { type: 'string', description: 'Elaboration/notes for the node (update).' },
      status: { type: 'string', enum: ['open', 'doing', 'done'], description: 'New status (update/sync).' },
      append_note: { type: 'string', description: 'For sync: text to append to the linked node\'s notes (progress log).' },
    },
    required: ['operation'],
  },
  execute: async (args, context) => {
    const op = typeof args.operation === 'string' ? args.operation : '';
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

    if (op === 'list') {
      return { nodes: listSmartTodoNodes() };
    }

    if (op === 'jot') {
      const note = str(args.note);
      if (!note) return { error: 'jot needs a note' };
      const tree = await decomposeNote(note);
      const root = insertSmartTodoTree(note, tree);
      return { ok: true, root, nodes: listSmartTodoNodes() };
    }

    if (op === 'add') {
      const title = str(args.title);
      if (!title) return { error: 'add needs a title' };
      const node = createSmartTodoNode({
        title,
        parent_id: num(args.parent_id),
        notes: str(args.notes),
        origin: 'jarvis',
      });
      return { ok: true, node };
    }

    if (op === 'update') {
      const id = num(args.node_id);
      if (id === null) return { error: 'update needs a node_id' };
      const status = str(args.status);
      const node = updateSmartTodoNode(id, {
        title: str(args.title) ?? undefined,
        notes: args.notes !== undefined ? str(args.notes) : undefined,
        status: status ? (status as SmartTodoStatus) : undefined,
      });
      return node ? { ok: true, node } : { error: `node ${id} not found` };
    }

    if (op === 'complete') {
      const id = num(args.node_id);
      if (id === null) return { error: 'complete needs a node_id' };
      const node = updateSmartTodoNode(id, { status: 'done' });
      return node ? { ok: true, node } : { error: `node ${id} not found` };
    }

    if (op === 'delete') {
      const id = num(args.node_id);
      if (id === null) return { error: 'delete needs a node_id' };
      const removed = deleteSmartTodoNode(id);
      return removed ? { ok: true, removed } : { error: `node ${id} not found` };
    }

    if (op === 'sync') {
      const convId = context?.conversationId;
      if (typeof convId !== 'number') return { error: 'sync only works inside a thread' };
      const ext = getConversationById(convId)?.external_id;
      if (!ext) return { error: 'could not resolve the current thread' };
      const node = getSmartTodoByThread(ext);
      if (!node) return { error: 'this thread is not linked to a smart-todo node' };
      const status = str(args.status);
      const append = str(args.append_note);
      const nextNotes = append
        ? [node.notes, append].filter(Boolean).join('\n')
        : undefined;
      const updated = updateSmartTodoNode(node.id, {
        status: status ? (status as SmartTodoStatus) : undefined,
        notes: nextNotes,
      });
      return { ok: true, node: updated };
    }

    return { error: `unknown operation: ${op || '(none)'}` };
  },
};
