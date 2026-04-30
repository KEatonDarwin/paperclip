ALTER TABLE "agent_groups" ADD COLUMN IF NOT EXISTS "default_collapsed" boolean NOT NULL DEFAULT false;
