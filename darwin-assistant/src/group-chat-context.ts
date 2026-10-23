import { listConversationsByGroup, countTurns } from './conversation-db.js';
import { getLatestThreadSummary } from './thread-summaries.js';
import { generateThreadSummary } from './thread-summarize.js';

// DAR-742 — Phase 1 group-chat context: on every group-chat turn, prepend
// each member thread's cached summary (regenerated only if the member has
// picked up new turns since its last summary — see SKILL.md "Summary cache").
// This is the ONLY context a group chat gets about its members automatically;
// anything deeper goes through the get_member_thread tool on demand.

export async function buildGroupChatContext(groupId: number): Promise<string> {
  const members = listConversationsByGroup(groupId);
  if (members.length === 0) {
    return '<group_chat_member_summaries>\nThis group has no member threads yet.\n</group_chat_member_summaries>\n\n';
  }

  const blocks = await Promise.all(
    members.map(async (m) => {
      const label = m.title ?? m.external_id;
      const lastTurnIndex = countTurns(m.id) - 1;
      let summary = getLatestThreadSummary(m.id);
      const stale = lastTurnIndex >= 0 && (!summary || summary.anchor_turn_index < lastTurnIndex);
      if (stale) {
        try {
          summary = await generateThreadSummary(m);
        } catch (err) {
          console.error(`[group-chat-context] summary refresh failed for conversation ${m.id}:`, err);
        }
      }
      if (!summary) {
        return `### ${label} (thread_id: ${m.external_id})\n_No messages yet._`;
      }
      return `### ${label} (thread_id: ${m.external_id})\n${summary.content}`;
    }),
  );

  return `<group_chat_member_summaries>\nThis group chat's member threads, each summarized as of their latest activity. Talk about the group in general using these; call the get_member_thread tool with a thread_id above and mode:'full' to pull one member's actual transcript if a question needs more than the summary gives you.\n\n${blocks.join('\n\n')}\n</group_chat_member_summaries>\n\n`;
}
