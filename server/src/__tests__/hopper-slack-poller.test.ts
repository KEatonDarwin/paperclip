import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetchReplies = vi.fn();
const mockOpenChannel = vi.fn();
const mockPostMessage = vi.fn();

vi.mock("../services/slack-dm.js", () => ({
  slackDm: () => ({
    openChannel: mockOpenChannel,
    postMessage: mockPostMessage,
    fetchReplies: mockFetchReplies,
  }),
}));

const mockStSvc = {
  listPendingSlackTasks: vi.fn(),
  addThread: vi.fn(),
  update: vi.fn(),
};
const mockProcessor = { processScheduledTask: vi.fn() };

vi.mock("../services/scheduled-tasks.js", () => ({
  scheduledTasksService: () => mockStSvc,
  scheduledTaskIdentifier: (n: number) => `SCH-${n}`,
}));

vi.mock("../services/hopper-processor.js", () => ({
  hopperProcessor: () => mockProcessor,
}));

import { hopperSlackPoller } from "../services/hopper-slack-poller.js";

describe("hopperSlackPoller (v2 — scheduled_tasks)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_HOPPER_USER_ID = "U123";
  });

  it("does nothing when SLACK_BOT_TOKEN is not set", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const poller = hopperSlackPoller({} as any);
    await poller.tick();
    expect(mockStSvc.listPendingSlackTasks).not.toHaveBeenCalled();
  });

  it("does nothing when no pending tasks", async () => {
    mockStSvc.listPendingSlackTasks.mockResolvedValue([]);
    const poller = hopperSlackPoller({} as any);
    await poller.tick();
    expect(mockFetchReplies).not.toHaveBeenCalled();
  });

  it("fetches replies and re-runs processor on new user message", async () => {
    mockStSvc.listPendingSlackTasks.mockResolvedValue([
      { id: "task-1", companyId: "co-1", slackThreadTs: "1000.000" },
    ]);
    mockOpenChannel.mockResolvedValue("D-channel-1");
    mockFetchReplies.mockResolvedValue([
      { type: "message", ts: "1001.000", text: "tomorrow morning", user: "U1" },
    ]);
    mockStSvc.addThread.mockResolvedValue({});
    mockProcessor.processScheduledTask.mockResolvedValue(undefined);

    const poller = hopperSlackPoller({} as any);
    await poller.tick();

    expect(mockStSvc.addThread).toHaveBeenCalledWith({
      taskId: "task-1",
      authorType: "user",
      authorId: "U123",
      body: "tomorrow morning",
    });
    expect(mockProcessor.processScheduledTask).toHaveBeenCalledWith("task-1");
  });

  it("skips already-seen replies on second tick", async () => {
    mockStSvc.listPendingSlackTasks.mockResolvedValue([
      { id: "task-1", companyId: "co-1", slackThreadTs: "1000.000" },
    ]);
    mockOpenChannel.mockResolvedValue("D-channel-1");
    mockFetchReplies.mockResolvedValueOnce([
      { type: "message", ts: "1001.000", text: "tomorrow morning", user: "U1" },
    ]);
    mockFetchReplies.mockResolvedValueOnce([]);

    mockStSvc.addThread.mockResolvedValue({});
    mockProcessor.processScheduledTask.mockResolvedValue(undefined);

    const poller = hopperSlackPoller({} as any);
    await poller.tick();
    await poller.tick();

    expect(mockStSvc.addThread).toHaveBeenCalledTimes(1);
    expect(mockProcessor.processScheduledTask).toHaveBeenCalledTimes(1);
  });
});
