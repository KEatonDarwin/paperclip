-- Create the scheduled_tasks table as a first-class entity
CREATE SEQUENCE IF NOT EXISTS "scheduled_tasks_seq_num_seq";
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"seq_num" integer NOT NULL DEFAULT nextval('scheduled_tasks_seq_num_seq'),
	"request_text" text NOT NULL,
	"title" text,
	"kind" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"duration_minutes" integer,
	"deadline_at" timestamp with time zone,
	"calendar_event_id" text,
	"slack_thread_ts" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_task_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "scheduled_task_threads" ADD CONSTRAINT "scheduled_task_threads_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."scheduled_tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "scheduled_tasks_company_user_idx" ON "scheduled_tasks" USING btree ("company_id","user_id");
--> statement-breakpoint
CREATE INDEX "scheduled_tasks_company_status_idx" ON "scheduled_tasks" USING btree ("company_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_tasks_seq_num_idx" ON "scheduled_tasks" USING btree ("seq_num");
--> statement-breakpoint
CREATE INDEX "scheduled_task_threads_task_id_created_idx" ON "scheduled_task_threads" USING btree ("task_id","created_at");
--> statement-breakpoint
-- Remove scheduler-specific columns that were added to hopper_items in migration 0054
-- These now live on scheduled_tasks
ALTER TABLE "hopper_items" DROP COLUMN IF EXISTS "task_mode";
--> statement-breakpoint
ALTER TABLE "hopper_items" DROP COLUMN IF EXISTS "scheduled_at";
--> statement-breakpoint
ALTER TABLE "hopper_items" DROP COLUMN IF EXISTS "duration_minutes";
--> statement-breakpoint
ALTER TABLE "hopper_items" DROP COLUMN IF EXISTS "calendar_event_id";
--> statement-breakpoint
ALTER TABLE "hopper_items" DROP COLUMN IF EXISTS "slack_thread_ts";
