// Foreman — Universal Coding Orchestrator (DAR-687 Phase 1, DAR-711 Phase 2 auto-merge).
// Job → Plan → Tasks → Integrate → Verify → Merge. Serial-first. Worker agents never merge to
// main directly — only Foreman itself does, and only after the integration branch has passed
// the verify gate (see DEFAULT_VERIFY_COMMAND). No PR step; the merge commit is the report.
//
// The orchestrator is dispatcher-agnostic: `runJob` takes a WorkerDispatcher, so the loop
// can be exercised end-to-end with a scripted in-test worker on a scratch repo, and run in
// production against the real Paperclip agent runtime (see foreman-dispatch.ts).
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { jobs, jobTasks } from "@paperclipai/db";
import {
  integrateBranches,
  runVerify,
  diffSummary,
  addForemanNote,
  replayTrail,
  mergeToBase,
  type IntegrationResult,
  type VerifyResult,
} from "./foreman-git.js";
import { normalizeJobType } from "./foreman-playbooks.js";

export type JobRow = typeof jobs.$inferSelect;
export type JobTaskRow = typeof jobTasks.$inferSelect;

// Phase 2 (DAR-711): auto-merge has no PR/human review left as a safety net, so a caller-omitted
// verify_command must NOT fall through to "skipped" (that would auto-merge unverified changes).
// Callers can still override with a stricter/different command; this is only the floor.
export const DEFAULT_VERIFY_COMMAND = "pnpm typecheck && pnpm build";

export interface CreateJobInput {
  repo: string;
  ask: string;
  baseBranch?: string;
  jobType?: string | null; // 'build' (default) | 'bug_fix' — sideloads a playbook (foreman-playbooks.ts)
  context?: string | null;
  workerType?: string | null;
  maxWorkers?: number;
  externalRef?: string | null;
  createdByUserId?: string | null;
  createdByAgentId?: string | null;
  // Phase 1 decomposition is caller-supplied (conservative, hand-obvious splits). If omitted,
  // the whole ask becomes a single serial task. No auto/LLM planner yet (that is Phase 2).
  tasks?: Array<{
    instruction: string;
    workerType?: string | null;
    flavor?: string; // 'generic' | 'chip'
    dependsOnSeq?: number | null;
  }>;
}

// The seam where a worker coder agent actually does the work on the task's branch.
export interface DispatchHandle {
  branch: string;
  issueId?: string | null;
  runId?: string | null;
  workerAgentId?: string | null;
}
export type PollState =
  | { state: "running" }
  | { state: "done"; branch: string; diff?: string }
  | { state: "failed"; error: string };

export interface WorkerDispatcher {
  // Kick off a worker for this task. Must create/own a branch off the job base and return it.
  dispatch(job: JobRow, task: JobTaskRow, retryContext?: string): Promise<DispatchHandle>;
  // Poll the worker until it commits to its branch (done) or fails.
  poll(job: JobRow, task: JobTaskRow, handle: DispatchHandle): Promise<PollState>;
}

