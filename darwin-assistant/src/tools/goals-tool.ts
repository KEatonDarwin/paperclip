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
  moveGoalNode,
  proposeMove,
  setLeafKind,
  proposePlanEx,
  approvePlan,
  setGoalAutopilot,
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
  resolveGoalScope,
  isNodeInSubtree,
  getOrCreateNodeThread,
  getRawGoalNode,
  type GoalTree,
} from '../goals.js';
import { listGuards, proposeGuard, discardGuard, getGuard } from '../goals-guards.js';
// v0.4 §15.7 — importing the driver module also registers the autopilot hooks
// into goals.ts and starts the tick loop (unless GOALS_AUTOPILOT_DRIVER=0).
import { getAutopilotStatus, buildNightReport } from '../goals-autopilot.js';

// GOALS tool (CONTRACT.md §5) — the ONLY way a goal chat touches the tree.
// Scope resolution: inside a `cockpit:goal-<id>` thread, goal_id is IMPLIED
// from context.externalId and any args.goal_id is ignored; outside a goal
// thread, goal_id is required on every op except `list` (list without a
// goal_id returns the whole forest).

// v0.3 §14.3 — a NODE chat (`cockpit:goal-<g>-node-<n>`) implies the goal AND
// pins the scope to node n's subtree; a goal chat implies only the goal.
function implicitGoalId(externalId: string | undefined): number | null {
  return resolveGoalScope(externalId)?.goal_id ?? null;
}

