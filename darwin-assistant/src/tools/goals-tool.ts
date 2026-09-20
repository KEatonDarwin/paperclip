import type { ToolDef } from './index.js';
import {
  GoalError,
  listGoals,
  getGoalTree,
  patchGoal,
  createGoalNode,
  proposeGoalNodes,
  acceptGoalNode,
  acceptGoalBatch,
  acceptAllGoalNodes,
  pushBackGhost,
  discardGoalNode,
  discardGoalBatch,
  patchGoalNode,
  proposeEdit,
  proposeRemoval,
  setLeafKind,
  proposePlan,
  approvePlan,
  verifyGoal,
  verifyGoalNode,
  humanDoneNode,
  parkGoal,
  unparkGoal,
  parkGoalNode,
  unparkGoalNode,
  promoteNode,
  setGoalFocus,
  getGoalFocus,
  requireGoal,
  insertEvent,
  emitGoal,
  type GoalTree,
} from '../goals.js';

// GOALS tool (CONTRACT.md §5) — the ONLY way a goal chat touches the tree.
// Scope resolution: inside a `cockpit:goal-<id>` thread, goal_id is IMPLIED
// from context.externalId and any args.goal_id is ignored; outside a goal
// thread, goal_id is required on every op except `list` (list without a
// goal_id returns the whole forest).

function implicitGoalId(externalId: string | undefined): number | null {
  const m = externalId ? /^cockpit:goal-(\d+)$/.exec(externalId) : null;
  return m ? Number(m[1]) : null;
}

