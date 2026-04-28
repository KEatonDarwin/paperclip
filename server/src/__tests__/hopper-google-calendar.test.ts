import { describe, it, expect, vi, beforeEach } from "vitest";
import { googleCalendarService } from "../services/hopper-google-calendar.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const tokenResponse = { access_token: "tok-abc", expires_in: 3600, token_type: "Bearer" };

describe("googleCalendarService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeService() {
    return googleCalendarService("client-id", "client-secret", "refresh-token");
  }

  function mockToken() {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => tokenResponse,
    });
  }

  describe("findFreeSlot", () => {
    it("returns preferred start when no conflicts", async () => {
      mockToken();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ calendars: { primary: { busy: [] } } }),
      });

      const start = new Date("2026-04-29T09:00:00Z");
      const svc = makeService();
      const slot = await svc.findFreeSlot(start, 60);
      expect(slot).toEqual(start);
    });

    it("skips busy slots and finds next free window", async () => {
      mockToken();
      // 9:00-10:00 is busy — should advance to 10:00
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          calendars: {
            primary: {
              busy: [{ start: "2026-04-29T09:00:00Z", end: "2026-04-29T10:00:00Z" }],
            },
          },
        }),
      });

      const preferredStart = new Date("2026-04-29T09:00:00Z");
      const svc = makeService();
      const slot = await svc.findFreeSlot(preferredStart, 60);

      // Should be at 10:00 (first free 30-min increment after the busy block)
      expect(slot.getTime()).toBeGreaterThan(preferredStart.getTime());
    });

    it("falls back to preferred start when freebusy API fails", async () => {
      mockToken();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      const start = new Date("2026-04-29T09:00:00Z");
      const svc = makeService();
      const slot = await svc.findFreeSlot(start, 30);
      expect(slot).toEqual(start);
    });
  });

  describe("createEvent", () => {
    it("creates event and returns eventId and htmlLink", async () => {
      mockToken();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "evt-123",
          summary: "Write report",
          start: { dateTime: "2026-04-29T09:00:00Z" },
          end: { dateTime: "2026-04-29T10:00:00Z" },
          htmlLink: "https://calendar.google.com/event/evt-123",
        }),
      });

      const start = new Date("2026-04-29T09:00:00Z");
      const svc = makeService();
      const result = await svc.createEvent("Write report", null, start, 60);

      expect(result.eventId).toBe("evt-123");
      expect(result.htmlLink).toBe("https://calendar.google.com/event/evt-123");
    });

    it("throws when createEvent API returns error", async () => {
      mockToken();
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      });

      const svc = makeService();
      await expect(
        svc.createEvent("Test", null, new Date(), 30),
      ).rejects.toThrow("Google Calendar createEvent failed");
    });

    it("includes description in event body when provided", async () => {
      mockToken();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "evt-456",
          htmlLink: "https://calendar.google.com/event/evt-456",
          start: { dateTime: "2026-04-29T09:00:00Z" },
          end: { dateTime: "2026-04-29T09:30:00Z" },
        }),
      });

      const svc = makeService();
      await svc.createEvent("Task", "Some extra details", new Date("2026-04-29T09:00:00Z"), 30);

      const callBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
      expect(callBody.description).toBe("Some extra details");
    });
  });

  it("throws when token refresh fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const svc = makeService();
    await expect(svc.findFreeSlot(new Date(), 30)).rejects.toThrow("Google token refresh failed");
  });
});
