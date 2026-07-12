-- Foreman — Universal Coding Orchestrator (DAR-687, Phase 1): jobs + job_tasks.
-- NOTE: intentionally NOT registered in meta/_journal.json. On a branchy repo the
-- in-review stack (DAR-662/684/…) already occupies migration idx 60..65; adding a
-- journal entry here would collide on merge. The server's applyPendingMigrationsManually
-- fallback (packages/db/src/client.ts) scans the migrations folder and applies any
-- on-disk .sql not yet recorded (deduped by content hash), on both fresh and existing
-- DBs — the same path that already applies the un-journaled 0063/0064 files.
--
-- IDEMPOTENT: the manual apply path re-runs statements raw (no already-applied guard),
-- so any content edit to this file changes its hash, marks it "pending" again, and
-- re-executes every statement. All statements below use IF NOT EXISTS so a re-apply on
-- an existing DB is a harmless no-op instead of a boot-killing "relation already exists".

CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
	"external_ref" text,
	"repo" text NOT NULL,
	"base_branch" text DEFAULT 'master' NOT NULL,
	"ask" text NOT NULL,
	"context" text,
	"worker_type" text,
	"max_workers" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'planning' NOT NULL,
	"integration_branch" text,
	"pr_url" text,
	"verify_result" text,
	"summary" text,
	"error_message" text,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL REFERENCES "jobs"("id") ON DELETE CASCADE,
	"seq" integer DEFAULT 0 NOT NULL,
	"instruction" text NOT NULL,
	"flavor" text DEFAULT 'generic' NOT NULL,
	"worker_type" text,
	"depends_on_seq" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"issue_id" uuid,
	"run_id" uuid,
	"worker_agent_id" uuid,
	"branch" text,
	"worktree_path" text,
	"verify_result" text,
	"artifact_diff" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_company_status_idx" ON "jobs" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_company_created_idx" ON "jobs" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_tasks_job_seq_idx" ON "job_tasks" USING btree ("job_id","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_tasks_job_status_idx" ON "job_tasks" USING btree ("job_id","status");
