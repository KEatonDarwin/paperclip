# Hopper Phase 2 — Slack DM Conversation Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a personal Hopper item needs clarification, send a Slack DM to the user and poll for replies, feeding them back into the processor to create a real-time back-and-forth.

**Architecture:** A new `slack-dm.ts` service wraps the Slack Web API (chat.postMessage, conversations.open, conversations.replies) using a bot token. The hopper processor is extended to call this service when a personal item enters `needs_info`. A new `hopper-slack-poller.ts` service is registered in `index.ts` on a 60-second interval to check open Slack threads for new user replies and re-run the processor.

**Tech Stack:** Slack Web API via native `fetch`, env vars `SLACK_BOT_TOKEN` + `SLACK_HOPPER_USER_ID`, existing `hopper_items.slack_thread_ts` column (Phase 1), vitest for tests.

**Branch:** `DAR-297/slack-dm-loop`

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `server/src/services/slack-dm.ts` | Slack Web API wrapper: openDm, postMessage, fetchReplies |
| Create | `server/src/services/hopper-slack-poller.ts` | Poll open threads, feed replies into processor |
| Modify | `server/src/services/hopper-processor.ts` | Send Slack DM after posting needs_info question |
| Modify | `server/src/services/hopper.ts` | Add `listPendingSlackItems()` helper |
| Modify | `server/src/index.ts` | Register poller setInterval |
| Modify | `.env.example` | Document SLACK_BOT_TOKEN, SLACK_HOPPER_USER_ID |
| Create | `server/src/__tests__/slack-dm.test.ts` | Unit tests for slack-dm service |
| Create | `server/src/__tests__/hopper-slack-poller.test.ts` | Unit tests for poller |

---

## Task 1: Create `slack-dm.ts` service

**Files:**
- Create: `server/src/services/slack-dm.ts`
- Create: `server/src/__tests__/slack-dm.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// server/src/__tests__/slack-dm.test.ts
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
    it("returns messages with ts after cursor", async () => {
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
      expect(replies).toHaveLength(1);
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/r1kon/paperclip && pnpm --filter @paperclipai/server test src/__tests__/slack-dm.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../services/slack-dm.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/services/slack-dm.ts

interface SlackMessage {
  type: string;
  ts: string;
  text: string;
  bot_id?: string;
  user?: string;
}

interface SlackDmService {
  openChannel(): Promise<string>;
  postMessage(channelId: string, text: string): Promise<string>;
  fetchReplies(channelId: string, threadTs: string, afterTs: string): Promise<SlackMessage[]>;
}

export function slackDm(botToken: string, targetUserId: string): SlackDmService {
  const baseHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    Authorization: `Bearer ${botToken}`,
  };

  async function callApi(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`https://slack.com/api/${path}`, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function openChannel(): Promise<string> {
    const data = await callApi("conversations.open", { users: targetUserId }) as {
      ok: boolean;
      error?: string;
      channel?: { id: string };
    };
    if (!data.ok) throw new Error(data.error ?? "conversations.open failed");
    return data.channel!.id;
  }

  async function postMessage(channelId: string, text: string): Promise<string> {
    const data = await callApi("chat.postMessage", { channel: channelId, text }) as {
      ok: boolean;
      error?: string;
      ts?: string;
    };
    if (!data.ok) throw new Error(data.error ?? "chat.postMessage failed");
    return data.ts!;
  }

  async function fetchReplies(channelId: string, threadTs: string, afterTs: string): Promise<SlackMessage[]> {
    let data: { ok: boolean; messages?: SlackMessage[] };
    try {
      data = await callApi("conversations.replies", {
        channel: channelId,
        ts: threadTs,
        oldest: afterTs,
        inclusive: false,
        limit: 50,
      }) as typeof data;
    } catch {
      return [];
    }
    if (!data.ok) return [];
    const messages = data.messages ?? [];
    // Exclude bot messages and the thread parent (ts === threadTs)
    return messages.filter(
      (m) => m.ts !== threadTs && !m.bot_id && m.type === "message",
    );
  }

  return { openChannel, postMessage, fetchReplies };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /home/r1kon/paperclip && pnpm --filter @paperclipai/server test src/__tests__/slack-dm.test.ts 2>&1 | tail -20
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /home/r1kon/paperclip
git add server/src/services/slack-dm.ts server/src/__tests__/slack-dm.test.ts
git commit -m "feat(DAR-297): add slack-dm service wrapping Slack Web API

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 2: Add `listPendingSlackItems()` to hopper service

