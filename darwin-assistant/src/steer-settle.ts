import { enqueueMessage } from './thread-message-queue.js';
import { formatDemoted, settleSteerFiles, sweepStaleSteerFiles } from './steer-inbox.js';

// Turn-end bookkeeping for the steer inbox. Kept apart from steer-inbox.ts so
// that module stays DB-free. Whatever never reached the model goes back on the
// existing queue as ONE After message (coalesced), so it is drained as the next
// turn exactly like today's 202 queue — never lost, never five separate turns.

/** `ok` = the turn finished normally (claimed items were seen by the model). */
export function settleSteer(conversationId: number, ok: boolean): void {
  try {
    const back = settleSteerFiles(conversationId, ok);
    if (back.length) enqueueMessage(conversationId, formatDemoted(back), null, null, null, { sender: 'steer-returned' });
  } catch (err) {
    console.warn('[steer] settle failed:', err instanceof Error ? err.message : err);
  }
}

/** A restart mid-turn leaves files from a dead process; queue them as After. */
export function sweepStaleSteer(conversationId: number): void {
  try {
    const stale = sweepStaleSteerFiles(conversationId);
    if (stale.length) enqueueMessage(conversationId, formatDemoted(stale), null, null, null, { sender: 'steer-returned' });
  } catch (err) {
    console.warn('[steer] stale sweep failed:', err instanceof Error ? err.message : err);
  }
}
