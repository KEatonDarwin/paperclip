CREATE TABLE IF NOT EXISTS "hopper_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL,
	"pref_key" text NOT NULL,
	"pref_value" text NOT NULL,
	"source" text DEFAULT 'explicit' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hopper_preferences_user_key_idx" ON "hopper_preferences" ("company_id","user_id","pref_key");
