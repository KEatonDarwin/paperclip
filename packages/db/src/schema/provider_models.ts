import { pgTable, uuid, text, timestamp, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const providerModels = pgTable(
  "provider_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // 'anthropic' | 'openai' | 'google' | ... (provider key, matches secret provider naming where applicable)
    modelKey: text("model_key").notNull(), // underlying model id/string used when running a prompt
    displayName: text("display_name").notNull(),
    source: text("source").notNull().default("manual"), // 'discovered' | 'manual'
    contextWindow: integer("context_window"),
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("provider_models_company_idx").on(table.companyId),
    companyProviderIdx: index("provider_models_company_provider_idx").on(table.companyId, table.provider),
    companyProviderModelUq: uniqueIndex("provider_models_company_provider_model_uq").on(
      table.companyId,
      table.provider,
      table.modelKey,
    ),
  }),
);
