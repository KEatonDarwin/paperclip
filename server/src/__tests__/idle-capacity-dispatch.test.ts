import { describe, expect, it, vi, beforeEach } from "vitest";

const { createJob, runJob, getIdleWorkerTypes, listAutonomyApprovedBacklog } = vi.hoisted(() => ({
  createJob: vi.fn(),
  runJob: vi.fn(),
  getIdleWorkerTypes: vi.fn(),
  listAutonomyApprovedBacklog: vi.fn(),
}));

vi.mock("../services/foreman.js", async () => {
  const actual = await vi.importActual<typeof import("../services/foreman.js")>("../services/foreman.js");
  return {
    ...actual,
    foremanService: () => ({ createJob, runJob }),
  };
});

vi.mock("../services/foreman-dispatch.js", () => ({
  paperclipAgentDispatcher: vi.fn(() => ({ dispatch: vi.fn(), poll: vi.fn() })),
  DEFAULT_WORKER_AGENTS: { claude: "agent-claude", codex: "agent-codex", auggie: "agent-auggie" },
}));

vi.mock("../services/idle-capacity.js", () => ({ getIdleWorkerTypes }));

vi.mock("../services/idle-capacity-backlog.js", async () => {
  const actual = await vi.importActual<typeof import("../services/idle-capacity-backlog.js")>(
    "../services/idle-capacity-backlog.js",
  );
  return { ...actual, listAutonomyApprovedBacklog };
});

import { tickIdleCapacityDispatch } from "../services/idle-capacity-dispatch.js";

const baseConfig = { companyId: "company-1", foremanProjectId: "11111111-1111-1111-1111-111111111111" };

function backlogItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    issueId: "issue-1",
    identifier: "DAR-9001",
    title: "Do the thing",
    description: "details",
    status: "backlog",
    priority: "medium",
    createdAt: new Date(),
    repoPath: "/tmp/some-repo",
    ...overrides,
  };
}

describe("tickIdleCapacityDispatch", () => {
  beforeEach(() => {
    createJob.mockReset().mockResolvedValue({ job: { id: "job-1", status: "planning" }, tasks: [] });
    runJob.mockReset().mockResolvedValue(undefined);
    getIdleWorkerTypes.mockReset();
    listAutonomyApprovedBacklog.mockReset();
  });

  it("returns [] when nothing is idle", async () => {
    getIdleWorkerTypes.mockResolvedValue([]);
    listAutonomyApprovedBacklog.mockResolvedValue([backlogItem()]);
    expect(await tickIdleCapacityDispatch({} as never, baseConfig)).toEqual([]);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("returns [] when the approved backlog is empty", async () => {
    getIdleWorkerTypes.mockResolvedValue(["claude"]);
    listAutonomyApprovedBacklog.mockResolvedValue([]);
    expect(await tickIdleCapacityDispatch({} as never, baseConfig)).toEqual([]);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("dispatches one job per idle worker_type, oldest-unclaimed-item first", async () => {
    getIdleWorkerTypes.mockResolvedValue(["claude", "codex"]);
    listAutonomyApprovedBacklog.mockResolvedValue([
      backlogItem({ issueId: "issue-1", identifier: "DAR-9001" }),
      backlogItem({ issueId: "issue-2", identifier: "DAR-9002" }),
    ]);

    const outcomes = await tickIdleCapacityDispatch({} as never, baseConfig);

    expect(outcomes).toEqual([
      { kind: "dispatched", workerType: "claude", issueIdentifier: "DAR-9001", job: { id: "job-1", status: "planning" } },
      { kind: "dispatched", workerType: "codex", issueIdentifier: "DAR-9002", job: { id: "job-1", status: "planning" } },
    ]);
    expect(createJob).toHaveBeenCalledTimes(2);
    expect(createJob).toHaveBeenNthCalledWith(
      1,
      "company-1",
      expect.objectContaining({ repo: "/tmp/some-repo", workerType: "claude", externalRef: "idle-capacity:DAR-9001" }),
    );
    expect(runJob).toHaveBeenCalledTimes(2);
  });

  it("stops once the backlog runs out, even if more providers are idle", async () => {
    getIdleWorkerTypes.mockResolvedValue(["claude", "codex", "auggie"]);
    listAutonomyApprovedBacklog.mockResolvedValue([backlogItem()]);

    const outcomes = await tickIdleCapacityDispatch({} as never, baseConfig);
    expect(outcomes).toHaveLength(1);
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it("skips (doesn't dispatch) a backlog item with no resolvable repoPath", async () => {
    getIdleWorkerTypes.mockResolvedValue(["claude"]);
    listAutonomyApprovedBacklog.mockResolvedValue([backlogItem({ repoPath: null })]);

    const outcomes = await tickIdleCapacityDispatch({} as never, baseConfig);
    expect(outcomes).toEqual([{ kind: "skipped_no_repo", workerType: "claude", issueIdentifier: "DAR-9001" }]);
    expect(createJob).not.toHaveBeenCalled();
  });
});
