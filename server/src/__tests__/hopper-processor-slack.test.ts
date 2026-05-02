import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOpenChannel = vi.fn();
const mockPostMessage = vi.fn();
const mockFetchReplies = vi.fn();

vi.mock("../services/slack-dm.js", () => ({
  slackDm: () => ({
    openChannel: mockOpenChannel,
    postMessage: mockPostMessage,
    fetchReplies: mockFetchReplies,
  }),
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

vi.mock("../services/hopper.js", () => ({
  hopperService: () => ({
    getById: vi.fn(),
    listThreads: vi.fn(),
    update: vi.fn(),
    addThread: vi.fn(),
  }),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, { stdout: JSON.stringify({
      has_info: false,
      question: "When do you need this done by?",
      tasks: [],
    }) });
  }),
}));

vi.mock("../services/hopper-preferences.js", () => ({
  hopperPreferencesService: () => ({ get: vi.fn(), set: vi.fn(), list: vi.fn() }),
  prefKeyForKind: (kind: string) => `preferred_time_for_kind:${kind}`,
}));

import { hopperProcessor } from "../services/hopper-processor.js";

describe("hopperProcessor Slack integration (scheduled tasks)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_HOPPER_USER_ID = "U123";
    mockStSvc.getById.mockResolvedValue({
      id: "task-1",
      companyId: "co-1",
      requestText: "take out the trash",
      status: "pending",
      slackThreadTs: null,
    });
    mockStSvc.listThreads.mockResolvedValue([]);
    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});
    mockOpenChannel.mockResolvedValue("D-channel-1");
    mockPostMessage.mockResolvedValue("1234567890.000001");
  });

  it("sends Slack DM when scheduled task hits needs-info path", async () => {
    const processor = hopperProcessor({} as any);
    await processor.processScheduledTask("task-1");

    expect(mockOpenChannel).toHaveBeenCalledOnce();
    expect(mockPostMessage).toHaveBeenCalledWith(
      "D-channel-1",
      "When do you need this done by?",
    );
    expect(mockStSvc.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ slackThreadTs: "1234567890.000001" }),
    );
  });

  it("skips Slack when SLACK_BOT_TOKEN is not set", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const processor = hopperProcessor({} as any);
    await processor.processScheduledTask("task-1");

    expect(mockOpenChannel).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("skips Slack when task already has a slackThreadTs (follow-up)", async () => {
    mockStSvc.getById.mockResolvedValue({
      id: "task-1",
      companyId: "co-1",
      requestText: "take out the trash",
      status: "pending",
      slackThreadTs: "existing-thread-ts",
    });
    mockStSvc.listThreads.mockResolvedValue([
      { authorType: "user", body: "tomorrow morning" },
    ]);

    const processor = hopperProcessor({} as any);
    await processor.processScheduledTask("task-1");

    expect(mockOpenChannel).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});
