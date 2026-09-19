#!/usr/bin/env node
// Persona-tools MCP server — exposes darwin-assistant's own tool registry
// (ALL_TOOLS in ../tools/index.js: goals, workstreams, thread_todos, hopper,
// notifications, SHIM/checkin/wiki/paperclip tools, etc.) to a `claude`-adapter
// subprocess as NATIVE mcp__jarvis__<name> tools, so the model doesn't have to
// fall back to the <tool_call> text-block protocol to reach them.
//
// This process does NOT execute tools in-process — it never opens jarvis.db
// itself (that would race the live server's own sqlite handle). Every call is
// a fetch to the loopback route POST /api/v1/internal/tool-exec on the ALREADY
// RUNNING darwin-assistant server, which runs the real TOOL_MAP handler with
// the real ToolExecutionContext and records the same turn rows + SSE a
// text-protocol call would. See src/mcp/persona-tools-server.README.md (or
// the project's RECON.md §7) for the full design rationale.
//
// Launched per-spawn by runClaude() via a temp --mcp-config file
// (src/agent.ts); env vars below are supplied there, not read from the
// process's own .env.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ALL_TOOLS } from '../tools/index.js';

const apiBase = process.env.JARVIS_API_BASE ?? 'http://localhost:3201/api/v1';
const internalKey = process.env.JARVIS_INTERNAL_KEY ?? '';
let toolContext: unknown = {};
try {
  toolContext = JSON.parse(process.env.JARVIS_TOOL_CONTEXT ?? '{}');
} catch {
  // Malformed context env — leave as {} so tool-exec's own validation surfaces
  // a clean 400 instead of this process crashing.
}

const server = new Server({ name: 'jarvis', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters as Record<string, unknown>,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const resp = await fetch(`${apiBase}/internal/tool-exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${internalKey}` },
      body: JSON.stringify({ context: toolContext, name, arguments: args ?? {} }),
    });
    const body = (await resp.json()) as { result?: unknown; error?: string };
    const payload = body.error ? { error: body.error } : body.result;
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
