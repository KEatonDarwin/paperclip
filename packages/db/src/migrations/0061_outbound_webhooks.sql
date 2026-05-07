-- Outbound webhook system (DAR-390)
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"method" text DEFAULT 'POST' NOT NULL,
	"headers" jsonb DEFAULT '{}' NOT NULL,
	"secret" text,
	"events" text[] NOT NULL,
	"scope" text DEFAULT 'company' NOT NULL,
	"scope_id" uuid,
	"exclude_actor_ids" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL REFERENCES "webhooks"("id") ON DELETE CASCADE,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"response_status" integer,
	"response_body" text,
	"error" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "webhooks_company_idx" ON "webhooks" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "webhooks_company_enabled_idx" ON "webhooks" USING btree ("company_id","enabled") WHERE "enabled" = true;
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_idx" ON "webhook_deliveries" USING btree ("webhook_id");
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_pending_idx" ON "webhook_deliveries" USING btree ("status","next_retry_at") WHERE "status" IN ('pending', 'retrying');
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created_idx" ON "webhook_deliveries" USING btree ("created_at");
