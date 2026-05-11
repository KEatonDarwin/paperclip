import type { ToolDef } from './index.js';

function shimUrl(): string {
  return process.env.SHIM_MCP_URL ?? 'https://somehow.thedarwinhub.com/mcp';
}

function shimBaseUrl(): string {
  return shimUrl().replace(/\/mcp$/, '');
}

async function shimApi(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const token = process.env.SHIM_MCP_TOKEN;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts: RequestInit = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${shimBaseUrl()}/api/v1${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    let msg: string;
    try {
      const json = JSON.parse(text) as { error?: string };
      msg = json.error ?? text;
    } catch { msg = text; }
    throw new Error(`SHIM deploy error (${res.status}): ${msg}`);
  }

  return (await res.json()) as unknown;
}

async function shimCall(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const token = process.env.SHIM_MCP_TOKEN;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(shimUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  if (!res.ok) throw new Error(`SHIM MCP error ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    result?: { content?: Array<{ type: string; text: string }> };
    error?: { message: string };
  };
  if (json.error) throw new Error(`SHIM tool error: ${json.error.message}`);

  const text = json.result?.content?.find((c) => c.type === 'text')?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const listShimTasks: ToolDef = {
  name: 'list_shim_tasks',
  description:
    "List Kevin's personal tasks in SHIM (Somehow I Manage). Use for day planning, status checks, and finding what needs to be done.",
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['open', 'in_progress', 'completed', 'blocked'],
        description: 'Filter by status. Omit for all.',
      },
      priority: {
        type: 'number',
        description: '0=none, 1=low, 2=medium, 3=high, 4=urgent',
      },
      project_id: { type: 'number', description: 'Filter by project ID' },
      mode: { type: 'string', enum: ['darwin', 'personal'], description: 'Filter by mode. Omit for all.' },
      limit: { type: 'number', default: 20 },
    },
  },
  execute: async (args) => shimCall('list-tasks-tool', args),
};

export const createShimTask: ToolDef = {
  name: 'create_shim_task',
  description:
    "Create a personal task in SHIM. Use for Kevin's personal todos, errands, life tasks, and anything that doesn't belong in Paperclip.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Task title' },
      description: { type: 'string', description: 'Optional description' },
      priority: { type: 'number', description: '0=none, 1=low, 2=medium, 3=high, 4=urgent', default: 2 },
      project_id: { type: 'number', description: 'Optional project ID' },
      due_date: { type: 'string', description: 'Optional due date ISO 8601' },
      mode: { type: 'string', enum: ['darwin', 'personal'], description: "Task mode. Omit to leave untagged." },
    },
    required: ['title'],
  },
  execute: async (args) => shimCall('create-task-tool', args),
};

export const updateShimTask: ToolDef = {
  name: 'update_shim_task',
  description: 'Update a SHIM task — change status, priority, title, or mark complete.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'number', description: 'Task ID' },
      title: { type: 'string' },
      status: { type: 'string', enum: ['open', 'in_progress', 'completed', 'blocked'] },
      priority: { type: 'number' },
      mode: { type: 'string', enum: ['darwin', 'personal'], description: 'Change the task mode.' },
      mark_complete: { type: 'boolean', description: 'Set true to mark done (cascades to subtasks)' },
    },
    required: ['id'],
  },
  execute: async (args) => shimCall('update-task-tool', args),
};

export const listShimProjects: ToolDef = {
  name: 'list_shim_projects',
  description: "List Kevin's projects in SHIM with task counts.",
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['active', 'archived', 'on_hold'] },
      mode: { type: 'string', enum: ['darwin', 'personal'], description: 'Filter by mode. Omit for all.' },
      include_counts: { type: 'boolean', default: true },
    },
  },
  execute: async (args) =>
    shimCall('list-projects-tool', { include_counts: true, ...args }),
};

export const createShimProject: ToolDef = {
  name: 'create_shim_project',
  description:
    "Create a new project in SHIM. Use when Kevin wants to organize tasks under a new project (e.g. 'Honey Do', 'Home Improvement').",
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Project name' },
      description: { type: 'string', description: 'Optional project description' },
      mode: { type: 'string', enum: ['darwin', 'personal'], description: "Project mode. Omit to leave untagged." },
      status: {
        type: 'string',
        enum: ['active', 'archived', 'on_hold'],
        description: 'Project status. Defaults to active.',
        default: 'active',
      },
    },
    required: ['name'],
  },
  execute: async (args) =>
    shimCall('create-project-tool', { status: 'active', ...args }),
};

export const listShimFridge: ToolDef = {
  name: 'list_shim_fridge',
  description:
    "List Kevin's fridge items — ideas on ice that don't have a home yet. Use when he asks about ideas or wants to pull something out of cold storage.",
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'fresh, stale, promoted, archived' },
      mode: { type: 'string', enum: ['darwin', 'personal'], description: 'Filter by mode. Omit for all.' },
      limit: { type: 'number', default: 20 },
    },
  },
  execute: async (args) => shimCall('list-fridge-items-tool', args),
};

export const createShimFridgeItem: ToolDef = {
  name: 'create_shim_fridge_item',
  description:
    "Add an idea to Kevin's fridge in SHIM. Use when he has an idea that isn't ready to be a task yet.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Idea title' },
      body: { type: 'string', description: 'Idea details' },
      mode: { type: 'string', enum: ['darwin', 'personal'], description: "Fridge item mode. Omit to leave untagged." },
      priority: { type: 'number', default: 2 },
      freshness_duration: {
        type: 'number',
        description: 'Days until it expires. 0 = never expires.',
        default: 30,
      },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['title'],
  },
  execute: async (args) => shimCall('create-fridge-item-tool', args),
};

export const listFocusSessions: ToolDef = {
  name: 'list_focus_sessions',
  description:
    "List Kevin's recent pomodoro focus sessions in SHIM. Use to understand today's work patterns, momentum, and how productive he's been.",
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', default: 10 },
      today_only: { type: 'boolean', description: 'Only return today\'s sessions' },
      status: { type: 'string', enum: ['active', 'paused', 'completed'] },
    },
  },
  execute: async (args) => shimCall('list-focus-sessions-tool', args),
};

export const startFocusSession: ToolDef = {
  name: 'start_focus_session',
  description:
    "Start a 25-minute pomodoro focus session in SHIM. Use when Kevin says he's ready to work on something.",
  parameters: {
    type: 'object',
    properties: {
      task_description: { type: 'string', description: 'What is Kevin working on?' },
      project_id: { type: 'number', description: 'Optional project ID' },
      planned_duration: {
        type: 'number',
        description: 'Duration in minutes. Defaults to 25.',
        default: 25,
      },
    },
  },
  execute: async (args) =>
    shimCall('start-focus-session-tool', {
      planned_duration: 25,
      ...args,
    }),
};

export const stopFocusSession: ToolDef = {
  name: 'stop_focus_session',
  description: 'Stop the currently active focus session in SHIM.',
  parameters: { type: 'object', properties: {} },
  execute: async () => shimCall('stop-focus-session-tool', {}),
};

export const shimDeployStatus: ToolDef = {
  name: 'shim_deploy_status',
  description:
    "Check SHIM's current deployment status — which branch is live, recent commits, and whether it's running a review branch or master.",
  parameters: { type: 'object', properties: {} },
  execute: async () => shimApi('GET', '/deploy/status'),
};

export const shimDeploySwitch: ToolDef = {
  name: 'shim_deploy_switch',
  description:
    'Switch SHIM production to a named branch for review. Fetches latest, checks out the branch, runs migrations, and clears caches.',
  parameters: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: 'Git branch name to switch to' },
    },
    required: ['branch'],
  },
  execute: async (args) => shimApi('POST', '/deploy/switch', args),
};

export const shimDeployApprove: ToolDef = {
  name: 'shim_deploy_approve',
  description:
    'Approve the current review branch — merges it into master, deletes the branch, and refreshes caches. Only works when SHIM is on a review branch.',
  parameters: { type: 'object', properties: {} },
  execute: async () => shimApi('POST', '/deploy/approve'),
};

export const shimDeployReject: ToolDef = {
  name: 'shim_deploy_reject',
  description:
    'Reject the current review branch — switches back to master without merging. The branch is preserved on GitHub for future reference.',
  parameters: { type: 'object', properties: {} },
  execute: async () => shimApi('POST', '/deploy/reject'),
};
