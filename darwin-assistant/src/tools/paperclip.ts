import { query, DARWIN_COMPANY_ID } from '../db.js';
import type { ToolDef } from './index.js';

function paperclipApi(): string {
  return process.env.PAPERCLIP_API_URL ?? 'http://localhost:3100';
}

function paperclipApiKey(): string {
  return process.env.PAPERCLIP_BOARD_API_KEY ?? '';
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${paperclipApi()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${paperclipApiKey()}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Paperclip API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPatch(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${paperclipApi()}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${paperclipApiKey()}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Paperclip API error ${res.status}: ${text}`);
  }
  return res.json();
}

export const createIssue: ToolDef = {
  name: 'create_issue',
  description:
    'Create a new issue/task in Paperclip. Use for software work, agent tasks, research, or anything that needs to be tracked and potentially delegated to an AI agent.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short, clear task title' },
      description: { type: 'string', description: 'Full task description with context' },
      priority: {
        type: 'string',
        enum: ['critical', 'high', 'medium', 'low'],
        default: 'medium',
      },
      status: { type: 'string', enum: ['backlog', 'todo'], default: 'todo' },
      projectId: { type: 'string', description: 'UUID of the project this belongs to' },
      assigneeAgentId: { type: 'string', description: 'UUID of the agent to assign this to' },
    },
    required: ['title'],
  },
  execute: async (args) => {
    const { title, description, priority = 'medium', status = 'todo', projectId, assigneeAgentId } =
      args as {
        title: string;
        description?: string;
        priority?: string;
        status?: string;
        projectId?: string;
        assigneeAgentId?: string;
      };
    const result = (await apiPost(`/api/companies/${DARWIN_COMPANY_ID}/issues`, {
      title,
      description,
      priority,
      status,
      projectId,
      assigneeAgentId,
    })) as { identifier: string; id: string };
    return { identifier: result.identifier, id: result.id, title };
  },
};

export const searchIssues: ToolDef = {
  name: 'search_issues',
  description: 'Search or list Paperclip issues by status, assignee, or keyword in title.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'],
      },
      keyword: { type: 'string', description: 'Keyword to match in issue title' },
      assigneeName: { type: 'string', description: 'Agent name to filter by (partial match)' },
      limit: { type: 'number', default: 10 },
    },
  },
  execute: async (args) => {
    const { status, keyword, assigneeName, limit = 10 } = args as {
      status?: string;
      keyword?: string;
      assigneeName?: string;
      limit?: number;
    };

    let sql = `
      SELECT i.identifier, i.title, i.status, i.priority, a.name AS assignee, i.updated_at
      FROM issues i
      LEFT JOIN agents a ON a.id = i.assignee_agent_id
      WHERE i.company_id = $1
    `;
    const params: unknown[] = [DARWIN_COMPANY_ID];
    let idx = 2;

    if (status) { sql += ` AND i.status = $${idx++}`; params.push(status); }
    if (keyword) { sql += ` AND i.title ILIKE $${idx++}`; params.push(`%${keyword}%`); }
    if (assigneeName) { sql += ` AND a.name ILIKE $${idx++}`; params.push(`%${assigneeName}%`); }

    sql += ` ORDER BY i.updated_at DESC LIMIT $${idx}`;
    params.push(limit);

    return query(sql, params);
  },
};

export const getIssue: ToolDef = {
  name: 'get_issue',
  description: 'Get full details of a specific Paperclip issue including latest comments.',
  parameters: {
    type: 'object',
    properties: {
      identifier: { type: 'string', description: 'Issue identifier, e.g. DAR-352' },
    },
    required: ['identifier'],
  },
  execute: async (args) => {
    const { identifier } = args as { identifier: string };

    const issues = await query<{
      id: string;
      identifier: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      assignee: string;
      updated_at: string;
    }>(
      `SELECT i.id, i.identifier, i.title, i.description, i.status, i.priority,
              a.name AS assignee, i.updated_at
       FROM issues i
       LEFT JOIN agents a ON a.id = i.assignee_agent_id
       WHERE i.company_id = $1 AND i.identifier = $2`,
      [DARWIN_COMPANY_ID, identifier],
    );

    if (!issues.length) return { error: `Issue ${identifier} not found` };
    const issue = issues[0];

    const comments = await query<{ author: string; body: string; created_at: string }>(
      `SELECT COALESCE(a.name, u.name, 'Kevin') AS author, c.body, c.created_at
       FROM issue_comments c
       LEFT JOIN agents a ON a.id = c.author_agent_id
       LEFT JOIN "user" u ON u.id = c.author_user_id
       WHERE c.issue_id = $1
       ORDER BY c.created_at DESC
       LIMIT 5`,
      [issue.id],
    );

    return { ...issue, recent_comments: comments };
  },
};

export const updateIssueStatus: ToolDef = {
  name: 'update_issue_status',
  description: 'Update the status of a Paperclip issue.',
  parameters: {
    type: 'object',
    properties: {
      identifier: { type: 'string', description: 'Issue identifier, e.g. DAR-352' },
      status: {
        type: 'string',
        enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'],
      },
      comment: {
        type: 'string',
        description: 'Optional comment explaining the status change',
      },
    },
    required: ['identifier', 'status'],
  },
  execute: async (args) => {
    const { identifier, status, comment } = args as {
      identifier: string;
      status: string;
      comment?: string;
    };

    const issues = await query<{ id: string }>(
      `SELECT id FROM issues WHERE company_id = $1 AND identifier = $2`,
      [DARWIN_COMPANY_ID, identifier],
    );
    if (!issues.length) return { error: `Issue ${identifier} not found` };
    const issueId = issues[0].id;

    await apiPatch(`/api/companies/${DARWIN_COMPANY_ID}/issues/${issueId}`, { status });
    if (comment) {
      await apiPost(`/api/companies/${DARWIN_COMPANY_ID}/issues/${issueId}/comments`, { body: comment });
    }

    return { identifier, status, updated: true };
  },
};

export const updateIssue: ToolDef = {
  name: 'update_issue',
  description:
    'Update fields on a Paperclip issue: reassign, change priority, move to a project, or edit title/description. Use this for field changes; use update_issue_status for status-only changes.',
  parameters: {
    type: 'object',
    properties: {
      identifier: { type: 'string', description: 'Issue identifier, e.g. DAR-382' },
      assigneeAgentId: {
        type: 'string',
        description: 'UUID of the agent to assign this issue to',
      },
      priority: {
        type: 'string',
        enum: ['critical', 'high', 'medium', 'low'],
      },
      projectId: { type: 'string', description: 'UUID of the project to move this issue to' },
      title: { type: 'string', description: 'New title for the issue' },
      description: { type: 'string', description: 'New description for the issue' },
    },
    required: ['identifier'],
  },
  execute: async (args) => {
    const { identifier, assigneeAgentId, priority, projectId, title, description } = args as {
      identifier: string;
      assigneeAgentId?: string;
      priority?: string;
      projectId?: string;
      title?: string;
      description?: string;
    };

    const issues = await query<{ id: string }>(
      `SELECT id FROM issues WHERE company_id = $1 AND identifier = $2`,
      [DARWIN_COMPANY_ID, identifier],
    );
    if (!issues.length) return { error: `Issue ${identifier} not found` };
    const issueId = issues[0].id;

    const patch: Record<string, unknown> = {};
    if (assigneeAgentId !== undefined) patch.assigneeAgentId = assigneeAgentId;
    if (priority !== undefined) patch.priority = priority;
    if (projectId !== undefined) patch.projectId = projectId;
    if (title !== undefined) patch.title = title;
    if (description !== undefined) patch.description = description;

    if (!Object.keys(patch).length) return { error: 'No fields to update' };

    await apiPatch(`/api/companies/${DARWIN_COMPANY_ID}/issues/${issueId}`, patch);
    return { identifier, updated: true, fields: Object.keys(patch) };
  },
};

export const addComment: ToolDef = {
  name: 'add_comment',
  description: 'Add a comment to a Paperclip issue.',
  parameters: {
    type: 'object',
    properties: {
      identifier: { type: 'string', description: 'Issue identifier, e.g. DAR-352' },
      body: { type: 'string', description: 'Comment text (markdown supported)' },
    },
    required: ['identifier', 'body'],
  },
  execute: async (args) => {
    const { identifier, body } = args as { identifier: string; body: string };
    const issues = await query<{ id: string }>(
      `SELECT id FROM issues WHERE company_id = $1 AND identifier = $2`,
      [DARWIN_COMPANY_ID, identifier],
    );
    if (!issues.length) return { error: `Issue ${identifier} not found` };
    await apiPost(`/api/companies/${DARWIN_COMPANY_ID}/issues/${issues[0].id}/comments`, { body });
    return { identifier, commented: true };
  },
};

export const listAgents: ToolDef = {
  name: 'list_agents',
  description: 'List Paperclip agents with their current status and role.',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['idle', 'running', 'paused', 'error'] },
    },
  },
  execute: async (args) => {
    const { status } = args as { status?: string };
    let sql = `SELECT id, name, role, status, adapter_type, last_heartbeat_at
               FROM agents WHERE company_id = $1`;
    const params: unknown[] = [DARWIN_COMPANY_ID];
    if (status) { sql += ` AND status = $2`; params.push(status); }
    sql += ` ORDER BY status, name`;
    return query(sql, params);
  },
};

export const listProjects: ToolDef = {
  name: 'list_projects',
  description: 'List Paperclip projects with open issue counts.',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    return query(
      `SELECT p.id, p.name, p.status,
              COUNT(i.id) FILTER (WHERE i.status NOT IN ('done','cancelled')) AS open_issues
       FROM projects p
       LEFT JOIN issues i ON i.project_id = p.id
       WHERE p.company_id = $1
       GROUP BY p.id, p.name, p.status
       ORDER BY p.status, p.name`,
      [DARWIN_COMPANY_ID],
    );
  },
};

export const getSystemHealth: ToolDef = {
  name: 'get_system_health',
  description: 'Get a quick system health snapshot: agent statuses, task counts, recent failures.',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const rows = await query<Record<string, string>>(
      `SELECT
        (SELECT COUNT(*) FROM agents WHERE company_id = $1 AND status = 'running') AS agents_running,
        (SELECT COUNT(*) FROM agents WHERE company_id = $1 AND status = 'idle') AS agents_idle,
        (SELECT COUNT(*) FROM agents WHERE company_id = $1 AND status = 'paused') AS agents_paused,
        (SELECT COUNT(*) FROM agents WHERE company_id = $1 AND status = 'error') AS agents_error,
        (SELECT COUNT(*) FROM issues WHERE company_id = $1 AND status = 'in_progress') AS tasks_in_progress,
        (SELECT COUNT(*) FROM issues WHERE company_id = $1 AND status = 'in_review') AS tasks_in_review,
        (SELECT COUNT(*) FROM issues WHERE company_id = $1 AND status = 'blocked') AS tasks_blocked,
        (SELECT COUNT(*) FROM issues WHERE company_id = $1 AND status IN ('todo','backlog')) AS tasks_queued,
        (SELECT COUNT(*) FROM heartbeat_runs WHERE company_id = $1 AND status = 'failed' AND started_at > now() - interval '24 hours') AS failures_24h,
        (SELECT COUNT(*) FROM approvals WHERE company_id = $1 AND status = 'pending') AS pending_approvals`,
      [DARWIN_COMPANY_ID],
    );
    return rows[0];
  },
};
