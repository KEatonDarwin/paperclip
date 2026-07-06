// Client for the Universal Bug/Task Intake API (DAR-688). Thin surface over the Foreman Job
// API — submit a bug/task (Ctrl+Shift+B) and list submission outcomes. Auth is the board
// session cookie (assertBoard on the server), so all calls use credentials: "include".

export type IntakeJobType = "bug_fix" | "build";

export interface IntakeSubmitInput {
  companyId: string;
  repo: string;
  text: string;
  jobType?: IntakeJobType;
  context?: string | null;
  source?: string;
  ref?: string | null;
  run?: boolean;
  foremanProjectId?: string;
}

export interface IntakeSubmitResponse {
  submission_id: string;
  source: string;
  status: string;
  running: boolean;
  status_url: string;
  run_url: string;
  outcomes_url: string;
}

export interface IntakeOutcome {
  submission_id: string;
  source: string;
  ref: string | null;
  text: string;
  repo: string | null;
  job_type: string;
  status: string;
  verify_result: string | null;
  pr_url: string | null;
  summary: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  status_url: string;
}

async function parseError(res: Response, fallback: string): Promise<never> {
  const payload = (await res.json().catch(() => null)) as
    | { error?: string | { message?: string } }
    | null;
  const err = payload?.error;
  const message = typeof err === "string" ? err : err?.message;
  throw new Error(message ?? `${fallback} (${res.status})`);
}

export const intakeApi = {
  submit: async (input: IntakeSubmitInput): Promise<IntakeSubmitResponse> => {
    const res = await fetch("/api/v1/intake", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        company_id: input.companyId,
        repo: input.repo,
        text: input.text,
        job_type: input.jobType ?? "bug_fix",
        source: input.source ?? "hotkey",
        ref: input.ref ?? null,
        context: input.context ?? null,
        ...(input.run != null ? { run: input.run } : {}),
        ...(input.foremanProjectId ? { foreman_project_id: input.foremanProjectId } : {}),
      }),
    });
    if (!res.ok) return parseError(res, "Failed to submit intake");
    return res.json();
  },

  list: async (companyId: string, opts?: { source?: string; limit?: number }): Promise<IntakeOutcome[]> => {
    const params = new URLSearchParams({ companyId });
    if (opts?.source) params.set("source", opts.source);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const res = await fetch(`/api/v1/intake?${params.toString()}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return parseError(res, "Failed to load intake outcomes");
    const payload = (await res.json()) as { outcomes?: IntakeOutcome[] };
    return payload.outcomes ?? [];
  },
};
