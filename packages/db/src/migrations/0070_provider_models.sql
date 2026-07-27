CREATE TABLE "provider_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model_key" text NOT NULL,
	"display_name" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"context_window" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "provider_models_company_idx" ON "provider_models" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "provider_models_company_provider_idx" ON "provider_models" USING btree ("company_id","provider");
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_models_company_provider_model_uq" ON "provider_models" USING btree ("company_id","provider","model_key");
