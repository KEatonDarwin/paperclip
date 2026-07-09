ALTER TABLE "jobs" ADD COLUMN "merge_commit_sha" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "merged_at" timestamp with time zone;
