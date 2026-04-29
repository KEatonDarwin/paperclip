import { api } from "./client";

export type ScheduledTaskKind = "task_personal" | "task_work" | "task_home" | "event" | "reminder" | null;
export type ScheduledTaskStatus = "pending" | "scheduled" | "completed" | "cancelled";

export interface ScheduledTask {
  id: string;
  companyId: string;
  userId: string;
  seqNum: number;
  identifier: string; // SCH-NNN
  requestText: string;
  title: string | null;
  kind: ScheduledTaskKind;
  status: ScheduledTaskStatus;
  scheduledAt: string | null;
  durationMinutes: number | null;
  deadlineAt: string | null;
  calendarEventId: string | null;
  slackThreadTs: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskThread {
  id: string;
  taskId: string;
  authorType: "user" | "agent";
  authorId: string;
  body: string;
  createdAt: string;
}

export const scheduledTasksApi = {
  list: (companyId: string) =>
    api.get<ScheduledTask[]>(`/companies/${companyId}/scheduled-tasks`),

  create: (companyId: string, requestText: string, deadlineAt?: string) =>
    api.post<ScheduledTask>(`/companies/${companyId}/scheduled-tasks`, {
      requestText,
      ...(deadlineAt ? { deadlineAt } : {}),
    }),

  get: (taskId: string) =>
    api.get<ScheduledTask>(`/scheduled-tasks/${taskId}`),

  update: (
    taskId: string,
    data: {
      status?: ScheduledTaskStatus;
      notes?: string;
      title?: string | null;
      kind?: ScheduledTaskKind;
      scheduledAt?: string | null;
      durationMinutes?: number | null;
      deadlineAt?: string | null;
    },
  ) => api.patch<ScheduledTask>(`/scheduled-tasks/${taskId}`, data),

  remove: (taskId: string) =>
    api.delete<void>(`/scheduled-tasks/${taskId}`),

  listThreads: (taskId: string) =>
    api.get<ScheduledTaskThread[]>(`/scheduled-tasks/${taskId}/threads`),

  addThread: (taskId: string, body: string) =>
    api.post<ScheduledTaskThread>(`/scheduled-tasks/${taskId}/threads`, { body }),
};
