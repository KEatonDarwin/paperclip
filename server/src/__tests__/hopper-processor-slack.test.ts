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

const mockHopperSvc = {
  getById: vi.fn(),
  listThreads: vi.fn(),
  update: vi.fn(),
  addThread: vi.fn(),
};

vi.mock("../services/hopper.js", () => ({
  hopperService: () => mockHopperSvc,
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              kind: "task_personal",
              has_info: false,
              question: "When do you need this done by?",
              title: null,
              description: null,
              duration_minutes: null,
              preferred_time_of_day: null,
              deadline: null,
            }),
          },
        ],
      }),
    },
  })),
}));

import { hopperProcessor } from "../services/hopper-processor.js";

describe("hopperProcessor Slack integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_HOPPER_USER_ID = "U123";
    mockHopperSvc.getById.mockResolvedValue({
      id: "item-1",
      companyId: "co-1",
      prompt: "take out the trash",
      taskMode: "personal",
      status: "processing",
      slackThreadTs: null,
    });
    mockHopperSvc.listThreads.mockResolvedValue([]);
    mockHopperSvc.update.mockResolvedValue({});
    mockHopperSvc.addThread.mockResolvedValue({});
    mockOpenChannel.mockResolvedValue("D-channel-1");
    mockPostMessage.mockResolvedValue("1234567890.000001");
  });

  it("sends Slack DM when personal task hits needs_info", async () => {
    const processor = hopperProcessor({} as any);
    await processor.process("item-1");

    expect(mockOpenChannel).toHaveBeenCalledOnce();
    expect(mockPostMessage).toHaveBeenCalledWith(
      "D-channel-1",
      "When do you need this done by?",
    );
    expect(mockHopperSvc.update).toHaveBeenCalledWith(
      "item-1",
      expect.objectContaining({ slackThreadTs: "1234567890.000001" }),
    );
  });

  it("skips Slack when SLACK_BOT_TOKEN is not set", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const processor = hopperProcessor({} as any);
    await processor.process("item-1");

    expect(mockOpenChannel).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("skips Slack when item already has a slackThreadTs (follow-up question)", async () => {
    mockHopperSvc.getById.mockResolvedValue({
      id: "item-1",
      companyId: "co-1",
      prompt: "take out the trash",
      taskMode: "personal",
      status: "needs_info",
      slackThreadTs: "existing-thread-ts",
    });
    mockHopperSvc.listThreads.mockResolvedValue([
      { authorType: "user", body: "tomorrow morning" },
    ]);

    const processor = hopperProcessor({} as any);
    await processor.process("item-1");

    expect(mockOpenChannel).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});
