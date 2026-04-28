import { pgTable, uuid, text, timestamp, index, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const hopperItems = pgTable(
  "hopper_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    prompt: text("prompt").notNull(),
    status: text("status").notNull().default("processing"), // 'processing' | 'needs_info' | 'created' | 'done' | 'cancelled'
    kind: text("kind"), // 'bug' | 'feature' | null
    question: text("question"),
    linkedIssueId: uuid("linked_issue_id").references(() => issues.id, { onDelete: "set null" }),
    linkedIssueIdentifier: text("linked_issue_identifier"),
    dismissed: boolean("dismissed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("hopper_items_company_user_idx").on(table.companyId, table.userId),
    companyCreatedIdx: index("hopper_items_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

export const hopperItemThreads = pgTable(
  "hopper_item_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id").notNull().references(() => hopperItems.id, { onDelete: "cascade" }),
    authorType: text("author_type").notNull(), // 'user' | 'agent'
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    itemIdCreatedIdx: index("hopper_item_threads_item_id_created_idx").on(table.itemId, table.createdAt),
  }),
);
