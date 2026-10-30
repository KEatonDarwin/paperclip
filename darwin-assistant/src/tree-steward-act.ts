// TREE STEWARD — AUTO-ANSWER EFFECTS (tree-91d31b19, node #1716)
//
// When the Tree Steward decides a stuck tree can be unstuck by adopting the
// worker's own recommendation, THREE things must happen, in order:
//   (1) ANSWER   — the blocked_question node goes back to `pending` with the
//                  answer injected (the ONLY effect that matters to the build;
//                  this is what un-sticks the tree and lets a fresh worker run).
//   (2) DECISION — an audit row in the Decision Ledger recording the choice,
//                  decided_by 'jarvis', so Kevin can scroll back and see what
//                  was auto-answered and why.
//   (3) ORIGIN   — a one-line breadcrumb queued into the planting thread so the
//                  humans watching that chat know the steward acted.
//
// EVERY effect is injectable (see StewardEffects) PRECISELY so this whole path
// can be proven with fakes — no database connection, no model call, no network.
// `executeAutoAnswer(..., effects = realStewardEffects)` runs the real writes in
// production; a test passes spy fakes and asserts order + isolation. That is the
// entire reason this module exists as a seam.
//
// ⚠️ This module must NEVER be statically imported by hopper-engine.ts. It
// statically imports hopper-engine (for answerHopperNode); the reverse would be
// a cycle. The trigger reaches THIS module by dynamic import instead.

import { answerHopperNode } from './hopper-engine.js';
import { insertJarvisDecision } from './jarvis-decisions.js';
import { getConversation } from './conversation-db.js';
import { getHopperTree } from './hopper-engine.js';
import { cueTargetForTree } from './goals.js';

/** Max chars of the worker's question we keep on the audit row — enough to read
 *  cold, not a wall. */
const QUESTION_CAP = 1000;
/** Max chars of the adopted answer echoed in the one-line origin breadcrumb. */
const ANSWER_LINE_CAP = 180;

/** Collapse all whitespace (incl. newlines) to single spaces and hard-truncate,
 *  so a multi-line answer can never inject a newline into the one-line cue. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Origin threads the steward must never wake — an ephemeral hopper worker, a
 *  checkin / other ephemeral plumbing thread, or a disposable quick chat.
 *  MIRRORS tree-cue.ts `isNonWakeableOrigin` deliberately: that copy is a local
 *  (non-exported) helper and this node is forbidden to edit tree-cue.ts, so the
 *  guard is reproduced here rather than imported. Keep the two in sync. */
function isNonWakeableOrigin(ext: string): boolean {
  return (
    ext.startsWith('cockpit:hopper-node-') ||
    ext.startsWith('ephemeral:') ||
    ext.startsWith('quick:')
  );
}

/** The three effects behind the seam. Production uses realStewardEffects; a test
 *  passes fakes to prove ordering + isolation without any DB/model/network. */
export interface StewardEffects {
  answerNode(nodeId: number, answer: string): void;
  recordDecision(input: {
    nodeId: number;
    treeId: string | null;
    question: string;
    decision: string;
    rationale: string;
    category: string;
  }): void;
  postOriginLine(treeId: string | null, line: string): void;
}

