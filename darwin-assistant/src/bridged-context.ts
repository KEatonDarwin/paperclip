import { getConversation, getBridgedThreads, countTurns } from './conversation-db.js';
import { getLatestThreadSummary } from './thread-summaries.js';
import { generateThreadSummary } from './thread-summarize.js';

// Two-way context bridge (tree-a9775da1, node #1413) — a thread linked via
// thread_bridges (node #1408's getBridgedThreads) gets a fresh digest of its
// partner's recent turns injected every turn, symmetric in either direction
// (a companion thread's turn sees its goal-12 partner's digest, and vice
// versa — same code path, driven by the bridge rows, not hardcoded per side).
//
// Reuses the exact summary-cache machinery group chat already uses
// (getLatestThreadSummary / generateThreadSummary, DAR-742) rather than
// re-implementing summarization.
//
// #276 safety: generateThreadSummary builds its transcript purely from the
// partner conversation's own turns (conversation-db), never from
// perTurnContextPrefix/operator-context assembly — so the digest can never
// carry the autonomy dial, the hard-limiter summary, or any live-DB
// reference. Threads with no bridge partner get '' (byte-identical to
// before this feature existed).
export async function buildBridgedContext(externalId: string): Promise<string> {
  const partners = getBridgedThreads(externalId);
  if (partners.length === 0) return '';

  const blocks = await Promise.all(
    partners.map(async (partnerExtId) => {
      const partnerConv = getConversation(partnerExtId);
      if (!partnerConv) return null;
      const lastTurnIndex = countTurns(partnerConv.id) - 1;
      let summary = getLatestThreadSummary(partnerConv.id);
      const stale = lastTurnIndex >= 0 && (!summary || summary.anchor_turn_index < lastTurnIndex);
      if (stale) {
        try {
          summary = await generateThreadSummary(partnerConv);
        } catch (err) {
          console.error(`[bridged-context] summary refresh failed for conversation ${partnerConv.id}:`, err);
        }
      }
      if (!summary) return null;
      return `<bridged_context source="${partnerExtId}">\n${summary.content}\n</bridged_context>`;
    }),
  );

  const present = blocks.filter((b): b is string => b !== null);
  return present.length ? present.join('\n\n') + '\n\n' : '';
}
