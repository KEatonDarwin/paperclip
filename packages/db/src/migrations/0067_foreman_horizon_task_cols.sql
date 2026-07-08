-- Foreman (DAR-687) — HORIZON prior-art columns on job_tasks.
-- NOTE: intentionally NOT registered in meta/_journal.json (same rationale as 0066 —
-- avoids merge-time idx collision with the in-review stack; applied by the
-- applyPendingMigrationsManually fallback in packages/db/src/client.ts).
--
-- WHY A SEPARATE FILE (not folded into 0066): 0066 already applied to environments
-- (incl. the live server DB) as its original content, creating job_tasks WITHOUT these
-- columns. The manual fallback dedups by content hash, so editing 0066 in place would
-- neither re-run on an existing DB (table already exists → CREATE TABLE can't add columns)
-- nor be safe. These ADD COLUMN IF NOT EXISTS statements are idempotent, so they add the
-- columns on existing DBs and are a harmless no-op on any fresh DB.
--
-- HORIZON (arXiv 2606.28279): repair_signal = diagnostics SHOWN to the worker during retry;
-- final_gate = the HELD-OUT check the worker never optimizes against (anti-reward-hacking);
-- token_spend + verify_latency_ms = per-Task cost/latency, first-class metrics.

ALTER TABLE "job_tasks" ADD COLUMN IF NOT EXISTS "repair_signal" text;
--> statement-breakpoint
ALTER TABLE "job_tasks" ADD COLUMN IF NOT EXISTS "final_gate" text;
--> statement-breakpoint
ALTER TABLE "job_tasks" ADD COLUMN IF NOT EXISTS "token_spend" integer;
--> statement-breakpoint
ALTER TABLE "job_tasks" ADD COLUMN IF NOT EXISTS "verify_latency_ms" integer;