function resolveGoalId(externalId: string | undefined, argsGoalId: unknown): number | null {
  const implied = implicitGoalId(externalId);
  if (implied != null) return implied;
  const n = Number(argsGoalId);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function errorResult(err: unknown): { error: string; code?: string } {
  if (err instanceof GoalError) return { error: err.message, code: err.code };
  return { error: err instanceof Error ? err.message : String(err) };
}

const TRIMMED_NODE_KEYS = [
  'id', 'parent_id', 'title', 'done_means', 'state', 'leaf_kind', 'plan_state',
  'tree_id', 'tree_status_cache', 'pending_title', 'pending_done_means',
  'pending_removal', 'pending_by', 'proposal_batch', 'depth', 'child_count', 'authored_by',
  // v0.1 §11 — so JARVIS can see Kevin's edits + the weigh-in state in `list`.
  'last_edited_by', 'review_state', 'review_note', 'kevin_edit_original',
] as const;

function trimTree(tree: GoalTree): unknown {
  return {
    goal: tree.goal,
    focus: tree.focus,
    nodes: tree.nodes.map((n) => {
      const out: Record<string, unknown> = {};
      for (const k of TRIMMED_NODE_KEYS) out[k] = (n as unknown as Record<string, unknown>)[k];
      return out;
    }),
  };
}

export const goals: ToolDef = {
  name: 'goals',
  description:
    "Touch Kevin's Goal tree — the goal-driven development surface (one thread per root goal, split chat|tree UI at /goals). " +
    'THE RULE: propose for anything not dictated verbatim by Kevin. `set_from_kevin` is ONLY for a node Kevin literally ' +
    'spelled out (title + what done means) in this conversation; everything you think of, infer, reword, split, or remove ' +
    'goes through propose / propose_edit / propose_remove and renders as a ghost until he ✓s it. Never create ' +
    'grandchildren: propose children only under the focused node or a node he named, one layer at a time. Every proposed ' +
    'node MUST carry a one-line done_means. While a proposal is still a ghost, reword it in place with `edit_ghost` as you and '+
    'Kevin talk it through (that is the "watch it change until I am good with it" loop) — do NOT discard and re-propose. ' +
    'When KEVIN edits one of your ghosts and OKs it, it does NOT solidify until you weigh in (§11): `accept` {node_id} to agree ' +
    '(it sets), or `push_back` {node_id, note} with your reason to keep it a ghost and talk it out. Inside a goal thread ' +
    '(cockpit:goal-<id>), goal_id and the default parent_id (the current focus) are inferred automatically — omit goal_id there.',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'list', 'set_goal_done_means', 'propose', 'set_from_kevin', 'accept', 'push_back', 'discard',
          'edit_ghost', 'propose_edit', 'propose_remove', 'set_leaf_kind', 'propose_plan', 'dispatch',
          'verify', 'human_done', 'park', 'unpark', 'log', 'promote', 'focus',
        ],
        description: 'What to do.',
      },
      goal_id: { type: 'number', description: 'Required outside a goal thread (except for list, which lists the forest without it). Ignored inside a goal thread.' },
      node_id: { type: 'number', description: 'Target node id, where applicable.' },
      parent_id: { type: ['number', 'null'], description: 'Parent node id for propose/set_from_kevin. Omit to default to the current focus node (inside a goal thread) or root-level.' },
      batch_id: { type: 'string', description: 'Target proposal batch id, for accept/discard.' },
      all: { type: 'boolean', description: "For accept: accept every ghost in scope instead of one node/batch." },
      items: {
        type: 'array',
        description: 'For propose: 1-12 items, each {title, done_means, notes?, leaf_kind?}. No nesting — one layer at a time.',
        items: { type: 'object' },
      },
      title: { type: 'string', description: 'Node title (set_from_kevin, propose_edit).' },
      done_means: { type: 'string', description: 'One-line done_means (set_from_kevin, propose_edit, set_goal_done_means).' },
      notes: { type: 'string', description: 'Optional notes (set_from_kevin).' },
      leaf_kind: { type: 'string', enum: ['none', 'machine', 'human'], description: 'For set_leaf_kind / set_from_kevin.' },
      plan: { type: 'object', description: 'PlanJson for propose_plan: {what, deliverable, model, estimate?, nodes:[{title, spec?, adapter?, model?, depends_on_indexes?}]}. adapter defaults to claude; never fable.' },
      passed: { type: 'boolean', description: 'For verify: true=done, false=reopen.' },
      note: { type: 'string', description: 'For verify/human_done: optional. For push_back: REQUIRED — your reason, one or two sentences.' },
      reason: { type: 'string', description: 'Optional reason (discard, propose_remove).' },
      text: { type: 'string', description: 'Log line text, for the log op.' },
      goal: { type: 'boolean', description: 'For verify: true = verify the GOAL root (node_id omitted) rather than a node.' },
    },
    required: ['operation'],
  },
  execute: async (args, context) => {
    const op = typeof args.operation === 'string' ? args.operation : '';
    const externalId = context?.externalId;
    const inGoalThread = implicitGoalId(externalId) != null;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

    const resolveParentId = (goalId: number): number | null => {
      if ('parent_id' in args && args.parent_id !== undefined) {
        return args.parent_id === null ? null : Number(args.parent_id);
      }
      if (!inGoalThread) return null;
      // Default = the focused node, but never a node that cannot take children
      // (ghost/discarded/parked/done): walk up to the nearest set-ish ancestor,
      // else the goal root. Prevents the "parent node is discarded" 409 when
      // Kevin's focus is still parked on a ghost he just discarded.
      const ok = new Set(['set', 'planned', 'working', 'check']);
      let cur = getGoalFocus(goalId).node_id;
      const tree = getGoalTree(goalId, true);
      if (!tree) return null;
      const byId = new Map(tree.nodes.map((n) => [n.id, n]));
      while (cur != null) {
        const n = byId.get(cur);
        if (!n) return null;
        if (ok.has(n.state)) return cur;
        cur = n.parent_id;
      }
      return null;
    };

    // -- list: only op that works with no goal_id at all (outside a thread) ---
    if (op === 'list') {
      const goalId = resolveGoalId(externalId, args.goal_id);
      if (goalId == null) return { goals: listGoals() };
      const tree = getGoalTree(goalId);
      if (!tree) return { error: `goal ${goalId} not found` };
      return trimTree(tree);
    }

    const goalId = resolveGoalId(externalId, args.goal_id);
    if (goalId == null) {
      return { error: 'goal_id is required (or call this tool from inside the goal\'s own thread)' };
    }

    try {
      if (op === 'set_goal_done_means') {
        const doneMeans = str(args.done_means);
        if (!doneMeans) return { error: 'done_means is required' };
        return { goal: patchGoal(goalId, { done_means: doneMeans, actor: 'jarvis' }) };
      }

      if (op === 'propose') {
        const items = Array.isArray(args.items) ? args.items : null;
        if (!items) return { error: 'items is required: an array of {title, done_means, notes?, leaf_kind?}' };
        return proposeGoalNodes(goalId, {
          parent_id: resolveParentId(goalId),
          items: items as Array<{ title: string; done_means: string; notes?: string; leaf_kind?: unknown }>,
          actor: 'jarvis',
        });
      }

      if (op === 'set_from_kevin') {
        const title = str(args.title);
        const doneMeans = str(args.done_means);
        if (!title || !doneMeans) return { error: 'title and done_means are required (Kevin must have stated both verbatim)' };
        const node = createGoalNode(goalId, {
          title,
          done_means: doneMeans,
          notes: str(args.notes) ?? null,
          parent_id: resolveParentId(goalId),
          authored_by: 'kevin',
          leaf_kind: args.leaf_kind,
          actor: 'jarvis',
        });
        return { node };
      }

      if (op === 'accept') {
        if (args.all === true) {
          const parentId = 'parent_id' in args ? (args.parent_id === null ? null : Number(args.parent_id)) : undefined;
          return { nodes: acceptAllGoalNodes(goalId, parentId, 'jarvis') };
        }
        const batchId = str(args.batch_id);
        if (batchId) return { nodes: acceptGoalBatch(goalId, batchId, undefined, 'jarvis') };
        if (args.node_id !== undefined) return { node: acceptGoalNode(goalId, Number(args.node_id), 'jarvis') };
        return { error: 'accept needs node_id, batch_id, or all:true — and only when Kevin actually said yes' };
      }

      if (op === 'push_back') {
        // §11.2 — disagree with Kevin's OK'd edit: stays a ghost, note shown, talk it out.
        if (args.node_id === undefined) return { error: 'node_id is required' };
        const note = str(args.note);
        if (!note) return { error: 'push_back requires a note — your reason in one or two sentences' };
        return { node: pushBackGhost(goalId, Number(args.node_id), note, 'jarvis') };
      }

      if (op === 'discard') {
        const batchId = str(args.batch_id);
        if (batchId) return { nodes: discardGoalBatch(goalId, batchId, undefined, 'jarvis') };
        if (args.node_id !== undefined) return { node: discardGoalNode(goalId, Number(args.node_id), str(args.reason), 'jarvis') };
        return { error: 'discard needs node_id or batch_id' };
      }

      if (op === 'edit_ghost') {
        // A ghost is JARVIS's own not-yet-approved proposal, so it may be
        // reworded in place while Kevin talks it through (CONTRACT route 16:
        // actor='jarvis' PATCH is permitted on ghosts ONLY — the server 403s
        // `jarvis_must_propose` on anything already set).
        if (args.node_id === undefined) return { error: 'node_id is required' };
        if (args.title === undefined && args.done_means === undefined && args.notes === undefined) {
          return { error: 'edit_ghost needs at least one of title/done_means/notes' };
        }
        return {
          node: patchGoalNode(goalId, Number(args.node_id), {
            title: str(args.title),
            done_means: str(args.done_means),
            notes: str(args.notes),
            actor: 'jarvis',
          }),
        };
      }

      if (op === 'propose_edit') {
        if (args.node_id === undefined) return { error: 'node_id is required' };
        return { node: proposeEdit(goalId, Number(args.node_id), { title: str(args.title), done_means: str(args.done_means), actor: 'jarvis' }) };
      }

      if (op === 'propose_remove') {
        if (args.node_id === undefined) return { error: 'node_id is required' };
        return { node: proposeRemoval(goalId, Number(args.node_id), str(args.reason), 'jarvis') };
      }

      if (op === 'set_leaf_kind') {
        if (args.node_id === undefined) return { error: 'node_id is required' };
        if (args.leaf_kind !== 'none' && args.leaf_kind !== 'machine' && args.leaf_kind !== 'human') {
          return { error: "leaf_kind must be 'none', 'machine', or 'human'" };
        }
        return { node: setLeafKind(goalId, Number(args.node_id), args.leaf_kind, 'jarvis') };
      }

      if (op === 'propose_plan') {
        if (args.node_id === undefined) return { error: 'node_id is required' };
        const rawPlan = args.plan;
        if (!rawPlan || typeof rawPlan !== 'object') return { error: 'plan (object) is required' };
        // Pre-check for a clean error message; the server re-validates authoritatively.
        const nodesArr = Array.isArray((rawPlan as Record<string, unknown>).nodes)
          ? ((rawPlan as Record<string, unknown>).nodes as Record<string, unknown>[])
          : [];
        for (const n of nodesArr) {
          if (!n.adapter) n.adapter = 'claude';
          const adapter = typeof n.adapter === 'string' ? n.adapter : 'claude';
          if (adapter !== 'claude') return { error: `plan node adapter must be 'claude', got '${adapter}'` };
          const model = typeof n.model === 'string' ? n.model : '';
          if (/fable/i.test(model)) return { error: `plan node model must not be a fable/frontier planner model: ${model}` };
        }
        return { node: proposePlan(goalId, Number(args.node_id), rawPlan, 'jarvis') };
      }

      if (op === 'dispatch') {
        if (args.node_id === undefined) return { error: 'node_id is required' };
        return approvePlan(goalId, Number(args.node_id), 'jarvis');
      }

      if (op === 'verify') {
        if (typeof args.passed !== 'boolean') return { error: 'passed (boolean) is required' };
        if (args.goal === true) {
          return verifyGoal(goalId, args.passed, str(args.note), 'jarvis');
        }
        if (args.node_id === undefined) return { error: 'node_id is required (or pass goal:true to verify the goal root)' };
        return { node: verifyGoalNode(goalId, Number(args.node_id), args.passed, str(args.note), 'jarvis') };
      }

      if (op === 'human_done') {
        if (args.node_id === undefined) return { error: 'node_id is required — only when Kevin said he did it' };
        return { node: humanDoneNode(goalId, Number(args.node_id), str(args.note), 'jarvis') };
      }

      if (op === 'park' || op === 'unpark') {
        if (args.node_id !== undefined) {
          const node = op === 'park'
            ? parkGoalNode(goalId, Number(args.node_id), 'jarvis')
            : unparkGoalNode(goalId, Number(args.node_id), 'jarvis');
          return { node };
        }
        const goal = op === 'park' ? parkGoal(goalId, 'jarvis') : unparkGoal(goalId, 'jarvis');
        return { goal };
      }

      if (op === 'log') {
        const text = str(args.text);
        if (!text) return { error: 'text is required' };
        requireGoal(goalId);
        const nodeId = args.node_id !== undefined ? Number(args.node_id) : null;
        insertEvent(goalId, nodeId, 'jarvis', 'log', text);
        emitGoal('updated', goalId);
        return { event: { goal_id: goalId, node_id: nodeId, actor: 'jarvis', kind: 'log', text } };
      }

      if (op === 'promote') {
        if (args.node_id === undefined) return { error: 'node_id is required' };
        const result = promoteNode(goalId, Number(args.node_id), 'jarvis');
        // Tool-side only (CONTRACT §5 `promote` row): post the seed via the
        // internal ingest so the promoted goal's chat boots without a second
        // round trip. Dynamic import avoids a static agent.ts<->tools cycle
        // (agent.ts already imports tools/index.ts, which imports this file).
        import('../agent.js')
          .then(({ processMessage }) => processMessage(result.thread.seed_text, result.thread.external_id))
          .catch((err) => console.error('[goals-tool] promote seed post failed', err));
        return result;
      }

      if (op === 'focus') {
        if (!('node_id' in args)) return { error: 'node_id is required (number or null)' };
        const nodeId = args.node_id === null ? null : Number(args.node_id);
        return { focus: setGoalFocus(goalId, nodeId, 'jarvis') };
      }

      return { error: `unknown operation: ${op || '(none)'}` };
    } catch (err) {
      return errorResult(err);
    }
  },
};
