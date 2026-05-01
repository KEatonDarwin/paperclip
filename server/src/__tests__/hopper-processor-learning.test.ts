import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Claude CLI via child_process
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

const mockStSvc = {
  getById: vi.fn(),
  listThreads: vi.fn(),
  update: vi.fn(),
  addThread: vi.fn(),
};
vi.mock("../services/scheduled-tasks.js", () => ({
  scheduledTasksService: () => mockStSvc,
  scheduledTaskIdentifier: (n: number) => `SCH-${n}`,
}));

// hopperService still needs to be mockable for the software path
vi.mock("../services/hopper.js", () => ({
  hopperService: () => ({
    getById: vi.fn(),
    listThreads: vi.fn(),
    update: vi.fn(),
    addThread: vi.fn(),
  }),
}));

const mockPrefsSvc = {
  get: vi.fn(),
  set: vi.fn().mockResolvedValue(undefined),
  list: vi.fn(),
};
vi.mock("../services/hopper-preferences.js", () => ({
  hopperPreferencesService: () => mockPrefsSvc,
  prefKeyForKind: (kind: string) => `preferred_time_for_kind:${kind}`,
}));

vi.mock("../services/slack-dm.js", () => ({
  slackDm: () => ({ openChannel: vi.fn(), postMessage: vi.fn(), fetchReplies: vi.fn() }),
}));

import { hopperProcessor } from "../services/hopper-processor.js";

describe("hopperProcessor learning integration (scheduled tasks)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SLACK_BOT_TOKEN;
  });

  it("saves preferred_time_for_kind when task has explicit time preference", async () => {
    mockStSvc.getById.mockResolvedValue({
      id: "task-1",
      companyId: "co-1",
      userId: "user-1",
      requestText: "schedule my gym session early tomorrow",
      status: "pending",
      slackThreadTs: null,
    });
    mockStSvc.listThreads.mockResolvedValue([]);

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: JSON.stringify({
        kind: "task_personal",
        has_info: true,
        question: null,
        title: "Gym session",
        description: null,
        duration_minutes: 60,
        preferred_time_of_day: "early_morning",
        deadline: null,
      }) });
    });

    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});

    const processor = hopperProcessor({} as any);
    await processor.processScheduledTask("task-1");

    expect(mockPrefsSvc.set).toHaveBeenCalledWith(
      "co-1",
      "user-1",
      "preferred_time_for_kind:task_personal",
      "early_morning",
      "explicit",
    );
  });

  it("does not save preference when preferred_time_of_day is anytime", async () => {
    mockStSvc.getById.mockResolvedValue({
      id: "task-2",
      companyId: "co-1",
      userId: "user-1",
      requestText: "call dentist",
      status: "pending",
      slackThreadTs: null,
    });
    mockStSvc.listThreads.mockResolvedValue([]);

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: JSON.stringify({
        kind: "reminder",
        has_info: true,
        question: null,
        title: "Call dentist",
        description: null,
        duration_minutes: null,
        preferred_time_of_day: "anytime",
        deadline: null,
      }) });
    });

    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});

    const processor = hopperProcessor({} as any);
    await processor.processScheduledTask("task-2");

    expect(mockPrefsSvc.set).not.toHaveBeenCalled();
  });

  it("does not save preference when kind is null", async () => {
    mockStSvc.getById.mockResolvedValue({
      id: "task-3",
      companyId: "co-1",
      userId: "user-1",
      requestText: "something unclear",
      status: "pending",
      slackThreadTs: null,
    });
    mockStSvc.listThreads.mockResolvedValue([]);

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: JSON.stringify({
        kind: null,
        has_info: true,
        question: null,
        title: "Something",
        description: null,
        duration_minutes: 30,
        preferred_time_of_day: "morning",
        deadline: null,
      }) });
    });

    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});

    const processor = hopperProcessor({} as any);
    await processor.processScheduledTask("task-3");

    expect(mockPrefsSvc.set).not.toHaveBeenCalled();
  });

  it("transitions task to scheduled status when has_info is true", async () => {
    mockStSvc.getById.mockResolvedValue({
      id: "task-4",
      companyId: "co-1",
      userId: "user-1",
      requestText: "write Q2 report by Friday",
      status: "pending",
      slackThreadTs: null,
    });
    mockStSvc.listThreads.mockResolvedValue([]);

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: JSON.stringify({
        kind: "task_work",
        has_info: true,
        question: null,
        title: "Write Q2 report",
        description: "Quarterly report due Friday",
        duration_minutes: 120,
        preferred_time_of_day: "morning",
        deadline: "2026-05-02",
      }) });
    });

    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});

    const processor = hopperProcessor({} as any);
    await processor.processScheduledTask("task-4");

    expect(mockStSvc.update).toHaveBeenCalledWith(
      "task-4",
      expect.objectContaining({ status: "scheduled", title: "Write Q2 report", kind: "task_work" }),
    );
  });
});
