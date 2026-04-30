import { pgTable, uuid, text, timestamp, index, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    seqNum: integer("seq_num").notNull().default(sql`nextval('scheduled_tasks_seq_num_seq')`),
    requestText: text("request_text").notNull(),
    title: text("title"),
    kind: text("kind"), // 'task_personal' | 'task_work' | 'task_home' | 'event' | 'reminder'
    status: text("status").notNull().default("pending"), // 'pending' | 'scheduled' | 'completed' | 'cancelled'
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    durationMinutes: integer("duration_minutes"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    calendarEventId: text("calendar_event_id"),
    slackThreadTs: text("slack_thread_ts"),
    origin: text("origin"), // 'jarvis_bar' | 'keyboard_shortcut' | 'apple_watch' | 'api' | 'slack'
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("scheduled_tasks_company_user_idx").on(table.companyId, table.userId),
    companyStatusIdx: index("scheduled_tasks_company_status_idx").on(table.companyId, table.status),
    seqNumIdx: uniqueIndex("scheduled_tasks_seq_num_idx").on(table.seqNum),
  }),
);

export const scheduledTaskThreads = pgTable(
  "scheduled_task_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => scheduledTasks.id, { onDelete: "cascade" }),
    authorType: text("author_type").notNull(), // 'user' | 'agent'
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskIdCreatedIdx: index("scheduled_task_threads_task_id_created_idx").on(table.taskId, table.createdAt),
  }),
);
