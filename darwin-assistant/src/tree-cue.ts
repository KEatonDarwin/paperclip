// TREE CUE (tree-c82544e2, node #473)
//
// When a hopper tree finishes (status 'done') or hits a wall (status 'blocked'),
// the only feedback today is the cockpit bell (🌳 notification) + the goals node
// hook — NOTHING wakes JARVIS in the thread that PLANTED the tree, so review /
// deploy waits for a commitment, the watchdog, a check-in, or Kevin asking.
//
// This module closes that gap: it registers a tree-status listener that posts a
// short cue into the tree's origin thread, running a real JARVIS turn there —
// the exact same seam `dispatch-gate.ts` `fireCue` uses for dispatches
// (getInFlightMessageId → enqueueMessage, else processMessage, catch
// ConversationBusyError → enqueue).
//
// Design mirrors goals.ts `fireGoalReviewCue`: the agent.js + thread-message-queue.js
// imports are DYNAMIC so (a) there's no import cycle (agent.ts pulls in the goals
// graph, and hopper-engine is already loaded by the time this fires) and (b) the
// scratch-DB test can intercept just this module's `import('./agent.js')` with a
// scoped ESM loader hook — proving the cue is composed + "sent" with NO real
// model call / NO API KEYS.

import { sqliteDb, getConversation, getSetting } from './conversation-db.js';
import {
  registerTreeStatusListener,
  getHopperTree,
  listTreeNodes,
  type HopperNodeRow,
} from './hopper-engine.js';
import { cueTargetForTree } from './goals.js';
import { nightShiftOwnsGoal } from './goals-autopilot.js';

