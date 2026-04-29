import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { scheduledTasksService } from "./scheduled-tasks.js";

const execFileAsync = promisify(execFile);

const GOG_BIN = "/usr/local/bin/gog";
const DEFAULT_DURATION_MINUTES = 30;
const AGENT_ID = "d33e935d-533f-45a1-bb7a-ee4a2c86b2d8";

function gogAccount(): string {
  return process.env.GOG_ACCOUNT || "kevineatonfx@gmail.com";
}

function gogCalendarId(): string {
  return process.env.GOG_CALENDAR_ID || "primary";
}

async function gogCreateEvent(input: {
  title: string;
  description: string | null;
  startTime: Date;
  endTime: Date;
}): Promise<{ eventId: string; htmlLink: string }> {
  const startISO = input.startTime.toISOString();
  const endISO = input.endTime.toISOString();
  const args = [
    "calendar", "create", gogCalendarId(),
    "--summary", input.title,
    "--from", startISO,
    "--to", endISO,
    "--no-input",
    "-a", gogAccount(),
    "--json",
    "--results-only",
  ];
  if (input.description) {
    args.push("--description", input.description);
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GOG_KEYRING_BACKEND: "file",
    GOG_KEYRING_PASSWORD: "",
  };
  const { stdout } = await execFileAsync(GOG_BIN, args, { env });
  const event = JSON.parse(stdout.trim()) as { id?: string; htmlLink?: string };
  if (!event.id) throw new Error("gog create returned no event id");
  return {
    eventId: event.id,
    htmlLink: event.htmlLink ?? `https://calendar.google.com/calendar/r`,
  };
}

export function hopperCalendarPlacer(db: Db) {
  async function tick(): Promise<void> {
    const stSvc = scheduledTasksService(db);

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

        const startTime = task.scheduledAt;
        const endTime = new Date(startTime.getTime() + durationMinutes * 60_000);
        const title = extractTitle(full.title ?? full.requestText);
        const description = full.requestText !== title ? full.requestText : null;

        const { eventId, htmlLink } = await gogCreateEvent({
          title,
          description,
          startTime,
          endTime,
        });

        await stSvc.update(task.id, { calendarEventId: eventId });

        const timeStr = startTime.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone: process.env.GOG_TIMEZONE || "America/Chicago",
        });
        await stSvc.addThread({
          taskId: task.id,
          authorType: "agent",
          authorId: AGENT_ID,
          body: `Synced to Google Calendar: **${timeStr}** (~${durationMinutes} min). [View event](${htmlLink})`,
        });
      } catch {
        // Skip this task; will retry on next tick
      }
    }
  }

  return { tick };
}

function extractTitle(titleOrPrompt: string): string {
  return titleOrPrompt.slice(0, 80);
}
