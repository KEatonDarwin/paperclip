import { App, LogLevel } from '@slack/bolt';
import { processMessage, clearConversation } from '../agent.js';
import { buildMorningBriefing } from '../briefing.js';
import { getOrCreateConversation, addTurn } from '../conversation-db.js';
import { sseBus, type SSEEvent } from '../sse-bus.js';

const BRIEFING_TRIGGERS = /\b(morning briefing|good morning|briefing|morning|wake up|what's my day|what is my day|day look like)\b/i;

// Friendlier progress text per tool, shown in the live-editing status message
// (and mirrored to Slack's native assistant.threads.setStatus indicator once
// Kevin adds the assistant:write scope — see DAR ticket for the Slack status
// upgrade). Falls back to a humanized tool name for anything not listed here.
const TOOL_STATUS_LABELS: Record<string, string> = {
  create_issue: 'Filing a Paperclip issue',
  search_issues: 'Checking Paperclip issues',
  get_issue: 'Pulling up the issue',
  update_issue: 'Updating the issue',
  update_issue_status: 'Updating issue status',
  add_comment: 'Posting a comment',
  list_agents: 'Checking agent status',
  list_projects: 'Checking Paperclip projects',
  get_system_health: 'Checking system health',
  create_calendar_event: 'Adding to your calendar',
  read_wiki_page: 'Reading the wiki',
  write_wiki_page: 'Writing to the wiki',
  list_wiki_pages: 'Browsing the wiki',
  search_wiki: 'Searching the wiki',
  read_memory: 'Checking memory',
  write_memory: 'Saving to memory',
  list_shim_tasks: 'Checking SHIM tasks',
  create_shim_task: 'Adding a SHIM task',
  update_shim_task: 'Updating a SHIM task',
  list_shim_projects: 'Checking SHIM projects',
  create_shim_project: 'Creating a SHIM project',
  list_shim_fridge: 'Checking the fridge',
  create_shim_fridge_item: 'Dropping an idea in the fridge',
  list_focus_sessions: 'Checking focus sessions',
  start_focus_session: 'Starting a focus session',
  stop_focus_session: 'Stopping the focus session',
  shim_deploy_status: 'Checking SHIM deploy status',
  shim_deploy_switch: 'Switching SHIM branch',
  shim_deploy_approve: 'Approving the SHIM branch',
  shim_deploy_reject: 'Rejecting the SHIM branch',
  enqueue_checkin: 'Scheduling a check-in',
  list_checkins: 'Checking upcoming check-ins',
  cancel_checkin: 'Cancelling a check-in',
  mute_reminders: 'Muting reminders',
  unmute_reminders: 'Unmuting reminders',
  list_muted: 'Checking muted items',
  create_scheduled_task: 'Scheduling that',
  list_scheduled_tasks: 'Checking the schedule',
  get_scheduled_task: 'Pulling up the schedule item',
  update_scheduled_task: 'Updating the schedule',
  cancel_scheduled_task: 'Cancelling the schedule item',
  mcp_call: 'Reaching out to a connected tool',
  lovable_send_message: 'Talking to Lovable',
  supabase_execute_sql: 'Querying Supabase',
  log_decision: 'Logging that decision',
  thread_todos: 'Updating the todo panel',
  intake_deploy: 'Deploying the MCP server',
  cockpit_deploy: 'Deploying the cockpit',
};

function statusLabelFor(toolName: string): string {
  const label = TOOL_STATUS_LABELS[toolName] ?? toolName.replace(/_/g, ' ');
  return `🔧 ${label}...`;
}

const THINKING_TEXT = '🧠 Thinking...';
// Slack's chat.update has no hard documented rate limit but misbehaves under
// tight bursts — a tool-call storm (e.g. a multi-step build) shouldn't spam
// edits faster than a human could read them anyway.
const MIN_EDIT_INTERVAL_MS = 700;

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
    const conv = getOrCreateConversation(conversationId);

    // Live status message — replaces the old thinking_face reaction. Edited
    // in place as JARVIS works, then becomes the final reply.
    let statusTs: string | undefined;
    try {
      const posted = await client.chat.postMessage({ channel: msg.channel, thread_ts: threadTs, text: THINKING_TEXT });
      statusTs = typeof posted.ts === 'string' ? posted.ts : undefined;
    } catch {}

    let lastEdit = 0;
    const updateStatus = async (statusText: string) => {
      if (!statusTs) return;
      const now = Date.now();
      if (now - lastEdit < MIN_EDIT_INTERVAL_MS) return;
      lastEdit = now;
      try {
        await client.chat.update({ channel: msg.channel, ts: statusTs, text: statusText });
      } catch {}
      // Best-effort native "app is thinking" indicator. No-ops (swallowed)
      // until the Slack app has the assistant:write scope — lights up
      // automatically the day that scope gets added, no code change needed.
      try {
        await client.assistant.threads.setStatus({ channel_id: msg.channel, thread_ts: threadTs, status: statusText });
      } catch {}
    };

    const onSseEvent = (event: SSEEvent) => {
      if (event.type === 'tool_call' && event.conversationId === conv.id) {
        void updateStatus(statusLabelFor(event.toolName));
      }
    };
    sseBus.on('sse', onSseEvent);

    try {
      let response: string;

      if (BRIEFING_TRIGGERS.test(text) && text.length < 60) {
        response = await buildMorningBriefing();
      } else {
        response = await processMessage(text, conversationId);
      }

      if (statusTs) {
        try {
          await client.chat.update({ channel: msg.channel, ts: statusTs, text: response });
        } catch {
          await say({ text: response, thread_ts: threadTs });
        }
      } else {
        await say({ text: response, thread_ts: threadTs });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errText = `❌ Error: ${errMsg}`;
      if (statusTs) {
        try {
          await client.chat.update({ channel: msg.channel, ts: statusTs, text: errText });
        } catch {
          await say({ text: errText, thread_ts: threadTs });
        }
      } else {
        await say({ text: errText, thread_ts: threadTs });
      }
    } finally {
      sseBus.off('sse', onSseEvent);
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
