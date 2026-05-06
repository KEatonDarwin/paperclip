import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { scheduledTasksService, scheduledTaskIdentifier } from "../services/scheduled-tasks.js";
import { gogUpdateEvent, gogDeleteEvent } from "../services/hopper-calendar-placer.js";
import { heartbeatService } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const JARVIS_AGENT_ID = "ee9f5ec7-3eba-49ca-8f11-4ce67367a1ec";

const createSchema = z.object({
  requestText: z.string().min(1).max(4000),
  deadlineAt: z.string().datetime().optional(),
  origin: z.enum(["jarvis_bar", "keyboard_shortcut", "apple_watch", "api", "slack", "mobile_shortcut"]).optional(),
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

const preplacedSchema = z.object({
  original_prompt: z.string().min(1).max(4000),
  title: z.string().min(1).max(200),
  summary: z.string().max(4000).optional(),
  scheduled_for: z.string().datetime({ offset: true }),
  duration_minutes: z.number().int().positive(),
  kind: z.enum(["task_personal", "task_work", "task_home", "event", "reminder"]).optional(),
  origin: z.string().max(50).optional(),
  userId: z.string().optional(),
});

const threadSchema = z.object({
  body: z.string().min(1).max(8000),
});

function withIdentifier<T extends { seqNum: number }>(task: T) {
  return { ...task, identifier: scheduledTaskIdentifier(task.seqNum) };
}


export function scheduledTaskRoutes(db: Db) {
  const router = Router();
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
      origin: req.body.origin ?? null,
    });
    res.status(201).json(withIdentifier(task));

    // Wake Jarvis directly with the task context — no issue created
    void heartbeat.wakeup(JARVIS_AGENT_ID, {
      source: "assignment",
      triggerDetail: "system",
      reason: "scheduled_task_new",
      payload: { scheduledTaskId: task.id },
      requestedByActorType: "user",
      requestedByActorId: userId,
      contextSnapshot: { scheduledTaskId: task.id, scheduledTaskText: task.requestText.slice(0, 200) },
    }).catch(() => {});
  });

  // Create a pre-placed scheduled task — bypass AI placer, go straight to calendar sync
  router.post("/companies/:companyId/scheduled-tasks/preplaced", validate(preplacedSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    let userId: string;
    if (req.actor.type === "agent") {
      if (!req.body.userId) {
        return res.status(400).json({ error: "userId is required for agent callers" });
      }
      userId = req.body.userId;
    } else {
      userId = req.body.userId || (req.actor as { userId: string }).userId;
    }

    const svc = scheduledTasksService(db);
    const task = await svc.createPreplaced({
      companyId,
      userId,
      requestText: req.body.original_prompt,
      title: req.body.title,
      scheduledAt: new Date(req.body.scheduled_for),
      durationMinutes: req.body.duration_minutes,
      kind: req.body.kind ?? null,
      notes: req.body.summary ?? null,
      origin: req.body.origin ?? "preplaced",
    });
    res.status(201).json(withIdentifier(task));
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

    // Sync time/duration/title changes to Google Calendar if event exists
    if (task && existing.calendarEventId) {
      const timeChanged = patch.scheduledAt !== undefined &&
        patch.scheduledAt?.getTime() !== existing.scheduledAt?.getTime();
      const durationChanged = patch.durationMinutes !== undefined &&
        patch.durationMinutes !== existing.durationMinutes;
      const titleChanged = patch.title !== undefined && patch.title !== existing.title;

      if (timeChanged || durationChanged || titleChanged) {
        const scheduledAt = task.scheduledAt;
        if (scheduledAt) {
          const duration = task.durationMinutes ?? 30;
          const endTime = new Date(scheduledAt.getTime() + duration * 60_000);
          void gogUpdateEvent({
            eventId: existing.calendarEventId,
            startTime: scheduledAt,
            endTime,
            title: titleChanged ? (task.title ?? undefined) : undefined,
          }).then(() =>
            svc.addThread({
              taskId: task.id,
              authorType: "agent",
              authorId: JARVIS_AGENT_ID,
              body: `Google Calendar event updated to **${scheduledAt.toLocaleDateString("en-US", {
                weekday: "short", month: "short", day: "numeric",
                hour: "numeric", minute: "2-digit",
                timeZone: process.env.GOG_TIMEZONE || "America/Chicago",
              })}** (~${duration} min).`,
            }),
          ).catch(() => {});
        } else {
          // scheduledAt cleared — delete the calendar event
          void gogDeleteEvent(existing.calendarEventId)
            .then(() => svc.update(task.id, { calendarEventId: null }))
            .catch(() => {});
        }
      }
    }
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
    if (existing.calendarEventId) {
      void gogDeleteEvent(existing.calendarEventId).catch(() => {});
    }
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
