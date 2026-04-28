import type { Db } from "@paperclipai/db";
import { scheduledTasksService } from "./scheduled-tasks.js";
import { hopperPreferencesService, prefKeyForKind } from "./hopper-preferences.js";
import { googleCalendarService } from "./hopper-google-calendar.js";

const DEFAULT_DURATION_MINUTES = 30;
const AGENT_ID = "d33e935d-533f-45a1-bb7a-ee4a2c86b2d8";

const PREFERRED_TIME_HOURS: Record<string, number> = {
  early_morning: 5,
  morning: 9,
  afternoon: 13,
  evening: 18,
};

export function hopperCalendarPlacer(db: Db) {
  async function tick(): Promise<void> {
    const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) return;

    const stSvc = scheduledTasksService(db);
    const prefsSvc = hopperPreferencesService(db);
    const calendar = googleCalendarService(clientId, clientSecret, refreshToken);

    let tasks: Awaited<ReturnType<typeof stSvc.listTasksForCalendarPlacement>>;
    try {
      tasks = await stSvc.listTasksForCalendarPlacement();
    } catch {
      return;
    }

    for (const task of tasks) {
      try {
        const durationMinutes = task.durationMinutes ?? DEFAULT_DURATION_MINUTES;

        const full = await stSvc.getById(task.id);
        if (!full) continue;

        let preferredStart = task.scheduledAt;
        if (task.kind) {
          const learnedPref = await prefsSvc.get(full.companyId, full.userId, prefKeyForKind(task.kind)).catch(() => null);
          if (learnedPref && PREFERRED_TIME_HOURS[learnedPref] !== undefined) {
            const adjusted = new Date(task.scheduledAt);
            adjusted.setHours(PREFERRED_TIME_HOURS[learnedPref], 0, 0, 0);
            if (adjusted.getTime() > Date.now()) {
              preferredStart = adjusted;
            }
          }
        }

        const start = await calendar.findFreeSlot(preferredStart, durationMinutes);

        const threads = await stSvc.listThreads(task.id);
        const title = extractTitle(full.title ?? full.requestText, threads);

        const { eventId, htmlLink } = await calendar.createEvent(
          title,
          full.requestText !== title ? full.requestText : null,
          start,
          durationMinutes,
        );

        await stSvc.update(task.id, { calendarEventId: eventId });

        const timeStr = start.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        await stSvc.addThread({
          taskId: task.id,
          authorType: "agent",
          authorId: AGENT_ID,
          body: `Scheduled on Google Calendar: **${timeStr}** (~${durationMinutes} min). [View event](${htmlLink})`,
        });
      } catch {
        // Skip this task; will retry on next tick
      }
    }
  }

  return { tick };
}

function extractTitle(titleOrPrompt: string, threads: Array<{ authorType: string; body: string }>): string {
  for (let i = threads.length - 1; i >= 0; i--) {
    const t = threads[i];
    if (t.authorType === "agent") {
      const match = /\*\*(.+?)\*\*/.exec(t.body);
      if (match?.[1]) return match[1].slice(0, 80);
    }
  }
  return titleOrPrompt.slice(0, 80);
}
