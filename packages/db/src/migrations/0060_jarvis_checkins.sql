-- JARVIS check-in queue: extensible reminder/follow-up system (DAR-388)
CREATE TABLE "jarvis_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "jarvis_checkins_pending_fire_idx" ON "jarvis_checkins" USING btree ("status","fire_at") WHERE "status" = 'pending';
