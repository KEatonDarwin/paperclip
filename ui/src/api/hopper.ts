import { api } from "./client";

export type HopperKind = "bug" | "feature" | null;

export interface HopperItem {
  id: string;
  companyId: string;
  userId: string;
  prompt: string;
  status: "processing" | "needs_info" | "created" | "done" | "cancelled";
  kind: HopperKind;
  question: string | null;
  linkedIssueId: string | null;
  linkedIssueIdentifier: string | null;
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

  create: (companyId: string, prompt: string) =>
    api.post<HopperItem>(`/companies/${companyId}/hopper`, { prompt }),

  update: (itemId: string, data: { dismissed?: boolean; status?: string }) =>
    api.patch<HopperItem>(`/hopper/${itemId}`, data),

  remove: (itemId: string) =>
    api.delete<void>(`/hopper/${itemId}`),

  listThreads: (itemId: string) =>
    api.get<HopperThread[]>(`/hopper/${itemId}/threads`),

  addThread: (itemId: string, body: string) =>
    api.post<HopperThread>(`/hopper/${itemId}/threads`, { body }),
};