// -- dedupe column: one cue per (tree, status) transition ------------------
// PRAGMA-checked additive ALTER, same pattern as hopper-engine's router cols.
{
  const cols = sqliteDb.prepare(`PRAGMA table_info(hopper_trees)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'last_cue_status')) {
    try {
      sqliteDb.exec(`ALTER TABLE hopper_trees ADD COLUMN last_cue_status TEXT`);
    } catch {
      /* column already exists (raced with another loader) */
    }
  }
}

// Which optional finish-line-gate columns actually exist on this DB. The gate
// (a separate tree) added original_ask/deferred_scope; this branch tolerates
// their absence entirely.
const treeCols = (sqliteDb.prepare(`PRAGMA table_info(hopper_trees)`).all() as Array<{ name: string }>)
  .map((c) => c.name);
const HAS_ORIGINAL_ASK = treeCols.includes('original_ask');
const HAS_DEFERRED_SCOPE = treeCols.includes('deferred_scope');

const getLastCueStmt = sqliteDb.prepare<[string], { last_cue_status: string | null }>(
  `SELECT last_cue_status FROM hopper_trees WHERE id = ?`,
);
const setLastCueStmt = sqliteDb.prepare<[string | null, string]>(
  `UPDATE hopper_trees SET last_cue_status = ? WHERE id = ?`,
);

/** Origin threads we must never wake: an ephemeral hopper worker, a checkin /
 *  other ephemeral plumbing thread, or a disposable quick chat. */
function isNonWakeableOrigin(ext: string): boolean {
  return (
    ext.startsWith('cockpit:hopper-node-') ||
    ext.startsWith('ephemeral:') ||
    ext.startsWith('quick:')
  );
}

const MAX_NODE_LINES = 12;

function firstLine(text: string | null | undefined, max = 200): string {
  if (!text) return '';
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function optionalColValue(treeId: string, col: string): string | null {
  try {
    const row = sqliteDb.prepare(`SELECT ${col} AS v FROM hopper_trees WHERE id = ?`).get(treeId) as
      | { v: string | null }
      | undefined;
    return row?.v ?? null;
  } catch {
    return null;
  }
}

function composeCue(
  treeId: string,
  topic: string,
  status: 'done' | 'blocked',
  nodes: HopperNodeRow[],
): string {
  const total = nodes.length;
  // A `split` parent is SETTLED (its children bubbled it up), so it counts as
  // done — otherwise a finished tree reads "7/9 nodes done" in its own DONE cue.
  const doneCount = nodes.filter((n) => n.status === 'done' || n.status === 'split').length;
  const blockedNodes = nodes.filter((n) => n.status === 'blocked' || n.status === 'blocked_question');
  const blockedCount = blockedNodes.length;

  const headBlocked = blockedCount ? `, ${blockedCount} blocked` : '';
  const header = `[tree ${treeId} "${topic}" ${status === 'done' ? 'DONE' : 'BLOCKED'} — ${doneCount}/${total} nodes done${headBlocked}]`;

  const shown = nodes.slice(0, MAX_NODE_LINES);
  const nodeLines = ['nodes:', ...shown.map((n) => `  #${n.id} ${n.status} ${firstLine(n.title, 120)}`)];
  if (total > MAX_NODE_LINES) nodeLines.push(`  … (+${total - MAX_NODE_LINES} more)`);

  const lines = [header, ...nodeLines];

  if (HAS_ORIGINAL_ASK) {
    const oa = optionalColValue(treeId, 'original_ask');
    if (oa && oa.trim()) lines.push(`original ask: ${firstLine(oa, 400)}`);
  }
  if (HAS_DEFERRED_SCOPE) {
    const ds = optionalColValue(treeId, 'deferred_scope');
    if (ds && ds.trim()) lines.push(`deferred scope: ${firstLine(ds, 400)}`);
  }

  if (status === 'done') {
    lines.push(
      'Next: review the deliverables against the original ask, then deploy/merge per your standing rules and mark the matching commitment done.',
    );
  } else {
    lines.push('blocked node(s):');
    for (const n of blockedNodes.slice(0, MAX_NODE_LINES)) {
      // A worker's wall lands in `result`; a blocked_question parks the text in
      // `question` — reading `result` for those printed a bare title.
      const why = firstLine(n.status === 'blocked_question' ? n.question : n.result, 200);
      const tag = n.status === 'blocked_question' ? ' [needs Kevin]' : '';
      lines.push(`  #${n.id} ${firstLine(n.title, 120)}${tag}${why ? ` — ${why}` : ''}`);
    }
    // blocked_question is reserved for a call only Kevin can make (the Smart
    // Unblocker explicitly never touches them) — the cue must not invite JARVIS
    // to answer one on his behalf.
    const questionOnly = blockedNodes.every((n) => n.status === 'blocked_question');
    lines.push(
      questionOnly
        ? "Next: this is a blocked_question — Kevin's call, not yours. Surface it to him and answer the node only once he has decided."
        : "Next: unstick the blocked node(s) per the Smart Unblocker rule if the subscription juice allows; any node tagged [needs Kevin] is his call — surface it, don't answer it yourself.",
    );
  }

  return lines.join('\n');
}

/** Registered tree-status listener. Posts a cue into the origin thread on a
 *  done/blocked transition; never on 'active' (that only re-arms the blocked
 *  dedupe guard so a blocked → active → blocked cycle can cue again). */
export function treeCueOnTreeStatus(treeId: string, status: 'done' | 'blocked' | 'active'): void {
  // Live kill switch, no restart needed. Default on.
  if ((getSetting('hopper_tree_cue') ?? 'on').trim().toLowerCase() === 'off') return;

  const last = getLastCueStmt.get(treeId)?.last_cue_status ?? null;

  if (status === 'active') {
    // Re-arm so the NEXT done/blocked cues again. Two cases, not one: a tree
    // that was blocked and got unstuck may block again, AND a DONE tree that was
    // re-agreed (a repair / continuation run, agreeHopperTree) must cue when it
    // finishes the second time — with the old `last === 'blocked'` guard that
    // second completion was silently deduped away forever. Only write when a
    // guard is actually set, so no-op 'active' pings don't touch the row.
    if (last !== null && last !== 'active') setLastCueStmt.run('active', treeId);
    return;
  }

  // Dedupe: one cue per (tree, status) transition.
  if (last === status) return;

  const tree = getHopperTree(treeId);
  if (!tree) return;
  // FOUNDRY: a project plants ONE hopper tree per module plus an integration
  // tree, and every one of them carries the PROJECT's origin thread. Cueing each
  // would storm that thread with a JARVIS turn per module AND fight foundry's own
  // auto-decide / integration-retry ladder — which is exactly why hopper-engine
  // already suppresses foundry bells (isFoundryTree). Foundry reports through
  // /foundry; the module trees are its internal steps, not Kevin's review gate.
  if (tree.topic.startsWith('foundry:')) return;
  // NIGHT SHIFT (review node #682): while a night run OWNS a goal, its trees are
  // the night's items — the driver's P0 sync already settles them and kicks on
  // the same tree-status event, and every cue for that goal must land in the ONE
  // orchestrator thread (`cockpit:night-shift`), not the goal chat. Without this
  // a finished night tree ran a SECOND, un-briefed JARVIS turn in the goal chat
  // telling it to "review the deliverables and deploy per your standing rules" —
  // two drivers on one node, and a [needs Kevin] prompt at 3AM. Returns false
  // for every non-night tree, so nothing outside a live run changes.
  {
    const owner = sqliteDb.prepare(
      `SELECT goal_id FROM goal_nodes WHERE tree_id = ? AND state != 'discarded' ORDER BY id DESC LIMIT 1`,
    ).get(treeId) as { goal_id: number } | undefined;
    if (owner && nightShiftOwnsGoal(owner.goal_id)) {
      setLastCueStmt.run(status, treeId);
      console.log(`[tree-cue] ${treeId} ${status}: goal #${owner.goal_id} is owned by a night run — the orchestrator thread drives it`);
      return;
    }
  }
  // GOALS v0.3 (CONTRACT §14.6): a tree planted from a goal node (approve_plan)
  // carries the GOAL chat as its origin; when that node — or an ancestor — has
  // its own node chat, the cue belongs there instead. cueTargetForTree is null
  // for every non-goal tree, so this changes nothing outside Goals.
  const originExt = cueTargetForTree(treeId) ?? tree.origin_thread_ext;
  if (!originExt) return; // no planting thread to wake
  if (isNonWakeableOrigin(originExt)) return;

  const conv = getConversation(originExt);
  if (!conv) {
    console.warn(`[tree-cue] ${treeId} ${status}: no conversation for origin ${originExt} — skipping`);
    // Still record the guard so we don't recompute every re-notify.
    setLastCueStmt.run(status, treeId);
    return;
  }

  const nodes = listTreeNodes(treeId);
  const text = composeCue(treeId, tree.topic, status, nodes);

  // Mark BEFORE the async post so a second synchronous notify (same status)
  // can't double-fire while the import()/processMessage promise is in flight.
  setLastCueStmt.run(status, treeId);

  const convId = conv.id;
  const correlationKey = `tree-cue:${treeId}:${status}`;

  Promise.all([import('./agent.js'), import('./thread-message-queue.js')])
    .then(([agent, queue]) => {
      if (agent.getInFlightMessageId(convId)) {
        queue.enqueueMessage(convId, text);
        return;
      }
      agent.processMessage(text, originExt, correlationKey).catch((err: unknown) => {
        if (err instanceof agent.ConversationBusyError) queue.enqueueMessage(convId, text);
        else console.error(`[tree-cue] ${treeId} ${status} post failed`, err);
      });
    })
    .catch((err) => {
      console.error(`[tree-cue] ${treeId} ${status} import failed`, err);
      // The cue never left the building — clear the guard so a later notify for
      // the same status retries instead of being deduped into silence.
      try {
        setLastCueStmt.run(null, treeId);
      } catch {
        /* best effort */
      }
    });
}

registerTreeStatusListener(treeCueOnTreeStatus);
