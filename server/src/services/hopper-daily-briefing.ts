import type { Db } from "@paperclipai/db";
import { hopperService } from "./hopper.js";
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

  // Track last sent date as YYYY-MM-DD string so we only fire once per day
  let lastSentDate = "";

  /**
   * Call this on a regular interval (e.g., every 60 seconds).
   * Fires the briefing once per day when the current time matches the configured hour/minute.
   */
  async function tick(): Promise<void> {
    const slackToken = process.env.SLACK_BOT_TOKEN;
    const slackUserId = process.env.SLACK_HOPPER_USER_ID;
    const gcalClientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    const gcalClientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    const gcalRefreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;

    if (!slackToken || !slackUserId) return;

    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);

    // Only fire once per day at the right time
    if (lastSentDate === todayKey) return;
    if (now.getHours() !== briefingHour || now.getMinutes() !== briefingMinute) return;

    lastSentDate = todayKey;

    try {
      await sendBriefing({ db, slackToken, slackUserId, gcalClientId, gcalClientSecret, gcalRefreshToken, now });
    } catch {
      // Reset so we retry on the next tick if it failed
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

  const svc = hopperService(db);
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

  // Fetch pending hopper items (created personal tasks without a calendar event)
  const pendingItems = await svc.listItemsForCalendarPlacement();

  const message = formatBriefingMessage(now, calendarEvents, pendingItems);

  const channelId = await slack.openChannel();
  await slack.postMessage(channelId, message);
}

function formatBriefingMessage(
  date: Date,
  events: CalendarEvent[],
  pendingItems: Array<{ id: string; kind: string | null }>,
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

  if (pendingItems.length > 0) {
    lines.push("");
    lines.push(`*${pendingItems.length} task${pendingItems.length === 1 ? "" : "s"} pending calendar placement:*`);
    lines.push("_These are in your Hopper queue but not yet on your calendar._");
  }

  lines.push("");
  lines.push("_Reply to reschedule or ask me anything about today._");

  return lines.join("\n");
}
