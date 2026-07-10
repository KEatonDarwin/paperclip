import 'dotenv/config';
import express from 'express';
import { createSlackApp, sendDailyBriefing } from './handlers/slack.js';
import { createWebhookRouter } from './handlers/webhook.js';
import { startCheckinWorker } from './checkin-worker.js';
import { enqueueCalendarCheckins } from './briefing.js';
import { startUiServer } from './ui-server.js';
import { reconcileInterruptedRuns, autoHideStaleThreads } from './conversation-db.js';
import { getSetting } from './conversation-db.js';
import { shutdownActiveRuns } from './agent.js';

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT ?? '3200', 10);
const SLACK_ENABLED = !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);

// ─── Auto-hide stale threads ─────────────────────────────────────────────────
// Archives threads idle beyond `thread_auto_hide_days` (setting; default 14,
// 0 = off) that have no open todos. Runs at boot + every 6h.
const AUTO_HIDE_DEFAULT_DAYS = 14;
const AUTO_HIDE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function runAutoHideSweep(): void {
  const raw = getSetting('thread_auto_hide_days');
  const days = raw != null && raw.trim() !== '' ? parseInt(raw, 10) : AUTO_HIDE_DEFAULT_DAYS;
  if (!Number.isFinite(days) || days <= 0) return;
  try {
    const n = autoHideStaleThreads(days);
    if (n > 0) console.log(`[auto-hide] archived ${n} thread(s) idle >${days}d with no open todos`);
  } catch (err) {
    console.error('[auto-hide] sweep failed:', err);
  }
}

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
  // Fix B (DAR-676): heal any runs left mid-flight by the previous process.
  const healed = reconcileInterruptedRuns();
  if (healed > 0) console.log(`[startup] Reconciled ${healed} interrupted assistant turn(s)`);

  // Fix C (DAR-676): on a service stop/restart, deterministically tear down any
  // live model subprocess instead of orphaning it. Empty assistant turns left
  // behind are healed on next boot by reconcileInterruptedRuns() above. Register
  // once; a second signal forces an immediate exit.
  let shuttingDown = false;
  const onShutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) process.exit(130);
    shuttingDown = true;
    const killed = shutdownActiveRuns();
    console.log(`[shutdown] ${signal}: tore down ${killed} live model run(s)`);
    process.exit(0);
  };
  process.on('SIGTERM', onShutdown);
  process.on('SIGINT', onShutdown);

  const webhookApp = express();
  webhookApp.use('/api', createWebhookRouter());

  webhookApp.listen(WEBHOOK_PORT, () => {
    console.log(`Darwin Assistant webhook listening on port ${WEBHOOK_PORT}`);
    console.log(`  POST http://localhost:${WEBHOOK_PORT}/api/intake`);
    console.log(`  GET  http://localhost:${WEBHOOK_PORT}/api/health`);
  });

  const slackApp = SLACK_ENABLED ? createSlackApp() : null;

  startUiServer(slackApp ?? undefined);

  // Auto-hide stale threads (runs regardless of Slack).
  runAutoHideSweep();
  setInterval(runAutoHideSweep, AUTO_HIDE_INTERVAL_MS);

  if (slackApp) {
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
