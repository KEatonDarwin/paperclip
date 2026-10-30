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
// STEWARD MODE (node #383) — shadow posture
// ---------------------------------------------------------------------------
// The steward's posture. 'card_only' (the DEFAULT) means classify-and-card only:
// the steward never auto-answers a real node — it raises the Kevin card carrying
// what it WOULD have answered and stops. 'live' means auto-answering is on.
export type StewardMode = 'card_only' | 'live';

/**
 * Resolve the current steward mode from the `steward_mode` setting.
 *
 * 🔴 THE DEFAULT IS THE SAFE SIDE — 'card_only'. Shadow-first is the Darwin
 * posture: a feature that answers real nodes must be turned ON deliberately,
 * never by accident. So ANY value that is not the exact string 'live' (after a
 * trim + lower-case) — unset, empty, a misspelling like 'liv'/'LIVE!', 'yes',
 * 'on' — resolves to 'card_only'. A typo in a settings value must never be the
 * thing that starts answering real nodes.
 *
 * ASYNC + DYNAMIC IMPORT ON PURPOSE: this reads via the SAME dynamically-imported
 * getSetting the kill switch uses (see onBlockedQuestionFinished below). The
 * trigger file deliberately keeps conversation-db OUT of its static import graph
 * (see the file header and the dynamic card/guard/act imports) so that merely
 * importing this trigger never opens the sqlite handle at module load. A static
 * `import { getSetting }` would break that invariant, so stewardMode stays async
 * and loads getSetting the same dynamic way — a pure read, allowed under the fence.
 */