/** Production implementations — the real writes Kevin deploys. */
export const realStewardEffects: StewardEffects = {
  // (1) Delegates to the exported answerHopperNode. NOTE FOR THE VERIFIER:
  // node #381's done_means wants the answer to go "through the EXISTING POST
  // /hopper-nodes/:id/answer endpoint". In src/handlers/api-v1.ts that route
  // (router.post('/hopper-nodes/:id/answer', …)) does nothing but
  // `answerHopperNode(id, body.answer.trim())`. We run in-process, so calling the
  // exported function IS that endpoint's own code path — identical write, identical
  // side effects (node → pending + answer, tree re-armed, dispatch tick), with no
  // new write path and no self-HTTP call needing a bearer key.
  answerNode(nodeId, answer) {
    answerHopperNode(nodeId, answer);
  },

  // (2) One Decision Ledger row. Maps onto the REAL JarvisDecisionInsert fields
  // (question / decidedBy / decision / rationale); decided_by is the literal
  // 'jarvis'. We let the insert default its conversation context — a steward
  // auto-answer is fired from the engine, not a tool turn, so there is honestly
  // no conversation to attribute it to.
  recordDecision(input) {
    insertJarvisDecision({
      question: oneLine(input.question, QUESTION_CAP),
      decidedBy: 'jarvis',
      decision: input.decision,
      rationale: input.rationale,
    });
  },

  // (3) One breadcrumb line queued into the planting thread. Thread resolution
  // mirrors tree-cue.ts exactly: cueTargetForTree(treeId) ?? tree.origin_thread_ext,
  // then the never-wake guard, then the conversation lookup.
  //
  // 🔴 DESIGN RULE — QUEUE-ONLY. We use the thread-message-queue `enqueueMessage`
  // path and deliberately NOT agent.processMessage. tree-cue starts a real JARVIS
  // turn because a FINISHED tree needs review; a steward auto-answer is only an
  // informational breadcrumb, and starting an unscheduled model turn per
  // auto-answer would make the steward expensive and noisy. Queue-only means the
  // line simply waits in the thread the next time that chat runs.
  //
  // DYNAMIC import of the queue module, matching tree-cue's documented reason
  // (avoids an import cycle through agent/goals, and lets a scratch test intercept
  // just this import with a scoped ESM loader hook — no real model call / no API
  // key). If there is no conversation for the thread we bail silently rather than
  // create one — same as tree-cue.
  postOriginLine(treeId, line) {
    if (treeId === null) return;
    const tree = getHopperTree(treeId);
    const originExt = cueTargetForTree(treeId) ?? tree?.origin_thread_ext ?? null;
    if (!originExt) return; // no planting thread to wake
    if (isNonWakeableOrigin(originExt)) return; // ephemeral / plumbing — never wake
    const conv = getConversation(originExt);
    if (!conv) return; // no conversation → bail silently, never create one
    const convId = conv.id;
    void import('./thread-message-queue.js')
      .then((queue) => {
        queue.enqueueMessage(convId, line);
      })
      .catch((err) => {
        console.error(`[tree-steward] origin-line enqueue failed for ${treeId}:`, err);
      });
  },
};

/**
 * Perform an auto-answer's three effects, in a strict, isolated order.
 *
 * Order is EXACTLY (1) answerNode, (2) recordDecision, (3) postOriginLine, and it
 * matters: the node getting unstuck is the only effect that matters to the build,
 * so the audit row and the breadcrumb must never be able to prevent it. Effects
 * (2) and (3) are each wrapped in their own try/catch — a failure there is logged
 * and reported in the return value but does NOT undo or block the answer. If (1)
 * throws, we do not attempt (2) or (3) and return answered:false.
 */
export function executeAutoAnswer(
  args: {
    nodeId: number;
    treeId: string | null;
    title: string;
    question: string;
    answer: string;
    category: string;
    reason: string;
  },
  effects: StewardEffects = realStewardEffects,
): { answered: boolean; decisionWritten: boolean; linePosted: boolean } {
  // (1) ANSWER — if this throws, nothing else runs and the node is not answered;
  // we return answered:false rather than propagating, so the caller can log and
  // move on. (2) and (3) are deliberately NOT attempted.
  try {
    effects.answerNode(args.nodeId, args.answer);
  } catch (err) {
    console.error(`[tree-steward] answerNode failed for node ${args.nodeId}:`, err);
    return { answered: false, decisionWritten: false, linePosted: false };
  }

  // (2) DECISION — audit row. Never allowed to undo or block the answer.
  let decisionWritten = false;
  try {
    const rationale =
      `Tree Steward auto-answer — classifier rule "${args.reason}" fired ` +
      `(category: ${args.category}); adopted the worker's own recommendation.`;
    effects.recordDecision({
      nodeId: args.nodeId,
      treeId: args.treeId,
      question: args.question,
      decision: args.answer,
      rationale,
      category: args.category,
    });
    decisionWritten = true;
  } catch (err) {
    console.error(`[tree-steward] decision-row write failed for node ${args.nodeId}:`, err);
  }

  // (3) ORIGIN LINE — informational breadcrumb. One line, no markdown block, no
  // embedded newline. Never allowed to undo or block the answer.
  let linePosted = false;
  try {
    const line =
      `🌿 steward: auto-answered #${args.nodeId} on ${args.treeId ?? '(no tree)'} — ` +
      `${args.category} — adopted the worker's own recommendation: ${oneLine(args.answer, ANSWER_LINE_CAP)}`;
    effects.postOriginLine(args.treeId, line);
    linePosted = true;
  } catch (err) {
    console.error(`[tree-steward] origin-line post failed for node ${args.nodeId}:`, err);
  }

  return { answered: true, decisionWritten, linePosted };
}
