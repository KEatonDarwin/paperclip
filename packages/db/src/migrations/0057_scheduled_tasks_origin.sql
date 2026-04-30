-- Add origin column to track how the scheduled task was created
ALTER TABLE "scheduled_tasks" ADD COLUMN "origin" text;
