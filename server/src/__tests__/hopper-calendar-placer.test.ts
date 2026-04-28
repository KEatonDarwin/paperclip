import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindFreeSlot = vi.fn();
const mockCreateEvent = vi.fn();

vi.mock("../services/hopper-google-calendar.js", () => ({
  googleCalendarService: () => ({
    findFreeSlot: mockFindFreeSlot,
    createEvent: mockCreateEvent,
  }),
}));

const mockStSvc = {
  listTasksForCalendarPlacement: vi.fn(),
  getById: vi.fn(),
  listThreads: vi.fn(),
  update: vi.fn(),
  addThread: vi.fn(),
};

vi.mock("../services/scheduled-tasks.js", () => ({
  scheduledTasksService: () => mockStSvc,
  scheduledTaskIdentifier: (n: number) => `SCH-${n}`,
}));

const mockPrefsSvc = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn(),
  list: vi.fn(),
};

vi.mock("../services/hopper-preferences.js", () => ({
  hopperPreferencesService: () => mockPrefsSvc,
  prefKeyForKind: (kind: string) => `preferred_time_for_kind:${kind}`,
}));

import { hopperCalendarPlacer } from "../services/hopper-calendar-placer.js";

const NOW = new Date("2026-04-29T09:00:00Z");

describe("hopperCalendarPlacer (v2 — scheduled_tasks)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_CALENDAR_CLIENT_ID = "client-id";
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = "refresh-token";
    mockPrefsSvc.get.mockResolvedValue(null);
  });

  it("does nothing when env vars are not set", async () => {
    delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();
    expect(mockStSvc.listTasksForCalendarPlacement).not.toHaveBeenCalled();
  });

  it("does nothing when no tasks need placement", async () => {
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([]);
    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();
    expect(mockFindFreeSlot).not.toHaveBeenCalled();
  });

  it("places task on Google Calendar and updates with eventId", async () => {
    const task = { id: "task-1", companyId: "co-1", scheduledAt: NOW, durationMinutes: 60, kind: "task_work" };
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([task]);
    mockStSvc.getById.mockResolvedValue({ id: "task-1", requestText: "Write Q2 report", title: "Write Q2 report" });
    mockStSvc.listThreads.mockResolvedValue([
      { authorType: "agent", body: "Got it! **Write Q2 report** (~60 min) is queued for Wed, Apr 30." },
    ]);
    mockFindFreeSlot.mockResolvedValue(NOW);
    mockCreateEvent.mockResolvedValue({ eventId: "gcal-event-123", htmlLink: "https://calendar.google.com/event/123" });
    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});

    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();

    expect(mockFindFreeSlot).toHaveBeenCalledWith(NOW, 60);
    expect(mockCreateEvent).toHaveBeenCalledWith("Write Q2 report", null, NOW, 60);
    expect(mockStSvc.update).toHaveBeenCalledWith("task-1", { calendarEventId: "gcal-event-123" });
    expect(mockStSvc.addThread).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        authorType: "agent",
        body: expect.stringContaining("Scheduled on Google Calendar"),
      }),
    );
  });

  it("uses default duration of 30 minutes when durationMinutes is null", async () => {
    const task = { id: "task-2", companyId: "co-1", scheduledAt: NOW, durationMinutes: null, kind: "reminder" };
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([task]);
    mockStSvc.getById.mockResolvedValue({ id: "task-2", requestText: "Call dentist", title: null });
    mockStSvc.listThreads.mockResolvedValue([]);
    mockFindFreeSlot.mockResolvedValue(NOW);
    mockCreateEvent.mockResolvedValue({ eventId: "gcal-event-456", htmlLink: "https://calendar.google.com/event/456" });
    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});

    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();

    expect(mockFindFreeSlot).toHaveBeenCalledWith(NOW, 30);
    expect(mockCreateEvent).toHaveBeenCalledWith("Call dentist", null, NOW, 30);
  });

  it("skips a task on error and continues with the next", async () => {
    const tasks = [
      { id: "task-fail", companyId: "co-1", scheduledAt: NOW, durationMinutes: 30, kind: "task_personal" },
      { id: "task-ok", companyId: "co-1", scheduledAt: NOW, durationMinutes: 45, kind: "task_work" },
    ];
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue(tasks);
    mockStSvc.getById
      .mockResolvedValueOnce({ id: "task-fail", requestText: "Broken task", title: null })
      .mockResolvedValueOnce({ id: "task-ok", requestText: "Working task", title: "Working task" });
    mockStSvc.listThreads.mockResolvedValue([]);

    mockFindFreeSlot
      .mockRejectedValueOnce(new Error("Calendar API error"))
      .mockResolvedValueOnce(NOW);

    mockCreateEvent.mockResolvedValue({ eventId: "gcal-event-789", htmlLink: "https://calendar.google.com/event/789" });
    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});

    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();

    expect(mockStSvc.update).toHaveBeenCalledTimes(1);
    expect(mockStSvc.update).toHaveBeenCalledWith("task-ok", { calendarEventId: "gcal-event-789" });
  });

  it("applies learned time preference when finding slot", async () => {
    const scheduledAt = new Date("2030-04-29T09:00:00Z");
    const task = { id: "task-pref", companyId: "co-1", scheduledAt, durationMinutes: 60, kind: "task_work" };
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([task]);
    mockStSvc.getById.mockResolvedValue({ id: "task-pref", requestText: "Write report", title: "Write report", companyId: "co-1", userId: "user-1" });
    mockStSvc.listThreads.mockResolvedValue([]);
    mockPrefsSvc.get.mockResolvedValue("evening");

    mockFindFreeSlot.mockImplementation(async (start: Date) => start);
    mockCreateEvent.mockResolvedValue({ eventId: "gcal-evt", htmlLink: "https://cal.google.com/x" });
    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});

    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();

    const calledWith = mockFindFreeSlot.mock.calls[0][0] as Date;
    expect(calledWith.getHours()).toBe(18);
  });

  it("extracts title from task title field, falling back to requestText", async () => {
    const task = { id: "task-3", companyId: "co-1", scheduledAt: NOW, durationMinutes: 30, kind: "task_personal" };
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([task]);
    mockStSvc.getById.mockResolvedValue({ id: "task-3", requestText: "take out the recycling bins tonight", title: "Take out recycling" });
    mockStSvc.listThreads.mockResolvedValue([]);
    mockFindFreeSlot.mockResolvedValue(NOW);
    mockCreateEvent.mockResolvedValue({ eventId: "gcal-event-abc", htmlLink: "https://calendar.google.com/event/abc" });
    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});

    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();

    expect(mockCreateEvent).toHaveBeenCalledWith("Take out recycling", expect.anything(), NOW, 30);
  });
});
