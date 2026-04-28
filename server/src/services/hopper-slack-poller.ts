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
