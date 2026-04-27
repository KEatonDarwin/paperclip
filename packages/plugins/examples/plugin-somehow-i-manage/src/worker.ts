import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolRunContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

type ShimConfig = {
  baseUrl?: string;
  apiToken?: string;
};

type ShimTask = {
  id: number;
  title: string;
  description?: string;
  status: string;
  priority: number;
  due_date?: string;
  project_id?: number;
  parent_task_id?: number;
  completed_at?: string;
  created_at: string;
  updated_at: string;
};

type ShimProject = {
  id: number;
  name: string;
  description?: string;
  status: string;
  created_at: string;
};

type ShimFridgeItem = {
  id: number;
  title: string;
  body?: string;
  status: string;
  freshness_duration: number;
  expires_at?: string;
  created_at: string;
};

type ShimFocusSession = {
  id: number;
  project_id?: number;
  task_description?: string;
  status: string;
  planned_duration?: number;
  started_at?: string;
  stopped_at?: string;
  break_time_seconds?: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getConfig(ctx: PluginContext): Promise<ShimConfig> {
  const raw = await ctx.config.get();
  return (raw ?? {}) as ShimConfig;
}

function getBaseUrl(cfg: ShimConfig): string {
  return (cfg.baseUrl ?? "https://somehow.thedarwinhub.com").replace(/\/$/, "");
}

async function shimFetch(
  ctx: PluginContext,
  cfg: ShimConfig,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const base = getBaseUrl(cfg);
  const url = `${base}/api/v1${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (cfg.apiToken?.trim()) {
    headers["Authorization"] = `Bearer ${cfg.apiToken.trim()}`;
  }
  const resp = await fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "unknown error");
    throw new Error(`SHIM API error ${resp.status}: ${text}`);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function priorityLabel(p: number): string {
  return ["", "Low", "Medium", "High", "Urgent"][p] ?? String(p);
}

function formatTask(t: ShimTask): string {
  const parts = [`[#${t.id}] ${t.title}`];
  parts.push(`  Status: ${t.status} | Priority: ${priorityLabel(t.priority)}`);
  if (t.due_date) parts.push(`  Due: ${t.due_date}`);
  if (t.description) parts.push(`  ${t.description.slice(0, 120)}`);
  return parts.join("\n");
}

function secondsToHuman(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Somehow I Manage (SHIM) plugin starting up");

    // ── Tool: shim_list_tasks ─────────────────────────────────────────────────
    ctx.tools.register(
      "shim_list_tasks",
      {
        displayName: "SHIM: List Tasks",
        description:
          "Returns Kevin's Darwin workday tasks. Optionally filter by status or priority.",
        parametersSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["open", "in_progress", "completed", "blocked"],
            },
            priority: { type: "number" },
            project_id: { type: "number" },
          },
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { status, priority, project_id } = (params ?? {}) as {
          status?: string;
          priority?: number;
          project_id?: number;
        };
        try {
          const cfg = await getConfig(ctx);
          const qs = new URLSearchParams();
          if (status) qs.set("status", status);
          if (priority != null) qs.set("priority", String(priority));
          if (project_id != null) qs.set("project_id", String(project_id));
          const query = qs.toString() ? `?${qs}` : "";
          const data = (await shimFetch(ctx, cfg, `/tasks${query}`)) as ShimTask[] | { data: ShimTask[] };
          const tasks = Array.isArray(data) ? data : (data as { data: ShimTask[] }).data ?? [];

          if (tasks.length === 0) {
            return { content: "No tasks found." };
          }

          const lines = tasks.map(formatTask);
          return { content: `${tasks.length} task(s):\n\n${lines.join("\n\n")}` };
        } catch (err) {
          return { error: `Error fetching tasks: ${summarizeError(err)}` };
        }
      },
    );

    // ── Tool: shim_create_task ────────────────────────────────────────────────
    ctx.tools.register(
      "shim_create_task",
      {
        displayName: "SHIM: Create Task",
        description: "Creates a new Darwin workday task for Kevin.",
        parametersSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            priority: { type: "number" },
            due_date: { type: "string" },
            project_id: { type: "number" },
            parent_task_id: { type: "number" },
          },
          required: ["title"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { title, description, priority, due_date, project_id, parent_task_id } =
          params as {
            title: string;
            description?: string;
            priority?: number;
            due_date?: string;
            project_id?: number;
            parent_task_id?: number;
          };
        try {
          const cfg = await getConfig(ctx);
          const body: Record<string, unknown> = { title, priority: priority ?? 2 };
          if (description) body["description"] = description;
          if (due_date) body["due_date"] = due_date;
          if (project_id != null) body["project_id"] = project_id;
          if (parent_task_id != null) body["parent_task_id"] = parent_task_id;

          const created = (await shimFetch(ctx, cfg, "/tasks", {
            method: "POST",
            body: JSON.stringify(body),
          })) as ShimTask | { data: ShimTask };
          const task = "id" in (created as object) ? (created as ShimTask) : (created as { data: ShimTask }).data;
          return { content: `Task created: **${task.title}** (ID: ${task.id}, priority: ${priorityLabel(task.priority)})` };
        } catch (err) {
          return { error: `Error creating task: ${summarizeError(err)}` };
        }
      },
    );

    // ── Tool: shim_update_task ────────────────────────────────────────────────
    ctx.tools.register(
      "shim_update_task",
      {
        displayName: "SHIM: Update Task",
        description: "Updates an existing task's status, priority, title, or description.",
        parametersSchema: {
          type: "object",
          properties: {
            id: { type: "number" },
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["open", "in_progress", "completed", "blocked"] },
            priority: { type: "number" },
            due_date: { type: "string" },
          },
          required: ["id"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { id, title, description, status, priority, due_date } = params as {
          id: number;
          title?: string;
          description?: string;
          status?: string;
          priority?: number;
          due_date?: string;
        };
        try {
          const cfg = await getConfig(ctx);
          const patch: Record<string, unknown> = {};
          if (title != null) patch["title"] = title;
          if (description != null) patch["description"] = description;
          if (status != null) patch["status"] = status;
          if (priority != null) patch["priority"] = priority;
          if (due_date != null) patch["due_date"] = due_date;

          const updated = (await shimFetch(ctx, cfg, `/tasks/${id}`, {
            method: "PUT",
            body: JSON.stringify(patch),
          })) as ShimTask | { data: ShimTask };
          const task = "id" in (updated as object) ? (updated as ShimTask) : (updated as { data: ShimTask }).data;
          return {
            content: `Task #${task.id} updated: **${task.title}** — status: ${task.status}, priority: ${priorityLabel(task.priority)}`,
          };
        } catch (err) {
          return { error: `Error updating task: ${summarizeError(err)}` };
        }
      },
    );

    // ── Tool: shim_complete_task ──────────────────────────────────────────────
    ctx.tools.register(
      "shim_complete_task",
      {
        displayName: "SHIM: Complete Task",
        description: "Marks a task (and all its subtasks) as completed.",
        parametersSchema: {
          type: "object",
          properties: {
            id: { type: "number" },
          },
          required: ["id"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { id } = params as { id: number };
        try {
          const cfg = await getConfig(ctx);
          const updated = (await shimFetch(ctx, cfg, `/tasks/${id}`, {
            method: "PUT",
            body: JSON.stringify({ mark_complete: true }),
          })) as ShimTask | { data: ShimTask };
          const task = "id" in (updated as object) ? (updated as ShimTask) : (updated as { data: ShimTask }).data;
          return { content: `Task #${task.id} **${task.title}** marked complete.` };
        } catch (err) {
          return { error: `Error completing task: ${summarizeError(err)}` };
        }
      },
    );

    // ── Tool: shim_list_projects ──────────────────────────────────────────────
    ctx.tools.register(
      "shim_list_projects",
      {
        displayName: "SHIM: List Projects",
        description: "Returns Kevin's active Darwin projects from SHIM.",
        parametersSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["active", "paused", "on-hold", "completed"],
            },
          },
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { status } = (params ?? {}) as { status?: string };
        try {
          const cfg = await getConfig(ctx);
          const query = status ? `?status=${status}` : "";
          const data = (await shimFetch(ctx, cfg, `/projects${query}`)) as ShimProject[] | { data: ShimProject[] };
          const projects = Array.isArray(data) ? data : (data as { data: ShimProject[] }).data ?? [];

          if (projects.length === 0) return { content: "No projects found." };

          const lines = projects.map(
            (p) => `[#${p.id}] **${p.name}** (${p.status})${p.description ? "\n  " + p.description.slice(0, 80) : ""}`,
          );
          return { content: `${projects.length} project(s):\n\n${lines.join("\n\n")}` };
        } catch (err) {
          return { error: `Error fetching projects: ${summarizeError(err)}` };
        }
      },
    );

    // ── Tool: shim_create_fridge_item ─────────────────────────────────────────
    ctx.tools.register(
      "shim_create_fridge_item",
      {
        displayName: "SHIM: Add to Fridge",
        description: "Captures an idea to the Fridge (quick-capture backlog) before it evaporates.",
        parametersSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            project_id: { type: "number" },
          },
          required: ["title"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { title, body, project_id } = params as {
          title: string;
          body?: string;
          project_id?: number;
        };
        try {
          const cfg = await getConfig(ctx);
          const payload: Record<string, unknown> = { title };
          if (body) payload["body"] = body;
          if (project_id != null) payload["project_id"] = project_id;

          const created = (await shimFetch(ctx, cfg, "/fridge-items", {
            method: "POST",
            body: JSON.stringify(payload),
          })) as ShimFridgeItem | { data: ShimFridgeItem };
          const item = "id" in (created as object) ? (created as ShimFridgeItem) : (created as { data: ShimFridgeItem }).data;
          return { content: `Idea captured to Fridge: **${item.title}** (ID: ${item.id})` };
        } catch (err) {
          return { error: `Error creating fridge item: ${summarizeError(err)}` };
        }
      },
    );

    // ── Tool: shim_list_fridge_items ──────────────────────────────────────────
    ctx.tools.register(
      "shim_list_fridge_items",
      {
        displayName: "SHIM: List Fridge Items",
        description: "Lists ideas currently on ice in the Fridge, including freshness status.",
        parametersSchema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["active", "promoted", "archived"] },
          },
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { status } = (params ?? {}) as { status?: string };
        try {
          const cfg = await getConfig(ctx);
          const query = status ? `?status=${status}` : "";
          const data = (await shimFetch(ctx, cfg, `/fridge-items${query}`)) as ShimFridgeItem[] | { data: ShimFridgeItem[] };
          const items = Array.isArray(data) ? data : (data as { data: ShimFridgeItem[] }).data ?? [];

          if (items.length === 0) return { content: "Fridge is empty." };

          const now = Date.now();
          const lines = items.map((item) => {
            const expiresAt = item.expires_at ? new Date(item.expires_at).getTime() : null;
            const daysLeft = expiresAt ? Math.ceil((expiresAt - now) / 86400000) : null;
            const freshness = daysLeft != null ? (daysLeft <= 7 ? ` ⚠️ expires in ${daysLeft}d` : ` (${daysLeft}d left)`) : "";
            return `[#${item.id}] **${item.title}**${freshness}`;
          });
          return { content: `${items.length} fridge item(s):\n\n${lines.join("\n")}` };
        } catch (err) {
          return { error: `Error fetching fridge items: ${summarizeError(err)}` };
        }
      },
    );

    // ── Tool: shim_get_today_summary ──────────────────────────────────────────
    ctx.tools.register(
      "shim_get_today_summary",
      {
        displayName: "SHIM: Today's Summary",
        description:
          "Returns a summary of Kevin's workday: focus sessions, total work time, and open high-priority tasks.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        try {
          const cfg = await getConfig(ctx);
          const today = new Date().toISOString().split("T")[0];

          const [sessionsRaw, tasksRaw] = await Promise.all([
            shimFetch(ctx, cfg, `/focus-sessions?date=${today}`).catch(() => []),
            shimFetch(ctx, cfg, "/tasks?status=open,in_progress&priority=3,4").catch(() => []),
          ]);

          const sessions = (() => {
            if (Array.isArray(sessionsRaw)) return sessionsRaw as ShimFocusSession[];
            const d = (sessionsRaw as { data?: ShimFocusSession[] }).data;
            return Array.isArray(d) ? d : [];
          })();

          const tasks = (() => {
            if (Array.isArray(tasksRaw)) return tasksRaw as ShimTask[];
            const d = (tasksRaw as { data?: ShimTask[] }).data;
            return Array.isArray(d) ? d : [];
          })();

          const completedSessions = sessions.filter((s) => s.status === "completed");
          const totalWorkSecs = completedSessions.reduce((acc, s) => {
            if (!s.started_at || !s.stopped_at) return acc;
            const dur =
              (new Date(s.stopped_at).getTime() - new Date(s.started_at).getTime()) / 1000 -
              (s.break_time_seconds ?? 0);
            return acc + Math.max(0, dur);
          }, 0);

          const lines: string[] = [`## Kevin's Workday — ${today}`];
          lines.push(
            `\n**Focus sessions today:** ${completedSessions.length} completed` +
              (sessions.some((s) => s.status === "active") ? " (1 active)" : ""),
          );
          if (totalWorkSecs > 0) {
            lines.push(`**Total focused work time:** ${secondsToHuman(totalWorkSecs)}`);
          }

          const urgentTasks = tasks.filter((t) => t.priority >= 3);
          if (urgentTasks.length > 0) {
            lines.push(`\n**High/Urgent open tasks (${urgentTasks.length}):**`);
            urgentTasks.slice(0, 8).forEach((t) => {
              lines.push(`- [#${t.id}] ${t.title} [${priorityLabel(t.priority)}]`);
            });
          } else {
            lines.push("\nNo urgent tasks open. Good shape!");
          }

          return { content: lines.join("\n") };
        } catch (err) {
          return { error: `Error fetching today's summary: ${summarizeError(err)}` };
        }
      },
    );

    // ── Tool: shim_start_focus_session ────────────────────────────────────────
    ctx.tools.register(
      "shim_start_focus_session",
      {
        displayName: "SHIM: Start Focus Session",
        description: "Starts a new Pomodoro focus session.",
        parametersSchema: {
          type: "object",
          properties: {
            project_id: { type: "number" },
            task_description: { type: "string" },
            planned_duration: { type: "number" },
          },
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { project_id, task_description, planned_duration } = (params ?? {}) as {
          project_id?: number;
          task_description?: string;
          planned_duration?: number;
        };
        try {
          const cfg = await getConfig(ctx);
          const body: Record<string, unknown> = {
            planned_duration: planned_duration ?? 25,
          };
          if (project_id != null) body["project_id"] = project_id;
          if (task_description) body["task_description"] = task_description;

          const created = (await shimFetch(ctx, cfg, "/focus-sessions/start", {
            method: "POST",
            body: JSON.stringify(body),
          })) as ShimFocusSession | { data: ShimFocusSession };
          const session = "id" in (created as object)
            ? (created as ShimFocusSession)
            : (created as { data: ShimFocusSession }).data;
          return {
            content: `Focus session #${session.id} started (${session.planned_duration ?? 25} min).${task_description ? ` Working on: ${task_description}` : ""}`,
          };
        } catch (err) {
          return { error: `Error starting focus session: ${summarizeError(err)}` };
        }
      },
    );

    // ── Tool: shim_stop_focus_session ─────────────────────────────────────────
    ctx.tools.register(
      "shim_stop_focus_session",
      {
        displayName: "SHIM: Stop Focus Session",
        description: "Ends an active focus session.",
        parametersSchema: {
          type: "object",
          properties: {
            id: { type: "number" },
          },
          required: ["id"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { id } = params as { id: number };
        try {
          const cfg = await getConfig(ctx);
          await shimFetch(ctx, cfg, `/focus-sessions/${id}/stop`, { method: "POST" });
          return { content: `Focus session #${id} stopped. Good work!` };
        } catch (err) {
          return { error: `Error stopping focus session: ${summarizeError(err)}` };
        }
      },
    );

    // ── Data endpoints (for UI) ───────────────────────────────────────────────
    ctx.data.register("today-snapshot", async () => {
      try {
        const cfg = await getConfig(ctx);
        const today = new Date().toISOString().split("T")[0]!;
        const [sessionsRaw, tasksRaw] = await Promise.all([
          shimFetch(ctx, cfg, `/focus-sessions?date=${today}`).catch(() => []),
          shimFetch(ctx, cfg, "/tasks?status=open,in_progress").catch(() => []),
        ]);
        const sessions = Array.isArray(sessionsRaw) ? (sessionsRaw as ShimFocusSession[]) : [];
        const tasks = Array.isArray(tasksRaw) ? (tasksRaw as ShimTask[]) : [];
        const completedSessions = sessions.filter((s) => s.status === "completed");
        return {
          date: today,
          sessionCount: completedSessions.length,
          activeSession: sessions.find((s) => s.status === "active") ?? null,
          openTaskCount: tasks.length,
          urgentTaskCount: tasks.filter((t) => t.priority >= 3).length,
        };
      } catch {
        return { date: null, sessionCount: 0, activeSession: null, openTaskCount: 0, urgentTaskCount: 0 };
      }
    });

    ctx.data.register("config-status", async () => {
      const cfg = await getConfig(ctx);
      return {
        baseUrl: getBaseUrl(cfg),
        hasApiToken: Boolean(cfg.apiToken?.trim()),
      };
    });

    ctx.logger.info("Somehow I Manage (SHIM) plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "SHIM plugin worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
