import { EventEmitter } from 'node:events';
import type { AutonomyLedgerRow } from './autonomy-ledger.js';
import type { ThreadTodoRow } from './thread-todos.js';
import type { ThreadLinkRow } from './thread-links.js';
import type { JarvisDecisionRow } from './jarvis-decisions.js';
import type { NoteRow } from './notes-db.js';
import type { QuickCaptureItemRow } from './quick-capture-db.js';
import type { ThreadReminderRow } from './thread-reminders.js';
import type { ThreadSummaryRow } from './thread-summaries.js';
import type { NotificationRow } from './notifications.js';
import type { DispatchRow, DispatchWorkerRow } from './dispatches.js';
import type { HopperItemRow } from './hopper.js';
import type { HopperNodeRow } from './hopper-engine.js';
import type { SmartTodoNodeRow } from './smart-todos.js';
import type { MonitorRow, MonitorRunRow } from './monitors.js';
import type { FoundryModuleResponse, FoundryProjectResponse } from './foundry.js';

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
    images: string | null;
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
  // The conversation this status is about. Every ingress emits its own
  // start/stop, so status is per-conversation — subscribers must key off this
  // rather than treating it as a single global "is anything running" toggle.
  conversationId: number;
  // Back-compat alias (= conversationId while running, null when stopped).
  activeConversationId: number | null;
}

export interface StreamStartEvent {
  type: 'stream_start';
  conversationId: number;
}

export interface StreamDeltaEvent {
  type: 'stream_delta';
  conversationId: number;
  delta: string;
}

export interface StreamEndEvent {
  type: 'stream_end';
  conversationId: number;
}

export interface AutonomyLedgerEvent {
  type: 'autonomy_ledger_entry';
  entry: AutonomyLedgerRow;
}

export interface AutonomyLedgerReviewEvent {
  type: 'autonomy_ledger_review';
  entry: AutonomyLedgerRow;
}

export interface ThreadTodoEvent {
  type: 'thread_todo';
  conversationId: number;
  action: 'created' | 'updated' | 'deleted';
  todo: ThreadTodoRow;
}

// Per-thread "relevant links" bar under the title (preview/build URL + refs).
// Same shape as ThreadTodoEvent — one row, create/update/delete, keyed by
// conversationId (the /events writer annotates external_id on the way out).
export interface ThreadLinkEvent {
  type: 'thread_link';
  conversationId: number;
  action: 'created' | 'updated' | 'deleted';
  link: ThreadLinkRow;
}

export interface ConversationRenamedEvent {
  type: 'conversation_renamed';
  conversationId: number;
  title: string | null;
}

export interface ConversationDeletedEvent {
  type: 'conversation_deleted';
  conversationId: number;
}

export interface JarvisDecisionEvent {
  type: 'jarvis_decision';
  action: 'created' | 'updated';
  decision: JarvisDecisionRow;
}

export interface QueuedMessageEvent {
  type: 'queued_message';
  conversationId: number;
  action: 'created' | 'deleted';
  item: {
    id: number;
    conversation_id: number;
    content: string;
    created_at: string;
  };
}

export interface NoteEvent {
  type: 'note';
  action: 'created' | 'updated';
  note: NoteRow;
}

export interface QuickCaptureEvent {
  type: 'quick_capture';
  action: 'created' | 'updated' | 'deleted' | 'reordered';
  item?: QuickCaptureItemRow;
  items?: QuickCaptureItemRow[];
  id?: number;
}

export interface ThreadReminderEvent {
  type: 'thread_reminder';
  conversationId: number;
  action: 'created' | 'updated' | 'cancelled' | 'fired';
  reminder: ThreadReminderRow & { alerting: boolean };
}

export interface ToolCallEvent {
  type: 'tool_call';
  conversationId: number;
  toolName: string;
}

// DAR-740 — point-in-time thread summary, generated on demand. The bookmark
// dropped into the timeline is anchored to anchor_turn_index at generation
// time, so a client can insert it in the right spot without waiting on a
// refetch.
export interface ThreadSummaryEvent {
  type: 'thread_summary';
  conversationId: number;
  action: 'created';
  summary: ThreadSummaryRow;
}

