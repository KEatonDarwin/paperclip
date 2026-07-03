export type BuildInfo = {
  serverVersion: string;
  serverStartedAt: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  git: {
    commitHash: string;
    commitShortHash: string;
    commitMessage: string;
    commitAuthor: string;
    commitDate: string;
    branch: string;
  } | null;
};

export const buildInfoApi = {
  get: async (): Promise<BuildInfo> => {
    const res = await fetch("/api/build-info", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Failed to load build info (${res.status})`);
    }
    return res.json();
  },
};
