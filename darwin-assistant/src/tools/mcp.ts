import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDef } from './index.js';

const execFileAsync = promisify(execFile);

// Phase 1 "fast-path bridge" (DAR-677): JARVIS makes MCP tool calls by shelling
// to the pi's `claude` binary, which is already authenticated to every MCP
// server we care about. Zero new auth flows. This is a bootstrap, NOT the
// durable answer — Phase 2 replaces it with a native @modelcontextprotocol/sdk
// client in this runtime. See skills/jarvis-mcp-integration/SKILL.md.

const CLAUDE_BIN = process.env.JARVIS_CLAUDE_BIN || '/home/kevin/.local/bin/claude';
// The proxy only needs to make one tool call and hand back the raw result — a
// small model does this fine and cuts per-call cost ~20x vs the opus default.
const BRIDGE_MODEL = process.env.JARVIS_MCP_BRIDGE_MODEL || 'claude-haiku-4-5-20251001';
const BRIDGE_CWD = process.env.JARVIS_MCP_BRIDGE_CWD || '/home/kevin';
const BRIDGE_TIMEOUT_MS = Number(process.env.JARVIS_MCP_BRIDGE_TIMEOUT_MS || 120_000);

// Friendly server name -> the prefix claude uses in its tool ids. Not uniform:
// smarty-pants keeps its hyphenated name, but claude.ai connectors are
// namespaced `claude_ai_<Name>`. Aliases included for ergonomics.
const SERVER_PREFIX: Record<string, string> = {
  'smarty-pants': 'smarty-pants',
  smarty_pants: 'smarty-pants',
  smartypants: 'smarty-pants',
  lovable: 'claude_ai_Lovable',
  supabase: 'claude_ai_Supabase',
  slack: 'claude_ai_Slack',
  context7: 'claude_ai_Context7',
  microsoft365: 'claude_ai_Microsoft_365',
  m365: 'claude_ai_Microsoft_365',
};

interface BridgeResult {
  ok: boolean;
  tool: string;
  result: string;
  cost_usd?: number;
  duration_ms?: number;
  error?: string;
}

function resolveToolName(server: string, tool: string): string {
  // Allow callers to pass a fully-qualified tool id and short-circuit.
  if (tool.startsWith('mcp__')) return tool;
  const key = server.trim().toLowerCase();
  const prefix = SERVER_PREFIX[key] ?? server.trim();
  return `mcp__${prefix}__${tool}`;
}

/**
 * Core bridge: ask the pre-authed claude CLI to invoke a single MCP tool,
 * scoped via --allowed-tools so it never prompts, and return its raw result.
 */
async function bridgeCall(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<BridgeResult> {
  const toolName = resolveToolName(server, tool);
  const argsJson = JSON.stringify(args ?? {});
  const prompt =
    `Call the ${toolName} tool with exactly these arguments: ${argsJson}. ` +
    `Return ONLY the raw tool result. Do not summarize, explain, or wrap it in ` +
    `markdown fences — output the tool's result verbatim.`;

  const cliArgs = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--allowed-tools',
    toolName,
    '--model',
    BRIDGE_MODEL,
  ];

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: BRIDGE_CWD,
  };

  try {
    const { stdout } = await execFileAsync(CLAUDE_BIN, cliArgs, {
      env,
      cwd: BRIDGE_CWD,
      timeout: BRIDGE_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });
    const envelope = JSON.parse(stdout) as {
      is_error?: boolean;
      result?: string;
      total_cost_usd?: number;
      duration_ms?: number;
      permission_denials?: unknown[];
    };
    const denied = Array.isArray(envelope.permission_denials) && envelope.permission_denials.length > 0;
    return {
      ok: envelope.is_error !== true && !denied,
      tool: toolName,
      result: typeof envelope.result === 'string' ? envelope.result : JSON.stringify(envelope.result ?? null),
      cost_usd: envelope.total_cost_usd,
      duration_ms: envelope.duration_ms,
      error: denied ? 'permission_denied: tool not in --allowed-tools scope' : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, tool: toolName, result: '', error: msg };
  }
}

export const mcpCall: ToolDef = {
  name: 'mcp_call',
  description:
    'Call any MCP tool on a server the pi is authenticated to (smarty-pants, lovable, ' +
    'supabase, slack, context7, microsoft365), via the claude bridge. Generic escape ' +
    'hatch — use the convenience wrappers (lovable_send_message, supabase_execute_sql) ' +
    'when one exists. Returns the tool result as text.',
  parameters: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description:
          'Server name: smarty-pants, lovable, supabase, slack, context7, or microsoft365.',
      },
      tool: {
        type: 'string',
        description:
          "The tool name without prefix (e.g. 'list_projects', 'query_database'), or a " +
          "fully-qualified id like 'mcp__smarty-pants__task-board-tool'.",
      },
      args: {
        type: 'object',
        description: 'Arguments object passed to the tool. Defaults to {}.',
      },
    },
    required: ['server', 'tool'],
  },
  execute: async (input) => {
    const { server, tool, args } = input as {
      server: string;
      tool: string;
      args?: Record<string, unknown>;
    };
    return bridgeCall(server, tool, args ?? {});
  },
};

export const lovableSendMessage: ToolDef = {
  name: 'lovable_send_message',
  description:
    'Send a natural-language build/edit request to a Lovable project agent and wait for ' +
    'it to finish. Use to have JARVIS iterate its own cockpit UI or any Lovable app. ' +
    'Set plan_mode=true to discuss approach without editing code.',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Lovable project ID.' },
      message: { type: 'string', description: 'What you want built or changed, in natural language.' },
      plan_mode: {
        type: 'boolean',
        description: 'If true, the agent plans without writing code. Default false.',
      },
    },
    required: ['project_id', 'message'],
  },
  execute: async (input) => {
    const { project_id, message, plan_mode } = input as {
      project_id: string;
      message: string;
      plan_mode?: boolean;
    };
    return bridgeCall('lovable', 'send_message', {
      project_id,
      message,
      plan_mode: plan_mode ?? false,
    });
  },
};

export const supabaseExecuteSql: ToolDef = {
  name: 'supabase_execute_sql',
  description:
    'Run a raw SQL query against a Supabase project via the MCP bridge. Read/DML only — ' +
    'use for reads and data queries, not DDL. Returns rows as JSON text.',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Supabase project ref/id.' },
      query: { type: 'string', description: 'The SQL query to execute.' },
    },
    required: ['project_id', 'query'],
  },
  execute: async (input) => {
    const { project_id, query } = input as { project_id: string; query: string };
    return bridgeCall('supabase', 'execute_sql', { project_id, query });
  },
};