**Files:**
- Modify: `server/src/services/hopper.ts`

The poller needs to find all hopper items that have an active Slack thread (slackThreadTs is set, status is needs_info).

- [ ] **Step 1: Locate the hopper service**

Read `server/src/services/hopper.ts`. The `hopperService` factory returns an object with `list`, `create`, `getById`, `update`, `remove`, `addThread`, `listThreads`.

- [ ] **Step 2: Add the helper function**

In `server/src/services/hopper.ts`, add the following to the returned object (after `listThreads`):

```typescript
async function listPendingSlackItems(): Promise<
  Array<{ id: string; companyId: string; slackThreadTs: string }>
> {
  const rows = await db
    .select({
      id: hopperItems.id,
      companyId: hopperItems.companyId,
      slackThreadTs: hopperItems.slackThreadTs,
    })
    .from(hopperItems)
    .where(
      and(
        eq(hopperItems.status, "needs_info"),
        isNotNull(hopperItems.slackThreadTs),
      ),
    );
  return rows.filter((r): r is typeof r & { slackThreadTs: string } =>
    r.slackThreadTs !== null,
  );
}
```

Add `listPendingSlackItems` to the return value of `hopperService`.

Also verify the imports — `hopperItems`, `isNotNull`, `and`, `eq` must all be imported. Check the top of the file for existing drizzle imports and add any missing ones.

- [ ] **Step 3: Typecheck**

```bash
cd /home/r1kon/paperclip && pnpm --filter @paperclipai/server typecheck 2>&1 | grep -i "hopper\|error" | head -20
```

Expected: No errors in hopper.ts

- [ ] **Step 4: Commit**

```bash
cd /home/r1kon/paperclip
git add server/src/services/hopper.ts
git commit -m "feat(DAR-297): add listPendingSlackItems to hopper service

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 3: Extend hopper processor to send Slack DM on needs_info

**Files:**
- Modify: `server/src/services/hopper-processor.ts`

When a personal task enters `needs_info` and `SLACK_BOT_TOKEN` + `SLACK_HOPPER_USER_ID` are set, send the clarifying question as a Slack DM and store the thread ts.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/hopper-processor-slack.test.ts
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
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /home/r1kon/paperclip && pnpm --filter @paperclipai/server test src/__tests__/hopper-processor-slack.test.ts 2>&1 | tail -20
```

Expected: FAIL — `slackDm is not called`

- [ ] **Step 3: Modify the processor**

At the top of `server/src/services/hopper-processor.ts`, add the import:

```typescript
import { slackDm } from "./slack-dm.js";
```

In `processPersonalTask`, find the `!parsed.has_info` branch (around line 204). Replace:

```typescript
    if (!parsed.has_info) {
      await svc.update(itemId, {
        status: "needs_info",
        kind: parsed.kind ?? null,
        question: parsed.question ?? null,
      });
      if (parsed.question) {
        await svc.addThread({
          itemId,
          authorType: "agent",
          authorId: ctoAgentId,
          body: parsed.question,
        });
      }
      return;
    }
```

With:

