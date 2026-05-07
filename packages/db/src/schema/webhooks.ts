import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    method: text("method").notNull().default("POST"),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    secret: text("secret"),
    events: text("events").array().notNull(),
    scope: text("scope").notNull().default("company"),
    scopeId: uuid("scope_id"),
    excludeActorIds: text("exclude_actor_ids").array().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("webhooks_company_idx").on(table.companyId),
    companyEnabledIdx: index("webhooks_company_enabled_idx").on(table.companyId, table.enabled),
  }),
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => ({
    webhookIdx: index("webhook_deliveries_webhook_idx").on(table.webhookId),
    pendingIdx: index("webhook_deliveries_pending_idx").on(table.status, table.nextRetryAt),
    createdIdx: index("webhook_deliveries_created_idx").on(table.createdAt),
  }),
);
