-- Foreman (DAR-687) — job_type sideloaded playbooks (Kevin 2026-07-05).
-- NOT registered in meta/_journal.json (same rationale as 0066/0067 — avoids merge-time idx
-- collision with the in-review stack; applied by applyPendingMigrationsManually).
-- FULLY IDEMPOTENT (ADD COLUMN IF NOT EXISTS) — the manual-apply fallback dedups by content
-- hash and re-runs statements raw, so any un-journaled migration MUST be safe to re-run
-- (lesson from the 0066 boot crash-loop). ADD COLUMN ... NOT NULL DEFAULT backfills existing rows.

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "job_type" text DEFAULT 'build' NOT NULL;