```typescript
    if (!parsed.has_info) {
      const updatePatch: Parameters<typeof svc.update>[1] = {
        status: "needs_info",
        kind: parsed.kind ?? null,
        question: parsed.question ?? null,
      };

      // Send Slack DM if configured and item doesn't already have a thread
      const slackToken = process.env.SLACK_BOT_TOKEN;
      const slackUserId = process.env.SLACK_HOPPER_USER_ID;
      if (slackToken && slackUserId && parsed.question && !item?.slackThreadTs) {
        try {
          const slack = slackDm(slackToken, slackUserId);
          const channelId = await slack.openChannel();
          const threadTs = await slack.postMessage(channelId, parsed.question);
          updatePatch.slackThreadTs = threadTs;
        } catch {
          // Slack DM failed — fall through to in-app question only
        }
      }

      await svc.update(itemId, updatePatch);
      if (parsed.question) {
        await svc.addThread({
          itemId,
          authorType: "agent",
          authorId: ctoAgentId,
          body: parsed.question,
        });
      }
      return;
    }
```

Note: `item` is already in scope as a parameter in `processPersonalTask`. The `slackThreadTs` field is available on the item object from Phase 1's schema.

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /home/r1kon/paperclip && pnpm --filter @paperclipai/server test src/__tests__/hopper-processor-slack.test.ts 2>&1 | tail -20
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /home/r1kon/paperclip
git add server/src/services/hopper-processor.ts server/src/__tests__/hopper-processor-slack.test.ts
git commit -m "feat(DAR-297): send Slack DM when personal hopper item needs clarification

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 4: Create `hopper-slack-poller.ts`

**Files:**
- Create: `server/src/services/hopper-slack-poller.ts`
- Create: `server/src/__tests__/hopper-slack-poller.test.ts`

This service polls open Slack threads for new user replies and feeds them back into the processor.

- [ ] **Step 1: Write the failing tests**

```typescript
// server/src/__tests__/hopper-slack-poller.test.ts
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
    // Second tick: same reply still returned by Slack (no new messages)
    mockFetchReplies.mockResolvedValueOnce([]);

    mockHopperSvc.addThread.mockResolvedValue({});
    mockProcessor.process.mockResolvedValue(undefined);

    const poller = hopperSlackPoller({} as any);
    await poller.tick(); // processes reply
    await poller.tick(); // should not re-add

    expect(mockHopperSvc.addThread).toHaveBeenCalledTimes(1);
    expect(mockProcessor.process).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/r1kon/paperclip && pnpm --filter @paperclipai/server test src/__tests__/hopper-slack-poller.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../services/hopper-slack-poller.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/services/hopper-slack-poller.ts
import type { Db } from "@paperclipai/db";
import { slackDm } from "./slack-dm.js";
import { hopperService } from "./hopper.js";
import { hopperProcessor } from "./hopper-processor.js";

export function hopperSlackPoller(db: Db) {
  // In-memory cursor: itemId → last seen Slack message ts
  const lastSeenTs = new Map<string, string>();

  async function tick(): Promise<void> {
    const slackToken = process.env.SLACK_BOT_TOKEN;
    const slackUserId = process.env.SLACK_HOPPER_USER_ID;
    if (!slackToken || !slackUserId) return;

    const svc = hopperService(db);
    const processor = hopperProcessor(db);
    const slack = slackDm(slackToken, slackUserId);

    let pendingItems: Awaited<ReturnType<typeof svc.listPendingSlackItems>>;
    try {
      pendingItems = await svc.listPendingSlackItems();
    } catch {
      return;
    }

    for (const item of pendingItems) {
      try {
        // Open the DM channel to get the channel ID for this thread
        const channelId = await slack.openChannel();
        const afterTs = lastSeenTs.get(item.id) ?? item.slackThreadTs;

        const replies = await slack.fetchReplies(channelId, item.slackThreadTs, afterTs);
        if (replies.length === 0) continue;

        for (const reply of replies) {
          await svc.addThread({
            itemId: item.id,
            authorType: "user",
            authorId: slackUserId,
            body: reply.text,
          });
          lastSeenTs.set(item.id, reply.ts);
        }

        // Re-run processor now that new user context is available
        await processor.process(item.id);
      } catch {
        // Skip this item on error; retry next tick
      }
    }
  }

  return { tick };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /home/r1kon/paperclip && pnpm --filter @paperclipai/server test src/__tests__/hopper-slack-poller.test.ts 2>&1 | tail -20
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /home/r1kon/paperclip
git add server/src/services/hopper-slack-poller.ts server/src/__tests__/hopper-slack-poller.test.ts
git commit -m "feat(DAR-297): add hopper Slack poller to pick up DM replies

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 5: Register poller in `index.ts` and update `.env.example`

**Files:**
- Modify: `server/src/index.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add import in `index.ts`**

