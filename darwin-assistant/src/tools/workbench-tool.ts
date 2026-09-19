import type { ToolDef } from './index.js';
import {
  getSmartTodoNode,
  createSmartTodoNode,
  updateSmartTodoNode,
  moveSmartTodoNode,
  appendSmartTodoContext,
  type SmartTodoNodeRow,
  type SmartTodoStatus,
} from '../smart-todos.js';
import {
  insertUnderParent,
  resolveWorkbenchToolScope,
  assertWorkbenchScope,
  touchWorkbenchActivity,
  readAncestorSummary,
  proposeBatch,
  updateWorkbenchProposal,
  deleteProposalCascade,
  acceptProposalBatch,
  getWorkbenchProposal,
  type DecompositionItem,
  type WorkbenchProposalRow,
} from '../workbench.js';

// WORKBENCH tool — lets a chat that's ZOOMED INTO a branch of the idea tree
// create/read/update items in that branch as the conversation happens (spec
// §3), instead of Kevin juggling a pile of separate chats. See
// docs/workbench/SPEC.md §2-4 and RECON.md §4 for the design this implements.
//
// SCOPE: which node this tool call is allowed to touch is resolved from the
// CALLING THREAD's own binding (its linked_thread_ext → a smart_todo_nodes
// row), NOT from an argument the model passes — a scoped chat cannot claim a
// wider scope than the branch it was opened on. A thread with no such binding
// (e.g. the workbench-root sentinel chat, or any ordinary thread) gets root/
// whole-tree scope, unrestricted — same exposure model as the pre-existing
// `smart_todos` tool.

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function serializeAncestor(n: SmartTodoNodeRow): Record<string, unknown> {
  return { id: n.id, title: n.title, notes: n.notes };
}

function serializeNode(n: SmartTodoNodeRow): Record<string, unknown> {
  return {
    id: n.id,
    parent_id: n.parent_id,
    title: n.title,
    status: n.status,
    notes: n.notes,
    context_notes: n.context_notes,
    sort_order: n.sort_order,
  };
}

function sanitizeChildren(raw: unknown, depth = 0): DecompositionItem[] {
  if (depth > 8 || !Array.isArray(raw)) return [];
  const out: DecompositionItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = str(r.title);
    if (!title) continue;
    out.push({
      title: title.slice(0, 500),
      notes: str(r.notes),
      children: sanitizeChildren(r.children, depth + 1),
    });
  }
  return out;
}

function numArray(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return out.length ? out : undefined;
}

function serializeProposal(p: WorkbenchProposalRow): Record<string, unknown> {
  return {
    id: p.id,
    batch_id: p.batch_id,
    parent_node_id: p.parent_node_id,
    parent_proposal_id: p.parent_proposal_id,
    title: p.title,
    notes: p.notes,
    sort_order: p.sort_order,
  };
}

