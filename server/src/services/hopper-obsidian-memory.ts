import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Db } from "@paperclipai/db";
import { hopperPreferencesService } from "./hopper-preferences.js";

const VAULT_ROOT = process.env.PAPERCLIP_WIKI_PATH
  ?? "/home/r1kon/.paperclip/instances/default/paperclip-wiki";

const PREFS_FILE = resolve(VAULT_ROOT, "agent-memory/jarvis/kevin-task-preferences.md");

const KIND_LABELS: Record<string, string> = {
  task_work: "Work tasks",
  task_personal: "Personal tasks",
  task_home: "Home tasks",
  event: "Events",
  reminder: "Reminders",
};

const TIME_LABELS: Record<string, string> = {
  early_morning: "before 7am",
  morning: "7am–12pm",
  afternoon: "12pm–5pm",
  evening: "after 5pm",
  anytime: "flexible",
};

/**
 * Read Kevin's current scheduling preferences from Obsidian.
 * Returns the raw markdown — suitable for including in a Jarvis context block.
 */
export async function readSchedulingPreferences(): Promise<string | null> {
  try {
    return await readFile(PREFS_FILE, "utf8");
  } catch {
    return null;
  }
}

/**
 * Rebuild the Obsidian preferences file from the database.
 * Called whenever a preference is saved so the file stays fresh.
 */
export async function syncPreferencesToObsidian(
  db: Db,
  companyId: string,
  userId: string,
): Promise<void> {
  const prefsSvc = hopperPreferencesService(db);
  const rows = await prefsSvc.list(companyId, userId);

  const timePrefs: string[] = [];
  for (const row of rows) {
    if (row.prefKey.startsWith("preferred_time_for_kind:")) {
      const kind = row.prefKey.replace("preferred_time_for_kind:", "");
      const kindLabel = KIND_LABELS[kind] ?? kind;
      const timeLabel = TIME_LABELS[row.prefValue] ?? row.prefValue;
      const src = row.source === "explicit" ? "(told me)" : "(inferred)";
      timePrefs.push(`- ${kindLabel}: ${timeLabel} ${src}`);
    }
  }

  const now = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
  const lines: string[] = [
    `# Kevin Task Scheduling Preferences`,
    `_Last synced: ${now} CDT_`,
    "",
    "## Preferred Time of Day by Task Kind",
    "",
  ];

  if (timePrefs.length === 0) {
    lines.push("No preferences learned yet — Jarvis will infer from task context.");
  } else {
    lines.push(...timePrefs);
  }

  lines.push(
    "",
    "## Notes",
    "",
    "- Jarvis infers kind, duration, and deadline from plain-text requests",
    "- When uncertain, Jarvis asks one clarifying question via Slack",
    "- Corrections update this file automatically",
    "- Work tasks are also created in SHIM when `kind = task_work`",
    "",
    "_Updated automatically by hopper-processor when preferences are learned._",
  );

  const content = lines.join("\n");

  const dir = dirname(PREFS_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(PREFS_FILE, content, "utf8");
}
