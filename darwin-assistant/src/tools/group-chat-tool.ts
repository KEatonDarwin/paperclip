import type { ToolDef } from './index.js';
import { getConversationById, listConversationsByGroup, getTurns } from '../conversation-db.js';
import { getLatestThreadSummary } from '../thread-summaries.js';

// DAR-742 — group-chat-only tool. Only usable from inside a group's cover
// chat (gated on the calling conversation's own is_group_chat/group_id), and
// only against threads that are actual members of THAT group — Phase 1 is
// read/synthesis only, so this never writes anywhere.
export const getMemberThread: ToolDef = {
  name: 'get_member_thread',
  description:
    "Group-chat only. Look up one member thread of the CURRENT group by its thread_id (shown in the group summaries context as 'thread_id: ...'). mode:'summary' (default) returns its cached point-in-time summary; mode:'full' returns its actual user/assistant transcript. Use 'full' only when the summary genuinely isn't enough to answer the question.",
  parameters: {
    type: 'object',
    properties: {
      thread_id: {
        type: 'string',
        description: "The member thread's external_id, as shown in the group summaries context.",
      },
      mode: {
        type: 'string',
        enum: ['summary', 'full'],
        description: "Depth to return. Default 'summary'.",
      },
    },
    required: ['thread_id'],
  },
  execute: async (args, context) => {
    const conversationId = context?.conversationId;
    if (!conversationId) return { error: 'No active conversation.' };
    const self = getConversationById(conversationId);
    if (!self || !self.is_group_chat || !self.group_id) {
      return { error: 'get_member_thread is only available inside a group chat conversation.' };
    }

    const threadId = typeof args.thread_id === 'string' ? args.thread_id.trim() : '';
    if (!threadId) return { error: 'thread_id is required' };

    const members = listConversationsByGroup(self.group_id);
    const target = members.find((m) => m.external_id === threadId);
    if (!target) {
      return { error: `"${threadId}" is not a member thread of this group.` };
    }

    const mode = args.mode === 'full' ? 'full' : 'summary';
    if (mode === 'summary') {
      const summary = getLatestThreadSummary(target.id);
      return summary
        ? { thread_id: target.external_id, mode: 'summary', summary: summary.content, generated_at: summary.created_at }
        : { thread_id: target.external_id, mode: 'summary', summary: null, note: 'No summary generated yet for this thread.' };
    }

    const turns = getTurns(target.id).filter((t) => t.role === 'user' || t.role === 'assistant');
    return {
      thread_id: target.external_id,
      mode: 'full',
      transcript: turns.map((t) => ({ role: t.role, content: t.content })),
    };
  },
};
