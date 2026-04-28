ALTER TABLE "hopper_items" ADD COLUMN "task_mode" text DEFAULT 'software' NOT NULL;
--> statement-breakpoint
ALTER TABLE "hopper_items" ADD COLUMN "scheduled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "hopper_items" ADD COLUMN "duration_minutes" integer;
--> statement-breakpoint
ALTER TABLE "hopper_items" ADD COLUMN "calendar_event_id" text;
--> statement-breakpoint
ALTER TABLE "hopper_items" ADD COLUMN "slack_thread_ts" text;
