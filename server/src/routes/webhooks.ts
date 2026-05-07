import { Router } from "express";
import { z } from "zod";
import { eq, and, desc, sql, lte, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { webhooks, webhookDeliveries } from "@paperclipai/db";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";

const VALID_EVENTS = new Set(PLUGIN_EVENT_TYPES);
const VALID_METHODS = ["GET", "POST", "PUT", "PATCH"] as const;
const VALID_SCOPES = ["company", "project", "issue"] as const;

const createWebhookSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url().max(2000),
  method: z.enum(VALID_METHODS).default("POST"),
  headers: z.record(z.string()).default({}),
  secret: z.string().max(500).optional(),
  events: z.array(z.string()).min(1).refine(
    (events) => events.every((e) => VALID_EVENTS.has(e as any)),
    { message: "Invalid event type" },
  ),
  scope: z.enum(VALID_SCOPES).default("company"),
  scopeId: z.string().uuid().nullable().optional(),
  excludeActorIds: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

const updateWebhookSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  url: z.string().url().max(2000).optional(),
  method: z.enum(VALID_METHODS).optional(),
  headers: z.record(z.string()).optional(),
  secret: z.string().max(500).nullable().optional(),
  events: z.array(z.string()).min(1).refine(
    (events) => events.every((e) => VALID_EVENTS.has(e as any)),
    { message: "Invalid event type" },
  ).optional(),
  scope: z.enum(VALID_SCOPES).optional(),
  scopeId: z.string().uuid().nullable().optional(),
  excludeActorIds: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

export function webhookRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/webhooks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const rows = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.companyId, companyId))
      .orderBy(desc(webhooks.createdAt));

    const result = rows.map(({ secret, ...rest }) => ({
      ...rest,
      hasSecret: !!secret,
    }));
    res.json(result);
  });

  router.post("/companies/:companyId/webhooks", validate(createWebhookSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const [row] = await db.insert(webhooks).values({
      companyId,
      name: req.body.name,
      url: req.body.url,
      method: req.body.method,
      headers: req.body.headers,
      secret: req.body.secret ?? null,
      events: req.body.events,
      scope: req.body.scope,
      scopeId: req.body.scopeId ?? null,
      excludeActorIds: req.body.excludeActorIds,
      enabled: req.body.enabled,
    }).returning();

    const { secret, ...result } = row;
    res.status(201).json({ ...result, hasSecret: !!secret });
  });

  router.get("/webhooks/:webhookId", async (req, res) => {
    const webhookId = req.params.webhookId as string;

    const [row] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhookId))
      .limit(1);

    if (!row) throw notFound("Webhook not found");
    assertBoard(req);
    assertCompanyAccess(req, row.companyId);

    const { secret, ...result } = row;
    res.json({ ...result, hasSecret: !!secret });
  });

  router.patch("/webhooks/:webhookId", validate(updateWebhookSchema), async (req, res) => {
    const webhookId = req.params.webhookId as string;

    const [existing] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhookId))
      .limit(1);

    if (!existing) throw notFound("Webhook not found");
    assertBoard(req);
    assertCompanyAccess(req, existing.companyId);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.url !== undefined) updates.url = req.body.url;
    if (req.body.method !== undefined) updates.method = req.body.method;
    if (req.body.headers !== undefined) updates.headers = req.body.headers;
    if (req.body.secret !== undefined) updates.secret = req.body.secret;
    if (req.body.events !== undefined) updates.events = req.body.events;
    if (req.body.scope !== undefined) updates.scope = req.body.scope;
    if (req.body.scopeId !== undefined) updates.scopeId = req.body.scopeId;
    if (req.body.excludeActorIds !== undefined) updates.excludeActorIds = req.body.excludeActorIds;
    if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;

    const [row] = await db
      .update(webhooks)
      .set(updates)
      .where(eq(webhooks.id, webhookId))
      .returning();

    const { secret, ...result } = row;
    res.json({ ...result, hasSecret: !!secret });
  });

  router.delete("/webhooks/:webhookId", async (req, res) => {
    const webhookId = req.params.webhookId as string;

    const [existing] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhookId))
      .limit(1);

    if (!existing) throw notFound("Webhook not found");
    assertBoard(req);
    assertCompanyAccess(req, existing.companyId);

    await db.delete(webhooks).where(eq(webhooks.id, webhookId));
    res.status(204).end();
  });

  router.get("/webhooks/:webhookId/deliveries", async (req, res) => {
    const webhookId = req.params.webhookId as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const [existing] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhookId))
      .limit(1);

    if (!existing) throw notFound("Webhook not found");
    assertBoard(req);
    assertCompanyAccess(req, existing.companyId);

    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit)
      .offset(offset);

    res.json(rows);
  });

  router.post("/webhooks/:webhookId/test", async (req, res) => {
    const webhookId = req.params.webhookId as string;

    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhookId))
      .limit(1);

    if (!webhook) throw notFound("Webhook not found");
    assertBoard(req);
    assertCompanyAccess(req, webhook.companyId);

    const testPayload = {
      id: randomUUID(),
      event: "webhook.test",
      timestamp: new Date().toISOString(),
      companyId: webhook.companyId,
      data: {
        message: "This is a test delivery from Paperclip.",
        webhookId: webhook.id,
        webhookName: webhook.name,
      },
    };

    const [delivery] = await db.insert(webhookDeliveries).values({
      webhookId: webhook.id,
      eventType: "webhook.test",
      payload: testPayload,
      status: "pending",
      nextRetryAt: new Date(),
    }).returning();

    res.status(202).json({ deliveryId: delivery.id, status: "pending" });
  });

  return router;
}