// DAR-742 — thread groups (folders). Fired on create/rename/delete of a group
// itself; per-thread group membership changes ride the existing
// `conversation_updated` event (setThreadGroup emits one, same as pin/unpin).
export interface ThreadGroupEvent {
  type: 'thread_group';
  action: 'created' | 'updated' | 'deleted';
  groupId: number;
  group?: { id: number; name: string; color: string | null; sort_order: number };
}

// DAR-761 — cockpit notification layer (bell/center + toasts). Global, not
// conversation-scoped — same treatment as NoteEvent/QuickCaptureEvent below.
export interface NotificationEvent {
  type: 'notification';
  action: 'created' | 'updated' | 'deleted';
  notification: NotificationRow;
}

// DAR-782 — dispatch signaling. Fired on dispatch lifecycle (create/complete/ack/delete)
// and worker status updates. Keyed to the orchestrator's conversationId.
export interface DispatchEvent {
  type: 'dispatch';
  conversationId: number;
  action: 'created' | 'updated' | 'completed' | 'acknowledged' | 'deleted';
  dispatch: DispatchRow;
  workers: DispatchWorkerRow[];
}

// DAR-782 — dispatch cue. Fired when a dispatch gate is satisfied and the
// orchestrator should be notified. Renders as a cue chip, NOT a chat message.
export interface DispatchCueEvent {
  type: 'dispatch_cue';
  conversationId: number;
  dispatchId: number;
  label: string | null;
  workersFinished: number;
  workersTotal: number;
}

// TASK HOPPER — a candidate task awaiting Kevin's yes/dismiss. Global, not
// conversation-scoped (same treatment as NotificationEvent).
export interface HopperItemEvent {
  type: 'hopper_item';
  action: 'created' | 'updated' | 'deleted';
  item: HopperItemRow;
}

// SMART TODO TREE — Kevin's standalone always-open backlog tree. Global, not
// conversation-scoped (same treatment as HopperItemEvent). A tree edit can
// touch many nodes, so 'bulk' signals "refetch the whole tree"; single-node
// create/update/delete carry the affected node.
export interface SmartTodoEvent {
  type: 'smart_todo';
  action: 'created' | 'updated' | 'deleted' | 'bulk';
  node?: SmartTodoNodeRow;
}

// HOPPER ENGINE — work-tree node state changes (dispatch/finish/split/etc.).
// Global like HopperItemEvent; a future tree-view pane renders live off these.
export interface HopperNodeEvent {
  type: 'hopper_node';
  action: 'created' | 'updated' | 'deleted';
  node: HopperNodeRow;
}

// COCKPIT MONITORS — scheduled prompt-check agents with durable pass/fail/error
// history. Global, not conversation-scoped; monitor threads themselves still
// emit normal thread events.
export interface MonitorEvent {
  type: 'monitor';
  action: 'created' | 'updated' | 'deleted';
  monitor: MonitorRow;
}

export interface MonitorRunEvent {
  type: 'monitor_run';
  action: 'created' | 'updated';
  run: MonitorRunRow;
}

export interface FoundryProjectEvent {
  type: 'foundry_project';
  action: 'created' | 'updated' | 'deleted';
  project: FoundryProjectResponse;
}

export interface FoundryModuleEvent {
  type: 'foundry_module';
  action: 'created' | 'updated' | 'deleted';
  project_id: string;
  module: FoundryModuleResponse;
}

export type SSEEvent =
  | TurnEvent | ConversationUpdatedEvent | ConversationCreatedEvent | StatusEvent
  | StreamStartEvent | StreamDeltaEvent | StreamEndEvent
  | AutonomyLedgerEvent | AutonomyLedgerReviewEvent
  | ThreadTodoEvent | ThreadLinkEvent | JarvisDecisionEvent
  | ConversationRenamedEvent | ConversationDeletedEvent
  | QueuedMessageEvent | NoteEvent | QuickCaptureEvent
  | ThreadReminderEvent | ToolCallEvent | ThreadSummaryEvent
  | ThreadGroupEvent | NotificationEvent
  | DispatchEvent | DispatchCueEvent | HopperItemEvent | HopperNodeEvent | SmartTodoEvent
  | MonitorEvent | MonitorRunEvent | FoundryProjectEvent | FoundryModuleEvent;

class SSEBus extends EventEmitter {}

export const sseBus = new SSEBus();
sseBus.setMaxListeners(100);
