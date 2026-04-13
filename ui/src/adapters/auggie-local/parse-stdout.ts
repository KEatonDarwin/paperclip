import type { TranscriptEntry } from "../types";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseAuggieLocalStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "result") {
    const isError = parsed.is_error === true;
    const text = asString(parsed.result).trim();
    if (isError) {
      return [{ kind: "stderr", ts, text: text || "auggie returned an error" }];
    }
    return [{
      kind: "result",
      ts,
      text,
      inputTokens: 0,
      outputTokens: asNumber(parsed.num_turns),
      cachedTokens: 0,
      costUsd: 0,
      subtype: "success",
      isError: false,
      errors: [],
    }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
