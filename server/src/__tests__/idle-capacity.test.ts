import { describe, expect, it, vi } from "vitest";

vi.mock("../services/quota-windows.js", () => ({
  fetchAllQuotaWindows: vi.fn(),
}));

import { fetchAllQuotaWindows } from "../services/quota-windows.js";
import {
  getIdleWorkerTypes,
  getProviderHeadroom,
  isWindowSetIdle,
} from "../services/idle-capacity.js";

const mockFetch = vi.mocked(fetchAllQuotaWindows);

describe("isWindowSetIdle", () => {
  it("is not idle with no usable windows", () => {
    expect(isWindowSetIdle([], 70)).toBe(false);
    expect(
      isWindowSetIdle([{ label: "5h", usedPercent: null, resetsAt: null, valueLabel: null }], 70),
    ).toBe(false);
  });

  it("is idle only when every measured window is under the threshold", () => {
    expect(
      isWindowSetIdle(
        [
          { label: "5h", usedPercent: 10, resetsAt: null, valueLabel: null },
          { label: "7d", usedPercent: 65, resetsAt: null, valueLabel: null },
        ],
        70,
      ),
    ).toBe(true);
    expect(
      isWindowSetIdle(
        [
          { label: "5h", usedPercent: 10, resetsAt: null, valueLabel: null },
          { label: "7d", usedPercent: 90, resetsAt: null, valueLabel: null },
        ],
        70,
      ),
    ).toBe(false);
  });
});

describe("getProviderHeadroom", () => {
  it("maps provider slugs to Foreman worker_types and flags idle providers", async () => {
    mockFetch.mockResolvedValue([
      {
        provider: "anthropic",
        ok: true,
        windows: [{ label: "5h", usedPercent: 20, resetsAt: null, valueLabel: null }],
      },
      {
        provider: "openai",
        ok: true,
        windows: [{ label: "5h", usedPercent: 95, resetsAt: null, valueLabel: null }],
      },
    ]);

    const headroom = await getProviderHeadroom({ idleThresholdPercent: 70 });
    const claude = headroom.find((h) => h.adapterType === "claude_local")!;
    const codex = headroom.find((h) => h.adapterType === "codex_local")!;
    const auggie = headroom.find((h) => h.adapterType === "auggie_local")!;

    expect(claude.workerType).toBe("claude");
    expect(claude.idle).toBe(true);
    expect(codex.workerType).toBe("codex");
    expect(codex.idle).toBe(false);
    expect(auggie.ok).toBe(false);
    expect(auggie.reason).toMatch(/no usage\/quota adapter/);
  });

  it("treats a failed fetch as not idle", async () => {
    mockFetch.mockResolvedValue([{ provider: "anthropic", ok: false, error: "timeout", windows: [] }]);
    const headroom = await getProviderHeadroom();
    expect(headroom.find((h) => h.adapterType === "claude_local")?.idle).toBe(false);
  });
});

describe("getIdleWorkerTypes", () => {
  it("returns only worker_types that are ok and idle", async () => {
    mockFetch.mockResolvedValue([
      {
        provider: "anthropic",
        ok: true,
        windows: [{ label: "5h", usedPercent: 5, resetsAt: null, valueLabel: null }],
      },
      {
        provider: "openai",
        ok: true,
        windows: [{ label: "5h", usedPercent: 80, resetsAt: null, valueLabel: null }],
      },
    ]);

    expect(await getIdleWorkerTypes()).toEqual(["claude"]);
  });
});
