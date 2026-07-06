import type { AdapterModel } from "./types.js";
import { models as claudeFallbackModels } from "@paperclipai/adapter-claude-local";

const ANTHROPIC_MODELS_ENDPOINT = "https://api.anthropic.com/v1/models";
const ANTHROPIC_MODELS_TIMEOUT_MS = 5000;
// Cache for 24 hours — models don't change often.
const CLAUDE_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

function mergedWithFallback(fetched: AdapterModel[]): AdapterModel[] {
  const seen = new Set(fetched.map((m) => m.id));
  // Append any static fallbacks not already in the fetched list.
  const extra = claudeFallbackModels.filter((m) => !seen.has(m.id));
  return [...fetched, ...extra];
}

async function fetchAnthropicModels(apiKey: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_MODELS_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_MODELS_ENDPOINT, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || !id.startsWith("claude")) continue;
      const label = (item as { display_name?: unknown }).display_name;
      models.push({ id, label: typeof label === "string" ? label : id });
    }
    return models;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function listClaudeModels(): Promise<AdapterModel[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return claudeFallbackModels;

  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;

  const fetched = await fetchAnthropicModels(apiKey);
  if (fetched.length > 0) {
    const merged = mergedWithFallback(fetched);
    cached = { expiresAt: now + CLAUDE_MODELS_CACHE_TTL_MS, models: merged };
    return merged;
  }

  // Fetch failed — serve stale cache if available, else static fallback.
  return cached?.models ?? claudeFallbackModels;
}

export function resetClaudeModelsCacheForTests() {
  cached = null;
}

export function resetClaudeModelsCache() {
  cached = null;
}