export const workbench: ToolDef = {
  name: 'workbench',
  description:
    "Create, read, and update items in Kevin's idea tree from INSIDE a scoped Workbench chat — the tree " +
    "is the place he works, not a pile of separate chats. Every op is auto-scoped to whichever branch " +
    "THIS thread is zoomed into (resolved server-side from how the chat was opened, not from anything you " +
    "pass) — write ops outside that branch are REFUSED with a plain error; if that happens, just tell " +
    "Kevin what you wanted to change and where, instead of trying to route around it. A thread with no " +
    "branch binding (e.g. the root chat) is unrestricted. Operations: 'list_scope' (your current focus " +
    "node + its full subtree + the ancestor chain above it — call this if you need to refresh what you " +
    "can see), 'add_child' (one new item under a node in scope — defaults to your focus node if parent_id " +
    "omitted; needs title), 'split' (decompose ONE existing node in scope into child items you've already " +
    "worked out in conversation — needs node_id, children: [{title, notes?, children?}]), 'update' (title/" +
    "notes on a node in scope — needs node_id), 'set_status' (needs node_id + status), 'move' (re-parent a " +
    "node WITHIN your scope — needs node_id + new_parent_id, null only allowed from root scope), " +
    "'write_context' (**do this at the end of any turn where something real happened** — appends a short " +
    "machine-written outcome note to a node's context_notes, defaulting to your focus node; this is what " +
    "lets the tree carry memory forward instead of the transcript, needs text), 'read_up' (ON DEMAND ONLY " +
    "— pulls an ancestor node's chat SUMMARY, never its transcript, for when you genuinely need context " +
    "from above your branch; needs node_id, must be one of your current ancestors). " +
    "PROPOSALS (the ghost layer — draft nodes Kevin corrects before they become real): " +
    "**any time you're creating MORE THAN ONE node at once — a multi-item breakdown of something Kevin " +
    "described vaguely — you MUST use 'propose_batch', never add_child/split, for every item. A single " +
    "node Kevin explicitly and unambiguously asked for may still go straight to add_child.** " +
    "'propose_batch' (stage a decomposition as pending ghosts instead of real nodes — needs items: " +
    "[{title, notes?, children?}], optional parent_id (a REAL node in scope; omit for your focus node, or " +
    "pass null only from root scope for new top-level branches) — items/children can nest, nested items " +
    "become nested ghosts under their parent item, not real nodes), 'update_proposal' (edit a still-pending " +
    "ghost's title/notes — needs proposal_id), 'delete_proposal' (discard ONE ghost + anything nested under " +
    "it — needs proposal_id), 'accept_batch' (materialize some or all of a batch into real nodes — needs " +
    "batch_id, optional ids to accept only some of the batch (accepting a nested ghost also accepts its " +
    "ghost ancestors) — **only call this when Kevin has actually said yes/approved in this conversation; " +
    "never accept a batch unprompted, even one you just proposed**).",
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'list_scope', 'add_child', 'split', 'update', 'set_status', 'move', 'write_context', 'read_up',
          'propose_batch', 'update_proposal', 'delete_proposal', 'accept_batch',
        ],
        description: 'What to do.',
      },
      node_id: {
        type: 'number',
        description:
          'Target node id. Required for split/update/set_status/move/read_up. For write_context, omit to ' +
          'target your own focus node.',
      },
      parent_id: {
        type: 'number',
        description: 'Parent node id for add_child. Omit to add under your current focus node.',
      },
      title: { type: 'string', description: 'Node title. Required for add_child.' },
      notes: { type: 'string', description: "Elaboration/notes for the node (add_child/update)." },
      status: { type: 'string', enum: ['open', 'doing', 'done'], description: 'New status. Required for set_status.' },
      children: {
        type: 'array',
        description:
          'Decomposition to attach under node_id. Required for split. Each item: {title, notes?, children?} ' +
          '(children can nest further).',
        items: { type: 'object' },
      },
      new_parent_id: {
        type: ['number', 'null'],
        description:
          'Destination parent for move. Required (may be explicit null to make a node top-level, only ' +
          'permitted when you are at root scope).',
      },
      sort_order: { type: 'number', description: 'Position among the new siblings for move. Defaults to 0.' },
      text: { type: 'string', description: 'The 1-3 line outcome note. Required for write_context.' },
      items: {
        type: 'array',
        description:
          'The decomposition to propose. Required for propose_batch. Each item: {title, notes?, children?} ' +
          '(children nest further as ghost items, not real nodes).',
        items: { type: 'object' },
      },
      proposal_id: {
        type: 'number',
        description: 'Target proposal id. Required for update_proposal and delete_proposal.',
      },
      batch_id: { type: 'string', description: 'Target batch id. Required for accept_batch.' },
      ids: {
        type: 'array',
        items: { type: 'number' },
        description: 'For accept_batch: specific proposal ids to accept. Omit to accept the whole batch.',
      },
    },
    required: ['operation'],
  },
  execute: async (args, context) => {
    const op = typeof args.operation === 'string' ? args.operation : '';
    const toolScope = resolveWorkbenchToolScope(context?.externalId ?? null);

    if (op === 'list_scope') {
      return {
        focus_id: toolScope.focusId,
        node: toolScope.scope.node ? serializeNode(toolScope.scope.node) : null,
        ancestors: toolScope.scope.ancestors.map(serializeAncestor),
        subtree: toolScope.scope.subtree.map(serializeNode),
      };
    }

    if (op === 'add_child') {
      const title = str(args.title);
      if (!title) return { error: 'add_child needs a title' };
      const parentId = num(args.parent_id) ?? toolScope.focusId;
      if (parentId !== null) {
        const guard = assertWorkbenchScope(toolScope, parentId);
        if (!guard.ok) return { error: guard.error };
        if (!getSmartTodoNode(parentId)) return { error: `parent node ${parentId} not found` };
      }
      const node = createSmartTodoNode({ parent_id: parentId, title, notes: str(args.notes), origin: 'workbench' });
      touchWorkbenchActivity(node.id);
      return { ok: true, node: serializeNode(node) };
    }

    if (op === 'split') {
      const targetId = num(args.node_id) ?? toolScope.focusId;
      if (targetId === null) return { error: 'split needs a node_id (there is nothing to split at root scope)' };
      const guard = assertWorkbenchScope(toolScope, targetId);
      if (!guard.ok) return { error: guard.error };
      if (!getSmartTodoNode(targetId)) return { error: `node ${targetId} not found` };
      const children = sanitizeChildren(args.children);
      if (!children.length) return { error: 'split needs a non-empty children array with at least one {title}' };
      const created = children.map((item) => insertUnderParent(targetId, item));
      touchWorkbenchActivity(targetId);
      return { ok: true, created: created.map(serializeNode) };
    }

    if (op === 'update') {
      const id = num(args.node_id);
      if (id === null) return { error: 'update needs a node_id' };
      const guard = assertWorkbenchScope(toolScope, id);
      if (!guard.ok) return { error: guard.error };
      const title = str(args.title);
      const node = updateSmartTodoNode(id, {
        title: title ?? undefined,
        notes: args.notes !== undefined ? str(args.notes) : undefined,
      });
      if (!node) return { error: `node ${id} not found` };
      touchWorkbenchActivity(id);
      return { ok: true, node: serializeNode(node) };
    }

    if (op === 'set_status') {
      const id = num(args.node_id);
      const status = str(args.status);
      if (id === null) return { error: 'set_status needs a node_id' };
      if (!status) return { error: 'set_status needs a status' };
      const guard = assertWorkbenchScope(toolScope, id);
      if (!guard.ok) return { error: guard.error };
      const node = updateSmartTodoNode(id, { status: status as SmartTodoStatus });
      if (!node) return { error: `node ${id} not found` };
      touchWorkbenchActivity(id);
      return { ok: true, node: serializeNode(node) };
    }

    if (op === 'move') {
      const id = num(args.node_id);
      if (id === null) return { error: 'move needs a node_id' };
      const guard = assertWorkbenchScope(toolScope, id);
      if (!guard.ok) return { error: guard.error };
      if (!Object.prototype.hasOwnProperty.call(args, 'new_parent_id')) {
        return { error: 'move needs new_parent_id (a node id, or null to make it top-level)' };
      }
      const rawNewParent = args.new_parent_id;
      let newParentId: number | null;
      if (rawNewParent === null) {
        newParentId = null;
      } else if (typeof rawNewParent === 'number' && Number.isFinite(rawNewParent)) {
        newParentId = rawNewParent;
      } else {
        return { error: 'new_parent_id must be a node id or null' };
      }
      if (newParentId === null) {
        if (toolScope.allowedIds !== null) {
          return {
            error:
              "Can't move that out of your branch to become a new top-level item while you're zoomed in — " +
              'zoom out to the root chat first if that\'s really what Kevin wants.',
          };
        }
      } else {
        const destGuard = assertWorkbenchScope(toolScope, newParentId);
        if (!destGuard.ok) return { error: destGuard.error };
        if (!getSmartTodoNode(newParentId)) return { error: `target parent ${newParentId} not found` };
      }
      let node: SmartTodoNodeRow | null;
      try {
        node = moveSmartTodoNode(id, newParentId, num(args.sort_order) ?? 0);
      } catch (err) {
        return { error: (err as Error).message };
      }
      if (!node) return { error: `node ${id} not found` };
      touchWorkbenchActivity(id);
      return { ok: true, node: serializeNode(node) };
    }

    if (op === 'write_context') {
      const text = str(args.text);
      if (!text) return { error: 'write_context needs text' };
      const id = num(args.node_id) ?? toolScope.focusId;
      if (id === null) {
        return { error: "write_context needs a node_id at root scope — there's no single focus node to attach it to" };
      }
      const guard = assertWorkbenchScope(toolScope, id);
      if (!guard.ok) return { error: guard.error };
      const node = appendSmartTodoContext(id, text);
      if (!node) return { error: `node ${id} not found` };
      return { ok: true, node: serializeNode(node) };
    }

    if (op === 'read_up') {
      const id = num(args.node_id);
      if (id === null) return { error: 'read_up needs a node_id (one of your ancestors)' };
      if (toolScope.focusId === null) {
        return { error: "You're at the root scope — there's nothing above you to read up into." };
      }
      const isAncestor = toolScope.scope.ancestors.some((a) => a.id === id);
      if (!isAncestor) {
        return {
          error:
            `Node ${id} is not one of your ancestors. read_up only reaches straight up the chain above your ` +
            'current focus node.',
        };
      }
      const result = readAncestorSummary(id);
      if (!result) return { error: `ancestor node ${id} not found` };
      return {
        ok: true,
        node: { id: result.node.id, title: result.node.title },
        summary: result.summary,
        note: result.note,
      };
    }

    if (op === 'propose_batch') {
      const items = sanitizeChildren(args.items);
      if (!items.length) return { error: 'propose_batch needs a non-empty items array with at least one {title}' };
      let parentNodeId: number | null;
      if (Object.prototype.hasOwnProperty.call(args, 'parent_id') && args.parent_id !== undefined) {
        if (args.parent_id === null) {
          if (toolScope.allowedIds !== null) {
            return {
              error:
                "Can't propose a new top-level branch while you're zoomed in — zoom out to the root chat " +
                "first if that's really what Kevin wants.",
            };
          }
          parentNodeId = null;
        } else if (typeof args.parent_id === 'number' && Number.isFinite(args.parent_id)) {
          parentNodeId = args.parent_id;
          const guard = assertWorkbenchScope(toolScope, parentNodeId);
          if (!guard.ok) return { error: guard.error };
          if (!getSmartTodoNode(parentNodeId)) return { error: `parent node ${parentNodeId} not found` };
        } else {
          return { error: 'parent_id must be a node id or null' };
        }
      } else {
        parentNodeId = toolScope.focusId;
      }
      const { batch_id, proposals } = proposeBatch(items, { parentNodeId, createdByThread: context?.externalId ?? null });
      return { ok: true, batch_id, proposals: proposals.map(serializeProposal) };
    }

    if (op === 'update_proposal') {
      const id = num(args.proposal_id);
      if (id === null) return { error: 'update_proposal needs a proposal_id' };
      if (!getWorkbenchProposal(id)) return { error: `proposal ${id} not found` };
      const title = str(args.title);
      const updated = updateWorkbenchProposal(id, {
        title: title ?? undefined,
        notes: args.notes !== undefined ? str(args.notes) : undefined,
      });
      if (!updated) return { error: `proposal ${id} not found` };
      return { ok: true, proposal: serializeProposal(updated) };
    }

    if (op === 'delete_proposal') {
      const id = num(args.proposal_id);
      if (id === null) return { error: 'delete_proposal needs a proposal_id' };
      if (!getWorkbenchProposal(id)) return { error: `proposal ${id} not found` };
      const removed = deleteProposalCascade(id);
      return { ok: true, removed };
    }

    if (op === 'accept_batch') {
      const batchId = str(args.batch_id);
      if (!batchId) return { error: 'accept_batch needs a batch_id' };
      const ids = numArray(args.ids);
      try {
        const { created } = acceptProposalBatch(batchId, ids);
        for (const node of created) touchWorkbenchActivity(node.id);
        return { ok: true, created: created.map(serializeNode) };
      } catch (err) {
        return { error: (err as Error).message };
      }
    }

    return { error: `unknown operation: ${op || '(none)'}` };
  },
};
