import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolRunContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";

// ─── Constants ────────────────────────────────────────────────────────────────

const JARVIS_AGENT_ID = "ee9f5ec7-3eba-49ca-8f11-4ce67367a1ec";
const GOG_BIN = "/usr/local/bin/gog";
const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

type GogConfig = {
  gogAccount?: string;
  calendarId?: string;
  timezone?: string;
};

type GogEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  conferenceData?: {
    entryPoints?: Array<{ uri: string; entryPointType: string }>;
  };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getConfig(ctx: PluginContext): Promise<GogConfig> {
  const raw = await ctx.config.get();
  return (raw ?? {}) as GogConfig;
}

function account(cfg: GogConfig): string {
  return cfg.gogAccount?.trim() || "kevineatonfx@gmail.com";
}

function calId(cfg: GogConfig): string {
  return cfg.calendarId?.trim() || "primary";
}

function tz(cfg: GogConfig): string {
  return cfg.timezone?.trim() || "America/Chicago";
}

async function runGog(
  subcommand: string,
  args: string[],
  acct: string,
  opts: { json?: boolean; force?: boolean } = {}
): Promise<unknown> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    GOG_KEYRING_BACKEND: "file",
    GOG_KEYRING_PASSWORD: "",
  };
  const allArgs = ["calendar", subcommand, ...args, "--no-input", "-a", acct];
  if (opts.json !== false) allArgs.push("--json", "--results-only");
  if (opts.force) allArgs.push("--force");

  const { stdout } = await execFileAsync(GOG_BIN, allArgs, { env });
  if (!stdout.trim()) return null;
  return JSON.parse(stdout);
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatTime(isoStr: string | undefined, timezone: string): string {
  if (!isoStr) return "?";
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).format(new Date(isoStr));
  } catch {
    return isoStr;
  }
}

function formatDateHeader(dateStr: string, timezone: string): string {
  try {
    const d = new Date(`${dateStr}T00:00:00`);
    return (
      "☀️ " +
      new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: timezone,
      }).format(d)
    );
  } catch {
    return dateStr;
  }
}

function buildDaySummary(events: GogEvent[], dateStr: string, timezone: string): string {
  const header = formatDateHeader(dateStr, timezone);
  if (events.length === 0) return `${header}\n\nNo events today.`;

  const lines = events.map((ev) => {
    const startStr = ev.start?.dateTime
      ? formatTime(ev.start.dateTime, timezone)
      : ev.start?.date
      ? "all day"
      : "?";
    const endStr = ev.end?.dateTime ? ` – ${formatTime(ev.end.dateTime, timezone)}` : "";
    const title = ev.summary ?? "(no title)";
    const videoUri = ev.conferenceData?.entryPoints?.find(
      (e) => e.entryPointType === "video"
    )?.uri;
    const meetPart = videoUri
      ? ` (${new URL(videoUri).hostname})`
      : "";
    return `${startStr}${endStr}  ${title}${meetPart}`;
  });

  const count = events.length;
  return `${header}\n\n${lines.join("\n")}\n\n${count} event${count === 1 ? "" : "s"} today.`;
}

