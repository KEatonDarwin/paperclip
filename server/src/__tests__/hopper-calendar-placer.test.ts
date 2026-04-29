import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock execFile — the gog CLI interface
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));
vi.mock("node:util", () => ({
  promisify: (fn: unknown) => fn,
}));

const mockStSvc = {
  listTasksForCalendarPlacement: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  addThread: vi.fn(),
};

vi.mock("../services/scheduled-tasks.js", () => ({
  scheduledTasksService: () => mockStSvc,
  scheduledTaskIdentifier: (n: number) => `SCH-${n}`,
}));

import { hopperCalendarPlacer } from "../services/hopper-calendar-placer.js";

const NOW = new Date("2026-04-29T14:00:00Z");

function makeGogCreateResponse(id = "gcal-event-123", htmlLink = "https://calendar.google.com/event/123") {
  return { stdout: JSON.stringify({ id, htmlLink }), stderr: "" };
}

describe("hopperCalendarPlacer (v3 — gog CLI)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no tasks need placement", async () => {
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([]);
    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockStSvc.update).not.toHaveBeenCalled();
  });

  it("creates a calendar event via gog and updates the task with eventId", async () => {
    const task = {
      id: "task-1",
      companyId: "co-1",
      scheduledAt: NOW,
      durationMinutes: 60,
      kind: "task_work",
    };
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([task]);
    mockStSvc.getById.mockResolvedValue({
      id: "task-1",
      requestText: "Write Q2 report",
      title: "Write Q2 report",
    });
    mockExecFile.mockResolvedValue(makeGogCreateResponse());
    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});

    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [bin, args] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(bin).toBe("/usr/local/bin/gog");
    expect(args).toContain("create");
    expect(args).toContain("--summary");
    expect(args[args.indexOf("--summary") + 1]).toBe("Write Q2 report");
    expect(mockStSvc.update).toHaveBeenCalledWith("task-1", { calendarEventId: "gcal-event-123" });
    expect(mockStSvc.addThread).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        authorType: "agent",
        body: expect.stringContaining("Synced to Google Calendar"),
      }),
    );
  });

  it("uses default duration of 30 minutes when durationMinutes is null", async () => {
    const task = {
      id: "task-2",
      companyId: "co-1",
      scheduledAt: NOW,
      durationMinutes: null,
      kind: "reminder",
    };
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([task]);
    mockStSvc.getById.mockResolvedValue({ id: "task-2", requestText: "Call dentist", title: null });
    mockExecFile.mockResolvedValue(makeGogCreateResponse("gcal-456", "https://calendar.google.com/event/456"));
    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});

    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();

    const args = mockExecFile.mock.calls[0][1] as string[];
    const toIdx = args.indexOf("--to");
    const endISO = args[toIdx + 1];
    const endMs = new Date(endISO).getTime();
    expect(endMs - NOW.getTime()).toBe(30 * 60_000);
    expect(mockStSvc.update).toHaveBeenCalledWith("task-2", { calendarEventId: "gcal-456" });
  });

  it("skips a task on gog error and continues with the next", async () => {
    const tasks = [
      { id: "task-fail", companyId: "co-1", scheduledAt: NOW, durationMinutes: 30, kind: "task_personal" },
      { id: "task-ok", companyId: "co-1", scheduledAt: NOW, durationMinutes: 45, kind: "task_work" },
    ];
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue(tasks);
    mockStSvc.getById
      .mockResolvedValueOnce({ id: "task-fail", requestText: "Broken task", title: null })
      .mockResolvedValueOnce({ id: "task-ok", requestText: "Working task", title: "Working task" });
    mockExecFile
      .mockRejectedValueOnce(new Error("gog error"))
      .mockResolvedValueOnce(makeGogCreateResponse("gcal-789"));
    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});

    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();

    expect(mockStSvc.update).toHaveBeenCalledTimes(1);
    expect(mockStSvc.update).toHaveBeenCalledWith("task-ok", { calendarEventId: "gcal-789" });
  });

  it("uses task title for event summary, falling back to requestText", async () => {
    const task = {
      id: "task-3",
      companyId: "co-1",
      scheduledAt: NOW,
      durationMinutes: 30,
      kind: "task_personal",
    };
    mockStSvc.listTasksForCalendarPlacement.mockResolvedValue([task]);
    mockStSvc.getById.mockResolvedValue({
      id: "task-3",
      requestText: "take out the recycling bins tonight",
      title: "Take out recycling",
    });
    mockExecFile.mockResolvedValue(makeGogCreateResponse("gcal-abc"));
    mockStSvc.update.mockResolvedValue({});
    mockStSvc.addThread.mockResolvedValue({});

    const placer = hopperCalendarPlacer({} as any);
    await placer.tick();

    const args = mockExecFile.mock.calls[0][1] as string[];
    const summaryIdx = args.indexOf("--summary");
    expect(args[summaryIdx + 1]).toBe("Take out recycling");
  });
});
