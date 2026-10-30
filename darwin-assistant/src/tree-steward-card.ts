// Tree Steward (tree-646923b4) — the Kevin card for a PARKED question.
//
// When the steward decides it should NOT auto-answer a blocked_question — it is
// on the escalation bar, it touches the test/DB fence, there was no confident
// recommendation to adopt, or the per-tree cap was already spent — it "parks"
// the node: leaves it as a blocked_question for Kevin, but raises a RICHER card
// than the engine's generic ❓ bell. This card carries the triage VERDICT, not
// just the raw question: which node/tree, the question, WHY the steward refused,
// and (for shadow mode, node #383) what it WOULD have answered.
//
// This is additive and isolated: it only calls createNotification. It never
// touches the hopper engine, the DB directly, or any schema.

import { createNotification } from './notifications.js';
import { getSetting } from './conversation-db.js';

export interface StewardCardInput {
  nodeId: number;
  treeId: string | null;
  title: string;
  question: string;
  category: string;
  reason: string;
  wouldHaveAnswered?: string | null;
}

// Keep the question readable in a toast/center row without dropping the point.
const QUESTION_CAP = 700;

function trimQuestion(q: string): string {
  const clean = (q ?? '').trim();
  if (!clean) return '(no question text)';
  if (clean.length <= QUESTION_CAP) return clean;
  return `${clean.slice(0, QUESTION_CAP).trimEnd()}…`;
}

/**
 * Raise the Kevin card for a steward-parked question. Fire-and-forget: NEVER
 * throws — a card failure must not break the worker-finish path that calls it.
 */
export function raiseStewardParkCard(input: StewardCardInput): void {
  try {
    const { nodeId, treeId, title, question, category, reason } = input;

    const where = treeId ? `Node ${nodeId}, tree ${treeId}` : `Node ${nodeId}`;
    const lines: string[] = [
      `${where} — the Tree Steward parked this question instead of answering it.`,
      '',
      `Question: ${trimQuestion(question)}`,
      '',
      `Why not auto-answered: ${(category || 'unknown').trim()} — ${(reason || 'no reason given').trim()}`,
    ];

    // Shadow / card-only mode (node #383): when present, show what the steward
    // WOULD have replied, so Kevin can judge the answer without it being sent.
    const would = input.wouldHaveAnswered?.trim();
    if (would) {
      lines.push('', `Would have answered: ${would}`);
    }

    // Known deliberate double-bell: the engine ALWAYS raises its own generic ❓
    // bell for every blocked_question (src/hopper-engine.ts ~L1472). We cannot
    // suppress it from here without editing that file (owned by another tree
    // tonight). When Kevin has flipped the setting on, we at least SAY the other
    // bell is redundant so the pair is not confusing.
    const suppress = (getSetting('steward_card_suppresses_engine_bell') ?? 'off').trim().toLowerCase() === 'on';
    if (suppress) {
      lines.push('', '(The generic ❓ "needs your call" bell for this node is redundant — this steward card supersedes it.)');
    }

    // Same answer phrasing the engine's own bell uses, so Kevin has one muscle
    // memory regardless of which card he's looking at.
    lines.push('', `Answer from any JARVIS chat: "answer hopper node ${nodeId}: <your answer>" — a fresh worker resumes with it.`);

    createNotification({
      severity: 'warning',
      title: `🧭 Tree Steward parked a question: ${(title || `node ${nodeId}`).slice(0, 100)}`,
      body: lines.join('\n'),
      source: 'tree-steward',
      // NotificationMeta is a FIXED shape (kind? | checkinId? | sourceType? |
      // sourceId?) — it does NOT allow arbitrary {nodeId, treeId, category}
      // keys, so we do not force them. sourceType/sourceId are the type's own
      // identity fields, so the card is still machine-findable later by
      // meta.sourceType === 'tree-steward'. treeId/category live in the body.
      meta: { sourceType: 'tree-steward', sourceId: String(nodeId) },
    });
  } catch (err) {
    console.error('[tree-steward-card] failed to raise park card:', err);
  }
}
