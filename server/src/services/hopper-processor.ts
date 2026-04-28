import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { hopperService } from "./hopper.js";
import { slackDm } from "./slack-dm.js";

const softwareClassifySchema = z.object({
  kind: z.enum(["bug", "feature"]).nullable(),
  has_info: z.boolean(),
  question: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
});

const personalTaskSchema = z.object({
  kind: z.enum(["task_personal", "task_work", "task_home", "event", "reminder"]).nullable(),
  has_info: z.boolean(),
  question: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  duration_minutes: z.number().nullable(),
  preferred_time_of_day: z.enum(["early_morning", "morning", "afternoon", "evening", "anytime"]).nullable(),
  deadline: z.string().nullable(), // ISO date string or null
});

const SOFTWARE_SYSTEM_PROMPT = `You are a product intake assistant for a software project management tool.
Your job is to classify a user's idea or bug report and determine if it has enough context to create an actionable issue.

You must respond with a JSON object that has exactly these fields:
- kind: "bug" or "feature" or null (if unclear)
- has_info: boolean — true if the prompt has enough context to create a clear, actionable issue
- question: string or null — if has_info is false, ONE short clarifying question that would unlock the missing context. If has_info is true, set this to null.
- title: string or null — if has_info is true, a concise issue title (under 100 chars). If has_info is false, set this to null.
- description: string or null — if has_info is true, a clear issue description in markdown. If has_info is false, set this to null.

Respond ONLY with valid JSON. No explanation, no markdown fences.`;

const PERSONAL_TASK_SYSTEM_PROMPT = `You are an intelligent personal task scheduling assistant.
Your job is to classify a task or to-do item and extract enough information to schedule it on a calendar.

Task kinds:
- "task_personal": personal errands, hobbies, self-care (take out trash, go for a walk, read, etc.)
- "task_work": work tasks, meetings, professional items (write report, code review, respond to emails, etc.)
- "task_home": home maintenance, household tasks (fix sink, clean garage, grocery run, etc.)
- "event": a specific event with a time (dentist at 2pm, conference call, etc.)
- "reminder": a reminder without a specific duration (call mom, renew license, etc.)

You must respond with a JSON object that has exactly these fields:
- kind: one of the task kinds above, or null if truly unclear
- has_info: boolean — true if you have enough to create a scheduled task (must know kind and have a clear title at minimum)
- question: string or null — if has_info is false, ONE short clarifying question. If has_info is true, set this to null.
- title: string or null — concise task title (under 80 chars). Set if has_info is true.
- description: string or null — optional extra details. Set if has_info is true and there are relevant details.
- duration_minutes: number or null — estimated time to complete (e.g., 30, 60, 90). Estimate if not stated. null for reminders.
- preferred_time_of_day: "early_morning" (before 7am), "morning" (7am-12pm), "afternoon" (12pm-5pm), "evening" (after 5pm), or "anytime". Infer from context.
- deadline: ISO date string (YYYY-MM-DD) or null — if the task has a specific deadline or must happen on a certain day.

Respond ONLY with valid JSON. No explanation, no markdown fences.`;

