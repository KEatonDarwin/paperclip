// Codex (OpenAI) model catalog discovery for the per-thread selector.
//
// The static `codex` adapter in agent.ts carried a hardcoded 3-model list that
// went stale (it predated GPT-6-Astra and still offered retired 5.4 tiers).
// Codex's real shelf lives behind the CLI's app-server JSON-RPC: `model/list`
// returns the live, account-scoped models (id, displayName, hidden, reasoning
// efforts). This module speaks that RPC on demand and caches the result
// (5-min TTL) so the cockpit dropdown tracks OpenAI's shelf the same way the
// auggie/devin catalogs track theirs.
//
// NO API KEYS — `codex app-server` runs on Kevin's ChatGPT/Codex login auth,
// the same transport the codex usage poller already uses.
import { spawn } from 'node:child_process';

export interface CodexModel {
  id: string;
  label: string;
}

const CODEX_BIN = process.env.CODEX_BIN?.trim() || 'codex';
const CACHE_TTL_MS = 5 * 60 * 1000;
const RPC_TIMEOUT_MS = 15_000;

let cached: CodexModel[] | null = null;
let cacheExpiry = 0;
let inFlight: Promise<CodexModel[]> | null = null;

interface RpcModelEntry {
  id?: unknown;
  displayName?: unknown;
  hidden?: unknown;
}

function runCodexModelList(): Promise<CodexModel[]> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    const extraPaths = ['/home/kevin/.local/bin', '/usr/bin'];
    env.PATH = [...extraPaths, env.PATH ?? ''].filter(Boolean).join(':');
    delete env['OPENAI_API_KEY'];

    let settled = false;
    let proc: ReturnType<typeof spawn>;
    const done = (models: CodexModel[]) => {
      if (settled) return;
      settled = true;
      try { proc?.kill('SIGKILL'); } catch { /* noop */ }
      resolve(models);
    };

    try {
      proc = spawn(CODEX_BIN, ['app-server'], { env });
    } catch {
      resolve([]);
      return;
    }

    const timer = setTimeout(() => done([]), RPC_TIMEOUT_MS);

    let buffer = '';
    proc.stdout?.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { data?: RpcModelEntry[] } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          // initialize acked — announce ready, then ask for the shelf.
          proc.stdin?.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
          proc.stdin?.write(JSON.stringify({ id: 2, method: 'model/list', params: {} }) + '\n');
        } else if (msg.id === 2) {
          clearTimeout(timer);
          const entries = Array.isArray(msg.result?.data) ? msg.result.data : [];
          const models: CodexModel[] = [];
          for (const entry of entries) {
            if (entry?.hidden === true) continue;
            const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
            if (!id) continue;
            const label = typeof entry?.displayName === 'string' && entry.displayName.trim()
              ? entry.displayName.trim()
              : id;
            models.push({ id, label });
          }
          done(models);
        }
      }
    });
    proc.on('error', () => { clearTimeout(timer); done([]); });
    proc.on('close', () => { clearTimeout(timer); done([]); });

    proc.stdin?.write(JSON.stringify({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'darwin-assistant', title: 'JARVIS', version: '1.0' } },
    }) + '\n');
  });
}

// Discover Codex's model shelf on demand. Cached 5 min; only a non-empty
// result is cached so a transient failure retries on the next call. Returns []
// on total failure — the caller keeps the adapter's existing list in that case.
export async function getCodexModels(): Promise<CodexModel[]> {
  const now = Date.now();
  if (cached && now < cacheExpiry) return cached;

  if (!inFlight) {
    inFlight = runCodexModelList().finally(() => { inFlight = null; });
  }
  const discovered = await inFlight;
  if (discovered.length > 0) {
    cached = discovered;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return cached;
  }
  return cached ?? [];
}

export function resetCodexModelsCache(): void {
  cached = null;
  cacheExpiry = 0;
}
