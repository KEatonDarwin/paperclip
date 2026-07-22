// Idle-capacity detection for the Foreman idle-capacity trigger (DAR-712).
//
// Wraps fetchAllQuotaWindows() (DAR-696) with an "idle enough to spend on autonomous
// work" threshold, then maps each provider back to the Foreman worker_type that would
// consume it (see DEFAULT_WORKER_AGENTS in foreman-dispatch.ts). This is the missing
// "is provider X idle" abstraction the quota-windows endpoint doesn't provide on its
// own (that endpoint only reports raw used-percent per window).
//
// Augment (auggie_local) has no quota adapter anywhere in the codebase today - it is
// always reported ok:false/idle:false here rather than guessed at with a heuristic.
// Anyone routing autonomous work to Augment needs to build that adapter first.

import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { fetchAllQuotaWindows } from "./quota-windows.js";

export const WORKER_TYPE_BY_ADAPTER: Record<string, string> = {
  claude_local: "claude",
  codex_local: "codex",
  auggie_local: "auggie",
};

export const DEFAULT_IDLE_THRESHOLD_PERCENT = 70;

export interface ProviderHeadroom {
  /** adapter type, e.g. "claude_local" */
  adapterType: string;
  /** Foreman worker_type this maps to (see DEFAULT_WORKER_AGENTS), null if unmapped */
  workerType: string | null;
  /** true when a quota signal was fetched successfully */
  ok: boolean;
  /** true when every reported window is under the threshold */
  idle: boolean;
  reason: string;
  windows: QuotaWindow[];
}

// fetchAllQuotaWindows reports provider slugs (anthropic/openai), not adapter types
// (see quota-windows.ts's providerSlugForAdapterType) - invert that mapping here.
function adapterTypeForProvider(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "claude_local";
    case "openai":
      return "codex_local";
    default:
      return provider;
  }
}

/** True only when every window with a reported usedPercent is under the threshold. A provider
 * with no usable windows at all is treated as NOT idle - absence of a signal is not a green light. */
export function isWindowSetIdle(windows: QuotaWindow[], thresholdPercent: number): boolean {
  const measured = windows.filter((w) => w.usedPercent != null);
  if (measured.length === 0) return false;
  return measured.every((w) => (w.usedPercent as number) < thresholdPercent);
}

function headroomForResult(result: ProviderQuotaResult, thresholdPercent: number): ProviderHeadroom {
  const adapterType = adapterTypeForProvider(result.provider);
  const workerType = WORKER_TYPE_BY_ADAPTER[adapterType] ?? null;

  if (!result.ok) {
    return {
      adapterType,
      workerType,
      ok: false,
      idle: false,
      reason: result.error ?? "quota fetch failed",
      windows: [],
    };
  }

  const idle = isWindowSetIdle(result.windows, thresholdPercent);
  return {
    adapterType,
    workerType,
    ok: true,
    idle,
    reason: idle
      ? `all reported windows under ${thresholdPercent}% used`
      : `at least one window at/above ${thresholdPercent}% used, or no usable window signal`,
    windows: result.windows,
  };
}

/**
 * Per-provider idle/headroom read, keyed to the Foreman worker_type each provider drives.
 * Includes an explicit auggie_local entry (always ok:false) when no adapter reported one,
 * so the Augment tracking gap is visible to callers instead of silently absent.
 */
export async function getProviderHeadroom(
  opts: { idleThresholdPercent?: number } = {},
): Promise<ProviderHeadroom[]> {
  const thresholdPercent = opts.idleThresholdPercent ?? DEFAULT_IDLE_THRESHOLD_PERCENT;
  const results = await fetchAllQuotaWindows();
  const headroom = results.map((result) => headroomForResult(result, thresholdPercent));

  if (!headroom.some((h) => h.adapterType === "auggie_local")) {
    headroom.push({
      adapterType: "auggie_local",
      workerType: WORKER_TYPE_BY_ADAPTER.auggie_local ?? "auggie",
      ok: false,
      idle: false,
      reason: "no usage/quota adapter implemented for Augment (auggie_local) yet",
      windows: [],
    });
  }

  return headroom;
}

/** Foreman worker_types currently idle enough to dispatch autonomous work to. */
export async function getIdleWorkerTypes(
  opts: { idleThresholdPercent?: number } = {},
): Promise<string[]> {
  const headroom = await getProviderHeadroom(opts);
  return headroom.filter((h) => h.ok && h.idle && h.workerType).map((h) => h.workerType as string);
}
