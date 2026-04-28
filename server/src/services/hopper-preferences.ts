import type { Db } from "@paperclipai/db";
import { hopperPreferences } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

/**
 * Preference key for the preferred time-of-day for a task kind.
 * e.g. prefKeyForKind("task_work") = "preferred_time_for_kind:task_work"
 */
export function prefKeyForKind(kind: string): string {
  return `preferred_time_for_kind:${kind}`;
}

export function hopperPreferencesService(db: Db) {
  async function get(companyId: string, userId: string, key: string): Promise<string | null> {
    const [row] = await db
      .select({ prefValue: hopperPreferences.prefValue })
      .from(hopperPreferences)
      .where(
        and(
          eq(hopperPreferences.companyId, companyId),
          eq(hopperPreferences.userId, userId),
          eq(hopperPreferences.prefKey, key),
        ),
      );
    return row?.prefValue ?? null;
  }

  async function set(
    companyId: string,
    userId: string,
    key: string,
    value: string,
    source: "explicit" | "inferred" = "explicit",
  ): Promise<void> {
    await db
      .insert(hopperPreferences)
      .values({
        companyId,
        userId,
        prefKey: key,
        prefValue: value,
        source,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [hopperPreferences.companyId, hopperPreferences.userId, hopperPreferences.prefKey],
        set: { prefValue: value, source, updatedAt: new Date() },
      });
  }

  async function list(companyId: string, userId: string) {
    return db
      .select()
      .from(hopperPreferences)
      .where(
        and(
          eq(hopperPreferences.companyId, companyId),
          eq(hopperPreferences.userId, userId),
        ),
      );
  }

  return { get, set, list };
}
