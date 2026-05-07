import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { webhooks, webhookDeliveries, issues } from "@paperclipai/db";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

const WEBHOOK_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);

export interface WebhookEventInput {
  companyId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  details?: Record<string, unknown> | null;
}

export async function dispatchOutboundWebhooks(db: Db, input: WebhookEventInput): Promise<void> {
  if (!WEBHOOK_EVENT_SET.has(input.action)) return;

  try {
    const matchingWebhooks = await db
      .select()
      .from(webhooks)
      .where(and(
        eq(webhooks.companyId, input.companyId),
        eq(webhooks.enabled, true),
        sql`${input.action} = ANY(${webhooks.events})`,
      ));

    if (matchingWebhooks.length === 0) return;

    let issueProjectId: string | null = null;
    if (input.entityType === "issue" || input.entityType === "issue_comment") {
      const issueId = input.entityType === "issue_comment"
        ? (input.details?.issueId as string | undefined) ?? input.entityId
        : input.entityId;
      const [issue] = await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1);
      issueProjectId = issue?.projectId ?? null;
    }

    const issueEntityId = input.entityType === "issue"
      ? input.entityId
      : input.entityType === "issue_comment"
        ? (input.details?.issueId as string | undefined) ?? null
        : null;

    const deliveries: Array<{
      webhookId: string;
      eventType: string;
      payload: Record<string, unknown>;
      status: string;
      nextRetryAt: Date;
    }> = [];

    for (const wh of matchingWebhooks) {
      if (wh.excludeActorIds.length > 0 && wh.excludeActorIds.includes(input.actorId)) {
        continue;
      }

      if (wh.scope === "project" && wh.scopeId) {
        if (issueProjectId !== wh.scopeId) continue;
      } else if (wh.scope === "issue" && wh.scopeId) {
        if (issueEntityId !== wh.scopeId) continue;
      }

      const payload: Record<string, unknown> = {
        id: randomUUID(),
        event: input.action,
        timestamp: new Date().toISOString(),
        companyId: input.companyId,
        data: {
          entityType: input.entityType,
          entityId: input.entityId,
          actor: {
            type: input.actorType,
            id: input.actorId,
          },
          agentId: input.agentId ?? null,
          runId: input.runId ?? null,
          ...(input.details ?? {}),
        },
      };

      deliveries.push({
        webhookId: wh.id,
        eventType: input.action,
        payload,
        status: "pending",
        nextRetryAt: new Date(),
      });
    }

    if (deliveries.length > 0) {
      await db.insert(webhookDeliveries).values(deliveries);
    }
  } catch (err) {
    logger.warn({ err, action: input.action }, "Failed to dispatch outbound webhooks");
  }
}
