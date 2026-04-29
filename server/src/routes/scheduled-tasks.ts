import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { scheduledTasksService, scheduledTaskIdentifier } from "../services/scheduled-tasks.js";
import { issueService, heartbeatService } from "../services/index.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const JARVIS_AGENT_ID = "ee9f5ec7-3eba-49ca-8f11-4ce67367a1ec";

const createSchema = z.object({
  requestText: z.string().min(1).max(4000),
  deadlineAt: z.string().datetime().optional(),
});

const updateSchema = z.object({
  title: z.string().max(200).nullable().optional(),
  kind: z.enum(["task_personal", "task_work", "task_home", "event", "reminder"]).nullable().optional(),
  status: z.enum(["pending", "scheduled", "completed", "cancelled"]).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  durationMinutes: z.number().int().positive().nullable().optional(),
  deadlineAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(8000).optional(),
});

const threadSchema = z.object({
  body: z.string().min(1).max(8000),
});

function withIdentifier<T extends { seqNum: number }>(task: T) {
  return { ...task, identifier: scheduledTaskIdentifier(task.seqNum) };
}

function buildJarvisIssueDescription(task: {
  id: string;
  seqNum: number;
  requestText: string;
  deadlineAt?: Date | null;
}): string {
  const identifier = scheduledTaskIdentifier(task.seqNum);
  const deadlineStr = task.deadlineAt
    ? new Date(task.deadlineAt).toISOString().split("T")[0]
    : "None";
  return [
    `## Scheduled Task — ${identifier}`,
    "",
    `**Request:** ${task.requestText}`,
    "",
    `**Task ID:** \`${task.id}\``,
    `**Deadline:** ${deadlineStr}`,
    "",
    "Process this task:",
    "1. Check the calendar for available slots",
    "2. Classify the task kind and estimate duration",
    "3. Pick the best time given schedule and learned preferences",
    `4. Call \`PATCH /api/scheduled-tasks/${task.id}\` with \`status: \"scheduled\"\`, \`scheduledAt\`, \`kind\`, \`durationMinutes\``,
    "5. If you need more info, send a Slack DM first and update the task when Kevin replies",
    "6. Mark this issue done when the task is scheduled",
  ].join("\n");
}

export function scheduledTaskRoutes(db: Db) {
  const router = Router();
  const issueSvc = issueService(db);
  const heartbeat = heartbeatService(db);

  // List scheduled tasks for current user
  router.get("/companies/:companyId/scheduled-tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const userId = (req.actor as { userId: string }).userId;
    const svc = scheduledTasksService(db);
    const tasks = await svc.list(companyId, userId);
    res.json(tasks.map(withIdentifier));
  });

  // Create a scheduled task — assign to Jarvis for processing
  router.post("/companies/:companyId/scheduled-tasks", validate(createSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const userId = (req.actor as { userId: string }).userId;
    const svc = scheduledTasksService(db);
    const task = await svc.create({
      companyId,
      userId,
      requestText: req.body.requestText,
      deadlineAt: req.body.deadlineAt ? new Date(req.body.deadlineAt) : null,
    });
    res.status(201).json(withIdentifier(task));

    // Create a Paperclip issue for Jarvis to process this task
    void (async () => {
      try {
        const issue = await issueSvc.create(companyId, {
          title: `Schedule: ${task.requestText.slice(0, 100)}`,
          description: buildJarvisIssueDescription(task),
          status: "todo",
          priority: "high",
          assigneeAgentId: JARVIS_AGENT_ID,
          createdByAgentId: null,
          createdByUserId: userId,
        });
        void queueIssueAssignmentWakeup({
          heartbeat,
          issue,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "scheduled_task.create",
          requestedByActorType: "user",
          requestedByActorId: userId,
        });
      } catch {
        // Non-fatal: task is created, Jarvis will catch it on next heartbeat
      }
    })();
  });

  // Get a single scheduled task
  router.get("/scheduled-tasks/:taskId", async (req, res) => {
    const svc = scheduledTasksService(db);
    const task = await svc.getById(req.params.taskId as string);
    if (!task) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, task.companyId);
    res.json(withIdentifier(task));
  });

  // Update a scheduled task (used by Jarvis and board users)
  router.patch("/scheduled-tasks/:taskId", validate(updateSchema), async (req, res) => {
    const svc = scheduledTasksService(db);
    const existing = await svc.getById(req.params.taskId as string);
    if (!existing) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, existing.companyId);
    const patch: Parameters<typeof svc.update>[1] = {};
    if (req.body.title !== undefined) patch.title = req.body.title;
    if (req.body.kind !== undefined) patch.kind = req.body.kind;
    if (req.body.status !== undefined) patch.status = req.body.status;
    if (req.body.scheduledAt !== undefined) {
      patch.scheduledAt = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null;
    }
    if (req.body.durationMinutes !== undefined) patch.durationMinutes = req.body.durationMinutes;
    if (req.body.deadlineAt !== undefined) {
      patch.deadlineAt = req.body.deadlineAt ? new Date(req.body.deadlineAt) : null;
    }
    if (req.body.notes !== undefined) patch.notes = req.body.notes;
    const task = await svc.update(req.params.taskId as string, patch);
    res.json(task ? withIdentifier(task) : null);
  });

  // Cancel / delete a scheduled task
  router.delete("/scheduled-tasks/:taskId", async (req, res) => {
    assertBoard(req);
    const svc = scheduledTasksService(db);
    const existing = await svc.getById(req.params.taskId as string);
    if (!existing) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, existing.companyId);
    await svc.remove(req.params.taskId as string);
    res.status(204).end();
  });

  // List thread entries for a task
  router.get("/scheduled-tasks/:taskId/threads", async (req, res) => {
    const svc = scheduledTasksService(db);
    const task = await svc.getById(req.params.taskId as string);
    if (!task) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, task.companyId);
    const entries = await svc.listThreads(req.params.taskId as string);
    res.json(entries);
  });

  // Add thread reply — wake Jarvis on user replies so he can respond
  router.post("/scheduled-tasks/:taskId/threads", validate(threadSchema), async (req, res) => {
    const taskId = req.params.taskId as string;
    const svc = scheduledTasksService(db);
    const task = await svc.getById(taskId);
    if (!task) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, task.companyId);
    const authorType = req.actor.type === "agent" ? "agent" : "user";
    const authorId = req.actor.type === "agent"
      ? (req.actor as { agentId: string }).agentId
      : (req.actor as { userId: string }).userId;
    const entry = await svc.addThread({ taskId, authorType, authorId, body: req.body.body });
    res.status(201).json(entry);
    if (authorType === "user") {
      void heartbeat.wakeup(JARVIS_AGENT_ID, {
        source: "assignment",
        triggerDetail: "system",
        reason: "scheduled_task_reply",
        payload: { scheduledTaskId: taskId },
        requestedByActorType: "user",
        requestedByActorId: authorId,
        contextSnapshot: { scheduledTaskId: taskId },
      }).catch(() => {});
    }
  });

  return router;
}
