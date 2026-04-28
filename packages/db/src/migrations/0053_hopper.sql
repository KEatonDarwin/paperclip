CREATE TABLE "hopper_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"kind" text,
	"question" text,
	"linked_issue_id" uuid,
	"linked_issue_identifier" text,
	"dismissed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hopper_item_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hopper_items" ADD CONSTRAINT "hopper_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hopper_items" ADD CONSTRAINT "hopper_items_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hopper_item_threads" ADD CONSTRAINT "hopper_item_threads_item_id_hopper_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."hopper_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "hopper_items_company_user_idx" ON "hopper_items" USING btree ("company_id","user_id");
--> statement-breakpoint
CREATE INDEX "hopper_items_company_created_idx" ON "hopper_items" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX "hopper_item_threads_item_id_created_idx" ON "hopper_item_threads" USING btree ("item_id","created_at");
