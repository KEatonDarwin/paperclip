import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Stores learned scheduling preferences per user.
 *
 * pref_key examples:
 *   preferred_time_for_kind:task_work   → "morning"
 *   preferred_time_for_kind:task_home   → "evening"
 *   preferred_time_for_kind:event       → "anytime"
 *
 * pref_value: the preference value as a string.
 * source: "explicit" (user stated it) | "inferred" (derived from patterns).
 */
export const hopperPreferences = pgTable(
  "hopper_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    prefKey: text("pref_key").notNull(),
    prefValue: text("pref_value").notNull(),
    source: text("source").notNull().default("explicit"), // 'explicit' | 'inferred'
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userKeyIdx: uniqueIndex("hopper_preferences_user_key_idx").on(
      table.companyId,
      table.userId,
      table.prefKey,
    ),
  }),
);
