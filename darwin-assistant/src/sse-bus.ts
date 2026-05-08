import { EventEmitter } from 'node:events';

export interface TurnEvent {
  type: 'turn';
  conversationId: number;
  turn: {
    id: number;
    turn_index: number;
    role: string;
    content: string | null;
    tool_name: string | null;
    tool_args: string | null;
    tool_result: string | null;
    created_at: string;
    timing_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    model: string | null;
    claude_input: string | null;
    claude_output: string | null;
  };
}

export interface ConversationUpdatedEvent {
  type: 'conversation_updated';
  conversationId: number;
  status: string;
  updatedAt: string;
  turnCount: number;
}

export interface ConversationCreatedEvent {
  type: 'conversation_created';
  conversationId: number;
  externalId: string;
  status: string;
  createdAt: string;
}

export interface StatusEvent {
  type: 'status';
  running: boolean;
  activeConversationId: number | null;
}

export type SSEEvent = TurnEvent | ConversationUpdatedEvent | ConversationCreatedEvent | StatusEvent;

class SSEBus extends EventEmitter {}

export const sseBus = new SSEBus();
sseBus.setMaxListeners(100);