export function hopperProcessor(db: Db) {
  const svc = hopperService(db);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const ctoAgentId = "d33e935d-533f-45a1-bb7a-ee4a2c86b2d8";

  async function processItem(itemId: string): Promise<void> {
    const item = await svc.getById(itemId);
    if (!item) return;

    const threads = await svc.listThreads(itemId);

    // Build conversation context
    const messages: { role: "user" | "assistant"; content: string }[] = [];
    messages.push({ role: "user", content: item.prompt });
    for (const t of threads) {
      const role = t.authorType === "agent" ? "assistant" : "user";
      messages.push({ role, content: t.body });
    }

    const isPersonalMode = item.taskMode === "personal";
    const systemPrompt = isPersonalMode ? PERSONAL_TASK_SYSTEM_PROMPT : SOFTWARE_SYSTEM_PROMPT;

    let raw: string;
    try {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      });
      raw = response.content[0].type === "text" ? response.content[0].text : "";
    } catch {
      await svc.update(itemId, { status: "needs_info" });
      await svc.addThread({
        itemId,
        authorType: "agent",
        authorId: ctoAgentId,
        body: "Could you provide more details about what you'd like to achieve and any relevant context?",
      });
      return;
    }

    if (isPersonalMode) {
      await processPersonalTask(itemId, item, raw, ctoAgentId);
    } else {
      await processSoftwareItem(itemId, item, raw, ctoAgentId);
    }
  }

  async function processSoftwareItem(
    itemId: string,
    item: Awaited<ReturnType<ReturnType<typeof hopperService>["getById"]>>,
    raw: string,
    ctoAgentId: string,
  ): Promise<void> {
    let parsed: z.infer<typeof softwareClassifySchema>;
    try {
      parsed = softwareClassifySchema.parse(JSON.parse(raw));
    } catch {
      await svc.update(itemId, { status: "needs_info" });
      await svc.addThread({
        itemId,
        authorType: "agent",
        authorId: ctoAgentId,
        body: "Could you provide more details about what you'd like to achieve and any relevant context?",
      });
      return;
    }

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

    const apiUrl = process.env.PAPERCLIP_API_URL ?? "http://localhost:3100";
    const apiKey = process.env.PAPERCLIP_API_KEY;

    let linkedIssueId: string | undefined;
    let linkedIssueIdentifier: string | undefined;

    try {
      const resp = await fetch(`${apiUrl}/api/companies/${item!.companyId}/issues`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          title: parsed.title,
          description: parsed.description,
          assigneeAgentId: ctoAgentId,
          status: "todo",
          priority: parsed.kind === "bug" ? "high" : "medium",
        }),
      });

      if (resp.ok) {
        const issue = await resp.json() as { id: string; identifier: string };
        linkedIssueId = issue.id;
        linkedIssueIdentifier = issue.identifier;
      }
    } catch {
      // Issue creation failed — still mark created without a link
    }

    await svc.update(itemId, {
      status: "created",
      kind: parsed.kind ?? null,
      linkedIssueId: linkedIssueId ?? null,
      linkedIssueIdentifier: linkedIssueIdentifier ?? null,
    });
  }

  async function processPersonalTask(
    itemId: string,
    item: Awaited<ReturnType<ReturnType<typeof hopperService>["getById"]>>,
    raw: string,
    ctoAgentId: string,
  ): Promise<void> {
    let parsed: z.infer<typeof personalTaskSchema>;
    try {
      parsed = personalTaskSchema.parse(JSON.parse(raw));
    } catch {
      await svc.update(itemId, { status: "needs_info" });
      await svc.addThread({
        itemId,
        authorType: "agent",
        authorId: ctoAgentId,
        body: "Could you tell me more about what you need to do and roughly when?",
      });
      return;
    }

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

    // Compute a suggested scheduledAt based on preferred_time_of_day and deadline
    let scheduledAt: Date | null = null;
    if (parsed.deadline) {
      const deadlineDate = new Date(parsed.deadline);
      if (!isNaN(deadlineDate.getTime())) {
        const timeOfDayHour = preferredTimeToHour(parsed.preferred_time_of_day);
        deadlineDate.setHours(timeOfDayHour, 0, 0, 0);
        scheduledAt = deadlineDate;
      }
    } else {
      // Default: next available slot based on preferred time of day (use tomorrow)
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(preferredTimeToHour(parsed.preferred_time_of_day), 0, 0, 0);
      scheduledAt = tomorrow;
    }

    await svc.update(itemId, {
      status: "created",
      kind: parsed.kind ?? null,
      scheduledAt,
      durationMinutes: parsed.duration_minutes ?? null,
    });

    // Add a confirmation thread message
    const timeStr = scheduledAt
      ? scheduledAt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "TBD";
    const durationStr = parsed.duration_minutes ? ` (~${parsed.duration_minutes} min)` : "";
    await svc.addThread({
      itemId,
      authorType: "agent",
      authorId: ctoAgentId,
      body: `Got it! I've captured **${parsed.title}**${durationStr} and queued it for **${timeStr}**. I'll place it on Google Calendar shortly.`,
    });
  }

  function preferredTimeToHour(pref: string | null): number {
    switch (pref) {
      case "early_morning": return 5;
      case "morning": return 9;
      case "afternoon": return 13;
      case "evening": return 18;
      default: return 9;
    }
  }

  return { process: processItem };
}
