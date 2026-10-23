import { sseBus, type StatusEvent, type DispatchCueEvent } from './sse-bus.js';
import {
  findWaitingDispatchesForWorker,
  markWorkerDone,
  evaluateGate,
  completeDispatch,
  getDispatch,
  listDispatchWorkers,
} from './dispatches.js';
import { getConversationById } from './conversation-db.js';
import { processMessage, getInFlightMessageId, ConversationBusyError } from './agent.js';
import { enqueueMessage } from './thread-message-queue.js';

export function installDispatchGate(): void {
  sseBus.on('sse', (ev) => {
    if (ev.type !== 'status' || ev.running) return;
    const workerConvId = (ev as StatusEvent).conversationId;
    handleWorkerCompletion(workerConvId);
  });
}

function handleWorkerCompletion(workerConversationId: number): void {
  const pending = findWaitingDispatchesForWorker(workerConversationId);
  if (!pending.length) return;

  for (const { dispatch_id, worker_id } of pending) {
    markWorkerDone(worker_id);

    const dispatch = getDispatch(dispatch_id);
    if (!dispatch || dispatch.status !== 'waiting') continue;

    const workers = listDispatchWorkers(dispatch_id);

    sseBus.emit('sse', {
      type: 'dispatch',
      conversationId: dispatch.orchestrator_conversation_id,
      action: 'updated',
      dispatch,
      workers,
    });

    if (!evaluateGate(dispatch_id)) continue;

    const completed = completeDispatch(dispatch_id);
    if (!completed) continue;

    const finishedCount = workers.filter(w => w.done === 1).length;
    const totalCount = workers.length;

    sseBus.emit('sse', {
      type: 'dispatch_cue',
      conversationId: completed.orchestrator_conversation_id,
      dispatchId: completed.id,
      label: completed.label,
      workersFinished: finishedCount,
      workersTotal: totalCount,
    } satisfies DispatchCueEvent);

    if (completed.wake_mode === 'active') {
      fireCue(completed.orchestrator_conversation_id, completed.id, completed.label, finishedCount);
    }
  }
}

function fireCue(orchestratorConvId: number, dispatchId: number, label: string | null, finishedCount: number): void {
  const conv = getConversationById(orchestratorConvId);
  if (!conv) return;

  const cueText = label
    ? `[dispatch #${dispatchId} "${label}" complete — ${finishedCount} workers finished]`
    : `[dispatch #${dispatchId} complete — ${finishedCount} workers finished]`;

  if (getInFlightMessageId(orchestratorConvId)) {
    enqueueMessage(orchestratorConvId, cueText);
    return;
  }

  processMessage(cueText, conv.external_id, `dispatch-cue:${dispatchId}`).catch((err: unknown) => {
    if (err instanceof ConversationBusyError) {
      enqueueMessage(orchestratorConvId, cueText);
    }
  });
}
