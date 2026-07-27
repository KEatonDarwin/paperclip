const ANTHROPIC_MODELS_ENDPOINT = "https://api.anthropic.com/v1/models";
const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_MODELS_TIMEOUT_MS = 5000;

export interface DiscoveredModel {
  modelKey: string;
  displayName: string;
}

export async function fetchAnthropicModels(apiKey: string): Promise<DiscoveredModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(ANTHROPIC_MODELS_ENDPOINT, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: DiscoveredModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const id = (item as { id?: unknown }).id;
      const displayName = (item as { display_name?: unknown }).display_name;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      models.push({
        modelKey: id,
        displayName: typeof displayName === "string" && displayName.trim() ? displayName : id,
      });
    }
    return models;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
