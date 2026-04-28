import type { Db } from "@paperclipai/db";
import { hopperService } from "./hopper.js";
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

    const svc = hopperService(db);
    const prefsSvc = hopperPreferencesService(db);
    const calendar = googleCalendarService(clientId, clientSecret, refreshToken);

    let items: Awaited<ReturnType<typeof svc.listItemsForCalendarPlacement>>;
    try {
      items = await svc.listItemsForCalendarPlacement();
    } catch {
      return;
    }

    for (const item of items) {
      try {
        const durationMinutes = item.durationMinutes ?? DEFAULT_DURATION_MINUTES;

        // Apply learned preferences: adjust preferred hour based on task kind
        const full = await svc.getById(item.id);
        if (!full) continue;

        let preferredStart = item.scheduledAt;
        if (item.kind) {
          const learnedPref = await prefsSvc.get(full.companyId, full.userId, prefKeyForKind(item.kind)).catch(() => null);
          if (learnedPref && PREFERRED_TIME_HOURS[learnedPref] !== undefined) {
            const adjusted = new Date(item.scheduledAt);
            adjusted.setHours(PREFERRED_TIME_HOURS[learnedPref], 0, 0, 0);
            // Only use the learned preference if it's in the future
            if (adjusted.getTime() > Date.now()) {
              preferredStart = adjusted;
            }
          }
        }

        // Find the first free slot at or after the proposed time
        const start = await calendar.findFreeSlot(preferredStart, durationMinutes);

        const threads = await svc.listThreads(item.id);
        const title = extractTitle(full.prompt, threads);

        const { eventId, htmlLink } = await calendar.createEvent(
          title,
          full.prompt !== title ? full.prompt : null,
          start,
          durationMinutes,
        );

        await svc.update(item.id, { calendarEventId: eventId });

        const timeStr = start.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        await svc.addThread({
          itemId: item.id,
          authorType: "agent",
          authorId: AGENT_ID,
          body: `Scheduled on Google Calendar: **${timeStr}** (~${durationMinutes} min). [View event](${htmlLink})`,
        });
      } catch {
        // Skip this item; will retry on next tick
      }
    }
  }

  return { tick };
}

/**
 * Derive a short event title from the item prompt and thread context.
 * Uses the last agent thread entry if it contains a bolded title (from processor confirmation),
 * otherwise falls back to the first 80 chars of the prompt.
 */
function extractTitle(prompt: string, threads: Array<{ authorType: string; body: string }>): string {
  for (let i = threads.length - 1; i >= 0; i--) {
    const t = threads[i];
    if (t.authorType === "agent") {
      const match = /\*\*(.+?)\*\*/.exec(t.body);
      if (match?.[1]) return match[1].slice(0, 80);
    }
  }
  return prompt.slice(0, 80);
}
