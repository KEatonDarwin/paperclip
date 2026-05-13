-- Persistent "do not remind" mutes keyed by (source_type, source_id) (DAR-453)
-- Covers: calendar events, SHIM tasks, Paperclip issues, scheduled items.
-- JARVIS checks this table before surfacing any item in briefings, check-ins, or prompts.
CREATE TABLE "jarvis_reminder_mutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"reason" text,
	"created_by" text DEFAULT 'jarvis' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "jarvis_reminder_mutes_source_idx" ON "jarvis_reminder_mutes" USING btree ("source_type", "source_id");
