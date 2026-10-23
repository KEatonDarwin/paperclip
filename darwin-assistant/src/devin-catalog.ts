// Devin (Windsurf/Cognition) model catalog discovery for the per-thread selector.
//
// The static `devin` adapter in agent.ts carries a small curated shortlist —
// Devin's real model shelf lives in the `devin` CLI (189 variants across 40
// families). This module runs `devin models list` on demand and parses the
// FAMILY-level ids (e.g. `claude-opus-5`, `gpt-5.6-sol`, `swe`) rather than every
// effort-tier variant, so the cockpit's model dropdown shows a clean ~40-item
// shelf instead of 189. Family ids are valid `--model` values (the CLI resolves
// the family to its default tier). Mirrors auggie-catalog.ts.
//
// NO API KEYS — this shells out to the local `devin` CLI on Windsurf/Devin
// subscription/login auth (credentials.toml), same as every other model
// invocation in the stack.
import { spawn } from 'node:child_process';

export interface DevinModel {
  id: string;
  label: string;
}

// Curated fallback if `devin models list` fails (a usable spread across tiers).
const DEFAULT_MODELS: DevinModel[] = [
  { id: 'adaptive', label: 'Adaptive (auto)' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
  { id: 'swe', label: 'SWE-1.7 Lightning (free)' },
];
const DEVIN_BIN = process.env.DEVIN_BIN?.trim() || '/home/kevin/.local/bin/devin';
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: DevinModel[] | null = null;
let cacheExpiry = 0;
let inFlight: Promise<DevinModel[]> | null = null;

// Parse `devin models list`. Family headers look like:
//   Claude Opus 5 (claude-opus-5)
//     aliases: opus
//     claude-opus-5-medium   Claude Opus 5 Medium  [1M context, ...]
// We keep only the family header lines: a non-indented line ending in "(id)".
// The parenthesized token is the model id; the text before it is the label.
function parseDevinModelList(stdout: string): DevinModel[] {
  const models: DevinModel[] = [];
  const seen = new Set<string>();
  const headerPattern = /^(\S.*?)\s+\(([a-z0-9][a-z0-9.\-]*)\)\s*$/;
  for (const line of stdout.split(/\r?\n/)) {
    // Family headers are not indented; variant/alias lines are.
    if (/^\s/.test(line)) continue;
    const match = line.match(headerPattern);
    if (match) {
      const label = match[1].trim();
      const id = match[2].trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        models.push({ id, label: label || id });
      }
    }
  }
  return models;
}

function runDevinModelList(): Promise<DevinModel[]> {
  return new Promise((resolve) => {
    // Ensure devin's install dir is on PATH even under a bare service env
    // (same non-interactive-PATH gotcha as the usage pollers / tag generator).
    const env = { ...process.env };
    const extraPaths = ['/home/kevin/.local/bin', '/home/kevin/.npm-global/bin'];
    env.PATH = [...extraPaths, env.PATH ?? ''].filter(Boolean).join(':');

    let stdout = '';
    let settled = false;
    const done = (models: DevinModel[]) => {
      if (!settled) {
        settled = true;
        resolve(models);
      }
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(DEVIN_BIN, ['models', 'list'], { env });
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
      if (code === 0 && stdout.trim()) done(parseDevinModelList(stdout));
      else done([]);
    });
  });
}

// Discover Devin's model shelf on demand. Returns the cached list if fresh;
// otherwise spawns `devin models list` (deduped via an in-flight guard). Only a
// non-empty result is cached, so a transient CLI failure just retries next call.
// Always returns at least the curated fallback so the selector never empties.
export async function getDevinModels(): Promise<DevinModel[]> {
  const now = Date.now();
  if (cached && now < cacheExpiry) return cached;

  if (!inFlight) {
    inFlight = runDevinModelList().finally(() => { inFlight = null; });
  }
  const discovered = await inFlight;
  if (discovered.length > 0) {
    cached = discovered;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return cached;
  }
  return cached ?? DEFAULT_MODELS;
}

export function resetDevinModelsCache(): void {
  cached = null;
  cacheExpiry = 0;
}
