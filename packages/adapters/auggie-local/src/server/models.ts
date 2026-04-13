import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

/**
 * Parses `auggie model list` text output.
 *
 * Example output:
 * Available models:
 *  - Haiku 4.5 [haiku4.5]
 *      Fast and efficient responses
 *  - Sonnet 4.6 [sonnet4.6]
 *      Latest Sonnet model with improved capabilities
 */
function parseAuggieModelList(stdout: string): Array<{ id: string; label: string }> {
  const models: Array<{ id: string; label: string }> = [];
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

let cachedModels: Array<{ id: string; label: string }> | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function discoverAuggieModels(opts: {
  command: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<Array<{ id: string; label: string }>> {
  const now = Date.now();
  if (cachedModels && now < cacheExpiry) return cachedModels;

  try {
    const proc = await runChildProcess(
      `auggie-models-${now}`,
      opts.command,
      ["model", "list"],
      {
        cwd: opts.cwd,
        env: opts.env,
        timeoutSec: 15,
        graceSec: 5,
        onLog: async () => {},
      },
    );

    if ((proc.exitCode ?? 1) === 0 && proc.stdout.trim()) {
      const models = parseAuggieModelList(proc.stdout);
      if (models.length > 0) {
        cachedModels = models;
        cacheExpiry = now + CACHE_TTL_MS;
        return models;
      }
    }
  } catch {
    // Discovery is best-effort
  }
  return [];
}

export async function listAuggieModels(): Promise<Array<{ id: string; label: string }>> {
  // Return cached models or empty list; full discovery runs from execute context
  return cachedModels ?? [];
}

export function resetAuggieModelsCacheForTests(): void {
  cachedModels = null;
  cacheExpiry = 0;
}
