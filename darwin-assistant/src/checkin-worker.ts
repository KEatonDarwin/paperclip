import type { App } from '@slack/bolt';
import { query } from './db.js';
import { processMessage } from './agent.js';
import { isMuted } from './mute-check.js';
import { getConversation, getOrCreateConversation, addTurn, updateSessionState } from './conversation-db.js';

const POLL_INTERVAL_MS = 60_000;
const CHECKIN_CONV_PREFIX = 'checkin:';

// Server-guaranteed Project Shepherd. The check-in re-queue used to be model-owned
// (each firing had to INSERT the next row), so the loop died permanently the first
// time a firing forgot to re-queue — it was silently dead 2026-07-05 → 2026-07-22.
// The worker now guarantees a pending project-shepherd row always exists, so a missed
// re-queue can no longer kill the heartbeat. "Server owns state, model owns story."
const SHEPHERD_LEAD_HOURS = 8;
const DEFAULT_SHEPHERD_REASON = [
  'PROJECT SHEPHERD SWEEP (server-guaranteed — the checkin-worker re-arms this',
  'automatically, so do NOT insert a new shepherd row yourself; just do the sweep).',
  'Goal: no build of mine stalls, and Kevin always hears back on anything I said',
  "I'd report. STEPS: (1) list my open in-flight issues (jarvis_created_issues +",
  'the Active Commitments list in memory) and check each one’s live status in',
  'Paperclip; (2) detect stalls (blocked, unanswered comment, no movement >24h, or',
  'sitting in todo unstarted); (3) nudge assignees where I can; (4) if anything I',
  'told Kevin "I’ll let you know when it’s done" is now DONE or needs his',
  'decision, DM him (Slack D0B2DGVNWD6) — this is the "never hear back" fix;',
  '(5) honor NO-WORK-SUNDAYS — sweep silently, don’t ping about work on',
  'Sundays. If nothing needs Kevin, reply exactly [SKIP].',
].join(' ');

// Idempotent: inserts the next shepherd row only when none is pending. Runs every
// tick after the due-check pass, so continuity is maintained even when the queue is
// otherwise empty.
async function ensureShepherdQueued(): Promise<void> {
  await query(
    `INSERT INTO jarvis_checkins (fire_at, reason, source_type, source_id, status)
     SELECT now() + interval '${SHEPHERD_LEAD_HOURS} hours', $1, 'manual', 'project-shepherd', 'pending'
     WHERE NOT EXISTS (
       SELECT 1 FROM jarvis_checkins
       WHERE source_id = 'project-shepherd' AND status = 'pending'
     )`,
    [DEFAULT_SHEPHERD_REASON],
  );
}

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
          updateSessionState(slackConv.id, checkinConv.claude_session_id, checkinConv.session_adapter);
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
    processDueCheckins(slackApp)
      .catch((err) => console.error('[checkin-worker] Poll error:', err))
      .finally(() => {
        ensureShepherdQueued().catch((err) =>
          console.error('[checkin-worker] ensureShepherd error:', err),
        );
      });
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
