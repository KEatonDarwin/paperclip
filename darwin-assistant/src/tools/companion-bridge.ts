import type { ToolDef } from './index.js';
import type { ToolExecutionContext } from '../autonomy-ledger.js';
import { COMPANION_BRIDGE_TOOL_NAME, companionIdFromThread } from '../companion-chat.js';
import { countTurns, getBridgedThreads } from '../conversation-db.js';
import { insertCrossChatSidecar, summarizeForSidecar } from '../cross-chat-sidecar.js';

// bridge_send — node #1430, wish-catalog pilot (tree-3e526df9). The real
// relay the stub registered under this name (#1383) deferred to #266: a
// companion thread's ONLY non-conversation tool, scoped in by the fail-closed
// allow-list in companion-chat.ts (allowedToolsForThread). It never widens
// that allow-list or reaches any JARVIS ops tool — it only ever resolves the
// caller's own bridge partner(s) (#1408's getBridgedThreads) and drops a
// digest card into each one.
export const bridgeSend: ToolDef = {
  name: COMPANION_BRIDGE_TOOL_NAME,
  description:
    'Relay an idea from this chat to your bridged partner thread. Give the idea in plain words — it is summarized into a short digest before it lands there, never dumped verbatim. Returns a clean "no bridge" result if this thread has no bridge partner.',
  parameters: {
    type: 'object',
    properties: {
      idea: {
        type: 'string',
        description: 'The idea or message to relay, in plain words.',
      },
    },
    required: ['idea'],
  },
  execute: async (args, context?: ToolExecutionContext) => {
    if (!context) {
      return { error: 'no_context: bridge_send requires a thread context and cannot run standalone' };
    }

    const idea = typeof args.idea === 'string' ? args.idea : '';
    if (!idea.trim()) {
      return { error: 'empty_idea: give bridge_send something to relay' };
    }

    const partners = getBridgedThreads(context.externalId);
    if (partners.length === 0) {
      return { error: 'no_bridge: this thread has no bridge partner to relay to' };
    }

    const companionId = companionIdFromThread(context.externalId);
    const fromLabel = companionId ? `Companion (${companionId})` : context.externalId;
    const summary = summarizeForSidecar(idea);
    const lastTurnIndex = countTurns(context.conversationId) - 1;
    const originTurnRef = lastTurnIndex >= 0 ? lastTurnIndex : null;

    const deliveredTo: string[] = [];
    for (const partnerExtId of partners) {
      const inserted = insertCrossChatSidecar({
        from_thread_ext: context.externalId,
        to_thread_ext: partnerExtId,
        from_label: fromLabel,
        summary,
        origin_turn_ref: originTurnRef,
      });
      if (inserted) deliveredTo.push(partnerExtId);
    }

    if (deliveredTo.length === 0) {
      return { error: 'no_bridge: bridge partner thread(s) do not exist yet' };
    }

    return { delivered_to: deliveredTo, summary };
  },
};
