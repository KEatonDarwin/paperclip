import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindFreeSlot = vi.fn();
const mockCreateEvent = vi.fn();

vi.mock("../services/hopper-google-calendar.js", () => ({
  googleCalendarService: () => ({
    findFreeSlot: mockFindFreeSlot,
    createEvent: mockCreateEvent,
  }),
}));

const mockHopperSvc = {
  listItemsForCalendarPlacement: vi.fn(),
  getById: vi.fn(),
  listThreads: vi.fn(),
  update: vi.fn(),
  addThread: vi.fn(),
};

vi.mock("../services/hopper.js", () => ({
  hopperService: () => mockHopperSvc,
}));

import { hopperCalendarPlacer } from "../services/hopper-calendar-placer.js";

const NOW = new Date("2026-04-29T09:00:00Z");

describe("hopperCalendarPlacer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_CALENDAR_CLIENT_ID = "client-id";
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = "refresh-token";
  });

  it("does nothing when env vars are not set", async () => {
    delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();
    expect(mockHopperSvc.listItemsForCalendarPlacement).not.toHaveBeenCalled();
  });

  it("does nothing when no items need placement", async () => {
    mockHopperSvc.listItemsForCalendarPlacement.mockResolvedValue([]);
    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();
    expect(mockFindFreeSlot).not.toHaveBeenCalled();
  });

  it("places item on Google Calendar and updates item with eventId", async () => {
    const item = { id: "item-1", companyId: "co-1", scheduledAt: NOW, durationMinutes: 60, kind: "task_work" };
    mockHopperSvc.listItemsForCalendarPlacement.mockResolvedValue([item]);
    mockHopperSvc.getById.mockResolvedValue({ id: "item-1", prompt: "Write Q2 report", taskMode: "personal" });
    mockHopperSvc.listThreads.mockResolvedValue([
      { authorType: "agent", body: "Got it! I've captured **Write Q2 report** (~60 min) and queued it for Wed, Apr 30." },
    ]);
    mockFindFreeSlot.mockResolvedValue(NOW);
    mockCreateEvent.mockResolvedValue({ eventId: "gcal-event-123", htmlLink: "https://calendar.google.com/event/123" });
    mockHopperSvc.update.mockResolvedValue({});
    mockHopperSvc.addThread.mockResolvedValue({});

    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();

    expect(mockFindFreeSlot).toHaveBeenCalledWith(NOW, 60);
    expect(mockCreateEvent).toHaveBeenCalledWith("Write Q2 report", null, NOW, 60);
    expect(mockHopperSvc.update).toHaveBeenCalledWith("item-1", { calendarEventId: "gcal-event-123" });
    expect(mockHopperSvc.addThread).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "item-1",
        authorType: "agent",
        body: expect.stringContaining("Scheduled on Google Calendar"),
      }),
    );
  });

  it("uses default duration of 30 minutes when durationMinutes is null", async () => {
    const item = { id: "item-2", companyId: "co-1", scheduledAt: NOW, durationMinutes: null, kind: "reminder" };
    mockHopperSvc.listItemsForCalendarPlacement.mockResolvedValue([item]);
    mockHopperSvc.getById.mockResolvedValue({ id: "item-2", prompt: "Call dentist", taskMode: "personal" });
    mockHopperSvc.listThreads.mockResolvedValue([]);
    mockFindFreeSlot.mockResolvedValue(NOW);
    mockCreateEvent.mockResolvedValue({ eventId: "gcal-event-456", htmlLink: "https://calendar.google.com/event/456" });
    mockHopperSvc.update.mockResolvedValue({});
    mockHopperSvc.addThread.mockResolvedValue({});

    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();

    expect(mockFindFreeSlot).toHaveBeenCalledWith(NOW, 30);
    expect(mockCreateEvent).toHaveBeenCalledWith("Call dentist", null, NOW, 30);
  });

  it("skips an item on error and continues with the next", async () => {
    const items = [
      { id: "item-fail", companyId: "co-1", scheduledAt: NOW, durationMinutes: 30, kind: "task_personal" },
      { id: "item-ok", companyId: "co-1", scheduledAt: NOW, durationMinutes: 45, kind: "task_work" },
    ];
    mockHopperSvc.listItemsForCalendarPlacement.mockResolvedValue(items);
    mockHopperSvc.getById
      .mockResolvedValueOnce({ id: "item-fail", prompt: "Broken task", taskMode: "personal" })
      .mockResolvedValueOnce({ id: "item-ok", prompt: "Working task", taskMode: "personal" });
    mockHopperSvc.listThreads.mockResolvedValue([]);

    // First item fails on findFreeSlot
    mockFindFreeSlot
      .mockRejectedValueOnce(new Error("Calendar API error"))
      .mockResolvedValueOnce(NOW);

    mockCreateEvent.mockResolvedValue({ eventId: "gcal-event-789", htmlLink: "https://calendar.google.com/event/789" });
    mockHopperSvc.update.mockResolvedValue({});
    mockHopperSvc.addThread.mockResolvedValue({});

    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();

    // Only second item should have been placed
    expect(mockHopperSvc.update).toHaveBeenCalledTimes(1);
    expect(mockHopperSvc.update).toHaveBeenCalledWith("item-ok", { calendarEventId: "gcal-event-789" });
  });

  it("extracts title from processor confirmation thread message", async () => {
    const item = { id: "item-3", companyId: "co-1", scheduledAt: NOW, durationMinutes: 30, kind: "task_personal" };
    mockHopperSvc.listItemsForCalendarPlacement.mockResolvedValue([item]);
    mockHopperSvc.getById.mockResolvedValue({ id: "item-3", prompt: "take out the recycling bins tonight", taskMode: "personal" });
    mockHopperSvc.listThreads.mockResolvedValue([
      { authorType: "agent", body: "Got it! I've captured **Take out recycling** (~30 min) and queued it for tonight." },
    ]);
    mockFindFreeSlot.mockResolvedValue(NOW);
    mockCreateEvent.mockResolvedValue({ eventId: "gcal-event-abc", htmlLink: "https://calendar.google.com/event/abc" });
    mockHopperSvc.update.mockResolvedValue({});
    mockHopperSvc.addThread.mockResolvedValue({});

    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();

    // Should use the bold title from the thread, not the raw prompt
    expect(mockCreateEvent).toHaveBeenCalledWith("Take out recycling", expect.anything(), NOW, 30);
  });
});
