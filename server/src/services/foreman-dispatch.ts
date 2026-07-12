// Foreman production worker dispatcher (DAR-687, Phase 1).
// Implements the WorkerDispatcher seam against the real Paperclip agent runtime: each Task
// becomes a child issue assigned to a generic coder agent (ClaudeCoder / CodexCoder / AuggieCoder),
// woken via heartbeat, running in its own git worktree/branch. No new pipeline — reuses the
// existing issue-execution + worktree runtime ("same code path" discipline).
//
// LIVE-WIRING REQUIREMENTS (deployment facts, not guessable — see DAR-687 comment):
//   1. A Foreman "project" the worker issues are created under (config.foremanProjectId).
//   2. Isolated-workspaces experimental flag ON + the project/issue workspace strategy set to
//      git_worktree, else workers share one cwd and parallel isolation is lost.
//   3. The worker agents must be able to reach config.repo on the host.
import { basename } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { issueService, heartbeatService, projectService } from "./index.js";
import { listBranchesMatching, branchHasCommitsAhead } from "./foreman-git.js";
import { getPlaybook } from "./foreman-playbooks.js";
import type { WorkerDispatcher, DispatchHandle, PollState, JobRow, JobTaskRow } from "./foreman.js";

// Build the worker's brief. Pure + exported so the job_type playbook injection is unit-testable
// without the live agent runtime. The playbook (bug_fix vs build) is sideloaded up top so the
// worker follows the right process; the task instruction + repo/base + retry context follow.
export function composeWorkerBrief(job: JobRow, task: JobTaskRow, retryContext?: string): string {
  const playbook = getPlaybook(job.jobType);
  return (
    `Foreman task for job ${job.id} (seq ${task.seq}).\n\n` +
    `Repo: ${job.repo}\nBase: ${job.baseBranch}\n\n` +
    `--- PLAYBOOK (${playbook.label}) ---\n${playbook.instructions}\n---\n\n` +
    `Instruction:\n${task.instruction}\n\n` +
    (job.context ? `Context:\n${job.context}\n\n` : "") +
    (retryContext ? `RETRY — ${retryContext}\n\n` : "") +
    `Commit your work to this issue's worktree branch. Do NOT merge to ${job.baseBranch}.`
  );
}

// Generic coder worker agents (Darwin company). worker_type -> agentId.
export const DEFAULT_WORKER_AGENTS: Record<string, string> = {
  claude: "128dc679-00dc-4915-a3f5-1e3cc0c4f5dd", // ClaudeCoder (claude_local)
  codex: "ef0261c7-5c3a-42c9-9139-c932daa9cbcf", // CodexCoder (codex_local)
  auggie: "e6973adf-d293-4dcb-923a-85b6a946cf33", // AuggieCoder (auggie_local)
};

// Known repo name -> absolute local path registry (deployment fact, same "operator-owned" shape
// as DEFAULT_WORKER_AGENTS above). DAR-714: `job.repo` is a public API param (repo *name*, e.g.
// "darwin-assistant") but every git-engine op in foreman-git.ts, and the worker's own execution
// workspace, need a real filesystem path. Resolve name -> path once at job-creation time (see
// resolveRepoPath, called from routes/intake.ts + routes/jobs.ts) so `job.repo` is stored as an
// absolute path from the start and every downstream consumer — dispatch's workspace resolution
// below, and Foreman's own integrate/verify/merge steps — sees one consistent, correct value.
export const DEFAULT_REPO_WORKSPACES: Record<string, string> = {
  "url-shortener": "/home/kevin/projects/url-shortener",
  paperclip: "/home/kevin/paperclip",
  "darwin-assistant": "/home/kevin/projects/darwin-assistant-dar666",
};

// Resolve a repo API param to an absolute filesystem path. Already-absolute paths pass through
// unchanged (existing callers — e.g. the DAR-711 auto-merge tests — already submit real repo
// paths directly). Otherwise looks the name up in the registry; throws on an unknown name rather
// than silently falling back to something else, since that's exactly the failure mode this
// ticket exists to close.
export function resolveRepoPath(repo: string, overrides?: Record<string, string>): string {
  if (repo.startsWith("/")) return repo;
  const registry = { ...DEFAULT_REPO_WORKSPACES, ...(overrides ?? {}) };
  const path = registry[repo.toLowerCase()];
  if (!path) {
    throw new Error(
      `Foreman: unknown repo "${repo}" — add it to the repo workspace registry ` +
        "(DEFAULT_REPO_WORKSPACES in foreman-dispatch.ts) or submit an absolute repo path instead.",
    );
  }
  return path;
}

