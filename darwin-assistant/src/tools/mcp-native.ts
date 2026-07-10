import { randomUUID } from 'node:crypto';

/**
 * Native Streamable-HTTP MCP client — DAR-680 Slice 4 / DAR-677 Phase 2.
 *
 * The Phase-1 bridge (`mcp.ts`) makes every MCP tool call by shelling to the
 * pre-authed `claude` CLI. That works for *all* servers but pays a ~20x cost
 * premium and multi-second latency per call (it spins a whole model turn just
 * to proxy one JSON-RPC request).
 *
 * This module talks the MCP Streamable-HTTP transport directly, with no model
 * in the loop. It is used ONLY for servers JARVIS can reach on its own:
 *
 *   - **smarty-pants** (`mcp.thedarwinhub.com`) — Darwin's own server, no auth.
 *
 * The five claude.ai connectors (Lovable / Supabase / Slack / Context7 / M365)
 * are deliberately NOT handled here: their OAuth is brokered by Kevin's
 * claude.ai account and there are no per-connector tokens on this box, so a
 * native client cannot authenticate to them without per-vendor app
 * registration. Those stay on the CLI bridge — see NATIVE_SERVERS below and
 * the routing in `mcp.ts`.
 */

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = Number(process.env.JARVIS_MCP_NATIVE_TIMEOUT_MS || 60_000);

/** Servers reachable by the native client, keyed by the same friendly names
 * the bridge accepts. Anything not in here falls back to the CLI bridge. */
export const NATIVE_SERVERS: Record<string, { url: string; headers?: Record<string, string> }> = {
  'smarty-pants': { url: process.env.JARVIS_SMARTY_PANTS_URL || 'https://mcp.thedarwinhub.com/mcp/boost' },
};

export function resolveNativeServer(server: string): { url: string; headers?: Record<string, string> } | undefined {
  const key = server.trim().toLowerCase();
  // Accept the same aliases the bridge does for smarty-pants.
  if (key === 'smarty-pants' || key === 'smarty_pants' || key === 'smartypants') {
    return NATIVE_SERVERS['smarty-pants'];
  }
  return NATIVE_SERVERS[key];
}

export interface NativeCallResult {
  ok: boolean;
  tool: string;
  result: string;
  error?: string;
  duration_ms?: number;
}

export interface NativeToolInfo {
  name: string;
  description?: string;
}

export interface NativeToolsResult {
  ok: boolean;
  server: string;
  tools: NativeToolInfo[];
  error?: string;
  duration_ms?: number;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * One MCP session per server URL. The Streamable-HTTP transport is stateful:
 * the server hands back an `Mcp-Session-Id` on `initialize` that must be echoed
 * on every subsequent request. We lazily initialize and cache the session, and
 * transparently re-initialize once if the server drops it (restart / expiry).
 */
class McpHttpSession {
  private sessionId: string | null = null;
  private initializing: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  private baseHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      // Streamable HTTP: server may answer with JSON or an SSE stream; accept both.
      Accept: 'application/json, text/event-stream',
      ...this.extraHeaders,
    };
  }

  /** POST a JSON-RPC message and return the parsed response (JSON or SSE-framed). */
  private async post(body: unknown, includeSession: boolean, signal: AbortSignal): Promise<Response> {
    const headers = this.baseHeaders();
    if (includeSession && this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  }

  private async ensureInitialized(signal: AbortSignal): Promise<void> {
    if (this.sessionId) return;
    if (!this.initializing) {
      this.initializing = this.doInitialize(signal).finally(() => {
        this.initializing = null;
      });
    }
    return this.initializing;
  }

  private async doInitialize(signal: AbortSignal): Promise<void> {
    const res = await this.post(
      {
        jsonrpc: '2.0',
        id: `init-${randomUUID()}`,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'jarvis-native', version: '0.1' },
        },
      },
      false,
      signal,
    );
    if (!res.ok) {
      throw new Error(`initialize failed: HTTP ${res.status} ${await safeText(res)}`);
    }
    // Session id is returned as a response header (case-insensitive).
    const sid = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id');
    await parseRpc(res); // drain body; confirms a well-formed initialize result
    if (!sid) throw new Error('initialize did not return an Mcp-Session-Id header');
    this.sessionId = sid;
    // Complete the handshake. Notifications have no id and expect no response body.
    const notif = await this.post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      true,
      signal,
    );
    // Some servers return 202 Accepted with an empty body — that's fine.
    if (notif.body) await notif.body.cancel().catch(() => {});
  }

  /** True when the failure looks like a dropped/expired session worth one re-init. */
  private isSessionError(status: number): boolean {
    return status === 404 || status === 400;
  }

  /** Enumerate the tools this server publishes (`tools/list`). Same
   * initialize-then-request lifecycle and one-shot session-retry as callTool. */
  async listTools(signal: AbortSignal): Promise<unknown> {
    await this.ensureInitialized(signal);
    const send = () =>
      this.post(
        { jsonrpc: '2.0', id: `list-${randomUUID()}`, method: 'tools/list', params: {} },
        true,
        signal,
      );

    let res = await send();
    if (this.isSessionError(res.status)) {
      if (res.body) await res.body.cancel().catch(() => {});
      this.sessionId = null;
      await this.ensureInitialized(signal);
      res = await send();
    }
    if (!res.ok) throw new Error(`tools/list failed: HTTP ${res.status} ${await safeText(res)}`);

    const rpc = await parseRpc(res);
    if (rpc.error) throw new Error(`tools/list error ${rpc.error.code}: ${rpc.error.message}`);
    return rpc.result;
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    await this.ensureInitialized(signal);
    const send = () =>
      this.post(
        {
          jsonrpc: '2.0',
          id: `call-${randomUUID()}`,
          method: 'tools/call',
          params: { name, arguments: args ?? {} },
        },
        true,
        signal,
      );

    let res = await send();
    if (this.isSessionError(res.status)) {
      // Session went stale — reset and try exactly once more.
      if (res.body) await res.body.cancel().catch(() => {});
      this.sessionId = null;
      await this.ensureInitialized(signal);
      res = await send();
    }
    if (!res.ok) throw new Error(`tools/call failed: HTTP ${res.status} ${await safeText(res)}`);

    const rpc = await parseRpc(res);
    if (rpc.error) throw new Error(`tools/call error ${rpc.error.code}: ${rpc.error.message}`);
    return rpc.result;
  }
}

