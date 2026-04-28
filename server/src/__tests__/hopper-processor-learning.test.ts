import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Anthropic
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
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

describe("hopperProcessor learning integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SLACK_BOT_TOKEN;
  });

  it("saves preferred_time_for_kind when personal task has explicit time preference", async () => {
    mockHopperSvc.getById.mockResolvedValue({
      id: "item-1",
      companyId: "co-1",
      userId: "user-1",
      prompt: "schedule my gym session early tomorrow",
      status: "processing",
      taskMode: "personal",
      slackThreadTs: null,
    });
    mockHopperSvc.listThreads.mockResolvedValue([]);

    mockCreate.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          kind: "task_personal",
          has_info: true,
          question: null,
          title: "Gym session",
          description: null,
          duration_minutes: 60,
          preferred_time_of_day: "early_morning",
          deadline: null,
        }),
      }],
    });

    mockHopperSvc.update.mockResolvedValue({});
    mockHopperSvc.addThread.mockResolvedValue({});

    const processor = hopperProcessor({} as any);
    await processor.process("item-1");

    expect(mockPrefsSvc.set).toHaveBeenCalledWith(
      "co-1",
      "user-1",
      "preferred_time_for_kind:task_personal",
      "early_morning",
      "explicit",
    );
  });

  it("does not save preference when preferred_time_of_day is anytime", async () => {
    mockHopperSvc.getById.mockResolvedValue({
      id: "item-2",
      companyId: "co-1",
      userId: "user-1",
      prompt: "call dentist",
      status: "processing",
      taskMode: "personal",
      slackThreadTs: null,
    });
    mockHopperSvc.listThreads.mockResolvedValue([]);

    mockCreate.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          kind: "reminder",
          has_info: true,
          question: null,
          title: "Call dentist",
          description: null,
          duration_minutes: null,
          preferred_time_of_day: "anytime",
          deadline: null,
        }),
      }],
    });

    mockHopperSvc.update.mockResolvedValue({});
    mockHopperSvc.addThread.mockResolvedValue({});

    const processor = hopperProcessor({} as any);
    await processor.process("item-2");

    expect(mockPrefsSvc.set).not.toHaveBeenCalled();
  });

  it("does not save preference when kind is null", async () => {
    mockHopperSvc.getById.mockResolvedValue({
      id: "item-3",
      companyId: "co-1",
      userId: "user-1",
      prompt: "something unclear",
      status: "processing",
      taskMode: "personal",
      slackThreadTs: null,
    });
    mockHopperSvc.listThreads.mockResolvedValue([]);

    mockCreate.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          kind: null,
          has_info: true,
          question: null,
          title: "Something",
          description: null,
          duration_minutes: 30,
          preferred_time_of_day: "morning",
          deadline: null,
        }),
      }],
    });

    mockHopperSvc.update.mockResolvedValue({});
    mockHopperSvc.addThread.mockResolvedValue({});

    const processor = hopperProcessor({} as any);
    await processor.process("item-3");

    expect(mockPrefsSvc.set).not.toHaveBeenCalled();
  });
});
