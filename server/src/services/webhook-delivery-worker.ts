import { createHmac } from "node:crypto";
import { eq, and, lte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { webhooks, webhookDeliveries } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const BACKOFF_SCHEDULE_MS = [
  30_000,       // attempt 1: 30s
  120_000,      // attempt 2: 2m
  480_000,      // attempt 3: 8m
  1_800_000,    // attempt 4: 30m
  7_200_000,    // attempt 5: 2h
];

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BODY = 4096;

export interface WebhookDeliveryWorkerOptions {
  tickIntervalMs?: number;
  maxConcurrent?: number;
}

export function createWebhookDeliveryWorker(db: Db, opts: WebhookDeliveryWorkerOptions = {}) {
  const tickIntervalMs = opts.tickIntervalMs ?? 10_000;
  const maxConcurrent = opts.maxConcurrent ?? 5;
  let timer: ReturnType<typeof setInterval> | null = null;
  let tickInProgress = false;
  let activeCount = 0;

  async function tick(): Promise<void> {
    if (tickInProgress) return;
    tickInProgress = true;

    try {
      const now = new Date();
      const pending = await db
        .select({
          id: webhookDeliveries.id,
          webhookId: webhookDeliveries.webhookId,
          eventType: webhookDeliveries.eventType,
          payload: webhookDeliveries.payload,
          attempt: webhookDeliveries.attempt,
          maxAttempts: webhookDeliveries.maxAttempts,
        })
        .from(webhookDeliveries)
        .where(and(
          inArray(webhookDeliveries.status, ["pending", "retrying"]),
          lte(webhookDeliveries.nextRetryAt, now),
        ))
        .limit(maxConcurrent - activeCount)
        .for("update", { skipLocked: true });

      for (const delivery of pending) {
        if (activeCount >= maxConcurrent) break;
        activeCount++;
        void processDelivery(delivery).finally(() => { activeCount--; });
      }
    } catch (err) {
      logger.error({ err }, "Webhook delivery worker tick failed");
    } finally {
      tickInProgress = false;
    }
  }

  async function processDelivery(delivery: {
    id: string;
    webhookId: string;
    eventType: string;
    payload: Record<string, unknown>;
    attempt: number;
    maxAttempts: number;
  }): Promise<void> {
    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, delivery.webhookId))
      .limit(1);

    if (!webhook || !webhook.enabled) {
      await db
        .update(webhookDeliveries)
        .set({ status: "failed", error: "Webhook disabled or deleted" })
        .where(eq(webhookDeliveries.id, delivery.id));
      return;
    }

    const body = JSON.stringify(delivery.payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Paperclip-Webhooks/1.0",
      ...webhook.headers,
    };

    if (webhook.secret) {
      const signature = createHmac("sha256", webhook.secret).update(body).digest("hex");
      headers["X-Paperclip-Signature"] = `sha256=${signature}`;
    }

    const attemptNum = delivery.attempt + 1;
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      const response = await fetch(webhook.url, {
        method: webhook.method,
        headers,
        body: webhook.method !== "GET" ? body : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const durationMs = Date.now() - startTime;
      let responseBody: string | null = null;
      try {
        const text = await response.text();
        responseBody = text.slice(0, MAX_RESPONSE_BODY);
      } catch {
        // ignore response body read failures
      }

      if (response.ok) {
        await db
          .update(webhookDeliveries)
          .set({
            status: "succeeded",
            attempt: attemptNum,
            responseStatus: response.status,
            responseBody,
            durationMs,
            deliveredAt: new Date(),
          })
          .where(eq(webhookDeliveries.id, delivery.id));
      } else {
        await handleFailure(delivery, attemptNum, durationMs, response.status, responseBody, `HTTP ${response.status}`);
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      await handleFailure(delivery, attemptNum, durationMs, null, null, errorMsg);
    }
  }

  async function handleFailure(
    delivery: { id: string; maxAttempts: number },
    attemptNum: number,
    durationMs: number,
    responseStatus: number | null,
    responseBody: string | null,
    error: string,
  ): Promise<void> {
    if (attemptNum >= delivery.maxAttempts) {
      await db
        .update(webhookDeliveries)
        .set({
          status: "failed",
          attempt: attemptNum,
          responseStatus,
          responseBody,
          error,
          durationMs,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
    } else {
      const backoffMs = BACKOFF_SCHEDULE_MS[attemptNum - 1] ?? BACKOFF_SCHEDULE_MS.at(-1)!;
      await db
        .update(webhookDeliveries)
        .set({
          status: "retrying",
          attempt: attemptNum,
          responseStatus,
          responseBody,
          error,
          durationMs,
          nextRetryAt: new Date(Date.now() + backoffMs),
        })
        .where(eq(webhookDeliveries.id, delivery.id));
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), tickIntervalMs);
      logger.info({ tickIntervalMs, maxConcurrent }, "Webhook delivery worker started");
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
