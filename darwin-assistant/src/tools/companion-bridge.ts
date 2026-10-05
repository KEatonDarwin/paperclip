import type { ToolDef } from './index.js';
import { COMPANION_BRIDGE_TOOL_NAME } from '../companion-chat.js';

// Reserved tool-name stub (node #1383). This is the ONLY tool a companion
// thread's fail-closed allow-list (companion-chat.ts allowedToolsForThread)
// admits besides the conversational turn path itself. The real send-to-Kevin
// bridge is #266's job — until it lands this just returns not-implemented so
// the name exists for the allow-list to reference and for #266 to fill in.
export const companionSendToKevin: ToolDef = {
  name: COMPANION_BRIDGE_TOOL_NAME,
  description:
    "Send a message to Kevin from the companion chat. NOT YET IMPLEMENTED — the real bridge is built in a later task; this stub exists only to reserve the tool name for the companion thread's allow-list.",
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The message to relay to Kevin.',
      },
    },
    required: ['message'],
  },
  execute: async () => {
    return { error: 'not_implemented: companion_send_to_kevin bridge is not built yet (see #266)' };
  },
};
