import { DARWIN_COMPANY_ID, DARWIN_USER_ID } from '../db.js';
import type { ToolDef } from './index.js';

function paperclipApi(): string {
  return process.env.PAPERCLIP_API_URL ?? 'http://localhost:3100';
}

function paperclipApiKey(): string {
  return process.env.PAPERCLIP_BOARD_API_KEY ?? '';
}

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${paperclipApiKey()}`,
  };
}

async function apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const opts: RequestInit = { method, headers: headers() };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${paperclipApi()}${path}`, opts);
  if (res.status === 204) return { success: true };
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Paperclip API error ${res.status}: ${text}`);
  }
  return res.json();
}

export const createScheduledTask: ToolDef = {
  name: 'create_scheduled_task',
  description:
    'Create a scheduled task in Paperclip that syncs to Google Calendar automatically (~60s). Use this instead of create_calendar_event for anything that should be tracked as a SCH-XXX record.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title for the task/event' },
      scheduledAt: {
        type: 'string',
        description: 'When to schedule it, ISO 8601 with timezone offset (e.g. 2026-05-14T09:00:00-05:00)',
      },
      durationMinutes: {
        type: 'number',
        description: 'Duration in minutes (default 30)',
        default: 30,
      },
      kind: {
        type: 'string',
        enum: ['task_personal', 'task_work', 'task_home', 'event', 'reminder'],
        description: 'Type of task (default task_personal)',
      },
      summary: { type: 'string', description: 'Optional longer description or notes' },
      linkedPaperclipIssueId: {
        type: 'string',
        description: 'UUID of a Paperclip issue to link this task to',
      },
      linkedShimTaskId: {
        type: 'number',
        description: 'SHIM task ID to link this task to',
      },
    },
    required: ['title', 'scheduledAt'],
  },
  execute: async (args) => {
    const {
      title,
      scheduledAt,
      durationMinutes = 30,
      kind,
      summary,
      linkedPaperclipIssueId,
      linkedShimTaskId,
    } = args as {
      title: string;
      scheduledAt: string;
      durationMinutes?: number;
      kind?: string;
      summary?: string;
      linkedPaperclipIssueId?: string;
      linkedShimTaskId?: number;
    };

    try {
      const body: Record<string, unknown> = {
        original_prompt: title,
        title,
        scheduled_for: scheduledAt,
        duration_minutes: durationMinutes,
        origin: 'jarvis',
        userId: DARWIN_USER_ID,
      };
      if (kind) body.kind = kind;
      if (summary) body.summary = summary;
      if (linkedPaperclipIssueId) body.linked_paperclip_issue_id = linkedPaperclipIssueId;
      if (linkedShimTaskId) body.linked_shim_task_id = linkedShimTaskId;

      const task = (await apiRequest(
        'POST',
        `/api/companies/${DARWIN_COMPANY_ID}/scheduled-tasks/preplaced`,
        body,
      )) as { id: string; identifier: string; seqNum: number; title: string; scheduledAt: string };

      return {
        created: true,
        identifier: task.identifier,
        id: task.id,
        title: task.title,
        scheduledAt: task.scheduledAt,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
};

export const listScheduledTasks: ToolDef = {
  name: 'list_scheduled_tasks',
  description:
    'List scheduled tasks from Paperclip. Returns SCH-XXX identifiers, titles, times, and linked anchors.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'scheduled', 'completed', 'cancelled'],
        description: 'Filter by status (default: all)',
      },
      limit: { type: 'number', description: 'Max results (default 20)', default: 20 },
    },
  },
  execute: async (args) => {
    const { status, limit = 20 } = args as { status?: string; limit?: number };

    try {
      const tasks = (await apiRequest(
        'GET',
        `/api/companies/${DARWIN_COMPANY_ID}/scheduled-tasks`,
      )) as Array<{
        id: string;
        identifier: string;
        title: string | null;
        status: string;
        kind: string | null;
        scheduledAt: string | null;
        durationMinutes: number | null;
        linkedPaperclipIssueId: string | null;
        linkedShimTaskId: number | null;
        createdAt: string;
      }>;

      let filtered = tasks;
      if (status) filtered = filtered.filter((t) => t.status === status);
      filtered = filtered.slice(0, limit);

      return filtered.map((t) => ({
        identifier: t.identifier,
        title: t.title,
        status: t.status,
        kind: t.kind,
        scheduledAt: t.scheduledAt,
        durationMinutes: t.durationMinutes,
        linkedPaperclipIssueId: t.linkedPaperclipIssueId,
        linkedShimTaskId: t.linkedShimTaskId,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
};

export const getScheduledTask: ToolDef = {
  name: 'get_scheduled_task',
  description: 'Get details of a specific scheduled task by SCH-XXX identifier or UUID.',
  parameters: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'SCH-XXX identifier or task UUID',
      },
    },
    required: ['identifier'],
  },
  execute: async (args) => {
    const { identifier } = args as { identifier: string };

    try {
      let taskId = identifier;

      // If it's a SCH-XXX identifier, look up the UUID via the list endpoint
      if (identifier.startsWith('SCH-')) {
        const tasks = (await apiRequest(
          'GET',
          `/api/companies/${DARWIN_COMPANY_ID}/scheduled-tasks`,
        )) as Array<{ id: string; identifier: string }>;
        const match = tasks.find((t) => t.identifier === identifier);
        if (!match) return { error: `${identifier} not found` };
        taskId = match.id;
      }

      const task = await apiRequest('GET', `/api/scheduled-tasks/${taskId}`);
      return task;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
};

export const updateScheduledTask: ToolDef = {
  name: 'update_scheduled_task',
  description:
    'Update a scheduled task — reschedule, change duration, title, status, or link/unlink anchors. Time changes propagate to Google Calendar automatically.',
  parameters: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'SCH-XXX identifier or task UUID',
      },
      title: { type: 'string', description: 'New title' },
      scheduledAt: {
        type: 'string',
        description: 'New scheduled time (ISO 8601 with timezone offset). Pass null to clear.',
      },
      durationMinutes: { type: 'number', description: 'New duration in minutes' },
      status: {
        type: 'string',
        enum: ['pending', 'scheduled', 'completed', 'cancelled'],
      },
      kind: {
        type: 'string',
        enum: ['task_personal', 'task_work', 'task_home', 'event', 'reminder'],
      },
      notes: { type: 'string', description: 'Notes or description' },
      linkedPaperclipIssueId: {
        type: 'string',
        description: 'Paperclip issue UUID to link (null to unlink)',
      },
      linkedShimTaskId: {
        type: 'number',
        description: 'SHIM task ID to link (null to unlink)',
      },
    },
    required: ['identifier'],
  },
  execute: async (args) => {
    const { identifier, ...updates } = args as {
      identifier: string;
      title?: string;
      scheduledAt?: string | null;
      durationMinutes?: number;
      status?: string;
      kind?: string;
      notes?: string;
      linkedPaperclipIssueId?: string | null;
      linkedShimTaskId?: number | null;
    };

    try {
      let taskId = identifier;
      if (identifier.startsWith('SCH-')) {
        const tasks = (await apiRequest(
          'GET',
          `/api/companies/${DARWIN_COMPANY_ID}/scheduled-tasks`,
        )) as Array<{ id: string; identifier: string }>;
        const match = tasks.find((t) => t.identifier === identifier);
        if (!match) return { error: `${identifier} not found` };
        taskId = match.id;
      }

      const patch: Record<string, unknown> = {};
      if (updates.title !== undefined) patch.title = updates.title;
      if (updates.scheduledAt !== undefined) patch.scheduledAt = updates.scheduledAt;
      if (updates.durationMinutes !== undefined) patch.durationMinutes = updates.durationMinutes;
      if (updates.status !== undefined) patch.status = updates.status;
      if (updates.kind !== undefined) patch.kind = updates.kind;
      if (updates.notes !== undefined) patch.notes = updates.notes;
      if (updates.linkedPaperclipIssueId !== undefined) patch.linkedPaperclipIssueId = updates.linkedPaperclipIssueId;
      if (updates.linkedShimTaskId !== undefined) patch.linkedShimTaskId = updates.linkedShimTaskId;

      if (!Object.keys(patch).length) return { error: 'No fields to update' };

      const task = await apiRequest('PATCH', `/api/scheduled-tasks/${taskId}`, patch);
      return task;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
};

export const cancelScheduledTask: ToolDef = {
  name: 'cancel_scheduled_task',
  description:
    'Cancel and delete a scheduled task. Also removes the associated Google Calendar event if one exists.',
  parameters: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'SCH-XXX identifier or task UUID',
      },
    },
    required: ['identifier'],
  },
  execute: async (args) => {
    const { identifier } = args as { identifier: string };

    try {
      let taskId = identifier;
      if (identifier.startsWith('SCH-')) {
        const tasks = (await apiRequest(
          'GET',
          `/api/companies/${DARWIN_COMPANY_ID}/scheduled-tasks`,
        )) as Array<{ id: string; identifier: string }>;
        const match = tasks.find((t) => t.identifier === identifier);
        if (!match) return { error: `${identifier} not found` };
        taskId = match.id;
      }

      await apiRequest('DELETE', `/api/scheduled-tasks/${taskId}`);
      return { cancelled: true, identifier };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
};
