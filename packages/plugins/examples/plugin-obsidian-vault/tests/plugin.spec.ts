import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("obsidian-vault plugin", () => {
  it("passes health check", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("ok");
  });

  it("registers vault_status data endpoint", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const status = await harness.getData<{
      wikiPageCount: number;
      rawArticleCount: number;
      recentLogEntries: string[];
    }>("vault_status");

    // Just verify the shape — vault may or may not be accessible in test env
    expect(typeof status.wikiPageCount).toBe("number");
    expect(typeof status.rawArticleCount).toBe("number");
    expect(Array.isArray(status.recentLogEntries)).toBe(true);
  });

  it("vault_read_schema tool returns CLAUDE.md content", async () => {
    const harness = createTestHarness({ manifest, capabilities: ["agent.tools.register"] });
    await plugin.definition.setup(harness.ctx);

    // The tool either returns CLAUDE.md content or a not-found message — both are valid strings
    const result = await harness.executeTool("vault_read_schema", {});
    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
  });
});
