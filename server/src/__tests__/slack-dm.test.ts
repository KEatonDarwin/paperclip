import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { slackDm } from "../services/slack-dm.js";

describe("slackDm", () => {
  const token = "xoxb-test-token";
  const userId = "U12345678";
  const channelId = "D87654321";
  const svc = slackDm(token, userId);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("openChannel", () => {
    it("returns channel id from conversations.open", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, channel: { id: channelId } }),
      });
      const result = await svc.openChannel();
      expect(result).toBe(channelId);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://slack.com/api/conversations.open",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws when Slack returns ok: false", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: "user_not_found" }),
      });
      await expect(svc.openChannel()).rejects.toThrow("user_not_found");
    });
  });

  describe("postMessage", () => {
    it("returns the message ts", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, ts: "1234567890.000001" }),
      });
      const ts = await svc.postMessage(channelId, "Hello!");
      expect(ts).toBe("1234567890.000001");
    });
  });

  describe("fetchReplies", () => {
    it("returns messages with ts after cursor, excluding bot messages", async () => {
      const messages = [
        { type: "message", ts: "100.000", text: "initial", bot_id: "B1" },
        { type: "message", ts: "200.000", text: "user reply", user: "U1" },
        { type: "message", ts: "300.000", text: "user reply 2", user: "U1" },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, messages }),
      });
      const replies = await svc.fetchReplies(channelId, "100.000", "150.000");
      // Both user messages (ts 200 and 300) are after cursor 150; bot message (ts 100 = threadTs) is excluded
      expect(replies).toHaveLength(2);
      expect(replies[0]!.text).toBe("user reply");
    });

    it("returns empty array when Slack call fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: "channel_not_found" }),
      });
      const replies = await svc.fetchReplies(channelId, "100.000", "0");
      expect(replies).toEqual([]);
    });
  });
});
