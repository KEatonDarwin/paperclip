// Augment (auggie) model catalog discovery for the per-thread selector.
//
// The static `auggie` adapter in agent.ts only carries a single {id:'default'}
// entry — Augment's real model shelf lives in the auggie CLI, not in our code.
// This module runs `auggie model list` on demand, parses it, and caches the
// result (5-min TTL) so the cockpit's provider/model dropdown shows the full
// shelf (Prism, Fable 5, Opus 4.8, Sonnet 5, GPT tiers, …) instead of just
// "Default". Mirrors the fix made on the Paperclip server side
// (packages/adapters/auggie-local/src/server/models.ts).
//
// NO API KEYS — this shells out to the local `auggie` CLI on subscription/login
// auth, same as every other model invocation in the stack.
import { spawn } from 'node:child_process';

export interface AuggieModel {
  id: string;
  label: string;
}

const DEFAULT_MODELS: AuggieModel[] = [{ id: 'default', label: 'Default' }];
const AUGGIE_BIN = process.env.AUGGIE_BIN?.trim() || 'auggie';
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: AuggieModel[] | null = null;
let cacheExpiry = 0;
let inFlight: Promise<AuggieModel[]> | null = null;

// Parse `auggie model list` text output. Each model line looks like:
//   - Opus 4.8 [opus4.8]
//       Great for complex, multi-step agentic tasks
function parseAuggieModelList(stdout: string): AuggieModel[] {
  const models: AuggieModel[] = [];
  const idPattern = /^\s*-\s+(.+?)\s+\[([^\]]+)\]/;
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(idPattern);
    if (match) {
      const label = match[1].trim();
      const id = match[2].trim();
      if (id) models.push({ id, label: label || id });
    }
  }
  return models;
}

function runAuggieModelList(): Promise<AuggieModel[]> {
  return new Promise((resolve) => {
    // Ensure auggie's install dir is on PATH even under a bare service env
    // (same non-interactive-PATH gotcha as the usage pollers / tag generator).
    const env = { ...process.env };
    const extraPaths = ['/home/kevin/.npm-global/bin', '/home/kevin/.local/bin'];
    env.PATH = [...extraPaths, env.PATH ?? ''].filter(Boolean).join(':');

    let stdout = '';
    let settled = false;
    const done = (models: AuggieModel[]) => {
      if (!settled) {
        settled = true;
        resolve(models);
      }
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(AUGGIE_BIN, ['model', 'list'], { env });
    } catch {
      done([]);
      return;
    }

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
      done([]);
    }, 15_000);

    proc.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.on('error', () => { clearTimeout(timer); done([]); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) done(parseAuggieModelList(stdout));
      else done([]);
    });
  });
}

// Discover Augment's model shelf on demand. Returns the cached list if fresh;
// otherwise spawns `auggie model list` (deduped via an in-flight guard). Only a
// non-empty result is cached, so a transient CLI failure just retries next call.
// Always returns at least the {default} fallback so the selector never empties.
export async function getAuggieModels(): Promise<AuggieModel[]> {
  const now = Date.now();
  if (cached && now < cacheExpiry) return cached;

  if (!inFlight) {
    inFlight = runAuggieModelList().finally(() => { inFlight = null; });
  }
  const discovered = await inFlight;
  if (discovered.length > 0) {
    cached = discovered;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return cached;
  }
  // Discovery failed — serve the last good cache if we have one, else default.
  return cached ?? DEFAULT_MODELS;
}

export function resetAuggieModelsCache(): void {
  cached = null;
  cacheExpiry = 0;
}