function resolveGoalId(externalId: string | undefined, argsGoalId: unknown): number | null {
  const implied = implicitGoalId(externalId);
  if (implied != null) return implied;
  const n = Number(argsGoalId);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Thrown (and caught into `{error, code}`) when a node-chat op reaches
 *  outside its pinned branch — CONTRACT §14.3. */
class OutsideScope extends GoalError {
  constructor(pinnedId: number, what: string) {
    const pinned = getRawGoalNode(pinnedId);
    super(403, 'outside_pinned_scope',
      `${what} is outside this chat's branch (#${pinnedId} "${pinned?.title ?? ''}"). Say so in one line — that change happens in the goal chat.`);
  }
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
  // v0.2 §13 — Kevin structure changes + JARVIS pending move.
  'kevin_moved_at', 'kevin_move_from', 'pending_parent_id',
  // v0.3 §14 — which nodes have their own chat.
  'thread_ext',
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
    '(it sets), or `push_back` {node_id, note} with your reason to keep it a ghost and talk it out. When Kevin restructures the ' +
    'tree himself (adds a row, edits a set row, drags a row under a new parent) the change is already real and flagged awaiting you ' +
    '(↕K/✎K in the snapshot): on your next turn `accept` {node_id} to agree or `push_back` {node_id, note} — never try to undo it; ' +
    'to move a set node yourself use `move` {node_id, parent_id} (it becomes a pending move he ✓s), your own ghosts move directly. ' +
    'Inside a goal thread (cockpit:goal-<id>), goal_id and the default parent_id (the current focus) are inferred automatically — omit goal_id there. ' +
    'GUARDS (v0.2): when a node verifies done and its done_means is a measurable condition over Hub data worth watching ' +
    '(a rate, a count, a reconciliation — NOT a one-off deliverable or an agreement), propose a Guard with `propose_guard`: ' +
    'capture the SQL that PROVED the done_means during verify (don\'t re-derive it), pick the comparator so `value COMPARATOR ' +
    'threshold` = the win condition holding, and write a plain-words `title`. Kevin ✓s it on the card; only then is it written ' +
    'to Overwatch. Never accept your own guard proposal. If Overwatch isn\'t connected, the proposal still stands as a ghost ' +
    'and writes the moment Kevin\'s key lands. When a guard fails, propose the fix under that node. ' +
    'NODE CHATS (v0.3): Kevin can give one node its own chat (💬, cockpit:goal-<g>-node-<n>): inside it you are PINNED to that node — ' +
    'shape only inside its branch; anything above it (or a sibling) → say so in one line, it happens in the goal chat. ' +
    'Call `open_node_chat` {node_id} only when Kevin asked for it in words ("give #7 its own chat") — never on your own initiative. ' +
    'AUTOPILOT (v0.4): on an AUTOPILOT goal (🌙 on the snapshot\'s `<goal_tree autopilot="1">`) your `propose` lands set and your ' +
    '`propose_plan` dispatches itself (the server appends the VERIFY node — never add your own); `accept` on your own batch and ' +
    '`dispatch` are allowed; Kevin is asleep — never ask, `park` {node_id, reason} instead. Turn autopilot on/off (`autopilot` op) ' +
    'only when Kevin asked in words ("run it overnight", "autopilot this", "stop the autopilot"); `autopilot_status` previews the ' +
    'driver\'s next action; `night_report` writes the morning report (the wrap cue tells you when).',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'list', 'set_goal_done_means', 'propose', 'set_from_kevin', 'accept', 'push_back', 'discard',
          'edit_ghost', 'propose_edit', 'propose_remove', 'move', 'set_leaf_kind', 'propose_plan', 'dispatch',
          'verify', 'human_done', 'park', 'unpark', 'log', 'promote', 'focus',
          'list_guards', 'propose_guard', 'discard_guard',
          'open_node_chat',
          'autopilot', 'autopilot_status', 'night_report',
        ],
        description: 'What to do.',
      },
      goal_id: { type: 'number', description: 'Required outside a goal thread (except for list, which lists the forest without it). Ignored inside a goal thread.' },
      node_id: { type: 'number', description: 'Target node id, where applicable.' },
      parent_id: { type: ['number', 'null'], description: 'Parent node id for propose/set_from_kevin (omit = current focus node inside a goal thread, else root-level). For move: the new parent (null = root-level), required.' },
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
      // v0.2 guards:
      guard_id: { type: 'number', description: 'Target guard id (discard_guard).' },
      mode: { type: 'string', enum: ['query', 'agent'], description: "Guard mode (propose_guard). Default 'query' (captured SQL, zero model calls); 'agent' only when the win condition needs judgment." },
      sql: { type: 'string', description: 'query-mode guard SQL (the proven SELECT that measured the done_means).' },
      comparator: { type: 'string', enum: ['gte', 'lte', 'gt', 'lt', 'eq'], description: 'query-mode: value COMPARATOR threshold = PASS.' },
      threshold: { type: 'number', description: 'query-mode threshold.' },
      value_column: { type: 'string', description: 'query-mode: which returned column holds the number (default first column).' },
      sample_columns: { type: 'array', items: { type: 'string' }, description: 'query-mode: columns to surface on failure.' },
      check_prompt: { type: 'string', description: 'agent-mode guard check prompt.' },
      failure_prompt: { type: 'string', description: 'agent-mode guard failure prompt (optional).' },
      cadence: { type: 'number', description: 'How often Overwatch runs the rule, in minutes (default 60).' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Guard severity (default medium).' },
      ow_group: { type: 'string', description: "Overwatch group (leads/email/queue/billing/revenue/system/custom/general); default custom." },
      // v0.4 autopilot:
      on: { type: 'boolean', description: 'For autopilot: true = turn it on, false = stop it. Only when Kevin said so in words.' },
      config: { type: 'object', description: 'For autopilot {on:true}: partial AutopilotConfig — build_model/light_model/verify_model (claude ids, never fable/frontier), max_depth 1-8, parallel 1-3, tick_minutes 1-120, max_attempts 1-5. Merged over defaults (or the stored config).' },
      date: { type: 'string', description: 'For night_report: YYYY-MM-DD (default = the current run/today).' },
    },
    required: ['operation'],
  },
  execute: async (args, context) => {
    const op = typeof args.operation === 'string' ? args.operation : '';
    const externalId = context?.externalId;
    const scope = resolveGoalScope(externalId);
    const inGoalThread = scope != null;
    // v0.3 §14.3 — inside `cockpit:goal-<g>-node-<n>` every write is clamped to n's subtree.
    const pinnedId: number | null = scope?.pinned_node_id ?? null;
    if (externalId && /^cockpit:goal-\d+-node-\d+$/.test(externalId) && !scope) {
      return { error: 'this node chat\'s node is gone (discarded or deleted) — continue in the goal chat', code: 'pinned_node_gone' };
    }
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

    /** §14.3 guard: a named node must be the pinned node or a descendant. */
    const assertInScope = (nodeId: number | null | undefined, what = 'node'): void => {
      if (pinnedId == null || nodeId == null) return;
      if (!isNodeInSubtree(pinnedId, nodeId)) {
        const n = getRawGoalNode(nodeId);
        throw new OutsideScope(pinnedId, `${what} #${nodeId}${n ? ` "${n.title}"` : ''}`);
      }
    };
    /** §14.3: goal-level ops have no home in a node chat. */
    const assertGoalLevelAllowed = (what: string): void => {
      if (pinnedId != null) throw new OutsideScope(pinnedId, `${what} (goal-level)`);
    };

    const resolveParentId = (goalId: number): number | null => {
      if ('parent_id' in args && args.parent_id !== undefined) {
        const explicit = args.parent_id === null ? null : Number(args.parent_id);
        if (pinnedId != null) {
          if (explicit == null) throw new OutsideScope(pinnedId, 'root-level (parent_id: null)');
          assertInScope(explicit, 'parent');
        }
        return explicit;
      }
      if (!inGoalThread) return null;
      // Default = the focused node, but never a node that cannot take children
      // (ghost/discarded/parked/done): walk up to the nearest set-ish ancestor,
      // else the goal root. Prevents the "parent node is discarded" 409 when
      // Kevin's focus is still parked on a ghost he just discarded.
      // v0.3 §14.3: in a node chat the walk never climbs above the pinned node —
      // and a focus outside the branch means "the pinned node itself".
      const ok = new Set(['set', 'planned', 'working', 'check']);
      let cur = getGoalFocus(goalId).node_id;
      if (pinnedId != null && (cur == null || !isNodeInSubtree(pinnedId, cur))) cur = pinnedId;
      const tree = getGoalTree(goalId, true);
      if (!tree) return null;
      const byId = new Map(tree.nodes.map((n) => [n.id, n]));
      while (cur != null) {
        const n = byId.get(cur);
        if (!n) return null;
        if (ok.has(n.state)) return cur;
        if (pinnedId != null && cur === pinnedId) {
          // Pinned node can't take children yet (still a ghost / parked / done).
          throw new GoalError(409, 'parent_not_set',
            `the pinned node #${pinnedId} is ${n.state} — it must be set before anything can go under it; say so, Kevin ✓s it from either window`);
        }
        cur = n.parent_id;
      }
      return null;
    };

    /** §14.3 — ghost ids under `rootId` (direct children only when `directOnly`). */
    const subtreeGhostIds = (goalId: number, rootId: number, directOnly: boolean): number[] => {
      const tree = getGoalTree(goalId, true);
      if (!tree) return [];
      return tree.nodes
        .filter((n) => n.state === 'ghost' && (directOnly ? n.parent_id === rootId : (n.id !== rootId && isNodeInSubtree(rootId, n.id))))
        .map((n) => n.id);
    };
    /** §14.3 — accept a scoped set of ghosts as ONE request: group by batch so
     *  the review cue fires once per batch, not once per node. */
    const acceptScopedGhosts = (goalId: number, ids: number[]) => {
      if (!ids.length) return [];
      const tree = getGoalTree(goalId, true);
      const byBatch = new Map<string, number[]>();
      const loose: number[] = [];
      for (const id of ids) {
        const n = tree?.nodes.find((x) => x.id === id);
        if (n?.proposal_batch) {
          if (!byBatch.has(n.proposal_batch)) byBatch.set(n.proposal_batch, []);
          byBatch.get(n.proposal_batch)!.push(id);
        } else loose.push(id);
      }
      const out = [];
      for (const [batchId, batchIds] of byBatch) out.push(...acceptGoalBatch(goalId, batchId, batchIds, 'jarvis'));
      for (const id of loose) out.push(acceptGoalNode(goalId, id, 'jarvis'));
      return out;
    };
    /** §14.3 — a batch is in scope only when EVERY ghost in it is. */
    const assertBatchInScope = (goalId: number, batchId: string): void => {
      if (pinnedId == null) return;
      const tree = getGoalTree(goalId, true);
      for (const n of tree?.nodes ?? []) {
        if (n.proposal_batch === batchId && n.state === 'ghost') assertInScope(n.id, 'batch node');
      }
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
        assertGoalLevelAllowed('set_goal_done_means');
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
          if (pinnedId != null) {
            // §14.3 — "all" inside a node chat = every ghost in the pinned subtree
            // (or under an in-scope parent); ONE cue for the request, like a batch.
            if (parentId === null) throw new OutsideScope(pinnedId, 'root-level (parent_id: null)');
            if (parentId !== undefined) assertInScope(parentId, 'parent');
            const ids = subtreeGhostIds(goalId, parentId ?? pinnedId, parentId !== undefined);
            return { nodes: acceptScopedGhosts(goalId, ids) };
          }
          return { nodes: acceptAllGoalNodes(goalId, parentId, 'jarvis') };
        }
        const batchId = str(args.batch_id);
        if (batchId) {
          assertBatchInScope(goalId, batchId);
          return { nodes: acceptGoalBatch(goalId, batchId, undefined, 'jarvis') };
        }
        if (args.node_id !== undefined) {
          assertInScope(Number(args.node_id));
          return { node: acceptGoalNode(goalId, Number(args.node_id), 'jarvis') };
        }
        return { error: 'accept needs node_id, batch_id, or all:true — and only when Kevin actually said yes' };
      }

      if (op === 'push_back') {
        // §11.2 — disagree with Kevin's OK'd edit: stays a ghost, note shown, talk it out.
        if (args.node_id === undefined) return { error: 'node_id is required' };
        const note = str(args.note);
        if (!note) return { error: 'push_back requires a note — your reason in one or two sentences' };
        assertInScope(Number(args.node_id));
        return { node: pushBackGhost(goalId, Number(args.node_id), note, 'jarvis') };
      }

      if (op === 'discard') {
        const batchId = str(args.batch_id);
        if (batchId) {
          assertBatchInScope(goalId, batchId);
          return { nodes: discardGoalBatch(goalId, batchId, undefined, 'jarvis') };
        }
        if (args.node_id !== undefined) {
          assertInScope(Number(args.node_id));
          return { node: discardGoalNode(goalId, Number(args.node_id), str(args.reason), 'jarvis') };
        }
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
        assertInScope(Number(args.node_id));
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
        assertInScope(Number(args.node_id));
        return { node: proposeEdit(goalId, Number(args.node_id), { title: str(args.title), done_means: str(args.done_means), actor: 'jarvis' }) };
      }

      if (op === 'propose_remove') {
        if (args.node_id === undefined) return { error: 'node_id is required' };
        assertInScope(Number(args.node_id));
        return { node: proposeRemoval(goalId, Number(args.node_id), str(args.reason), 'jarvis') };
      }

      if (op === 'move') {
        // §13.6 — a ghost is JARVIS's own proposal → direct move; a set node
        // becomes a pending move Kevin ✓s (route 32), never a direct write.
        if (args.node_id === undefined) return { error: 'node_id is required' };
        if (!('parent_id' in args) || args.parent_id === undefined) return { error: 'parent_id is required (number, or null for root-level)' };
        const parentId = args.parent_id === null ? null : Number(args.parent_id);
        if (pinnedId != null) {
          // §14.3 — the pinned node's own parent is above the boundary; and a
          // move can only land inside the branch.
          if (Number(args.node_id) === pinnedId) throw new OutsideScope(pinnedId, `moving the pinned node #${pinnedId} itself`);
          assertInScope(Number(args.node_id));
          if (parentId == null) throw new OutsideScope(pinnedId, 'root-level (parent_id: null)');
          assertInScope(parentId, 'parent');
        }
        const tree = getGoalTree(goalId, true);
        const target = tree?.nodes.find((n) => n.id === Number(args.node_id));
        if (!target) return { error: `node ${String(args.node_id)} not found in goal ${goalId}`, code: 'node_not_found' };
        if (target.state === 'ghost') {
          return { node: moveGoalNode(goalId, target.id, { parent_id: parentId, actor: 'jarvis' }), moved: true };
        }
        return { node: proposeMove(goalId, target.id, parentId, 'jarvis'), proposed: true };
      }

      if (op === 'set_leaf_kind') {
        if (args.node_id === undefined) return { error: 'node_id is required' };
        if (args.leaf_kind !== 'none' && args.leaf_kind !== 'machine' && args.leaf_kind !== 'human') {
          return { error: "leaf_kind must be 'none', 'machine', or 'human'" };
        }
        assertInScope(Number(args.node_id));
        return { node: setLeafKind(goalId, Number(args.node_id), args.leaf_kind, 'jarvis') };
      }

      if (op === 'propose_plan') {
        if (args.node_id === undefined) return { error: 'node_id is required' };
        const rawPlan = args.plan;
        if (!rawPlan || typeof rawPlan !== 'object') return { error: 'plan (object) is required' };
        assertInScope(Number(args.node_id));
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
        // v0.4 §15.2 — under autopilot the plan is dispatched in the same call;
        // the result then carries {dispatched:true, tree, hopper_nodes}.
        const planResult = proposePlanEx(goalId, Number(args.node_id), rawPlan, 'jarvis');
        return planResult.dispatched
          ? { node: planResult.node, dispatched: true, tree: planResult.tree, hopper_nodes: planResult.hopper_nodes }
          : { node: planResult.node };
      }

      if (op === 'dispatch') {
        if (args.node_id === undefined) return { error: 'node_id is required' };
        assertInScope(Number(args.node_id));
        return approvePlan(goalId, Number(args.node_id), 'jarvis');
      }

      if (op === 'verify') {
        if (typeof args.passed !== 'boolean') return { error: 'passed (boolean) is required' };
        if (args.goal === true) {
          assertGoalLevelAllowed('verify {goal:true}');
          return verifyGoal(goalId, args.passed, str(args.note), 'jarvis');
        }
        if (args.node_id === undefined) return { error: 'node_id is required (or pass goal:true to verify the goal root)' };
        assertInScope(Number(args.node_id));
        return { node: verifyGoalNode(goalId, Number(args.node_id), args.passed, str(args.note), 'jarvis') };
      }

      if (op === 'human_done') {
        if (args.node_id === undefined) return { error: 'node_id is required — only when Kevin said he did it' };
        assertInScope(Number(args.node_id));
        return { node: humanDoneNode(goalId, Number(args.node_id), str(args.note), 'jarvis') };
      }

      if (op === 'park' || op === 'unpark') {
        if (args.node_id !== undefined) {
          assertInScope(Number(args.node_id));
          const node = op === 'park'
            // v0.4 §15.2 — a JARVIS park on an autopilot goal REQUIRES a reason
            // (enforced server-side; the night report surfaces it).
            ? parkGoalNode(goalId, Number(args.node_id), 'jarvis', str(args.reason))
            : unparkGoalNode(goalId, Number(args.node_id), 'jarvis');
          return { node };
        }
        assertGoalLevelAllowed(`${op} the goal`);
        const goal = op === 'park' ? parkGoal(goalId, 'jarvis') : unparkGoal(goalId, 'jarvis');
        return { goal };
      }

      if (op === 'log') {
        const text = str(args.text);
        if (!text) return { error: 'text is required' };
        requireGoal(goalId);
        // §14.3 — a node chat's log defaults to its pinned node.
        const nodeId = args.node_id !== undefined ? Number(args.node_id) : pinnedId;
        assertInScope(nodeId);
        insertEvent(goalId, nodeId, 'jarvis', 'log', text);
        emitGoal('updated', goalId);
        return { event: { goal_id: goalId, node_id: nodeId, actor: 'jarvis', kind: 'log', text } };
      }

      if (op === 'promote') {
        if (args.node_id === undefined) return { error: 'node_id is required' };
        if (pinnedId != null && Number(args.node_id) === pinnedId) throw new OutsideScope(pinnedId, `promoting the pinned node #${pinnedId} itself`);
        assertInScope(Number(args.node_id));
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
        let nodeId = args.node_id === null ? null : Number(args.node_id);
        // §14.3 — clamp: null = the pinned node; anything outside the branch is refused.
        if (pinnedId != null) {
          if (nodeId == null) nodeId = pinnedId;
          else assertInScope(nodeId);
        }
        return { focus: setGoalFocus(goalId, nodeId, 'jarvis') };
      }

      // -- v0.3 §14.7 node chats --------------------------------------------
      if (op === 'open_node_chat') {
        if (args.node_id === undefined) return { error: 'node_id is required — and only when Kevin asked for the chat in words' };
        const target = Number(args.node_id);
        if (pinnedId != null) {
          // Nesting is allowed (a chat for a grandchild), never for the pinned node itself or anything above/beside it.
          if (target === pinnedId) throw new OutsideScope(pinnedId, `a chat for the pinned node #${pinnedId} (this IS that chat)`);
          assertInScope(target);
        }
        const result = getOrCreateNodeThread(goalId, target, 'jarvis');
        if (result.created && result.seed_text) {
          // Tool-side only (same exception as `promote`): post the seed via the
          // internal ingest so the node chat boots without a second round trip.
          const seed = result.seed_text;
          import('../agent.js')
            .then(({ processMessage }) => processMessage(seed, result.external_id))
            .catch((err) => console.error('[goals-tool] node chat seed post failed', err));
        }
        return { external_id: result.external_id, created: result.created, node: result.node };
      }

      // -- v0.2 guards -----------------------------------------------------
      if (op === 'list_guards') {
        return { guards: listGuards(goalId) };
      }

      if (op === 'propose_guard') {
        // Omitted → the current focus (inside a goal thread), like `propose`;
        // explicit null → a root guard (only once the goal is done).
        let guardNodeId: number | null = 'node_id' in args && args.node_id !== undefined
          ? (args.node_id === null ? null : Number(args.node_id))
          : (inGoalThread ? getGoalFocus(goalId).node_id : null);
        if (pinnedId != null) {
          // §14.3 — a node chat guards its own branch; a root guard is goal-level.
          if (guardNodeId == null) {
            if ('node_id' in args && args.node_id === null) throw new OutsideScope(pinnedId, 'a root guard (goal-level)');
            guardNodeId = pinnedId;
          } else if (!isNodeInSubtree(pinnedId, guardNodeId)) {
            if ('node_id' in args && args.node_id !== undefined) assertInScope(guardNodeId);
            guardNodeId = pinnedId; // focus outside the branch → the pinned node
          }
        }
        return {
          guard: proposeGuard(goalId, {
            node_id: guardNodeId,
            mode: args.mode,
            title: str(args.title),
            sql: str(args.sql),
            comparator: args.comparator,
            threshold: typeof args.threshold === 'number' ? args.threshold : undefined,
            value_column: str(args.value_column),
            sample_columns: Array.isArray(args.sample_columns) ? args.sample_columns : undefined,
            check_prompt: str(args.check_prompt),
            failure_prompt: str(args.failure_prompt),
            cadence: typeof args.cadence === 'number' ? args.cadence : undefined,
            severity: args.severity,
            ow_group: str(args.ow_group) ?? 'custom',
            actor: 'jarvis',
          }),
        };
      }

      // -- v0.4 §15.7 autopilot ---------------------------------------------
      // All three are goal-level: inside a node chat they are outside_pinned_scope.
      if (op === 'autopilot') {
        assertGoalLevelAllowed('autopilot');
        if (typeof args.on !== 'boolean') return { error: 'on (boolean) is required — and only when Kevin said so in words' };
        const goal = setGoalAutopilot(goalId, args.on, args.config, 'jarvis');
        const status = await getAutopilotStatus(goalId);
        return { goal, autopilot: status };
      }

      if (op === 'autopilot_status') {
        assertGoalLevelAllowed('autopilot_status');
        return await getAutopilotStatus(goalId);
      }

      if (op === 'night_report') {
        assertGoalLevelAllowed('night_report');
        const report = buildNightReport(goalId, str(args.date) ?? null);
        // §15.7 — link the wrap turn's account and the file in the event log.
        insertEvent(goalId, null, 'jarvis', 'log', `autopilot: night report written → ${report.path}`);
        emitGoal('updated', goalId);
        return { markdown: report.markdown, path: report.path, written: report.written };
      }

      if (op === 'discard_guard') {
        if (args.guard_id === undefined) return { error: 'guard_id is required' };
        if (pinnedId != null) {
          const g = getGuard(goalId, Number(args.guard_id));
          if (g.node_id == null) throw new OutsideScope(pinnedId, 'a root guard (goal-level)');
          assertInScope(g.node_id, 'guard node');
        }
        return { guard: await discardGuard(goalId, Number(args.guard_id), str(args.reason), 'jarvis') };
      }

      return { error: `unknown operation: ${op || '(none)'}` };
    } catch (err) {
      return errorResult(err);
    }
  },
};
