import type { LlmProvider, ProviderModelSource } from "../constants.js";

export interface ProviderModel {
  id: string;
  companyId: string;
  provider: LlmProvider;
  modelKey: string;
  displayName: string;
  source: ProviderModelSource;
  contextWindow: number | null;
  isActive: boolean;
  createdByUserId: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderStatus {
  provider: LlmProvider;
  label: string;
  configured: boolean;
  secretName: string | null;
  builtInModelCount: number;
  discoveredModelCount: number;
  manualModelCount: number;
  lastRefreshedAt: Date | null;
}
