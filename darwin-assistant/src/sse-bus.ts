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
import type { WorkbenchProposalRow } from './workbench.js';
import type { WorkstreamWithDetails } from './workstreams.js';
import type { MonitorRow, MonitorRunRow } from './monitors.js';
import type { FoundryModuleResponse, FoundryProjectResponse } from './foundry.js';
import type { IntelItem, IntelRun } from './intel-desk.js';
import type { GoalSummary, GoalNodeRow, FocusRow } from './goals.js';
import type { GoalGuardRow } from './goals-guards.js';
import type { NightRunRow, NightItemRow } from './night-shift.js';

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

// WORKBENCH V2 — the ghost/proposal layer (draft nodes Kevin corrects before
// they become real). Global, not conversation-scoped (same treatment as
// HopperItemEvent/SmartTodoEvent). A batch can contain many rows at once, so
// clients simply refetch GET /workbench/proposals on any event — same
// reload-on-SSE pattern workbench.tsx already uses for smart_todo. See
// docs/workbench/SPEC.md "V2 — THE INTERACTION CORRECTION" + RECON-V2.md §5/§6.
export interface WorkbenchProposalEvent {
  type: 'workbench_proposal';
  action: 'created' | 'updated' | 'accepted' | 'rejected';
  batch_id: string;
  proposal?: WorkbenchProposalRow;
}

// FLIGHT DECK — Kevin/JARVIS workstreams, the "balls in the air" surface.
// Global like HopperItemEvent; payload includes links + latest timeline events
// so clients can patch a card/drawer from one event or simply refetch.
export interface WorkstreamEvent {
  type: 'workstream';
  action: 'created' | 'updated' | 'deleted';
  workstream: WorkstreamWithDetails;
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

export interface IntelRunEvent {
  type: 'intel_run';
  action: 'created' | 'updated' | 'deleted';
  run: IntelRun;
}

export interface IntelItemEvent {
  type: 'intel_item';
  action: 'created' | 'updated' | 'deleted';
  item: IntelItem;
}

// GOALS — the goal-driven development surface. Global like HopperItemEvent
// (no conversationId); the cockpit filters by goal_id client-side.
export interface GoalEvent {
  type: 'goal';
  action: 'created' | 'updated' | 'deleted';
  goal: GoalSummary;
}
export interface GoalNodeEvent {
  type: 'goal_node';
  action: 'created' | 'updated' | 'deleted';
  goal_id: number;
  node: GoalNodeRow;
  batch_id?: string;
}
export interface GoalFocusEvent {
  type: 'goal_focus';
  goal_id: number;
  focus: FocusRow;
}
export interface GoalGuardEvent {          // 'goal_guard' (v0.2 §12.9) — global, like goal/goal_node
  type: 'goal_guard';
  action: 'proposed' | 'set' | 'updated' | 'discarded' | 'health';
  goal_id: number;
  guard: GoalGuardRow;
}

// NIGHT SHIFT (CONTRACT §7) — global like GoalEvent (no conversationId). Planning
// emits ONE `night_run` with action 'planned'; per-item events fire only for
// individual status/position/insert changes during a run (§12.15).
export interface NightRunEvent {
  type: 'night_run';
  action: 'planned' | 'updated' | 'started' | 'paused' | 'resumed' | 'stopped' | 'complete';
  run: NightRunRow;
}
export interface NightItemEvent {
  type: 'night_item';
  action: 'created' | 'updated';
  item: NightItemRow;
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
  | WorkstreamEvent | MonitorEvent | MonitorRunEvent | FoundryProjectEvent | FoundryModuleEvent
  | IntelRunEvent | IntelItemEvent | WorkbenchProposalEvent
  | GoalEvent | GoalNodeEvent | GoalFocusEvent | GoalGuardEvent
  | NightRunEvent | NightItemEvent;

// ---------------------------------------------------------------------------
// THE GLOBAL-STREAM EVENT CONTRACT — one list, server-owned.
//
// `GET /events` forwards exactly the types in GLOBAL_STREAM_EVENT_TYPES, and it
// ANNOUNCES that list to every client in a `stream_types` frame on connect (see
// api-v1.ts) — plus `GET /events/types` for a plain fetch. That announcement is
// the whole point: the cockpit's SharedWorker
// (jarvis-command-center/src/lib/sse-worker.ts) used to carry its own hardcoded
// copy of this list, and because a SharedWorker only fans out event names it
// explicitly subscribed to, anything missing from that copy was silently
// dropped for EVERY tab. Both halves of that bug were live:
//   - `notification` was in FORWARD but missing from the worker's copy, so bell
//     toasts never fired live on the SharedWorker path (Chrome) — only after a
//     manual refresh or a stream reconnect.
//   - `thread_group` was the mirror image: subscribed on the client, never in
//     FORWARD, so group renames never reached a tab either.
// The cockpit is a separate repo, so a shared import is impossible; runtime
// discovery is what makes the two lists incapable of diverging.
//
// ADDING AN EVENT TYPE: add it to SSEEvent, then put its name in exactly ONE of
// the two arrays below. The assertion underneath will not compile until you do.
// ---------------------------------------------------------------------------
export const GLOBAL_STREAM_EVENT_TYPES = [
  'turn', 'conversation_created', 'conversation_updated',
  'conversation_renamed', 'conversation_deleted', 'status',
  'stream_start', 'stream_delta', 'stream_end',
  'note', 'quick_capture', 'notification',
  'thread_todo', 'thread_link', 'thread_reminder', 'thread_summary',
  'thread_group', 'queued_message',
  'dispatch', 'dispatch_cue',
  'hopper_item', 'hopper_node', 'smart_todo', 'workbench_proposal', 'workstream',
  'monitor', 'monitor_run',
  'foundry_project', 'foundry_module',
  'intel_run', 'intel_item',
  'goal', 'goal_node', 'goal_focus', 'goal_guard',
  'night_run', 'night_item',   // Night Shift (node #679/#680): board + /night live updates
] as const satisfies readonly SSEEvent['type'][];

export type GlobalStreamEventType = (typeof GLOBAL_STREAM_EVENT_TYPES)[number];

// Emitted on the bus but deliberately NOT on the global stream. Each of these
// is either per-thread-only or has no client consumer at all — spelled out so
// that omission is a decision on the record rather than an oversight:
//   tool_call              per-thread only; carries conversationId, so the
//                          /threads/:ext/events stream already delivers it.
//   autonomy_ledger_entry  no conversationId and no cockpit consumer today, so
//   autonomy_ledger_review forwarding them would be dead weight on the stream.
//   jarvis_decision        same — written to the ledger, read back over REST.
export const LOCAL_ONLY_SSE_EVENT_TYPES = [
  'tool_call', 'autonomy_ledger_entry', 'autonomy_ledger_review', 'jarvis_decision',
] as const satisfies readonly SSEEvent['type'][];

// Compile-time exhaustiveness: if a new member of the SSEEvent union is in
// neither array, `UnclassifiedSSEEventType` stops being `never` and this line
// fails to typecheck with the offending name in the error message.
type AssertNever<T extends never> = T;
type UnclassifiedSSEEventType = Exclude<
  SSEEvent['type'],
  GlobalStreamEventType | (typeof LOCAL_ONLY_SSE_EVENT_TYPES)[number]
>;
export type _EverySSEEventTypeIsClassified = AssertNever<UnclassifiedSSEEventType>;

class SSEBus extends EventEmitter {}

export const sseBus = new SSEBus();
sseBus.setMaxListeners(100);
