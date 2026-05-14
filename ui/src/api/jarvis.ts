import { api } from "./client";

export interface JarvisStatus {
  up: boolean;
  uptime: string | null;
  activeState: string | null;
  since: string | null;
  pid: number | null;
  memory: string | null;
  healthTime: string | null;
  uiPort: string;
}

export const jarvisApi = {
  status: (companyId: string) =>
    api.get<JarvisStatus>(`/companies/${companyId}/jarvis/status`),
  restart: (companyId: string) =>
    api.post<{ ok: boolean; killedPid: number }>(`/companies/${companyId}/jarvis/restart`, {}),
};
