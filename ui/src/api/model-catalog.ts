import type { ProviderModel, ProviderStatus, LlmProvider } from "@paperclipai/shared";
import { api } from "./client";

export const modelCatalogApi = {
  list: (companyId: string) => api.get<ProviderModel[]>(`/companies/${companyId}/model-catalog`),
  providers: (companyId: string) =>
    api.get<ProviderStatus[]>(`/companies/${companyId}/model-catalog/providers`),
  refresh: (companyId: string, provider: LlmProvider) =>
    api.post<{ refreshed: boolean; count: number }>(`/companies/${companyId}/model-catalog/refresh`, {
      provider,
    }),
  create: (
    companyId: string,
    data: { provider: LlmProvider; modelKey: string; displayName: string; contextWindow?: number | null },
  ) => api.post<ProviderModel>(`/companies/${companyId}/model-catalog/models`, data),
  update: (
    companyId: string,
    id: string,
    data: { displayName?: string; isActive?: boolean; contextWindow?: number | null },
  ) => api.patch<ProviderModel>(`/companies/${companyId}/model-catalog/models/${id}`, data),
  remove: (companyId: string, id: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/model-catalog/models/${id}`),
};
