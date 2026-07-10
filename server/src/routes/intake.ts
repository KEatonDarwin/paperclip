// Universal Bug/Task Intake API (DAR-688, Phase 1). A thin, per-caller-authed, ergonomic
// surface over the Foreman Job API (DAR-687): POST /api/v1/intake submits a bug/task →
// opens a Foreman Job; GET /api/v1/intake lists submissions+outcomes (status, verify, PR link).
//
// Design notes:
//  - The durable submission log IS the jobs table — no separate table/migration. The
//    caller/source tag is namespaced into `external_ref` as `intake:<source>[:<ref>]`, so
//    intake-originated jobs are filterable and attributable without a schema change.
//  - Programmatic callers (JARVIS, the DAR-685 UX reviewer, other chats) POST here too — the
//    hotkey (Ctrl+Shift+B) widget is just one caller. Repo is a parameter → portable/droppable.
//  - Async submit/poll, mirroring DAR-666/DAR-665. Auto-run is OPT-IN: it only fires when a
//    `foreman_project_id` (+ worker pool) is supplied — deployment facts owned by the operator.
//    Default is submit-to-`planning`, which is fully functional standalone.
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { JobRow } from "../services/foreman.js";
import { validate } from "../middleware/validate.js";
import { foremanService, DEFAULT_VERIFY_COMMAND } from "../services/foreman.js";
import { paperclipAgentDispatcher, resolveRepoPath, DEFAULT_WORKER_AGENTS } from "../services/foreman-dispatch.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const INTAKE_PREFIX = "intake:";

// Encode a submission's caller/source (+ optional idempotency ref) into external_ref, so the
// jobs table doubles as the intake log. e.g. source='ux_reviewer', ref='DAR-685#42' →
// "intake:ux_reviewer:DAR-685#42".
function encodeExternalRef(source: string, ref?: string | null): string {
  return `${INTAKE_PREFIX}${source}${ref ? `:${ref}` : ""}`;
}

// Inverse of encodeExternalRef. Returns null for non-intake jobs (raw Job API callers).
function parseExternalRef(externalRef: string | null): { source: string; ref: string | null } | null {
  if (!externalRef || !externalRef.startsWith(INTAKE_PREFIX)) return null;
  const rest = externalRef.slice(INTAKE_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep === -1) return { source: rest, ref: null };
  return { source: rest.slice(0, sep), ref: rest.slice(sep + 1) || null };
}

// Project a Job into the intake outcome view the widget's list + programmatic callers consume.
function toOutcome(job: JobRow) {
  const tag = parseExternalRef(job.externalRef);
  return {
    submission_id: job.id,
    source: tag?.source ?? "api",
    ref: tag?.ref ?? null,
    text: job.ask,
    repo: job.repo,
    job_type: job.jobType,
    status: job.status,
    verify_result: job.verifyResult,
    pr_url: job.prUrl,
    merge_commit_sha: job.mergeCommitSha,
    base_branch: job.baseBranch,
    summary: job.summary,
    error: job.errorMessage,
    created_at: job.createdAt,
    completed_at: job.completedAt,
    status_url: `/api/v1/jobs/${job.id}`,
  };
}

const submitSchema = z.object({
  company_id: z.string().uuid(),
  repo: z.string().min(1),
  text: z.string().min(1), // the bug/task description → Job.ask
  // Intake defaults to 'bug_fix' (the "submit a bug → Paperclip fixes it" loop); pass 'build'
  // for feature/chip work. Sideloads the matching Foreman playbook (DAR-687).
  job_type: z.enum(["build", "bug_fix"]).optional(),
  context: z.string().nullable().optional(),
  source: z.string().min(1).max(64).optional(), // caller label: 'hotkey' | 'jarvis' | 'ux_reviewer' | ...
  ref: z.string().max(128).nullable().optional(), // caller idempotency / label
  base_branch: z.string().optional(),
  workers: z.number().int().min(1).max(3).optional(),
  // Opt-in auto-run. Only fires when foreman_project_id is present (deployment fact); otherwise
  // the submission stays in 'planning' and can be run later via POST /api/v1/jobs/:id/run.
  run: z.boolean().optional(),
  foreman_project_id: z.string().uuid().optional(),
  worker_agents: z.record(z.string(), z.string().uuid()).optional(),
  foreman_agent_id: z.string().uuid().optional(),
  verify_command: z.string().nullable().optional(),
});