// Resolve the project workspace whose cwd actually points at repoPath (an absolute path by the
// time it gets here — see resolveRepoPath), instead of letting issue creation silently fall back
// to the Foreman project's primary/default workspace (DAR-714). Reuses an existing workspace
// with a matching cwd under the Foreman project if one exists; otherwise creates one. Pure over
// (db, foremanProjectId, repoPath) — no heartbeat/issue side effects — so it's unit-testable
// without triggering the live agent runtime, same discipline as composeWorkerBrief above.
export async function resolveProjectWorkspaceId(db: Db, foremanProjectId: string, repoPath: string): Promise<string> {
  const projectsSvc = projectService(db);
  const existingWorkspaces = await projectsSvc.listWorkspaces(foremanProjectId);
  const existing = existingWorkspaces.find((w) => w.cwd === repoPath);
  if (existing) return existing.id;

  const created = await projectsSvc.createWorkspace(foremanProjectId, {
    name: basename(repoPath),
    cwd: repoPath,
    sourceType: "local_path",
    isPrimary: false,
  });
  if (!created) {
    throw new Error(`Foreman: failed to create a project workspace for repo path "${repoPath}"`);
  }
  return created.id;
}

export interface PaperclipDispatcherConfig {
  companyId: string;
  foremanProjectId: string; // project the worker issues are created under
  workerAgents?: Record<string, string>; // worker_type -> agentId (defaults to DEFAULT_WORKER_AGENTS)
  defaultWorkerType?: string; // default 'claude'
  foremanAgentId?: string; // acting agent for wakeup attribution
}

export function paperclipAgentDispatcher(db: Db, config: PaperclipDispatcherConfig): WorkerDispatcher {
  const issuesSvc = issueService(db);
  const heartbeat = heartbeatService(db);
  const workerAgents = { ...DEFAULT_WORKER_AGENTS, ...(config.workerAgents ?? {}) };
  const defaultWorkerType = config.defaultWorkerType ?? "claude";

  function resolveAgentId(workerType: string | null | undefined): string {
    const key = (workerType ?? defaultWorkerType).toLowerCase();
    return workerAgents[key] ?? workerAgents[defaultWorkerType] ?? DEFAULT_WORKER_AGENTS.claude;
  }

  return {
    async dispatch(job: JobRow, task: JobTaskRow, retryContext?: string): Promise<DispatchHandle> {
      const agentId = resolveAgentId(task.workerType);
      const description = composeWorkerBrief(job, task, retryContext);
      const projectWorkspaceId = await resolveProjectWorkspaceId(db, config.foremanProjectId, job.repo);

      const issue = await issuesSvc.create(config.companyId, {
        projectId: config.foremanProjectId,
        projectWorkspaceId,
        title: `Foreman: ${task.instruction.slice(0, 72)}`,
        description,
        status: "in_progress",
        assigneeAgentId: agentId,
        originKind: "manual",
        // Request an isolated git-worktree workspace pinned to the job's base branch, so the
        // worker's worktree can't silently inherit whatever HEAD the shared clone happens to
        // have checked out. Ignored unless the isolated-workspaces flag is on (see file header).
        executionWorkspacePreference: "isolated",
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: {
            type: "git_worktree",
            baseRef: job.baseBranch,
            branchTemplate: "{{issue.identifier}}-{{slug}}",
          },
        },
      } as Parameters<typeof issuesSvc.create>[1]);

      await heartbeat
        .wakeup(agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "foreman_task",
          payload: { issueId: issue.id, jobId: job.id, taskId: task.id },
          requestedByActorType: "agent",
          requestedByActorId: config.foremanAgentId ?? agentId,
          contextSnapshot: { issueId: issue.id },
        })
        .catch(() => {});

      return {
        // Branch is resolved at poll time from the issue identifier (worktree names it
        // `{{issue.identifier}}-{{slug}}`, slug not caller-controlled).
        branch: "",
        issueId: issue.id,
        workerAgentId: agentId,
      };
    },

    async poll(job: JobRow, _task: JobTaskRow, handle: DispatchHandle): Promise<PollState> {
      if (!handle.issueId) return { state: "failed", error: "no issue id on dispatch handle" };
      const [issue] = await db.select().from(issues).where(eq(issues.id, handle.issueId)).limit(1);
      if (!issue) return { state: "failed", error: "worker issue vanished" };

      // Terminal-failure states.
      if (issue.status === "cancelled") return { state: "failed", error: "worker issue cancelled" };

      // Resolve the worker's branch by identifier prefix.
      const branch = listBranchesMatching(job.repo, `${issue.identifier}`)[0] ?? "";

      // Consider the task done when the worker finished (issue moved out of in_progress) AND
      // its branch has commits ahead of base. This keeps us honest: a finished run with no
      // commits is a failure, not a silent success.
      const finished = issue.status === "in_review" || issue.status === "done";
      if (finished) {
        if (branch && branchHasCommitsAhead(job.repo, job.baseBranch, branch)) {
          return { state: "done", branch };
        }
        return { state: "failed", error: `worker finished but produced no commits on ${branch || "(no branch)"}` };
      }

      // Surface a hard run error if the latest run for this agent errored on this issue.
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, handle.workerAgentId ?? ""), eq(heartbeatRuns.status, "failed")))
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      if (run && run.contextSnapshot && (run.contextSnapshot as Record<string, unknown>).issueId === issue.id) {
        return { state: "failed", error: run.error ?? "worker run failed" };
      }

      return { state: "running" };
    },
  };
}