const sessions = new Map<string, McpHttpSession>();

function sessionFor(url: string, headers?: Record<string, string>): McpHttpSession {
  let s = sessions.get(url);
  if (!s) {
    s = new McpHttpSession(url, headers);
    sessions.set(url, s);
  }
  return s;
}

/**
 * Call a tool on a native-reachable MCP server. `server` is the friendly name
 * (must resolve via {@link resolveNativeServer}); `tool` is the bare tool name
 * (no `mcp__…` prefix — that framing is a claude-CLI concept, irrelevant here).
 */
export async function nativeCall(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<NativeCallResult> {
  const target = resolveNativeServer(server);
  if (!target) {
    return { ok: false, tool, result: '', error: `no native transport for server '${server}'` };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const session = sessionFor(target.url, target.headers);
    const result = await session.callTool(tool, args ?? {}, controller.signal);
    return {
      ok: true,
      tool,
      result: extractContentText(result),
      duration_ms: Date.now() - started,
    };
  } catch (err) {
    const msg = controller.signal.aborted ? `native MCP call timed out after ${DEFAULT_TIMEOUT_MS}ms` : errMsg(err);
    return { ok: false, tool, result: '', error: msg, duration_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enumerate the tools a native-reachable MCP server publishes. Mirrors
 * {@link nativeCall}'s resolution + timeout handling. Powers the cockpit's
 * per-server tool drawer (DAR-677 Phase 3 `GET /mcp/servers/:id/tools`).
 */
export async function nativeListTools(server: string): Promise<NativeToolsResult> {
  const target = resolveNativeServer(server);
  if (!target) {
    return { ok: false, server, tools: [], error: `no native transport for server '${server}'` };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const session = sessionFor(target.url, target.headers);
    const result = await session.listTools(controller.signal);
    return { ok: true, server, tools: extractToolList(result), duration_ms: Date.now() - started };
  } catch (err) {
    const msg = controller.signal.aborted
      ? `native MCP tools/list timed out after ${DEFAULT_TIMEOUT_MS}ms`
      : errMsg(err);
    return { ok: false, server, tools: [], error: msg, duration_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** `tools/list` returns `{ tools: [{ name, description, inputSchema }] }`. Keep
 * name + description for display; drop schemas (the drawer doesn't render them). */
function extractToolList(result: unknown): NativeToolInfo[] {
  if (result && typeof result === 'object' && Array.isArray((result as { tools?: unknown }).tools)) {
    return (result as { tools: Array<Record<string, unknown>> }).tools
      .map((t) => ({
        name: typeof t.name === 'string' ? t.name : String(t.name ?? ''),
        description: typeof t.description === 'string' ? t.description : undefined,
      }))
      .filter((t) => t.name);
  }
  return [];
}

/** MCP tool results are `{ content: [{type:'text', text}], isError? }`. Flatten
 * the text parts; fall back to JSON for non-text content or odd shapes. */
function extractContentText(result: unknown): string {
  if (result && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)) {
    const content = (result as { content: Array<Record<string, unknown>> }).content;
    const parts = content
      .map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
      .filter(Boolean);
    if (parts.length > 0) return parts.join('\n');
  }
  return typeof result === 'string' ? result : JSON.stringify(result ?? null);
}

/** Parse a Streamable-HTTP response body, which is either a single JSON-RPC
 * object or an SSE stream whose `data:` lines carry JSON-RPC objects. We return
 * the first response object that carries a `result` or `error`. */
async function parseRpc(res: Response): Promise<JsonRpcResponse> {
  const ct = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (ct.includes('text/event-stream')) {
    let last: JsonRpcResponse | null = null;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload) as JsonRpcResponse;
        if (obj && (obj.result !== undefined || obj.error !== undefined)) return obj;
        last = obj;
      } catch {
        // skip keep-alive / comment frames
      }
    }
    if (last) return last;
    throw new Error('SSE response contained no JSON-RPC message');
  }
  if (!raw.trim()) return { jsonrpc: '2.0' };
  return JSON.parse(raw) as JsonRpcResponse;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
