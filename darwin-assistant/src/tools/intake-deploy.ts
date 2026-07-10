import type { ToolDef } from './index.js';

// JARVIS Ops — intake MCP deploy tool (DAR-671).
//
// Wraps the scoped /deploy/* endpoint on the darwin-intake-system MCP server
// so JARVIS can pull + restart it without SSH. Prior art: the shim_deploy_*
// tools in shim.ts. The endpoint enforces all guardrails server-side (bearer
// auth, hardcoded repo path, ff-only pull, no branch switching, no shell
// passthrough); this tool just picks an action and forwards the token.

function intakeBaseUrl(): string {
  // Base URL of the intake MCP server (no trailing slash). Falls back to the
  // known live host; override with INTAKE_DEPLOY_URL when the box moves.
  return (process.env.INTAKE_DEPLOY_URL ?? 'https://mcp.thedarwinhub.com').replace(/\/$/, '');
}

const ACTION_ROUTES: Record<string, { method: string; path: string }> = {
  status: { method: 'GET', path: '/deploy/status' },
  pull: { method: 'POST', path: '/deploy/pull' },
  restart: { method: 'POST', path: '/deploy/restart' },
  pull_and_restart: { method: 'POST', path: '/deploy/pull-and-restart' },
};

async function intakeDeployApi(action: string): Promise<unknown> {
  const route = ACTION_ROUTES[action];
  if (!route) throw new Error(`intake_deploy: unknown action '${action}'`);

  const token = process.env.INTAKE_DEPLOY_TOKEN;
  if (!token) {
    throw new Error('intake_deploy: INTAKE_DEPLOY_TOKEN not set — cannot call the deploy endpoint');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const res = await fetch(`${intakeBaseUrl()}${route.path}`, { method: route.method, headers });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error?: unknown }).error)
        : text;
    throw new Error(`intake_deploy error (${res.status}): ${msg}`);
  }

  return body;
}

export const intakeDeploy: ToolDef = {
  name: 'intake_deploy',
  description:
    "Deploy the darwin-intake-system MCP server (mcp.thedarwinhub.com) without SSH. " +
    "'status' snapshots the live branch + commit and service health; 'pull' fetches and " +
    "fast-forwards the current branch; 'restart' restarts the MCP service; 'pull_and_restart' " +
    "does both (restart only runs if the pull succeeds). Always run 'status' before and after " +
    "a deploy to verify the commit advanced and the service is healthy. No auto-retry on failure — " +
    "surface the error to Kevin. See skills/jarvis-ops/intake-mcp-deploy.md.",
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'pull', 'restart', 'pull_and_restart'],
        description: 'Which deploy operation to run.',
      },
    },
    required: ['action'],
  },
  execute: async (args) => intakeDeployApi(String(args.action)),
};