function todayInTz(timezone: string, date?: string): string {
  if (date) return date;
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Google Calendar (gog) plugin starting up");

    // ── Job: morning-briefing ─────────────────────────────────────────────────
    ctx.jobs.register("morning-briefing", async (_jobCtx) => {
      ctx.logger.info("Running morning briefing — waking Jarvis agent");
      try {
        const companyId =
          process.env["PAPERCLIP_COMPANY_ID"] ??
          ((await ctx.state.get({
            scopeKind: "instance",
            stateKey: "company-id",
          })) as string | null) ??
          "";

        if (!companyId) {
          ctx.logger.error("morning-briefing: companyId not available — cannot invoke Jarvis");
          return;
        }

        await ctx.agents.invoke(JARVIS_AGENT_ID, companyId, {
          prompt: "Good morning! Please deliver the morning briefing.",
          reason: "routine_morning_briefing",
        });
        ctx.logger.info("Morning briefing: Jarvis agent woken successfully");
      } catch (err) {
        ctx.logger.error("Failed to wake Jarvis agent", { error: summarizeError(err) });
        throw err;
      }
    });

    // ── Tool: gcal_get_day_summary ────────────────────────────────────────────
    ctx.tools.register(
      "gcal_get_day_summary",
      {
        displayName: "Google Calendar: Day Summary",
        description:
          "Returns a human-readable summary of today's events (or a specific date if provided).",
        parametersSchema: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "ISO date (YYYY-MM-DD). Defaults to today in the configured timezone.",
            },
          },
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { date } = (params ?? {}) as { date?: string };
        try {
          const cfg = await getConfig(ctx);
          const dateStr = todayInTz(tz(cfg), date);
          const timeMin = `${dateStr}T00:00:00Z`;
          const timeMax = `${dateStr}T23:59:59Z`;
          const events = (await runGog(
            "events",
            [calId(cfg), "--from", timeMin, "--to", timeMax],
            account(cfg),
            { json: true }
          )) as GogEvent[] | null;
          return { content: buildDaySummary(events ?? [], dateStr, tz(cfg)) };
        } catch (err) {
          return { error: `Error fetching day summary: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: gcal_list_events ────────────────────────────────────────────────
    ctx.tools.register(
      "gcal_list_events",
      {
        displayName: "Google Calendar: List Events",
        description: "Lists calendar events between two ISO dates (inclusive).",
        parametersSchema: {
          type: "object",
          properties: {
            dateStart: { type: "string", description: "Start date (YYYY-MM-DD)" },
            dateEnd: { type: "string", description: "End date (YYYY-MM-DD)" },
          },
          required: ["dateStart", "dateEnd"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { dateStart, dateEnd } = params as { dateStart: string; dateEnd: string };
        try {
          const cfg = await getConfig(ctx);
          const events = (await runGog(
            "events",
            [calId(cfg), "--from", `${dateStart}T00:00:00Z`, "--to", `${dateEnd}T23:59:59Z`],
            account(cfg),
            { json: true }
          )) as GogEvent[] | null;
          if (!events || events.length === 0) {
            return { content: `No events found between ${dateStart} and ${dateEnd}.` };
          }
          return { content: JSON.stringify(events, null, 2) };
        } catch (err) {
          return { error: `Error listing events: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: gcal_get_event ──────────────────────────────────────────────────
    ctx.tools.register(
      "gcal_get_event",
      {
        displayName: "Google Calendar: Get Event",
        description: "Returns a single calendar event by ID.",
        parametersSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "Google Calendar event ID" },
          },
          required: ["eventId"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { eventId } = params as { eventId: string };
        try {
          const cfg = await getConfig(ctx);
          const event = await runGog(
            "event",
            [calId(cfg), eventId],
            account(cfg),
            { json: true }
          );
          return { content: JSON.stringify(event, null, 2) };
        } catch (err) {
          return { error: `Error fetching event: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: gcal_create_event ───────────────────────────────────────────────
    ctx.tools.register(
      "gcal_create_event",
      {
        displayName: "Google Calendar: Create Event",
        description: "Creates a new calendar event.",
        parametersSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Event title / summary" },
            startTime: { type: "string", description: "ISO 8601 datetime" },
            endTime: { type: "string", description: "ISO 8601 datetime" },
            description: { type: "string", description: "Optional event description" },
            location: { type: "string", description: "Optional location" },
          },
          required: ["title", "startTime", "endTime"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { title, startTime, endTime, description, location } = params as {
          title: string;
          startTime: string;
          endTime: string;
          description?: string;
          location?: string;
        };
        try {
          const cfg = await getConfig(ctx);
          const args = [
            calId(cfg),
            "--summary", title,
            "--from", startTime,
            "--to", endTime,
          ];
          if (description) args.push("--description", description);
          if (location) args.push("--location", location);

          const created = (await runGog("create", args, account(cfg), { json: true })) as GogEvent;
          return {
            content: `Event created: **${created?.summary ?? title}** (ID: \`${created?.id}\`)\n\`\`\`json\n${JSON.stringify(created, null, 2)}\n\`\`\``,
          };
        } catch (err) {
          return { error: `Error creating event: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: gcal_update_event ───────────────────────────────────────────────
    ctx.tools.register(
      "gcal_update_event",
      {
        displayName: "Google Calendar: Update Event",
        description: "Updates fields on an existing calendar event.",
        parametersSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "Event ID to update" },
            title: { type: "string", description: "New title" },
            startTime: { type: "string", description: "New start datetime (ISO 8601)" },
            endTime: { type: "string", description: "New end datetime (ISO 8601)" },
            description: { type: "string", description: "New description" },
          },
          required: ["eventId"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { eventId, title, startTime, endTime, description } = params as {
          eventId: string;
          title?: string;
          startTime?: string;
          endTime?: string;
          description?: string;
        };
        try {
          const cfg = await getConfig(ctx);
          const args = [calId(cfg), eventId];
          if (title) args.push("--summary", title);
          if (startTime) args.push("--from", startTime);
          if (endTime) args.push("--to", endTime);
          if (description !== undefined) args.push("--description", description);

          const updated = await runGog("update", args, account(cfg), { json: true, force: true });
          return {
            content: `Event updated.\n\`\`\`json\n${JSON.stringify(updated, null, 2)}\n\`\`\``,
          };
        } catch (err) {
          return { error: `Error updating event: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: gcal_delete_event ───────────────────────────────────────────────
    ctx.tools.register(
      "gcal_delete_event",
      {
        displayName: "Google Calendar: Delete Event",
        description: "Permanently deletes a calendar event.",
        parametersSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "Event ID to delete" },
          },
          required: ["eventId"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { eventId } = params as { eventId: string };
        try {
          const cfg = await getConfig(ctx);
          await runGog("delete", [calId(cfg), eventId], account(cfg), {
            json: false,
            force: true,
          });
          return { content: `Event \`${eventId}\` deleted successfully.` };
        } catch (err) {
          return { error: `Error deleting event: ${summarizeError(err)}` };
        }
      }
    );

    // ── Data: today-summary (for UI) ──────────────────────────────────────────
    ctx.data.register("today-summary", async () => {
      try {
        const cfg = await getConfig(ctx);
        const dateStr = todayInTz(tz(cfg));
        const events = (await runGog(
          "events",
          [calId(cfg), "--from", `${dateStr}T00:00:00Z`, "--to", `${dateStr}T23:59:59Z`],
          account(cfg),
          { json: true }
        )) as GogEvent[] | null;
        const evList = events ?? [];
        return {
          date: dateStr,
          summary: buildDaySummary(evList, dateStr, tz(cfg)),
          eventCount: evList.length,
        };
      } catch {
        return { date: null, summary: null, eventCount: 0 };
      }
    });

    // ── Data: config-status (for UI) ──────────────────────────────────────────
    ctx.data.register("config-status", async () => {
      const cfg = await getConfig(ctx);
      let gogWorking = false;
      try {
        await runGog("calendars", [], account(cfg), { json: true });
        gogWorking = true;
      } catch {
        gogWorking = false;
      }
      return {
        gogAccount: account(cfg),
        gogWorking,
        calendarId: calId(cfg),
        timezone: tz(cfg),
      };
    });

    ctx.logger.info("Google Calendar (gog) plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Google Calendar (gog) plugin worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
