import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { hopperService } from "./hopper.js";
import { scheduledTasksService } from "./scheduled-tasks.js";
import { hopperPreferencesService, prefKeyForKind } from "./hopper-preferences.js";
import { slackDm } from "./slack-dm.js";
import { syncPreferencesToObsidian } from "./hopper-obsidian-memory.js";

const execFileAsync = promisify(execFile);

const softwareClassifySchema = z.object({
  kind: z.enum(["bug", "feature"]).nullable(),
  has_info: z.boolean(),
  question: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
});

const personalTaskItemSchema = z.object({
  kind: z.enum(["task_personal", "task_work", "task_home", "event", "reminder"]).nullable(),
  title: z.string(),
  description: z.string().nullable(),
  duration_minutes: z.number().nullable(),
  preferred_time_of_day: z.enum(["early_morning", "morning", "afternoon", "evening", "anytime"]).nullable(),
  deadline: z.string().nullable(), // ISO date string or null
});

const personalTaskSchema = z.object({
  has_info: z.boolean(),
  question: z.string().nullable(),
  tasks: z.array(personalTaskItemSchema),
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
Your job is to parse a user's natural-language input, extract one or more tasks, classify each, and return clean structured data for calendar scheduling.

A single prompt may contain MULTIPLE tasks. Extract each one separately.
Example: "Tomorrow I need to fix my office door and pick up groceries at 3pm" → two tasks.

Task kinds:
- "task_personal": personal errands, hobbies, self-care (take out trash, go for a walk, read, etc.)
- "task_work": work tasks, meetings, professional items (write report, code review, respond to emails, etc.)
- "task_home": home maintenance, household tasks (fix sink, clean garage, grocery run, etc.)
- "event": a specific event with a time (dentist at 2pm, conference call, etc.)
- "reminder": a reminder without a specific duration (call mom, renew license, etc.)

TITLE RULES — these are critical:
- Titles must be clean, action-oriented to-do items (like you'd write on a checklist).
- STRIP temporal words: never include "tomorrow", "today", "next week", "Monday", etc. Those go in the deadline field.
- STRIP filler phrases: remove "I need to", "I have to", "I want to", "I should", "don't forget to", "remember to", etc.
- Good: "Fix office door", "Pick up groceries", "Schedule dentist appointment"
- Bad: "Tomorrow I need to fix my office door", "I should pick up groceries next week"

You must respond with a JSON object that has exactly these fields:
- has_info: boolean — true if you have enough to create at least one scheduled task
- question: string or null — if has_info is false, ONE short clarifying question. If has_info is true, set this to null.
- tasks: array of task objects (1 or more when has_info is true, empty array when false). Each task object has:
  - kind: one of the task kinds above, or null if truly unclear
  - title: string — concise, clean task title (under 80 chars). Follow TITLE RULES above.
  - description: string or null — optional extra details
  - duration_minutes: number or null — estimated time to complete. Estimate if not stated. null for reminders.
  - preferred_time_of_day: "early_morning" (before 7am), "morning" (7am-12pm), "afternoon" (12pm-5pm), "evening" (after 5pm), or "anytime". Infer from context.
  - deadline: ISO date string (YYYY-MM-DD) or null — if the task has a specific deadline or day.

Respond ONLY with valid JSON. No explanation, no markdown fences.`;

function extractJson(raw: string): string {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  return text;
}

export function hopperProcessor(db: Db) {
  const svc = hopperService(db);
  const prefsSvc = hopperPreferencesService(db);
  const ctoAgentId = "d33e935d-533f-45a1-bb7a-ee4a2c86b2d8";

  async function classify(
    _companyId: string,
    systemPrompt: string,
    messages: { role: "user" | "assistant"; content: string }[],
  ): Promise<string> {
    const prompt = messages.length === 1
      ? messages[0].content
      : messages.map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");

    const result = await execFileAsync("claude", [
      "--print",
      "--model", "haiku",
      "--output-format", "text",
      "--system-prompt", systemPrompt,
      "--no-session-persistence",
      prompt,
    ], { timeout: 60_000 });

    return result.stdout;
  }

  async function processItem(itemId: string): Promise<void> {
    const item = await svc.getById(itemId);
    if (!item) return;

    const threads = await svc.listThreads(itemId);

    const messages: { role: "user" | "assistant"; content: string }[] = [];
    messages.push({ role: "user", content: item.prompt });
    for (const t of threads) {
      const role = t.authorType === "agent" ? "assistant" : "user";
      messages.push({ role, content: t.body });
    }

    let raw: string;
    try {
      raw = await classify(item.companyId, SOFTWARE_SYSTEM_PROMPT, messages);
    } catch (err) {
      console.error("[hopper] Failed to classify software item:", err);
      await svc.update(itemId, { status: "needs_info" });
      await svc.addThread({
        itemId,
        authorType: "agent",
        authorId: ctoAgentId,
        body: "Sorry, I had trouble processing your request. Please try again in a moment.",
      });
      return;
    }

    await processSoftwareItem(itemId, item, raw, ctoAgentId);
  }

  /** Process a personal task that lives in scheduled_tasks (not hopper_items) */
  async function processScheduledTask(taskId: string): Promise<void> {
    const stSvc = scheduledTasksService(db);
    const task = await stSvc.getById(taskId);
    if (!task) return;

    const threads = await stSvc.listThreads(taskId);

    const messages: { role: "user" | "assistant"; content: string }[] = [];
    messages.push({ role: "user", content: task.requestText });
    for (const t of threads) {
      const role = t.authorType === "agent" ? "assistant" : "user";
      messages.push({ role, content: t.body });
    }

    let raw: string;
    try {
      raw = await classify(task.companyId, PERSONAL_TASK_SYSTEM_PROMPT, messages);
    } catch (err) {
      console.error("[hopper] Failed to classify scheduled task:", err);
      await stSvc.addThread({
        taskId,
        authorType: "agent",
        authorId: ctoAgentId,
        body: "Sorry, I had trouble processing your request. Please try again in a moment.",
      });
      return;
    }

    let parsed: z.infer<typeof personalTaskSchema>;
    try {
      parsed = personalTaskSchema.parse(JSON.parse(extractJson(raw)));
    } catch (err) {
      console.error("[hopper] Failed to parse scheduled task response:", err, "raw:", raw);
      await stSvc.addThread({
        taskId,
        authorType: "agent",
        authorId: ctoAgentId,
        body: "Could you tell me more about what you need to do and roughly when?",
      });
      return;
    }

    if (!parsed.has_info) {
      const updatePatch: Parameters<typeof stSvc.update>[1] = {};

      // Send Slack DM for clarification if configured and no thread yet
      const slackToken = process.env.SLACK_BOT_TOKEN;
      const slackUserId = process.env.SLACK_HOPPER_USER_ID;
      if (slackToken && slackUserId && parsed.question && !task.slackThreadTs) {
        try {
          const slack = slackDm(slackToken, slackUserId);
          const channelId = await slack.openChannel();
          const threadTs = await slack.postMessage(channelId, parsed.question);
          updatePatch.slackThreadTs = threadTs;
        } catch {
          // Slack DM failed — fall through
        }
      }

      if (Object.keys(updatePatch).length > 0) {
        await stSvc.update(taskId, updatePatch);
      }
      if (parsed.question) {
        await stSvc.addThread({
          taskId,
          authorType: "agent",
          authorId: ctoAgentId,
          body: parsed.question,
        });
      }
      return;
    }

    const tasks = parsed.tasks;
    if (tasks.length === 0) return;

    const confirmationLines: string[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];

      // Compute scheduledAt from deadline or default to tomorrow
      let scheduledAt: Date | null = null;
      if (t.deadline) {
        const deadlineDate = new Date(t.deadline);
        if (!isNaN(deadlineDate.getTime())) {
          deadlineDate.setHours(preferredTimeToHour(t.preferred_time_of_day), 0, 0, 0);
          scheduledAt = deadlineDate;
        }
      } else {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(preferredTimeToHour(t.preferred_time_of_day), 0, 0, 0);
        scheduledAt = tomorrow;
      }

      if (i === 0) {
        await stSvc.update(taskId, {
          title: t.title,
          kind: t.kind ?? null,
          status: "scheduled",
          scheduledAt,
          durationMinutes: t.duration_minutes ?? null,
          notes: t.description ?? null,
        });
      } else {
        const newTask = await stSvc.create({
          companyId: task.companyId,
          userId: task.userId,
          requestText: t.title,
          origin: task.origin,
        });
        await stSvc.update(newTask.id, {
          title: t.title,
          kind: t.kind ?? null,
          status: "scheduled",
          scheduledAt,
          durationMinutes: t.duration_minutes ?? null,
          notes: t.description ?? null,
        });
      }

      // Save time-of-day preference for this kind and sync to Obsidian
      if (t.kind && t.preferred_time_of_day && t.preferred_time_of_day !== "anytime") {
        try {
          await prefsSvc.set(
            task.companyId,
            task.userId,
            prefKeyForKind(t.kind),
            t.preferred_time_of_day,
            "explicit",
          );
        } catch {
          // Non-fatal
        }
      }

      const timeStr = scheduledAt
        ? scheduledAt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : "TBD";
      const durationStr = t.duration_minutes ? ` (~${t.duration_minutes} min)` : "";
      confirmationLines.push(`**${t.title}**${durationStr} → **${timeStr}**`);
    }

    // Sync Obsidian prefs once after all tasks
    void syncPreferencesToObsidian(db, task.companyId, task.userId).catch(() => {});

    const body = tasks.length === 1
      ? `Got it! ${confirmationLines[0]}. I'll place it on Google Calendar shortly.`
      : `Got it! ${tasks.length} tasks queued:\n${confirmationLines.map(l => `- ${l}`).join("\n")}\n\nI'll place them on Google Calendar shortly.`;

    await stSvc.addThread({
      taskId,
      authorType: "agent",
      authorId: ctoAgentId,
      body,
    });
  }

  async function processSoftwareItem(
    itemId: string,
    item: Awaited<ReturnType<ReturnType<typeof hopperService>["getById"]>>,
    raw: string,
    ctoAgentId: string,
  ): Promise<void> {
    let parsed: z.infer<typeof softwareClassifySchema>;
    try {
      parsed = softwareClassifySchema.parse(JSON.parse(extractJson(raw)));
    } catch (err) {
      console.error("[hopper] Failed to parse software item response:", err, "raw:", raw);
      await svc.update(itemId, { status: "needs_info" });
      await svc.addThread({
        itemId,
        authorType: "agent",
        authorId: ctoAgentId,
        body: "Sorry, I had trouble understanding your request. Could you try rephrasing it?",
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

  function preferredTimeToHour(pref: string | null): number {
    switch (pref) {
      case "early_morning": return 5;
      case "morning": return 9;
      case "afternoon": return 13;
      case "evening": return 18;
      default: return 9;
    }
  }

  return { process: processItem, processScheduledTask };
}
