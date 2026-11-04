#!/usr/bin/env node
// Persona-tools MCP server — exposes darwin-assistant's own tool registry
// (ALL_TOOLS in ../tools/index.js: goals, workstreams, thread_todos, hopper,
// notifications, SHIM/checkin/wiki/paperclip tools, etc.) to a `claude`-adapter
// subprocess as NATIVE mcp__jarvis__<name> tools, so the model doesn't have to
// fall back to the <tool_call> text-block protocol to reach them.
//
// This process is deliberately DEPENDENCY-FREE with respect to the app: it does
// NOT import ../tools/index.js and never opens jarvis.db. (Importing the tool
// registry would transitively load conversation-db.ts, whose module scope opens
// the sqlite file and runs the whole CREATE TABLE / ALTER TABLE block — one
// extra writer on the live DB per claude spawn.) Instead BOTH halves go over
// loopback HTTP to the ALREADY RUNNING darwin-assistant server:
//   - tools/list -> GET  /api/v1/internal/tools     (the manifest)
//   - tools/call -> POST /api/v1/internal/tool-exec (real TOOL_MAP execution,
//                   real ToolExecutionContext, same turn rows + SSE as the
//                   text-protocol path)
//
// Launched per-spawn by runClaude() via a temp --mcp-config file
// (src/agent.ts); env vars below are supplied there, not read from the
// process's own .env.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readToolManifest } from './tool-manifest.js';

const apiBase = process.env.JARVIS_API_BASE ?? 'http://localhost:3201/api/v1';
const internalKey = process.env.JARVIS_INTERNAL_KEY ?? '';
let toolContext: unknown = {};
try {
  toolContext = JSON.parse(process.env.JARVIS_TOOL_CONTEXT ?? '{}');
} catch {
  // Malformed context env — leave as {} so tool-exec's own validation surfaces
  // a clean 400 instead of this process crashing.
}

const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${internalKey}` };

/** Abortable fetch so a wedged server can't hang a tool call (or startup) forever. */
async function loopback(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(`${apiBase}${path}`, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

const server = new Server({ name: 'jarvis', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // FLOOR FIRST (2026-10-18): read the boot-written static cache. The list is
  // static (ALL_TOOLS, no per-turn filtering), so the file is authoritative and,
  // unlike the loopback, cannot stall when many spawns land at once — the silent
  // `{ tools: [] }` drop that stall used to cause. See mcp/tool-manifest.ts.
  const cached = readToolManifest();
  if (cached) {
    return {
      tools: cached.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
    };
  }
  // FALLBACK: cache missing (the brief window right after boot before it is
  // written). Ask the running server directly.
  try {
    const resp = await loopback('/internal/tools', { method: 'GET', headers: authHeaders }, 15_000);
    const body = (await resp.json()) as { tools?: { name: string; description: string; parameters: Record<string, unknown> }[] };
    return {
      tools: (body.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
      })),
    };
  } catch {
    // Both the cache and the loopback are unreachable — advertise nothing rather
    // than crash. The spawn still runs; the model falls back to the <tool_call>
    // text protocol.
    return { tools: [] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const resp = await loopback(
      '/internal/tool-exec',
      { method: 'POST', headers: authHeaders, body: JSON.stringify({ context: toolContext, name, arguments: args ?? {} }) },
      300_000,
    );
    const body = (await resp.json()) as { result?: unknown; error?: string };
    const payload = body.error ? { error: body.error } : body.result;
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
