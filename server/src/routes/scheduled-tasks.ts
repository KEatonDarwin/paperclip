import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { scheduledTasksService, scheduledTaskIdentifier } from "../services/scheduled-tasks.js";
import { hopperProcessor } from "../services/hopper-processor.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const createSchema = z.object({
  requestText: z.string().min(1).max(4000),
  deadlineAt: z.string().datetime().optional(),
});

const updateSchema = z.object({
  status: z.enum(["pending", "scheduled", "completed", "cancelled"]).optional(),
  notes: z.string().max(8000).optional(),
});

const threadSchema = z.object({
  body: z.string().min(1).max(8000),
});

function withIdentifier<T extends { seqNum: number }>(task: T) {
  return { ...task, identifier: scheduledTaskIdentifier(task.seqNum) };
}

export function scheduledTaskRoutes(db: Db) {
  const router = Router();
  const processor = hopperProcessor(db);

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

  // Create a scheduled task + trigger processor async
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
    void processor.processScheduledTask(task.id).catch(() => {});
  });

  // Get a single scheduled task
  router.get("/scheduled-tasks/:taskId", async (req, res) => {
    const svc = scheduledTasksService(db);
    const task = await svc.getById(req.params.taskId as string);
    if (!task) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, task.companyId);
    res.json(withIdentifier(task));
  });

  // Update a scheduled task
  router.patch("/scheduled-tasks/:taskId", validate(updateSchema), async (req, res) => {
    const svc = scheduledTasksService(db);
    const existing = await svc.getById(req.params.taskId as string);
    if (!existing) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, existing.companyId);
    const task = await svc.update(req.params.taskId as string, req.body);
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

  // Add user reply + re-trigger processor
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
      void processor.processScheduledTask(taskId).catch(() => {});
    }
  });

  return router;
}