export function intakeRoutes(db: Db) {
  const router = Router();
  const foreman = foremanService(db);

  // Submit a bug/task. Opens a Foreman Job (planning), tagged as intake-originated. Optionally
  // kicks the orchestrator if deployment facts are supplied. Returns immediately (async).
  router.post("/v1/intake", validate(submitSchema), async (req, res) => {
    const companyId = req.body.company_id as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const source = (req.body.source as string | undefined) ?? "api";
    const actorUserId = (req.actor as { userId?: string }).userId ?? null;

    // DAR-714: resolve the repo *name* the caller submitted (e.g. "darwin-assistant") to an
    // absolute path up front, so job.repo is stored as a real path — the one thing every
    // downstream consumer (Foreman's git-engine, and the worker's own execution workspace) needs.
    let repoPath: string;
    try {
      repoPath = resolveRepoPath(req.body.repo);
    } catch (err) {
      res.status(400).json({ error: { code: "unknown_repo", message: (err as Error).message } });
      return;
    }

    const { job } = await foreman.createJob(companyId, {
      repo: repoPath,
      ask: req.body.text,
      baseBranch: req.body.base_branch,
      jobType: req.body.job_type ?? "bug_fix",
      context: req.body.context ?? null,
      maxWorkers: req.body.workers ?? 1,
      externalRef: encodeExternalRef(source, req.body.ref ?? null),
      createdByUserId: actorUserId,
    });

    // Opt-in auto-run: mirror POST /api/v1/jobs/:id/run, fire-and-forget. Requires the operator
    // to pass a foreman_project_id; without it we leave the submission in 'planning'.
    const wantsRun = req.body.run === true && typeof req.body.foreman_project_id === "string";
    if (wantsRun) {
      const dispatcher = paperclipAgentDispatcher(db, {
        companyId,
        foremanProjectId: req.body.foreman_project_id,
        workerAgents: { ...DEFAULT_WORKER_AGENTS, ...(req.body.worker_agents ?? {}) },
        foremanAgentId: req.body.foreman_agent_id,
      });
      foreman
        .runJob(job.id, { dispatcher, verifyCommand: req.body.verify_command ?? DEFAULT_VERIFY_COMMAND })
        .catch((err: unknown) => console.error("[intake] runJob unhandled error", err));
    }

    res.status(wantsRun ? 202 : 201).json({
      submission_id: job.id,
      source,
      status: wantsRun ? "dispatching" : job.status,
      running: wantsRun,
      status_url: `/api/v1/jobs/${job.id}`,
      run_url: `/api/v1/jobs/${job.id}/run`,
      outcomes_url: `/api/v1/intake?companyId=${companyId}`,
    });
  });

  // List intake submissions + outcomes for a company (what Foreman changed, result, PR link).
  // Only intake-originated jobs (external_ref prefixed `intake:`); optionally filter by source.
  router.get("/v1/intake", async (req, res) => {
    const companyId = req.query.companyId as string | undefined;
    if (!companyId) {
      res.status(400).json({ error: { code: "company_id_required", message: "companyId query param required" } });
      return;
    }
    assertCompanyAccess(req, companyId);

    const sourceFilter = req.query.source as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    // Over-fetch then filter to intake-originated so offset/limit still page the full set.
    const rows = await foreman.listJobs(companyId, { limit: limit + offset + 50, offset: 0 });
    const outcomes = rows
      .filter((j) => parseExternalRef(j.externalRef) !== null)
      .filter((j) => !sourceFilter || parseExternalRef(j.externalRef)?.source === sourceFilter)
      .slice(offset, offset + limit)
      .map(toOutcome);

    res.json({ outcomes });
  });

  return router;
}

// Exported for unit tests (ref round-trip is the intake↔jobs seam).
export const _internals = { encodeExternalRef, parseExternalRef };
