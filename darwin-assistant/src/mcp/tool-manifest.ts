// Static tool-manifest cache (2026-10-18) — the "never drop" floor for the
// native-MCP tool list.
//
// The per-spawn persona-tools-server reads its tools/list surface over loopback
// HTTP (GET /internal/tools). That call can stall: dozens of claude spawns can
// land at once, and if the event loop is busy the fetch hits its abort timeout
// and the server returns `{ tools: [] }` — handing the model ZERO native tools
// for that whole turn, silently. That is the second way tools "drop" (the first,
// ToolSearch deferral, is fixed in agent.ts).
//
// The manifest is STATIC: GET /internal/tools is `ALL_TOOLS.map(...)` with no
// per-turn or per-persona filtering (api-v1.ts). So the main process writes it
// to a file once at boot, and the child reads that file FIRST — instant, no
// event-loop dependency, cannot stall. The loopback is kept only as a fallback
// for the brief window after boot before the file exists. A slightly stale list
// is impossible in practice (ALL_TOOLS is fixed at module load; a registry change
// requires a restart, which rewrites the file) and would still beat zero tools.
//
// This module is DEPENDENCY-FREE with respect to the app (no ../tools/index.js
// import): the writer takes the tool list as an argument. That keeps it safe for
// the persona-tools-server child to import without transitively opening jarvis.db
// (the same constraint that put the manifest behind loopback in the first place).

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface ManifestTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Where the cache lives. Overridable via env so a spawn and the writer agree
 *  even if TMPDIR ever differs between them; defaults to the shared tmpdir. */
export function toolManifestPath(): string {
  return process.env.JARVIS_TOOL_MANIFEST || join(tmpdir(), 'jarvis-tool-manifest.json');
}

/** Called once at server boot (index.ts) with ALL_TOOLS mapped to the manifest
 *  shape. Best-effort: a write failure just means the child falls back to the
 *  loopback, exactly as before this cache existed. */
export function writeToolManifest(tools: ManifestTool[]): string | null {
  const path = toolManifestPath();
  try {
    writeFileSync(path, JSON.stringify({ tools }), { encoding: 'utf8', mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

/** Read the cached manifest. Returns null (never throws, never an empty list)
 *  so the child can cleanly fall through to the loopback. */
export function readToolManifest(): ManifestTool[] | null {
  try {
    const body = JSON.parse(readFileSync(toolManifestPath(), 'utf8')) as { tools?: ManifestTool[] };
    return Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : null;
  } catch {
    return null;
  }
}
