import type { CreateConfigValues } from "../types";

export function buildOllamaLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.baseUrl = v.url;
  if (v.model) ac.model = v.model;
  if (v.maxTurnsPerRun) ac.maxTurns = v.maxTurnsPerRun;
  return ac;
}
