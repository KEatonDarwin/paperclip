import type { Db } from "@paperclipai/db";
import { scheduledTasksService } from "./scheduled-tasks.js";
import { googleCalendarService, type CalendarEvent } from "./hopper-google-calendar.js";
import { slackDm } from "./slack-dm.js";

interface BriefingConfig {
  /** Hour to send briefing (0-23, local server time). Default: 5 */
  briefingHour: number;
  /** Minute to send briefing (0-59). Default: 30 */
  briefingMinute: number;
}

export function hopperDailyBriefing(db: Db, config?: Partial<BriefingConfig>) {
  const briefingHour = config?.briefingHour ?? parseInt(process.env.HOPPER_BRIEFING_HOUR ?? "5", 10);
  const briefingMinute = config?.briefingMinute ?? parseInt(process.env.HOPPER_BRIEFING_MINUTE ?? "30", 10);

  let lastSentDate = "";

  async function tick(): Promise<void> {
    const slackToken = process.env.SLACK_BOT_TOKEN;
    const slackUserId = process.env.SLACK_HOPPER_USER_ID;
    const gcalClientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    const gcalClientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    const gcalRefreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;

    if (!slackToken || !slackUserId) return;

    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);

    if (lastSentDate === todayKey) return;
    if (now.getHours() !== briefingHour || now.getMinutes() !== briefingMinute) return;

    lastSentDate = todayKey;

    try {
      await sendBriefing({ db, slackToken, slackUserId, gcalClientId, gcalClientSecret, gcalRefreshToken, now });
    } catch {
      lastSentDate = "";
    }
  }

  return { tick };
}

async function sendBriefing(opts: {
  db: Db;
  slackToken: string;
  slackUserId: string;
  gcalClientId?: string;
  gcalClientSecret?: string;
  gcalRefreshToken?: string;
  now: Date;
}): Promise<void> {
  const { db, slackToken, slackUserId, gcalClientId, gcalClientSecret, gcalRefreshToken, now } = opts;

  const slack = slackDm(slackToken, slackUserId);

  // Fetch today's calendar events if Google Calendar is configured
  let calendarEvents: CalendarEvent[] = [];
  if (gcalClientId && gcalClientSecret && gcalRefreshToken) {
    const cal = googleCalendarService(gcalClientId, gcalClientSecret, gcalRefreshToken);
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    try {
      calendarEvents = await cal.listEvents(startOfDay, endOfDay);
    } catch {
      // Continue without calendar events
    }
  }

  // Fetch pending scheduled tasks (status=scheduled but no calendar event yet)
  const stSvc = scheduledTasksService(db);
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  // All companies — briefing is a global daily summary
  // In practice this is single-tenant, but we query without company filter for simplicity
  const pendingTasks = await stSvc.listTasksForCalendarPlacement().catch(() => []);

  const message = formatBriefingMessage(now, calendarEvents, pendingTasks);

  const channelId = await slack.openChannel();
  await slack.postMessage(channelId, message);
}

function formatBriefingMessage(
  date: Date,
  events: CalendarEvent[],
  pendingTasks: Array<{ id: string; kind: string | null }>,
): string {
  const dateStr = date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const lines: string[] = [
    `*Good morning — here's your day for ${dateStr}*`,
    "",
  ];

  if (events.length > 0) {
    lines.push("*Scheduled today:*");
    for (const evt of events) {
      const start = evt.start.dateTime
        ? new Date(evt.start.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
        : "All day";
      lines.push(`• ${start} — ${evt.summary}`);
    }
  } else {
    lines.push("_No calendar events today._");
  }

  if (pendingTasks.length > 0) {
    lines.push("");
    lines.push(`*${pendingTasks.length} task${pendingTasks.length === 1 ? "" : "s"} pending calendar placement:*`);
    lines.push("_These are classified and ready but not yet on your calendar._");
  }

  lines.push("");
  lines.push("_Reply to reschedule or ask me anything about today._");

  return lines.join("\n");
}
