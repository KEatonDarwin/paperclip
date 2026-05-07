import 'dotenv/config';
import express from 'express';
import { createSlackApp, sendDailyBriefing } from './handlers/slack.js';
import { createWebhookRouter } from './handlers/webhook.js';
import { startCheckinWorker } from './checkin-worker.js';
import { enqueueCalendarCheckins } from './briefing.js';
import { startUiServer } from './ui-server.js';

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT ?? '3200', 10);
const SLACK_ENABLED = !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);

// ─── 8am CST daily briefing cron ─────────────────────────────────────────────

function msUntilNext8amCST(): number {
  const now = new Date();
  const target = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/Chicago' }),
  );
  target.setHours(8, 0, 0, 0);

  // If 8am today has already passed, schedule for tomorrow
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  // Convert back to UTC offset by computing the difference
  const cstNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const offset = now.getTime() - cstNow.getTime();
  return target.getTime() + offset - now.getTime();
}

function scheduleDailyBriefing(slackApp: ReturnType<typeof createSlackApp>) {
  const ms = msUntilNext8amCST();
  const hoursUntil = (ms / 1000 / 60 / 60).toFixed(1);
  console.log(`[briefing] Next morning briefing in ${hoursUntil}h`);

  setTimeout(async () => {
    await sendDailyBriefing(slackApp);
    await enqueueCalendarCheckins().catch((err: unknown) =>
      console.error('[briefing] Failed to enqueue calendar check-ins:', err),
    );
    scheduleDailyBriefing(slackApp);
  }, ms);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const webhookApp = express();
  webhookApp.use('/api', createWebhookRouter());

  webhookApp.listen(WEBHOOK_PORT, () => {
    console.log(`Darwin Assistant webhook listening on port ${WEBHOOK_PORT}`);
    console.log(`  POST http://localhost:${WEBHOOK_PORT}/api/intake`);
    console.log(`  GET  http://localhost:${WEBHOOK_PORT}/api/health`);
  });

  startUiServer();

  if (SLACK_ENABLED) {
    const slackApp = createSlackApp();
    await slackApp.start();
    console.log('Darwin Assistant Slack bot connected (Socket Mode)');
    scheduleDailyBriefing(slackApp);
    startCheckinWorker(slackApp);
  } else {
    console.warn('Slack not configured — set SLACK_BOT_TOKEN and SLACK_APP_TOKEN to enable');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
