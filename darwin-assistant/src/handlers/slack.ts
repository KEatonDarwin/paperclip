import { App, LogLevel } from '@slack/bolt';
import { processMessage, clearConversation } from '../agent.js';
import { buildMorningBriefing } from '../briefing.js';
import { getOrCreateConversation, addTurn } from '../conversation-db.js';

const BRIEFING_TRIGGERS = /\b(morning briefing|good morning|briefing|morning|wake up|what's my day|what is my day|day look like)\b/i;

export function createSlackApp() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  app.message(async ({ message, say, client }) => {
    if (message.subtype) return;
    const msg = message as { text?: string; ts: string; thread_ts?: string; channel: string; user?: string };
    const text = msg.text?.trim();
    if (!text) return;

    const threadTs = msg.thread_ts ?? msg.ts;
    const conversationId = `slack:${msg.channel}:${threadTs}`;

    try {
      await client.reactions.add({ channel: msg.channel, timestamp: msg.ts, name: 'thinking_face' });
    } catch {}

    try {
      let response: string;

      if (BRIEFING_TRIGGERS.test(text) && text.length < 60) {
        response = await buildMorningBriefing();
      } else {
        response = await processMessage(text, conversationId);
      }

      await say({ text: response, thread_ts: threadTs });

      try {
        await client.reactions.remove({ channel: msg.channel, timestamp: msg.ts, name: 'thinking_face' });
      } catch {}
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await say({ text: `❌ Error: ${errMsg}`, thread_ts: threadTs });

      try {
        await client.reactions.remove({ channel: msg.channel, timestamp: msg.ts, name: 'thinking_face' });
      } catch {}
    }
  });

  app.command('/darwin-clear', async ({ ack, respond, body }) => {
    await ack();
    const conversationId = `slack:${body.channel_id}:clear`;
    clearConversation(conversationId);
    await respond('Conversation history cleared. Fresh start!');
  });

  return app;
}

export async function sendDailyBriefing(app: App): Promise<void> {
  const userId = process.env.SLACK_KEVIN_USER_ID;
  if (!userId) {
    console.warn('[briefing] SLACK_KEVIN_USER_ID not set — skipping daily briefing');
    return;
  }
  try {
    const briefing = await buildMorningBriefing();
    const postResult = await app.client.chat.postMessage({ channel: userId, text: briefing });
    console.log('[briefing] Morning briefing sent to Kevin');

    // Persist the briefing as an assistant turn so that Kevin's reply has context.
    const slackTs = typeof postResult.ts === 'string' ? postResult.ts : null;
    if (slackTs) {
      const conv = getOrCreateConversation(`slack:${userId}:${slackTs}`, userId);
      addTurn(conv.id, 'assistant', briefing);
    }
  } catch (err) {
    console.error('[briefing] Failed to send morning briefing:', err);
  }
}