export async function stewardMode(): Promise<StewardMode> {
  const { getSetting } = await import('./conversation-db.js');
  const raw = (getSetting('steward_mode') ?? '').trim().toLowerCase();
  return raw === 'live' ? 'live' : 'card_only';
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
 * Act on a steward decision — the effects stage.
 *
 * This node fills in the real `auto_answer` effect and nothing more. The branches:
 *
 *   - `auto_answer`: adopt the worker's own recommendation. Requires a non-empty
 *     `decision.answer` — an auto_answer with no answer text is a classifier bug,
 *     and answering a real node with an empty string would unstick the tree with
 *     nothing, so we refuse (log + return) rather than act. Otherwise we hand off
 *     to `executeAutoAnswer`, which performs, in order, (1) ANSWER the node back to
 *     pending, (2) write the Decision Ledger row, (3) queue one breadcrumb into the
 *     origin thread. We log ONLY the effects its return value actually confirms —
 *     never a flag the result did not set.
 *   - `park_card`: INERT here by design. We log a single PARK line and do nothing
 *     else — no notification, no answer, no decision row. ⚠️ The card surface Kevin
 *     reviews, together with the guardrails that make parking actionable, is NODE
 *     #382's job and lands THERE, not here.
 *   - `noop`: return silently (the classifier already found nothing to do).
 *
 * The whole body is wrapped so a broken steward can never break a worker's finish.
 *
 * WHY THE ACT IMPORT IS DYNAMIC: same reason tree-cue gives for loading agent.js —
 * `./tree-steward-act.ts` statically imports hopper-engine (for answerHopperNode),
 * so a static edge from this trigger would help close an import cycle through the
 * engine's module graph. Loading it with `await import('./tree-steward-act.js')`
 * keeps hopper-engine's module graph unchanged and keeps the whole path provable
 * with injected fakes (no DB / model / network).
 */
export async function applyStewardDecision(
  ctx: StewardTriggerContext,
  decision: StewardDecision,
): Promise<void> {
  try {
    if (decision.action === 'noop') return;

    if (decision.action === 'park_card') {
      // Node #382: the classifier already ruled this Kevin's call (escalation bar,
      // test/DB fence, or a real decision with nothing to adopt). Raise the rich
      // Kevin card carrying the classifier's own category + reason, and answer
      // nothing. DYNAMIC import for the same reason the act import is dynamic (see
      // the header): tree-steward-card.ts statically pulls in conversation-db, which
      // opens the sqlite handle at module load — a static edge here would open the
      // DB merely by importing this trigger.
      // A park is a park in EITHER mode (this branch is unchanged by mode), but
      // the card body should say which mode produced it so Kevin can tell a
      // shadow-period card from a real one at a glance. The card module (locked
      // this tree) exposes NO dedicated mode field — its rendered free-text fields
      // are category/reason/question/wouldHaveAnswered — so we fold a compact mode
      // tag into `reason`, the field it already renders as the "why" line, rather
      // than inventing a field or editing the card module.
      const mode = await stewardMode();
      const { raiseStewardParkCard } = await import('./tree-steward-card.js');
      raiseStewardParkCard({
        nodeId: ctx.nodeId,
        treeId: ctx.treeId,
        title: ctx.title,
        question: ctx.question ?? '',
        category: decision.category,
        reason: `[steward mode: ${mode}] ${decision.reason}`,
      });
      console.log(
        `[tree-steward] node ${ctx.nodeId}: PARK (${decision.category}, mode:${mode}) — ${decision.reason} — card raised`,
      );
      return;
    }

    if (decision.action === 'auto_answer') {
      // The answer the classifier would adopt. Computed up front because it is
      // used BOTH for the live effect AND, in shadow mode, as the "would have
      // answered" shown on the card.
      const answer = (decision.answer ?? '').trim();

      // ── MODE GATE (node #383) — STEP 2 in the fixed order. STEP 1, the
      //    `tree_steward` kill switch, already ran in onBlockedQuestionFinished
      //    before any classify. This gate sits BEFORE the empty-answer refusal,
      //    BEFORE the guard, and BEFORE any effect: a mode checked after a node is
      //    already answered is not a mode. In card_only (the DEFAULT) the steward
      //    CLASSIFIES and CARDS but answers NOTHING — raise the park card carrying
      //    what it WOULD have answered, log one SHADOW line, and RETURN. No answer,
      //    no Decision Ledger row, no origin-thread breadcrumb, and crucially NO
      //    recordStewardAnswer: a shadow run must not burn the per-tree cap or the
      //    never-answer-twice list, so Kevin sees EVERY case during the shadow
      //    period. Only 'live' falls through to the guard gate and the effects.
      if ((await stewardMode()) === 'card_only') {
        const { raiseStewardParkCard } = await import('./tree-steward-card.js');
        raiseStewardParkCard({
          nodeId: ctx.nodeId,
          treeId: ctx.treeId,
          title: ctx.title,
          question: ctx.question ?? '',
          category: decision.category,
          reason: decision.reason,
          wouldHaveAnswered: answer,
        });
        console.log(
          `[tree-steward] node ${ctx.nodeId} tree ${ctx.treeId}: SHADOW (card_only) — ` +
            `would AUTO-ANSWER (${decision.category}); carded with wouldHaveAnswered, no effects, no recordStewardAnswer`,
        );
        return;
      }

      // ── LIVE mode only from here down. ───────────────────────────────────────
      // An auto_answer with no answer text is a classifier bug; answering a real
      // node with '' would unstick the tree with nothing. Refuse, do not act.
      if (answer === '') {
        console.error(
          `[tree-steward] node ${ctx.nodeId}: auto_answer with empty answer — refusing to answer (classifier bug; category ${decision.category})`,
        );
        return;
      }

      // Node #382 — THE GUARD GATE. Consulted BEFORE any effect runs, so the lane
      // switch, the per-tree cap, and the never-answer-twice rule get the final say
      // over the classifier. A check that ran after the node was already unstuck
      // would not be a guard; this sits ahead of executeAutoAnswer. If the guard
      // says no, we answer NOTHING and raise the Kevin card instead, carrying the
      // guard's own code + reason. Both modules load by DYNAMIC import for the same
      // reason the act import is dynamic (see the header): tree-steward-guard.ts and
      // tree-steward-card.ts each statically pull in conversation-db, which opens
      // the sqlite handle at module load — a static edge here would open the DB
      // merely by importing this trigger.
      const { stewardAllowed, recordStewardAnswer } = await import('./tree-steward-guard.js');
      const verdict = stewardAllowed(ctx.treeId, ctx.nodeId);
      if (!verdict.allowed) {
        const { raiseStewardParkCard } = await import('./tree-steward-card.js');
        raiseStewardParkCard({
          nodeId: ctx.nodeId,
          treeId: ctx.treeId,
          title: ctx.title,
          question: ctx.question ?? '',
          category: verdict.code,
          reason: verdict.reason,
        });
        console.log(
          `[tree-steward] node ${ctx.nodeId} tree ${ctx.treeId}: PARK (guard:${verdict.code}) — ${verdict.reason} — card raised`,
        );
        return;
      }

      // Dynamic import — see the header: keeps hopper-engine's module graph
      // unchanged and the path provable with fakes.
      const { executeAutoAnswer } = await import('./tree-steward-act.js');
      const r = executeAutoAnswer({
        nodeId: ctx.nodeId,
        treeId: ctx.treeId,
        title: ctx.title,
        question: ctx.question ?? '',
        answer,
        category: decision.category,
        reason: decision.reason,
      });
      // Record the answer ONLY after a confirmed success (r.answered). A failed
      // answer must never burn the per-tree cap or poison the never-answer-twice
      // list — otherwise a single transient failure would lock the node out forever.
      if (r.answered) recordStewardAnswer(ctx.treeId, ctx.nodeId);
      // Report ONLY the effects the return value confirms — never a flag it did not set.
      console.log(
        `[tree-steward] node ${ctx.nodeId} tree ${ctx.treeId}: AUTO-ANSWER (${decision.category}) — ` +
          `answered=${r.answered} decision=${r.decisionWritten} origin=${r.linePosted}`,
      );
      return;
    }
  } catch (err) {
    // A broken steward must never break a worker's finish.
    console.error(`[tree-steward] applyStewardDecision failed for node ${ctx.nodeId}:`, err);
  }
}
