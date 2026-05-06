import type { Db } from "@paperclipai/db";
import { scheduledTasks, scheduledTaskThreads } from "@paperclipai/db";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

/** Derive the display identifier from a seq_num: e.g. SCH-42 */
export function scheduledTaskIdentifier(seqNum: number): string {
  return `SCH-${seqNum}`;
}

export function scheduledTasksService(db: Db) {
  async function list(companyId: string, userId: string) {
    return db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.companyId, companyId),
          eq(scheduledTasks.userId, userId),
        ),
      )
      .orderBy(desc(scheduledTasks.createdAt));
  }

  async function create(input: {
    companyId: string;
    userId: string;
    requestText: string;
    deadlineAt?: Date | null;
    origin?: string | null;
  }) {
    const [task] = await db
      .insert(scheduledTasks)
      .values({
        companyId: input.companyId,
        userId: input.userId,
        requestText: input.requestText,
        deadlineAt: input.deadlineAt ?? null,
        origin: input.origin ?? null,
        status: "pending",
      })
      .returning();
    return task;
  }

  async function getById(id: string) {
    const [task] = await db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.id, id));
    return task ?? null;
  }

  async function update(
    taskId: string,
    patch: {
      title?: string | null;
      kind?: string | null;
      status?: string;
      scheduledAt?: Date | null;
      durationMinutes?: number | null;
      deadlineAt?: Date | null;
      calendarEventId?: string | null;
      slackThreadTs?: string | null;
      notes?: string | null;
    },
  ) {
    const [task] = await db
      .update(scheduledTasks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(scheduledTasks.id, taskId))
      .returning();
    return task ?? null;
  }

  async function remove(taskId: string) {
    const [task] = await db
      .delete(scheduledTasks)
      .where(eq(scheduledTasks.id, taskId))
      .returning();
    return task ?? null;
  }

  async function addThread(input: { taskId: string; authorType: string; authorId: string; body: string }) {
    const [entry] = await db
      .insert(scheduledTaskThreads)
      .values(input)
      .returning();
    return entry;
  }

  async function listThreads(taskId: string) {
    return db
      .select()
      .from(scheduledTaskThreads)
      .where(eq(scheduledTaskThreads.taskId, taskId))
      .orderBy(scheduledTaskThreads.createdAt);
  }

  /** Tasks awaiting Slack clarification replies */
  async function listPendingSlackTasks(): Promise<
    Array<{ id: string; companyId: string; slackThreadTs: string }>
  > {
    const rows = await db
      .select({
        id: scheduledTasks.id,
        companyId: scheduledTasks.companyId,
        slackThreadTs: scheduledTasks.slackThreadTs,
      })
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.status, "pending"),
          isNotNull(scheduledTasks.slackThreadTs),
        ),
      );
    return rows.filter(
      (r): r is typeof r & { slackThreadTs: string } => r.slackThreadTs !== null,
    );
  }

  /** Tasks that have been classified and scheduled but not yet placed on Google Calendar */
  async function listTasksForCalendarPlacement(): Promise<
    Array<{ id: string; companyId: string; scheduledAt: Date; durationMinutes: number | null; kind: string | null }>
  > {
    const rows = await db
      .select({
        id: scheduledTasks.id,
        companyId: scheduledTasks.companyId,
        scheduledAt: scheduledTasks.scheduledAt,
        durationMinutes: scheduledTasks.durationMinutes,
        kind: scheduledTasks.kind,
      })
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.status, "scheduled"),
          isNull(scheduledTasks.calendarEventId),
          isNotNull(scheduledTasks.scheduledAt),
        ),
      );
    return rows.filter(
      (r): r is typeof r & { scheduledAt: Date } => r.scheduledAt !== null,
    );
  }

  /** Tasks scheduled for today (has calendarEventId and scheduledAt today) */
  async function listTasksForToday(companyId: string, start: Date, end: Date) {
    const rows = await db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.companyId, companyId),
          eq(scheduledTasks.status, "scheduled"),
        ),
      );
    return rows.filter((r) => {
      if (!r.scheduledAt) return false;
      return r.scheduledAt >= start && r.scheduledAt <= end;
    });
  }

  async function createPreplaced(input: {
    companyId: string;
    userId: string;
    requestText: string;
    title: string;
    scheduledAt: Date;
    durationMinutes: number;
    kind?: string | null;
    notes?: string | null;
    origin?: string | null;
  }) {
    const [task] = await db
      .insert(scheduledTasks)
      .values({
        companyId: input.companyId,
        userId: input.userId,
        requestText: input.requestText,
        title: input.title,
        scheduledAt: input.scheduledAt,
        durationMinutes: input.durationMinutes,
        kind: input.kind ?? null,
        notes: input.notes ?? null,
        origin: input.origin ?? "preplaced",
        status: "scheduled",
      })
      .returning();
    return task;
  }

  return {
    list,
    create,
    createPreplaced,
    getById,
    update,
    remove,
    addThread,
    listThreads,
    listPendingSlackTasks,
    listTasksForCalendarPlacement,
    listTasksForToday,
  };
}
