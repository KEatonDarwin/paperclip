// tree-steward-trigger.ts — the one event-driven seam between a stuck tree and
// the Tree Steward (tree-0dd74c62, node #1712).
//
// WHY THIS EXISTS: a `blocked_question` is the single place a stuck tree is born
// — it is set exactly once, in finishHopperNode's `else if (outcome ===
// 'blocked_question')` branch. Hooking there makes the steward fire exactly once
// per stuck node, with no poller and no cron sweep. This module is the thin
// trigger; the DECISION lives in the pure core `src/tree-steward.ts`.
//
// WHY THE IMPORT OF THE CORE IS DYNAMIC: hopper-engine.ts is already loaded by
// the time a finish fires, and the steward's eventual effects (node #381) reach
// the goals graph / queue the same way tree-cue.ts does — those pull hopper-engine
// back in, which would close an import cycle if the edge were static. So, exactly
// as tree-cue.ts loads agent.js dynamically to avoid that cycle, we load the core
// with `await import('./tree-steward.js')` inside the function. The TYPES are
// imported with `import type`, which is erased at compile time and adds NO runtime
// module-graph edge — it is purely for the typechecker.

import type { StewardInput, StewardDecision } from './tree-steward.js';

/** The plain-data context the hopper-engine hands this trigger at the moment a
 *  node finishes as `blocked_question`. Deliberately a flat copy of the node
 *  facts the hook already has in scope — the trigger opens no DB itself. */
export interface StewardTriggerContext {
  nodeId: number;
  treeId: string | null;
  title: string;
  question: string | null;
  result: string | null;
}

// ---------------------------------------------------------------------------
// EXACTLY-ONCE GUARD
// ---------------------------------------------------------------------------
// A module-level Set of node ids already handled. The steward must act on a
// given blocked_question exactly once; a second call for the same node id is a
// no-op. This lives in process memory ON PURPOSE: it is a trigger-dedupe, not a
// durable fact, so it is deliberately NOT a DB column and NOT a settings write
// (the durable "was this answered" truth is the node's own status, owned by the
// answer path in node #381). A process restart re-arming the guard is fine — the
// node's real status is what prevents a double real-answer downstream.
const handledNodeIds = new Set<number>();

/**
 * DRY-RUN ONLY. Clears the exactly-once guard so the dry-run script can prove it
 * both blocks a repeat and can be reset. This is the ONLY exported mutator of the
 * guard; nothing in the real finish path may clear it.
 */
export function __resetStewardTriggerGuardForDryRun(): void {
  handledNodeIds.clear();
}

/**
 * Single entry point, called fire-and-forget from finishHopperNode's
 * blocked_question branch. Never throws into its caller: the whole body is
 * wrapped so a broken steward can never break a worker's finish. Returns void.
 */
export async function onBlockedQuestionFinished(ctx: StewardTriggerContext): Promise<void> {
  try {
    // (a) EXACTLY-ONCE: a repeat for the same node id is a no-op.
    if (handledNodeIds.has(ctx.nodeId)) return;
    handledNodeIds.add(ctx.nodeId);

    // (b) KILL SWITCH: Kevin can disable the steward with no restart. Read the
    //     existing settings helper exactly as tree-cue.ts reads `hopper_tree_cue`
    //     (default on). This is a pure read — allowed under the fence.
    const { getSetting } = await import('./conversation-db.js');
    if ((getSetting('tree_steward') ?? 'on').trim().toLowerCase() === 'off') return;

    // (c) Build the pure-core input from the context and classify. The core is
    //     imported DYNAMICALLY (see the header) and is synchronous, so no await.
    const { classifyBlockedQuestion } = await import('./tree-steward.js');
    const input: StewardInput = {
      nodeId: ctx.nodeId,
      treeId: ctx.treeId,
      status: 'blocked_question', // the hook only ever fires from that branch
      title: ctx.title,
      question: ctx.question,
      result: ctx.result,
    };
    const decision = classifyBlockedQuestion(input);

    // (d) Hand the decision to the (currently inert) effects stage.
    await applyStewardDecision(ctx, decision);
  } catch (err) {
    // (e) A broken steward must never break a worker's finish.
    console.error(`[tree-steward] trigger failed for node ${ctx.nodeId}:`, err);
  }
}

/**
 * Act on a steward decision.
 *
 * ⚠️ INTENTIONALLY INERT IN THIS NODE (#1712). This node wires the exactly-once,
 * event-driven trigger and nothing more. It deliberately does NOT answer any real
 * node, because the guardrails that make auto-answering safe do not exist yet.
 *
 * Node #381 fills in the real effects HERE, and ONLY here:
 *   - on `auto_answer`: re-queue the node via POST /hopper-nodes/:id/answer with
 *     `decision.answer`, record it with log_decision, and post one line to the
 *     origin thread;
 *   - on `park_card` / `noop`: leave the node parked for Kevin (the card the
 *     notification already created) and, where useful, note why.
 * Until that lands, the ONLY effect is a single structured log line, so nothing
 * can answer a real node before the guardrails exist.
 */
export async function applyStewardDecision(
  ctx: StewardTriggerContext,
  decision: StewardDecision,
): Promise<void> {
  console.log(
    `[tree-steward] node ${ctx.nodeId} tree ${ctx.treeId}: ${decision.action} (${decision.category}) — ${decision.reason}`,
  );
}
