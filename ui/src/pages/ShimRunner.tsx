import { Wrench } from "lucide-react";
import { DevPlayground, type PlaygroundTool } from "../components/dev/DevPlayground";

const SHIM_TOOLS: PlaygroundTool[] = [
  // ── Tasks ──────────────────────────────────────────────────────────────────
  {
    name: "shim_list_tasks",
    displayName: "List Tasks",
    description: "Returns Kevin's Darwin workday tasks. Optionally filter by status or priority.",
    category: "Tasks",
    method: "GET",
    urlTemplate: "/api/v1/tasks",
    bodyTemplate: "",
    queryParams: [
      {
        name: "status",
        type: "string",
        description: "Filter by task status",
        required: false,
        enum: ["open", "in_progress", "completed", "blocked"],
      },
      { name: "priority", type: "number", description: "Priority: 1=Low 2=Med 3=High 4=Urgent", required: false },
      { name: "project_id", type: "number", description: "Filter by project ID", required: false },
    ],
    pathParams: [],
  },
  {
    name: "shim_create_task",
    displayName: "Create Task",
    description: "Creates a new Darwin workday task for Kevin.",
    category: "Tasks",
    method: "POST",
    urlTemplate: "/api/v1/tasks",
    bodyTemplate: JSON.stringify(
      { title: "", description: "", priority: 2, due_date: "", project_id: null, parent_task_id: null },
      null,
      2,
    ),
    queryParams: [],
    pathParams: [],
  },
  {
    name: "shim_update_task",
    displayName: "Update Task",
    description: "Updates an existing task's status, priority, title, or description.",
    category: "Tasks",
    method: "PUT",
    urlTemplate: "/api/v1/tasks/{id}",
    bodyTemplate: JSON.stringify(
      { title: "", description: "", status: "in_progress", priority: 2, due_date: "" },
      null,
      2,
    ),
    queryParams: [],
    pathParams: ["id"],
  },
  {
    name: "shim_complete_task",
    displayName: "Complete Task",
    description: "Marks a task (and all its subtasks) as completed.",
    category: "Tasks",
    method: "PUT",
    urlTemplate: "/api/v1/tasks/{id}",
    bodyTemplate: JSON.stringify({ mark_complete: true }, null, 2),
    queryParams: [],
    pathParams: ["id"],
  },
  // ── Projects ───────────────────────────────────────────────────────────────
  {
    name: "shim_list_projects",
    displayName: "List Projects",
    description: "Returns Kevin's active Darwin projects from SHIM.",
    category: "Projects",
    method: "GET",
    urlTemplate: "/api/v1/projects",
    bodyTemplate: "",
    queryParams: [
      {
        name: "status",
        type: "string",
        description: "Filter by project status",
        required: false,
        enum: ["active", "paused", "on-hold", "completed"],
      },
    ],
    pathParams: [],
  },
  // ── Fridge Items ───────────────────────────────────────────────────────────
  {
    name: "shim_create_fridge_item",
    displayName: "Add to Fridge",
    description: "Captures an idea to the Fridge (quick-capture backlog) before it evaporates.",
    category: "Fridge Items",
    method: "POST",
    urlTemplate: "/api/v1/fridge-items",
    bodyTemplate: JSON.stringify({ title: "", body: "", project_id: null }, null, 2),
    queryParams: [],
    pathParams: [],
  },
  {
    name: "shim_list_fridge_items",
    displayName: "List Fridge Items",
    description: "Lists ideas currently on ice in the Fridge, including freshness status.",
    category: "Fridge Items",
    method: "GET",
    urlTemplate: "/api/v1/fridge-items",
    bodyTemplate: "",
    queryParams: [
      {
        name: "status",
        type: "string",
        description: "Filter by status",
        required: false,
        enum: ["active", "promoted", "archived"],
      },
    ],
    pathParams: [],
  },
  // ── Focus Sessions ─────────────────────────────────────────────────────────
  {
    name: "shim_start_focus_session",
    displayName: "Start Focus Session",
    description: "Starts a new Pomodoro focus session.",
    category: "Focus Sessions",
    method: "POST",
    urlTemplate: "/api/v1/focus-sessions/start",
    bodyTemplate: JSON.stringify(
      { project_id: null, task_description: "", planned_duration: 25 },
      null,
      2,
    ),
    queryParams: [],
    pathParams: [],
  },
  {
    name: "shim_stop_focus_session",
    displayName: "Stop Focus Session",
    description: "Ends an active focus session.",
    category: "Focus Sessions",
    method: "POST",
    urlTemplate: "/api/v1/focus-sessions/{id}/stop",
    bodyTemplate: "",
    queryParams: [],
    pathParams: ["id"],
  },
  // ── Analytics ──────────────────────────────────────────────────────────────
  {
    name: "shim_get_today_summary",
    displayName: "Today's Focus Sessions",
    description:
      "Returns today's focus sessions. Combine with the tasks endpoint for a full workday summary.",
    category: "Analytics",
    method: "GET",
    urlTemplate: "/api/v1/focus-sessions",
    bodyTemplate: "",
    queryParams: [
      { name: "date", type: "string", description: "Date filter (YYYY-MM-DD)", required: false },
    ],
    pathParams: [],
  },
];

export function ShimRunner() {
  return (
    <DevPlayground
      name="SHIM Runner"
      subtitle="Somehow I Manage · MCP Tool Playground"
      icon={Wrench}
      tools={SHIM_TOOLS}
      defaultBaseUrl="https://somehow.thedarwinhub.com"
      storageKeyPrefix="shim_runner"
      testConnectionPath="/api/v1/tasks?status=open"
    />
  );
}
