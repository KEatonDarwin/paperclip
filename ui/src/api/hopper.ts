import { api } from "./client";

export type HopperTaskMode = "software" | "personal";
export type HopperKind = "bug" | "feature" | "task_personal" | "task_work" | "task_home" | "event" | "reminder" | null;

export interface HopperItem {
  id: string;
  companyId: string;
  userId: string;
  prompt: string;
  status: "processing" | "needs_info" | "created" | "done" | "cancelled";
  taskMode: HopperTaskMode;
  kind: HopperKind;
  question: string | null;
  linkedIssueId: string | null;
  linkedIssueIdentifier: string | null;
  scheduledAt: string | null;
  durationMinutes: number | null;
  calendarEventId: string | null;
  slackThreadTs: string | null;
  dismissed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HopperThread {
  id: string;
  itemId: string;
  authorType: "user" | "agent";
  authorId: string;
  body: string;
  createdAt: string;
}

export const hopperApi = {
  list: (companyId: string) =>
    api.get<HopperItem[]>(`/companies/${companyId}/hopper`),

  create: (companyId: string, prompt: string, mode: HopperTaskMode = "software") =>
    api.post<HopperItem>(`/companies/${companyId}/hopper`, { prompt, mode }),

  update: (itemId: string, data: { dismissed?: boolean; status?: string }) =>
    api.patch<HopperItem>(`/hopper/${itemId}`, data),

  remove: (itemId: string) =>
    api.delete<void>(`/hopper/${itemId}`),

  listThreads: (itemId: string) =>
    api.get<HopperThread[]>(`/hopper/${itemId}/threads`),

  addThread: (itemId: string, body: string) =>
    api.post<HopperThread>(`/hopper/${itemId}/threads`, { body }),
};
