import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { hopperService } from "../services/hopper.js";
import { hopperProcessor } from "../services/hopper-processor.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const createSchema = z.object({
  prompt: z.string().min(1).max(4000),
});

const updateSchema = z.object({
  dismissed: z.boolean().optional(),
  status: z.enum(["processing", "needs_info", "created", "done", "cancelled"]).optional(),
});

const threadSchema = z.object({
  body: z.string().min(1).max(8000),
});

export function hopperRoutes(db: Db) {
  const router = Router();
  const svc = hopperService(db);
  const processor = hopperProcessor(db);

  // List hopper items (software only) for current user
  router.get("/companies/:companyId/hopper", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const userId = (req.actor as { userId: string }).userId;
    const items = await svc.list(companyId, userId);
    res.json(items);
  });

  // Create hopper item (software mode) + trigger processor async
  router.post("/companies/:companyId/hopper", validate(createSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const userId = (req.actor as { userId: string }).userId;
    const item = await svc.create({
      companyId,
      userId,
      prompt: req.body.prompt,
    });
    res.status(201).json(item);
    void processor.process(item.id).catch(() => {});
  });

  // Update hopper item (dismissed/status)
  router.patch("/hopper/:itemId", validate(updateSchema), async (req, res) => {
    const existing = await svc.getById(req.params.itemId as string);
    if (!existing) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, existing.companyId);
    const item = await svc.update(req.params.itemId as string, req.body);
    res.json(item);
  });

  // Delete (cancel) hopper item
  router.delete("/hopper/:itemId", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getById(req.params.itemId as string);
    if (!existing) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, existing.companyId);
    await svc.remove(req.params.itemId as string);
    res.status(204).end();
  });

  // List thread entries
  router.get("/hopper/:itemId/threads", async (req, res) => {
    const item = await svc.getById(req.params.itemId as string);
    if (!item) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, item.companyId);
    const entries = await svc.listThreads(req.params.itemId as string);
    res.json(entries);
  });

  // Add user reply + re-trigger processor async
  router.post("/hopper/:itemId/threads", validate(threadSchema), async (req, res) => {
    const itemId = req.params.itemId as string;
    const item = await svc.getById(itemId);
    if (!item) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, item.companyId);
    const authorType = req.actor.type === "agent" ? "agent" : "user";
    const authorId = req.actor.type === "agent"
      ? (req.actor as { agentId: string }).agentId
      : (req.actor as { userId: string }).userId;
    const entry = await svc.addThread({ itemId, authorType, authorId, body: req.body.body });
    res.status(201).json(entry);
    if (authorType === "user") {
      void processor.process(itemId).catch(() => {});
    }
  });

  return router;
}
