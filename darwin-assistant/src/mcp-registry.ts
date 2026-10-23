import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Powers the cockpit's MCP Connection Manager pane (DAR-676 / DAR-677 Phase 3).
// The source of truth for "which MCP servers can JARVIS reach and are they up"
// is the same `claude` CLI config the MCP bridge (src/tools/mcp.ts) shells out
// to. Rather than maintain a second parallel registry, we read the live view
// from `claude mcp list` and normalize it into the shape the cockpit expects.

const CLAUDE_BIN = process.env.JARVIS_CLAUDE_BIN || '/home/kevin/.local/bin/claude';
const LIST_TIMEOUT_MS = Number(process.env.JARVIS_MCP_LIST_TIMEOUT_MS || 30_000);
// `claude mcp list` runs a live health probe per server, so it is not free.
// Cache briefly so a dashboard that polls / re-renders doesn't stampede it.
const CACHE_TTL_MS = Number(process.env.JARVIS_MCP_LIST_CACHE_MS || 20_000);

export type McpStatus = 'connected' | 'disconnected' | 'needs_auth' | 'error';
export type McpTransport = 'HTTP' | 'SSE' | 'stdio';
export type McpAuthType = 'none' | 'bearer' | 'oauth';

export interface McpServerInfo {
  id: string;
  name: string;
  url: string;
  transport: McpTransport;
  status: McpStatus;
  auth_type: McpAuthType;
  // Live per-server tool enumeration is deferred (it requires a per-server
  // introspection round-trip). null = "not introspected", rendered as "—".
  tool_count: number | null;
  tools: string[];
  error_message?: string;
}

export interface McpServerListResult {
  servers: McpServerInfo[];
  source: 'claude_cli';
  checked_at: string;
  stale: boolean;
  error?: string;
}

let cache: { result: McpServerListResult; at: number } | null = null;

function slug(name: string): string {
  return `srv_${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

function classifyStatus(marker: string): McpStatus {
  const m = marker.toLowerCase();
  if (m.includes('connected') || m.includes('✔') || m.includes('✓')) return 'connected';
  if (m.includes('need') && m.includes('auth')) return 'needs_auth';
  if (m.includes('auth')) return 'needs_auth';
  if (m.includes('fail') || m.includes('error') || m.includes('✗') || m.includes('✘')) return 'error';
  if (m.includes('disconnect')) return 'disconnected';
  return 'error';
}

// claude.ai-hosted connectors are OAuth; smarty-pants is a bearer HTTP server.
// Best-effort classification for display only.
function classifyAuth(name: string, url: string): McpAuthType {
  const n = name.toLowerCase();
  if (n.startsWith('claude.ai') || url.includes('.claude.com') || url.includes('mcp.lovable.dev') || url.includes('mcp.supabase.com') || url.includes('mcp.slack.com') || url.includes('mcp.context7.com') || url.includes('googleapis.com') || url.includes('mcp.sentry.dev')) {
    return 'oauth';
  }
  if (url.includes('thedarwinhub.com')) return 'bearer';
  return 'none';
}

/**
 * Parse a line of `claude mcp list`. Expected forms:
 *   "claude.ai Lovable: https://mcp.lovable.dev - ✔ Connected"
 *   "smarty-pants: https://mcp.thedarwinhub.com/mcp/kevin-connected (HTTP) - ✔ Connected"
 *   "claude.ai Gmail: https://.../mcp/v1 - ! Needs authentication"
 * Returns null for non-server lines (headers, blank lines).
 */
export function parseMcpListLine(line: string): McpServerInfo | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('Checking') || trimmed.toLowerCase().startsWith('no mcp')) return null;

  // Split "name: rest" on the first colon that is followed by a URL/command.
  const colon = trimmed.indexOf(': ');
  if (colon === -1) return null;
  const name = trimmed.slice(0, colon).trim();
  let rest = trimmed.slice(colon + 2).trim();
  if (!name || !rest) return null;

  // Status is after the final " - ".
  const dashIdx = rest.lastIndexOf(' - ');
  let statusText = '';
  if (dashIdx !== -1) {
    statusText = rest.slice(dashIdx + 3).trim();
    rest = rest.slice(0, dashIdx).trim();
  }

  // Optional "(TRANSPORT)" suffix on the target.
  let transport: McpTransport = 'HTTP';
  const transportMatch = rest.match(/\(([^)]+)\)\s*$/);
  if (transportMatch) {
    const t = transportMatch[1].trim().toUpperCase();
    if (t === 'SSE') transport = 'SSE';
    else if (t === 'STDIO') transport = 'stdio';
    else transport = 'HTTP';
    rest = rest.slice(0, transportMatch.index).trim();
  }

  const url = rest;
  if (!/^https?:\/\//i.test(url)) {
    // stdio servers list a command rather than a URL.
    transport = 'stdio';
  }

  const status = statusText ? classifyStatus(statusText) : 'error';
  const info: McpServerInfo = {
    id: slug(name),
    name,
    url,
    transport,
    status,
    auth_type: classifyAuth(name, url),
    tool_count: null,
    tools: [],
  };
  if (status !== 'connected' && statusText) info.error_message = statusText;
  return info;
}

export function parseMcpList(stdout: string): McpServerInfo[] {
  return stdout
    .split('\n')
    .map((l) => parseMcpListLine(l))
    .filter((s): s is McpServerInfo => s !== null);
}

/** Fetch the live MCP server list, cached for CACHE_TTL_MS. */
export async function listMcpServers(force = false): Promise<McpServerListResult> {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) {
    return { ...cache.result, stale: false };
  }

  try {
    const { stdout } = await execFileAsync(CLAUDE_BIN, ['mcp', 'list'], {
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env },
    });
    const result: McpServerListResult = {
      servers: parseMcpList(stdout),
      source: 'claude_cli',
      checked_at: new Date().toISOString(),
      stale: false,
    };
    cache = { result, at: now };
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // On failure, serve the last good snapshot (marked stale) if we have one.
    if (cache) {
      return { ...cache.result, stale: true, error: message };
    }
    return {
      servers: [],
      source: 'claude_cli',
      checked_at: new Date().toISOString(),
      stale: true,
      error: message,
    };
  }
}

/** Force a fresh probe (used by the "reconnect / refresh" action). */
export async function refreshMcpServers(): Promise<McpServerListResult> {
  cache = null;
  return listMcpServers(true);
}
