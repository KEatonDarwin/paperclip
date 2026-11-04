// Memory meter (lean/harness-gaps, 2026-10-17). How big the memory is, against its budget, so
// JARVIS sees it at write time and Kevin sees it on the health page — instead of the first sign
// being a watchdog breach after the fact (memory.md sat at 123KB against an 80KB contract).
//
// Budgets are the watchdog's (scripts/jarvis-watchdog.py sentinel_memory_bloat) — keep in sync:
//   memory.md 84,000 · memory/core.md 30,000 · each pack 25,000 · worker-core.md 15,000 bytes.
// Tokens are an estimate (bytes / 4) — good enough for a gauge, not a bill.
// Read-only and model-free; never throws to the caller.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CORE_MEMORY_REL, LEGACY_MEMORY_REL, PACKS_REL, VAULT_ROOT, memoryLayout, type MemoryLayout } from './memory-layout.js';

export const MEMORY_BUDGETS = {
  legacy: 84_000,
  core: 30_000,
  pack: 25_000,
  workerCore: 15_000,
} as const;

const WORKER_CORE_REL = 'agent-memory/jarvis/worker-core.md';
// At this share of budget the gauge turns amber; over 100% it is red.
const WARN_AT = 0.9;

export type MeterLevel = 'ok' | 'warn' | 'over' | 'missing';

export interface MeterFile {
  label: string;
  rel: string;
  bytes: number;
  tokens: number;
  budget: number;
  pct: number;
  level: MeterLevel;
  /** true = rides on every turn (memory.md or core.md); packs ride only when their topic comes up. */
  every_turn: boolean;
}

export interface MemoryMeter {
  layout: MemoryLayout;
  files: MeterFile[];
  /** What the main memory costs on a fresh prompt, in estimated tokens. */
  every_turn_tokens: number;
  level: MeterLevel;
  /** memory.md size at each dated backup, oldest first, then now — the trend line. */
  trend: { date: string; bytes: number }[];
  headline: string;
}

export const estTokens = (bytes: number) => Math.round(bytes / 4);

export function budgetFor(rel: string): number {
  if (rel === CORE_MEMORY_REL) return MEMORY_BUDGETS.core;
  if (rel.startsWith(`${PACKS_REL}/`)) return MEMORY_BUDGETS.pack;
  if (rel === WORKER_CORE_REL) return MEMORY_BUDGETS.workerCore;
  return MEMORY_BUDGETS.legacy;
}

export function levelFor(bytes: number, budget: number): MeterLevel {
  if (bytes > budget) return 'over';
  if (bytes >= budget * WARN_AT) return 'warn';
  return 'ok';
}

function measure(label: string, rel: string, everyTurn: boolean, root = VAULT_ROOT): MeterFile {
  const budget = budgetFor(rel);
  let bytes = 0;
  let level: MeterLevel = 'missing';
  try {
    bytes = statSync(join(root, rel)).size;
    level = levelFor(bytes, budget);
  } catch { /* missing stays missing */ }
  return { label, rel, bytes, tokens: estTokens(bytes), budget, pct: Math.round((bytes / budget) * 100), level, every_turn: everyTurn };
}

/** memory.md.bak-YYYYMMDD[-tag] → a dated size series (one point per day, the last backup wins). */
function legacyTrend(root = VAULT_ROOT): { date: string; bytes: number }[] {
  const dir = join(root, 'agent-memory/jarvis');
  const byDate = new Map<string, number>();
  try {
    for (const f of readdirSync(dir).sort()) {
      const m = f.match(/^memory\.md\.bak-(?:[a-z0-9]+-)?(\d{4})(\d{2})(\d{2})/i);
      if (!m) continue;
      try { byDate.set(`${m[1]}-${m[2]}-${m[3]}`, statSync(join(dir, f)).size); } catch { /* skip */ }
    }
  } catch { return []; }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, bytes]) => ({ date, bytes }));
}

const RANK: Record<MeterLevel, number> = { ok: 0, warn: 1, over: 2, missing: 3 };

export function memoryMeter(): MemoryMeter {
  const layout = memoryLayout();
  const files: MeterFile[] = [];
  if (layout === 'core') {
    files.push(measure('Core memory', CORE_MEMORY_REL, true));
    let packs: string[] = [];
    try { packs = readdirSync(join(VAULT_ROOT, PACKS_REL)).filter((f) => f.endsWith('.md')).sort(); } catch { /* none */ }
    for (const f of packs) files.push(measure(`Pack: ${basename(f, '.md')}`, `${PACKS_REL}/${f}`, false));
  } else {
    files.push(measure('Memory', LEGACY_MEMORY_REL, true));
  }
  if (existsSync(join(VAULT_ROOT, WORKER_CORE_REL))) files.push(measure('Worker core', WORKER_CORE_REL, false));

  const main = files[0];
  const level = files.reduce<MeterLevel>((w, f) => (RANK[f.level] > RANK[w] ? f.level : w), 'ok');
  const trend = legacyTrend();
  const legacyNow = layout === 'single' ? main.bytes : measure('Memory', LEGACY_MEMORY_REL, false).bytes;
  if (legacyNow) trend.push({ date: 'now', bytes: legacyNow });

  const over = files.filter((f) => f.level === 'over').map((f) => f.label);
  const headline = main.level === 'missing'
    ? `${main.label} file is missing`
    : `${main.label} ${kb(main.bytes)} of ${kb(main.budget)} (${main.pct}%) · ~${main.tokens.toLocaleString()} tokens every fresh prompt`
      + (over.length ? ` · over budget: ${over.join(', ')}` : '');
  return { layout, files, every_turn_tokens: files.filter((f) => f.every_turn).reduce((n, f) => n + f.tokens, 0), level, trend, headline };
}

const kb = (b: number) => `${Math.round(b / 1000)}KB`;

/**
 * What write_memory hands back after a write, so the model sees the size it just created.
 * `warning` is set only when the file is at/over 90% of budget.
 */
export function writeReceipt(rel: string, bytes: number): { bytes: number; tokens: number; budget: number; pct: number; level: MeterLevel; warning?: string } {
  const budget = budgetFor(rel);
  const level = levelFor(bytes, budget);
  const pct = Math.round((bytes / budget) * 100);
  const out: { bytes: number; tokens: number; budget: number; pct: number; level: MeterLevel; warning?: string } =
    { bytes, tokens: estTokens(bytes), budget, pct, level };
  if (level === 'over') {
    out.warning = `Memory is ${kb(bytes)}, OVER its ${kb(budget)} budget (${pct}%). It rides on every fresh prompt — `
      + 'trim it now: archive finished sagas to agent-memory/jarvis/archive/, or move topic detail into a pack.';
  } else if (level === 'warn') {
    out.warning = `Memory is ${kb(bytes)} — ${pct}% of its ${kb(budget)} budget. Trim before adding more.`;
  }
  return out;
}