export interface RunJobOptions {
  dispatcher: WorkerDispatcher;
  verifyCommand?: string | null; // build/typecheck/test command run on the integrated branch
  pollIntervalMs?: number;
  taskTimeoutMs?: number;
  now?: () => Date; // injectable clock for tests (avoids Date.now in hot paths)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Git-notes trail rendering (HORIZON §1) — pure, so unit-exercisable ------------
function clip(s: string, max: number): string {
  const t = (s ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

// The per-task note: seq, instruction, how many attempts it took, and the produced diff.
// Passed attempts are 0-based (attempt 0 = first try), so attempts = attempt + 1.
export function renderTaskNote(task: JobTaskRow, attempt: number, diff: string): string {
  return [
    `foreman-task seq=${task.seq} flavor=${task.flavor} status=committed`,
    `attempts: ${attempt + 1}${attempt > 0 ? " (retried)" : ""}`,
    `instruction: ${clip(task.instruction, 200)}`,
    `diff:`,
    clip(diff || "(no diff)", 1200),
  ].join("\n");
}

// The verify note on the integration commit: the gate verdict + latency + output tail.
export function renderVerifyNote(result: string, verify: VerifyResult, latencyMs: number): string {
  return [
    `foreman-verify result=${result} exit=${verify.exitCode ?? "null"} latency_ms=${latencyMs}`,
    `output:`,
    clip(verify.output || "(no output)", 2000),
  ].join("\n");
}

export function foremanService(db: Db) {
  const store = {
    async createJob(companyId: string, input: CreateJobInput): Promise<{ job: JobRow; tasks: JobTaskRow[] }> {
      const [job] = await db
        .insert(jobs)
        .values({
          companyId,
          repo: input.repo,
          ask: input.ask,
          baseBranch: input.baseBranch ?? "master",
          jobType: normalizeJobType(input.jobType),
          context: input.context ?? null,
          workerType: input.workerType ?? null,
          maxWorkers: input.maxWorkers ?? 1,
          externalRef: input.externalRef ?? null,
          createdByUserId: input.createdByUserId ?? null,
          createdByAgentId: input.createdByAgentId ?? null,
          status: "planning",
        })
        .returning();

      const taskSpecs =
        input.tasks && input.tasks.length > 0
          ? input.tasks
          : [{ instruction: input.ask, workerType: input.workerType ?? null }];

      const taskRows = await db
        .insert(jobTasks)
        .values(
          taskSpecs.map((t, i) => ({
            jobId: job.id,
            seq: i,
            instruction: t.instruction,
            flavor: t.flavor ?? "generic",
            workerType: t.workerType ?? input.workerType ?? null,
            dependsOnSeq: t.dependsOnSeq ?? null,
            status: "pending",
          })),
        )
        .returning();

      return { job, tasks: taskRows };
    },

    async getJob(id: string): Promise<JobRow | null> {
      const rows = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
      return rows[0] ?? null;
    },

    async getTasks(jobId: string): Promise<JobTaskRow[]> {
      return db.select().from(jobTasks).where(eq(jobTasks.jobId, jobId)).orderBy(jobTasks.seq);
    },

    async getJobTree(id: string): Promise<{ job: JobRow; tasks: JobTaskRow[] } | null> {
      const job = await store.getJob(id);
      if (!job) return null;
      return { job, tasks: await store.getTasks(id) };
    },

    async listJobs(companyId: string, opts: { limit?: number; offset?: number } = {}): Promise<JobRow[]> {
      return db
        .select()
        .from(jobs)
        .where(eq(jobs.companyId, companyId))
        .orderBy(desc(jobs.createdAt))
        .limit(opts.limit ?? 50)
        .offset(opts.offset ?? 0);
    },

    async updateJob(id: string, patch: Partial<JobRow>): Promise<JobRow | null> {
      const [row] = await db
        .update(jobs)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(jobs.id, id))
        .returning();
      return row ?? null;
    },

    async updateTask(id: string, patch: Partial<JobTaskRow>): Promise<JobTaskRow | null> {
      const [row] = await db
        .update(jobTasks)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(jobTasks.id, id))
        .returning();
      return row ?? null;
    },
  };

  // The orchestration loop. Serial in Phase 1 (build the loop, prove it, then add parallel).
  async function runJob(jobId: string, opts: RunJobOptions): Promise<JobRow> {
    const pollInterval = opts.pollIntervalMs ?? 5000;
    const taskTimeout = opts.taskTimeoutMs ?? 30 * 60_000;
    const now = opts.now ?? (() => new Date());

    let job = await store.getJob(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    const tasks = (await store.getTasks(jobId)).slice().sort((a, b) => a.seq - b.seq);

    try {
      // 1. Dispatch each task serially; worker commits to its own branch.
      await store.updateJob(jobId, { status: "dispatching" });
      const committed: JobTaskRow[] = [];
      for (const t of tasks) {
        const done = await dispatchWithRetry(job, t);
        if (!done) {
          const failed = await finishJob(jobId, "failed", `task ${t.seq} (${t.instruction.slice(0, 60)}) did not complete`);
          return failed;
        }
        committed.push(done);
      }

      // 2. Integrate committed branches in seq order into one integration branch.
      await store.updateJob(jobId, { status: "integrating" });
      const integrationBranch = `foreman/job-${jobId.slice(0, 8)}-integration`;
      const branches = committed.filter((t) => t.branch).map((t) => t.branch as string);
      const integration: IntegrationResult = integrateBranches(job.repo, job.baseBranch, integrationBranch, branches);
      await store.updateJob(jobId, { integrationBranch });
      if (!integration.allMerged) {
        const bad = integration.outcomes.find((o) => !o.merged);
        return await finishJob(jobId, "needs_review", `integration halted: ${bad?.message ?? "unknown"}`, { integrationBranch });
      }

      // 3. Verify the integrated result (build/typecheck/test gate).
      await store.updateJob(jobId, { status: "verifying" });
      const verifyStart = now().getTime();
      const verify = runVerify(job.repo, opts.verifyCommand, taskTimeout);
      const verifyLatencyMs = Math.max(0, now().getTime() - verifyStart);
      const verifyResult = verify.skipped ? "skipped" : verify.pass ? "pass" : "fail";
      // HORIZON §1: attach the job's verify verdict to the integration commit, so the
      // trail (git log --notes=foreman) is complete end-to-end. §3: latency is first-class.
      addForemanNote(job.repo, integrationBranch, renderVerifyNote(verifyResult, verify, verifyLatencyMs));
      if (!verify.pass && !verify.skipped) {
        return await finishJob(
          jobId,
          "needs_review",
          `verify failed on integration branch:\n${verify.output}`,
          { integrationBranch, verifyResult },
        );
      }
      // A skipped verify (no verify command supplied/configured) is not a passing gate — with
      // no PR/human review downstream, merging on a skip would ship unverified changes. Routes
      // default verifyCommand to DEFAULT_VERIFY_COMMAND so this should be rare in practice; a
      // caller that explicitly passes an empty verify_command lands here instead of auto-merging.
      if (verify.skipped) {
        return await finishJob(
          jobId,
          "needs_review",
          "verify was skipped (no verify command) — auto-merge requires a passing verify gate.",
          { integrationBranch, verifyResult },
        );
      }

      // 4. Merge. Phase 2 (DAR-711): Foreman merges its own verified work directly into
      // baseBranch — no PR, no human hand-off. Only reachable once verify has actually passed.
      const trail = replayTrail(job.repo, job.baseBranch, integrationBranch);
      const mergeResult = mergeToBase(job.repo, job.baseBranch, integrationBranch);
      if (!mergeResult.merged) {
        return await finishJob(
          jobId,
          "needs_review",
          `verify passed but merge into ${job.baseBranch} failed: ${mergeResult.message}`,
          { integrationBranch, verifyResult },
        );
      }
      const summary =
        `Foreman job complete. ${committed.length} task(s) integrated and merged into ${job.baseBranch} ` +
        `(${mergeResult.commitSha.slice(0, 8)}). Verify: ${verifyResult}. ${mergeResult.message}.` +
        (trail ? `\n\nRepair trail (git log --notes=foreman):\n${trail}` : "");
      const finished = await store.updateJob(jobId, {
        status: "merged",
        verifyResult,
        integrationBranch,
        mergeCommitSha: mergeResult.commitSha,
        mergedAt: now(),
        summary,
        completedAt: now(),
      });
      return finished as JobRow;
    } catch (err) {
      return await finishJob(jobId, "failed", `orchestrator error: ${(err as Error).message}`);
    }

    // --- helpers (closures over job/opts) ---

    // Dispatch a task, poll to completion, retry ONCE on worker failure (Phase-1 single retry).
    async function dispatchWithRetry(j: JobRow, task: JobTaskRow): Promise<JobTaskRow | null> {
      for (let attempt = 0; attempt <= 1; attempt++) {
        const retryContext =
          attempt === 0 ? undefined : `Previous attempt failed: ${task.errorMessage ?? "unknown"}. Fix and retry.`;
        await store.updateTask(task.id, { status: "dispatched", retryCount: attempt });
        const handle = await opts.dispatcher.dispatch(j, task, retryContext);
        await store.updateTask(task.id, {
          status: "running",
          branch: handle.branch,
          issueId: handle.issueId ?? null,
          runId: handle.runId ?? null,
          workerAgentId: handle.workerAgentId ?? null,
        });

        const outcome = await pollToCompletion(j, task, handle);
        if (outcome.state === "done") {
          const diff = outcome.diff ?? diffSummary(j.repo, j.baseBranch, outcome.branch);
          const updated = (await store.updateTask(task.id, {
            status: "committed",
            branch: outcome.branch,
            artifactDiff: diff,
          })) as JobTaskRow;
          // HORIZON §1: git-notes repair trail — the task commit records its own outcome.
          addForemanNote(j.repo, outcome.branch, renderTaskNote(task, attempt, diff));
          return updated;
        }
        // failed
        await store.updateTask(task.id, {
          status: attempt === 0 ? "pending" : "failed",
          errorMessage: outcome.state === "failed" ? outcome.error : "timed out",
        });
      }
      return null;
    }

    async function pollToCompletion(j: JobRow, task: JobTaskRow, handle: DispatchHandle): Promise<PollState> {
      const deadline = now().getTime() + taskTimeout;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const state = await opts.dispatcher.poll(j, task, handle);
        if (state.state !== "running") return state;
        if (now().getTime() > deadline) return { state: "failed", error: "task timed out" };
        await sleep(pollInterval);
      }
    }

    async function finishJob(
      id: string,
      status: string,
      message: string,
      extra: Partial<JobRow> = {},
    ): Promise<JobRow> {
      const isError = status === "failed";
      const patch: Partial<JobRow> = {
        status,
        summary: message,
        completedAt: now(),
        ...extra,
      };
      if (isError) patch.errorMessage = message;
      const row = await store.updateJob(id, patch);
      return row as JobRow;
    }
  }

  return { ...store, runJob };
}

export type ForemanService = ReturnType<typeof foremanService>;
