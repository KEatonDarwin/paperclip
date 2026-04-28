import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOpenChannel = vi.fn();
const mockPostMessage = vi.fn();

vi.mock("../services/slack-dm.js", () => ({
  slackDm: () => ({
    openChannel: mockOpenChannel,
    postMessage: mockPostMessage,
    fetchReplies: vi.fn(),
  }),
}));

const mockListEvents = vi.fn();
vi.mock("../services/hopper-google-calendar.js", () => ({
  googleCalendarService: () => ({
    findFreeSlot: vi.fn(),
    createEvent: vi.fn(),
    listEvents: mockListEvents,
  }),
}));

const mockStSvc = {
  listTasksForCalendarPlacement: vi.fn(),
};
vi.mock("../services/scheduled-tasks.js", () => ({
  scheduledTasksService: () => mockStSvc,
  scheduledTaskIdentifier: (n: number) => `SCH-${n}`,
}));

import { hopperDailyBriefing } from "../services/hopper-daily-briefing.js";

describe("hopperDailyBriefing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_HOPPER_USER_ID = "U123";
    process.env.GOOGLE_CALENDAR_CLIENT_ID = "cid";
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "csec";
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = "rtoken";
  });

  it("does nothing when SLACK_BOT_TOKEN is not set", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const svc = hopperDailyBriefing({} as any, { briefingHour: 5, briefingMinute: 30 });
    await svc.tick();
    expect(mockOpenChannel).not.toHaveBeenCalled();
  });

  it("does nothing when current time does not match briefing time", async () => {
    const svc = hopperDailyBriefing({} as any, { briefingHour: 3, briefingMinute: 17 });
    await svc.tick();
    expect(mockOpenChannel).not.toHaveBeenCalled();
  });

  it("sends briefing at the configured time", async () => {
    const now = new Date();
    const svc = hopperDailyBriefing({} as any, {
      briefingHour: now.getHours(),
      briefingMinute: now.getMinutes(),
    });

    mockListEvents.mockResolvedValue([]);
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([]);
    mockOpenChannel.mockResolvedValue("D-channel");
    mockPostMessage.mockResolvedValue("ts-abc");

    await svc.tick();

    expect(mockOpenChannel).toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledWith("D-channel", expect.stringContaining("Good morning"));
  });

  it("does not send briefing twice on the same day", async () => {
    const now = new Date();
    const svc = hopperDailyBriefing({} as any, {
      briefingHour: now.getHours(),
      briefingMinute: now.getMinutes(),
    });

    mockListEvents.mockResolvedValue([]);
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([]);
    mockOpenChannel.mockResolvedValue("D-channel");
    mockPostMessage.mockResolvedValue("ts-abc");

    await svc.tick();
    await svc.tick();

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  it("includes calendar events in the briefing message", async () => {
    const now = new Date();
    const svc = hopperDailyBriefing({} as any, {
      briefingHour: now.getHours(),
      briefingMinute: now.getMinutes(),
    });

    mockListEvents.mockResolvedValue([
      {
        id: "evt-1",
        summary: "Team standup",
        start: { dateTime: new Date().toISOString() },
        end: { dateTime: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
        htmlLink: "https://cal.google.com/1",
      },
    ]);
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([]);
    mockOpenChannel.mockResolvedValue("D-channel");
    mockPostMessage.mockResolvedValue("ts-abc");

    await svc.tick();

    const message = mockPostMessage.mock.calls[0][1] as string;
    expect(message).toContain("Team standup");
    expect(message).toContain("Scheduled today");
  });

  it("mentions pending tasks count in briefing", async () => {
    const now = new Date();
    const svc = hopperDailyBriefing({} as any, {
      briefingHour: now.getHours(),
      briefingMinute: now.getMinutes(),
    });

    mockListEvents.mockResolvedValue([]);
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([
      { id: "task-1", kind: "task_personal", scheduledAt: now, durationMinutes: 30 },
      { id: "task-2", kind: "task_work", scheduledAt: now, durationMinutes: 60 },
    ]);
    mockOpenChannel.mockResolvedValue("D-channel");
    mockPostMessage.mockResolvedValue("ts-abc");

    await svc.tick();

    const message = mockPostMessage.mock.calls[0][1] as string;
    expect(message).toContain("2 tasks pending calendar placement");
  });

  it("sends briefing without Google Calendar events when not configured", async () => {
    delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;

    const now = new Date();
    const svc = hopperDailyBriefing({} as any, {
      briefingHour: now.getHours(),
      briefingMinute: now.getMinutes(),
    });

    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([]);
    mockOpenChannel.mockResolvedValue("D-channel");
    mockPostMessage.mockResolvedValue("ts-abc");

    await svc.tick();

    expect(mockPostMessage).toHaveBeenCalled();
    expect(mockListEvents).not.toHaveBeenCalled();
  });
});
