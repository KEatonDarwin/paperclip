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

const mockHopperSvc = {
  listPendingSlackItems: vi.fn(),
  addThread: vi.fn(),
  update: vi.fn(),
};
const mockProcessor = { process: vi.fn() };

vi.mock("../services/hopper.js", () => ({
  hopperService: () => mockHopperSvc,
}));

vi.mock("../services/hopper-processor.js", () => ({
  hopperProcessor: () => mockProcessor,
}));

import { hopperSlackPoller } from "../services/hopper-slack-poller.js";

describe("hopperSlackPoller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_HOPPER_USER_ID = "U123";
  });

  it("does nothing when SLACK_BOT_TOKEN is not set", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const poller = hopperSlackPoller({} as any);
    await poller.tick();
    expect(mockHopperSvc.listPendingSlackItems).not.toHaveBeenCalled();
  });

  it("does nothing when no pending items", async () => {
    mockHopperSvc.listPendingSlackItems.mockResolvedValue([]);
    const poller = hopperSlackPoller({} as any);
    await poller.tick();
    expect(mockFetchReplies).not.toHaveBeenCalled();
  });

  it("fetches replies and re-runs processor on new user message", async () => {
    mockHopperSvc.listPendingSlackItems.mockResolvedValue([
      { id: "item-1", companyId: "co-1", slackThreadTs: "1000.000" },
    ]);
    mockOpenChannel.mockResolvedValue("D-channel-1");
    mockFetchReplies.mockResolvedValue([
      { type: "message", ts: "1001.000", text: "tomorrow morning", user: "U1" },
    ]);
    mockHopperSvc.addThread.mockResolvedValue({});
    mockProcessor.process.mockResolvedValue(undefined);

    const poller = hopperSlackPoller({} as any);
    await poller.tick();

    expect(mockHopperSvc.addThread).toHaveBeenCalledWith({
      itemId: "item-1",
      authorType: "user",
      authorId: "U123",
      body: "tomorrow morning",
    });
    expect(mockProcessor.process).toHaveBeenCalledWith("item-1");
  });

  it("skips already-seen replies on second tick", async () => {
    mockHopperSvc.listPendingSlackItems.mockResolvedValue([
      { id: "item-1", companyId: "co-1", slackThreadTs: "1000.000" },
    ]);
    mockOpenChannel.mockResolvedValue("D-channel-1");
    // First tick: one new reply
    mockFetchReplies.mockResolvedValueOnce([
      { type: "message", ts: "1001.000", text: "tomorrow morning", user: "U1" },
    ]);
    // Second tick: no new messages (cursor updated to "1001.000")
    mockFetchReplies.mockResolvedValueOnce([]);

    mockHopperSvc.addThread.mockResolvedValue({});
    mockProcessor.process.mockResolvedValue(undefined);

    const poller = hopperSlackPoller({} as any);
    await poller.tick(); // processes reply
    await poller.tick(); // cursor advanced, no new messages

    expect(mockHopperSvc.addThread).toHaveBeenCalledTimes(1);
    expect(mockProcessor.process).toHaveBeenCalledTimes(1);
  });
});