At the top of `server/src/index.ts`, add alongside other service imports:

```typescript
import { hopperSlackPoller } from "./services/hopper-slack-poller.js";
```

- [ ] **Step 2: Register polling interval**

Find the block in `index.ts` that starts `if (config.heartbeatSchedulerEnabled)` (around line 564). Just before the closing `}` of that block (but after the setInterval for heartbeat), add:

```typescript
  // Slack DM poller — checks open Hopper threads for user replies every 60s
  if (process.env.SLACK_BOT_TOKEN) {
    const slackPoller = hopperSlackPoller(db as any);
    setInterval(() => {
      void slackPoller.tick().catch((err) => {
        logger.error({ err }, "hopper slack poller tick failed");
      });
    }, 60_000);
    logger.info("hopper Slack DM poller registered (60s interval)");
  }
```

- [ ] **Step 3: Update `.env.example`**

Add to `.env.example`:

```
# Hopper Slack DM integration (Phase 2)
# SLACK_BOT_TOKEN=xoxb-your-bot-token
# SLACK_HOPPER_USER_ID=U1234567890  # Slack user ID to send DMs to
```

- [ ] **Step 4: Typecheck**

```bash
cd /home/r1kon/paperclip && pnpm --filter @paperclipai/server typecheck 2>&1 | grep -i "error" | grep -v "node_modules" | head -20
```

Expected: No errors

- [ ] **Step 5: Run full test suite for affected files**

```bash
cd /home/r1kon/paperclip && pnpm --filter @paperclipai/server test src/__tests__/slack-dm.test.ts src/__tests__/hopper-slack-poller.test.ts src/__tests__/hopper-processor-slack.test.ts 2>&1 | tail -30
```

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /home/r1kon/paperclip
git add server/src/index.ts .env.example
git commit -m "feat(DAR-297): register Slack poller in server startup

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 6: Merge to master

- [ ] **Step 1: Final typecheck**

```bash
cd /home/r1kon/paperclip && pnpm --filter @paperclipai/server typecheck 2>&1 | grep -i "error" | grep -v "node_modules" | head -20
```

- [ ] **Step 2: Run full test suite**

```bash
cd /home/r1kon/paperclip && pnpm --filter @paperclipai/server test 2>&1 | tail -20
```

Expected: All pre-existing tests still pass; new tests pass.

- [ ] **Step 3: Merge branch to master**

```bash
cd /home/r1kon/paperclip
git checkout master
git merge --no-ff DAR-297/slack-dm-loop -m "Merge DAR-297/slack-dm-loop: Hopper Phase 2 Slack DM conversation loop

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
git branch -d DAR-297/slack-dm-loop
```

---

## Notes on `slackThreadTs` Lookup

The poller calls `slack.openChannel()` on every tick to get the DM channel ID. This works because `conversations.open` is idempotent — it returns the same DM channel for the same user pair. The channel ID is NOT stored in the DB to avoid schema churn; the extra API call is cheap and stateless.

If performance becomes a concern, consider caching `channelId` in the `lastSeenTs` Map (change it to `Map<string, { ts: string; channelId: string }>`).
