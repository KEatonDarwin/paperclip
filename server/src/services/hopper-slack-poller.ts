import type { Db } from "@paperclipai/db";
import { slackDm } from "./slack-dm.js";
import { scheduledTasksService } from "./scheduled-tasks.js";
import { hopperProcessor } from "./hopper-processor.js";

export function hopperSlackPoller(db: Db) {
  // In-memory cursor: taskId → last seen Slack message ts
  const lastSeenTs = new Map<string, string>();

  async function tick(): Promise<void> {
    const slackToken = process.env.SLACK_BOT_TOKEN;
    const slackUserId = process.env.SLACK_HOPPER_USER_ID;
    if (!slackToken || !slackUserId) return;

    const stSvc = scheduledTasksService(db);
    const processor = hopperProcessor(db);
    const slack = slackDm(slackToken, slackUserId);

    let pendingTasks: Awaited<ReturnType<typeof stSvc.listPendingSlackTasks>>;
    try {
      pendingTasks = await stSvc.listPendingSlackTasks();
    } catch {
      return;
    }

    for (const task of pendingTasks) {
      try {
        const channelId = await slack.openChannel();
        const afterTs = lastSeenTs.get(task.id) ?? task.slackThreadTs;

        const replies = await slack.fetchReplies(channelId, task.slackThreadTs, afterTs);
        if (replies.length === 0) continue;

        for (const reply of replies) {
          await stSvc.addThread({
            taskId: task.id,
            authorType: "user",
            authorId: slackUserId,
            body: reply.text,
          });
          lastSeenTs.set(task.id, reply.ts);
        }

        // Re-run processor now that new user context is available
        await processor.processScheduledTask(task.id);
      } catch {
        // Skip this task on error; retry next tick
      }
    }
  }

  return { tick };
}
