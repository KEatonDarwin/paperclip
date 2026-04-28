import type { Db } from "@paperclipai/db";
import { hopperItems, hopperItemThreads } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";

export function hopperService(db: Db) {
  async function list(companyId: string, userId: string, opts?: { includeDismissed?: boolean }) {
    const conditions = [
      eq(hopperItems.companyId, companyId),
      eq(hopperItems.userId, userId),
    ];
    if (!opts?.includeDismissed) {
      conditions.push(eq(hopperItems.dismissed, false));
    }
    return db
      .select()
      .from(hopperItems)
      .where(and(...conditions))
      .orderBy(desc(hopperItems.createdAt));
  }

  async function create(input: {
    companyId: string;
    userId: string;
    prompt: string;
    taskMode?: string;
  }) {
    const [item] = await db
      .insert(hopperItems)
      .values({
        companyId: input.companyId,
        userId: input.userId,
        prompt: input.prompt,
        taskMode: input.taskMode ?? "software",
        status: "processing",
      })
      .returning();
    return item;
  }

  async function getById(id: string) {
    const [item] = await db
      .select()
      .from(hopperItems)
      .where(eq(hopperItems.id, id));
    return item ?? null;
  }

  async function update(
    itemId: string,
    patch: {
      status?: string;
      kind?: string | null;
      question?: string | null;
      linkedIssueId?: string | null;
      linkedIssueIdentifier?: string | null;
      scheduledAt?: Date | null;
      durationMinutes?: number | null;
      calendarEventId?: string | null;
      slackThreadTs?: string | null;
      dismissed?: boolean;
    },
  ) {
    const [item] = await db
      .update(hopperItems)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(hopperItems.id, itemId))
      .returning();
    return item ?? null;
  }

  async function remove(itemId: string) {
    const [item] = await db
      .delete(hopperItems)
      .where(eq(hopperItems.id, itemId))
      .returning();
    return item ?? null;
  }

  async function addThread(input: { itemId: string; authorType: string; authorId: string; body: string }) {
    const [entry] = await db
      .insert(hopperItemThreads)
      .values(input)
      .returning();
    return entry;
  }

  async function listThreads(itemId: string) {
    return db
      .select()
      .from(hopperItemThreads)
      .where(eq(hopperItemThreads.itemId, itemId))
      .orderBy(hopperItemThreads.createdAt);
  }

  return { list, create, getById, update, remove, addThread, listThreads };
}
