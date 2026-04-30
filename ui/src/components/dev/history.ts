import type { HttpMethod } from "./HttpBadges";

export interface HistoryEntry {
  id: string;
  timestamp: number;
  toolName: string;
  method: HttpMethod;
  url: string;
  status: number | null;
  durationMs: number | null;
  responseBody: unknown;
  error: string | null;
}

export function loadHistory(storageKey: string): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? "[]") as HistoryEntry[];
  } catch {
    return [];
  }
}

export function saveHistory(storageKey: string, entries: HistoryEntry[], max = 20) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(entries.slice(0, max)));
  } catch {
    // ignore quota errors
  }
}

export function loadConfig(storageKey: string, defaults: { baseUrl: string }): { baseUrl: string; apiToken: string } {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, string>;
    return { baseUrl: stored.baseUrl || defaults.baseUrl, apiToken: stored.apiToken || "" };
  } catch {
    return { baseUrl: defaults.baseUrl, apiToken: "" };
  }
}

export function saveConfig(storageKey: string, config: { baseUrl: string; apiToken: string }) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(config));
  } catch {
    // ignore
  }
}
