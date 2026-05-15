import type { App } from '@slack/bolt';
import { query } from './db.js';
import { processMessage } from './agent.js';
import { isMuted } from './mute-check.js';
import { getConversation, getOrCreateConversation, addTurn, updateSessionId } from './conversation-db.js';

const POLL_INTERVAL_MS = 60_000;
const CHECKIN_CONV_PREFIX = 'checkin:';

interface CheckinRow {
  id: string;
  fire_at: string;
  reason: string;
  source_type: string;
  source_id: string | null;
}

async function processDueCheckins(slackApp: App): Promise<void> {
  const due = await query<CheckinRow>(
    `UPDATE jarvis_checkins
     SET status = 'fired'
     WHERE id IN (
       SELECT id FROM jarvis_checkins
       WHERE status = 'pending' AND fire_at <= now()
       ORDER BY fire_at ASC
       LIMIT 5
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, fire_at, reason, source_type, source_id`,
  );

  if (!due.length) return;

  const userId = process.env.SLACK_KEVIN_USER_ID;
  if (!userId) {
    console.warn('[checkin-worker] SLACK_KEVIN_USER_ID not set — skipping delivery');
    return;
  }

  for (const checkin of due) {
    try {
      if (checkin.source_id && await isMuted(checkin.source_type, checkin.source_id)) {
        await query(`UPDATE jarvis_checkins SET status = 'skipped' WHERE id = $1`, [checkin.id]);
        console.log(`[checkin-worker] Muted — skipped ${checkin.id}: ${checkin.reason.slice(0, 60)}`);
        continue;
      }

      const prompt = [
        `[CHECK-IN REMINDER — ${checkin.source_type}]`,
        checkin.reason,
        '',
        'Check if Kevin is actively working on this (look at SHIM focus sessions, recent activity).',
        'If there is clear proof he is on track, respond with exactly "[SKIP]" and nothing else.',
        'Otherwise, write a short, warm nudge to Kevin about this — one or two sentences max.',
      ].join('\n');

      const conversationId = `${CHECKIN_CONV_PREFIX}${checkin.id}`;
      const response = await processMessage(prompt, conversationId);

      if (response.trim().startsWith('[SKIP]')) {
        await query(`UPDATE jarvis_checkins SET status = 'skipped' WHERE id = $1`, [checkin.id]);
        console.log(`[checkin-worker] Skipped ${checkin.id}: ${checkin.reason.slice(0, 60)}`);
        continue;
      }

      const postResult = await slackApp.client.chat.postMessage({ channel: userId, text: response });
      console.log(`[checkin-worker] Fired ${checkin.id}: ${checkin.reason.slice(0, 60)}`);

      // Link the posted message to a Slack-keyed conversation so that when Kevin
      // replies in the thread, JARVIS has context of what it said.
      const slackTs = typeof postResult.ts === 'string' ? postResult.ts : null;
      if (slackTs) {
        const checkinConv = getConversation(conversationId);
        const slackConv = getOrCreateConversation(`slack:${userId}:${slackTs}`, userId);
        if (checkinConv?.claude_session_id) {
          updateSessionId(slackConv.id, checkinConv.claude_session_id);
        }
        addTurn(slackConv.id, 'assistant', response);
      }
    } catch (err) {
      console.error(`[checkin-worker] Error processing ${checkin.id}:`, err);
    }
  }
}

export function startCheckinWorker(slackApp: App): void {
  console.log('[checkin-worker] Started (polling every 60s)');
  const tick = () => {
    processDueCheckins(slackApp).catch((err) =>
      console.error('[checkin-worker] Poll error:', err),
    );
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
