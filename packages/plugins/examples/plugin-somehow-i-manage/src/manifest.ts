import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "darwin.plugin-somehow-i-manage",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Somehow I Manage (SHIM)",
  description:
    "Connects to Kevin's personal ADHD-optimized productivity app. Manages tasks, projects, Fridge items (ideas), and focus sessions for the Darwin workday.",
  author: "Darwin",
  categories: ["connector", "productivity"],
  capabilities: [
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "agent.tools.register",
    "instance.settings.register",
    "ui.dashboardWidget.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      baseUrl: {
        type: "string",
        title: "SHIM Base URL",
        description:
          "Base URL of the Somehow I Manage app (e.g. https://somehow.thedarwinhub.com).",
        default: "https://somehow.thedarwinhub.com",
      },
      apiToken: {
        type: "string",
        title: "API Token (optional)",
        description: "Bearer token for the SHIM REST API, if authentication is enabled.",
        default: "",
      },
    },
  },
  tools: [
    {
      name: "shim_list_tasks",
      displayName: "SHIM: List Tasks",
      description:
        "Returns Kevin's open Darwin workday tasks. Optionally filter by status or priority.",
      parametersSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["open", "in_progress", "completed", "blocked"],
            description: "Filter by task status. Omit to return all non-completed tasks.",
          },
          priority: {
            type: "number",
            description: "Filter by priority: 1=Low, 2=Medium, 3=High, 4=Urgent.",
          },
          project_id: {
            type: "number",
            description: "Filter tasks by project ID.",
          },
        },
      },
    },
    {
      name: "shim_create_task",
      displayName: "SHIM: Create Task",
      description: "Creates a new Darwin workday task for Kevin.",
      parametersSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Optional task description" },
          priority: {
            type: "number",
            description: "Priority: 1=Low, 2=Medium, 3=High, 4=Urgent. Defaults to 2.",
          },
          due_date: { type: "string", description: "Optional due date (YYYY-MM-DD)" },
          project_id: { type: "number", description: "Optional project ID to link task to" },
          parent_task_id: { type: "number", description: "Optional parent task ID for subtasks" },
        },
        required: ["title"],
      },
    },
    {
      name: "shim_update_task",
      displayName: "SHIM: Update Task",
      description: "Updates an existing task's status, priority, title, or description.",
      parametersSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Task ID" },
          title: { type: "string", description: "New title" },
          description: { type: "string", description: "New description" },
          status: {
            type: "string",
            enum: ["open", "in_progress", "completed", "blocked"],
            description: "New status",
          },
          priority: { type: "number", description: "New priority (1-4)" },
          due_date: { type: "string", description: "New due date (YYYY-MM-DD)" },
        },
        required: ["id"],
      },
    },
    {
      name: "shim_complete_task",
      displayName: "SHIM: Complete Task",
      description: "Marks a task (and all its subtasks) as completed.",
      parametersSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Task ID to complete" },
        },
        required: ["id"],
      },
    },
    {
      name: "shim_list_projects",
      displayName: "SHIM: List Projects",
      description: "Returns Kevin's active Darwin projects from SHIM.",
      parametersSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["active", "paused", "on-hold", "completed"],
            description: "Filter by project status. Defaults to active.",
          },
        },
      },
    },
    {
      name: "shim_create_fridge_item",
      displayName: "SHIM: Add to Fridge",
      description:
        "Captures an idea or thought to the Fridge (Kevin's quick-capture backlog) before it evaporates.",
      parametersSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Idea title" },
          body: { type: "string", description: "Optional detail or context" },
          project_id: { type: "number", description: "Optional project to associate with" },
        },
        required: ["title"],
      },
    },
    {
      name: "shim_list_fridge_items",
      displayName: "SHIM: List Fridge Items",
      description: "Lists ideas currently on ice in the Fridge, including freshness status.",
      parametersSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["active", "promoted", "archived"],
            description: "Filter by status. Defaults to active.",
          },
        },
      },
    },
    {
      name: "shim_get_today_summary",
      displayName: "SHIM: Today's Summary",
      description:
        "Returns a summary of Kevin's workday so far: today's focus sessions, total work time, and open high-priority tasks.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "shim_start_focus_session",
      displayName: "SHIM: Start Focus Session",
      description: "Starts a new 25-minute Pomodoro focus session.",
      parametersSchema: {
        type: "object",
        properties: {
          project_id: { type: "number", description: "Optional project to associate with" },
          task_description: {
            type: "string",
            description: "What Kevin plans to work on this session",
          },
          planned_duration: {
            type: "number",
            description: "Session duration in minutes. Defaults to 25.",
          },
        },
      },
    },
    {
      name: "shim_stop_focus_session",
      displayName: "SHIM: Stop Focus Session",
      description: "Ends an active focus session.",
      parametersSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Focus session ID to stop" },
        },
        required: ["id"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "shim-page",
        displayName: "Somehow I Manage",
        exportName: "ShimPage",
        routePath: "somehow-i-manage",
      },
      {
        type: "dashboardWidget",
        id: "shim-today-widget",
        displayName: "Darwin Workday",
        exportName: "ShimTodayWidget",
      },
    ],
  },
};

export default manifest;
