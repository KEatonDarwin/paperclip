import { api } from "./client";

export interface Webhook {
  id: string;
  companyId: string;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  hasSecret: boolean;
  events: string[];
  scope: string;
  scopeId: string | null;
  excludeActorIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: "pending" | "retrying" | "succeeded" | "failed";
  attempt: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface CreateWebhookData {
  name: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  secret?: string;
  events: string[];
  scope?: string;
  scopeId?: string | null;
  excludeActorIds?: string[];
  enabled?: boolean;
}

export interface UpdateWebhookData {
  name?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  secret?: string | null;
  events?: string[];
  scope?: string;
  scopeId?: string | null;
  excludeActorIds?: string[];
  enabled?: boolean;
}

export const webhooksApi = {
  list: (companyId: string) =>
    api.get<Webhook[]>(`/companies/${companyId}/webhooks`),
  create: (companyId: string, data: CreateWebhookData) =>
    api.post<Webhook>(`/companies/${companyId}/webhooks`, data),
  get: (id: string) =>
    api.get<Webhook>(`/webhooks/${id}`),
  update: (id: string, data: UpdateWebhookData) =>
    api.patch<Webhook>(`/webhooks/${id}`, data),
  remove: (id: string) =>
    api.delete<void>(`/webhooks/${id}`),
  deliveries: (id: string, limit = 50, offset = 0) =>
    api.get<WebhookDelivery[]>(`/webhooks/${id}/deliveries?limit=${limit}&offset=${offset}`),
  test: (id: string) =>
    api.post<{ deliveryId: string; status: string }>(`/webhooks/${id}/test`, {}),
};
