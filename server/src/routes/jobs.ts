// Foreman Job API (DAR-687, Phase 1). Bearer-authed (global actorMiddleware) + company-scoped.
// Async: POST creates a Job (planning), POST /:id/run kicks the orchestrator in the background,
// GET polls the whole tree. Mirrors DAR-666/DAR-665 async submit/poll shapes.
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { foremanService } from "../services/foreman.js";
import { paperclipAgentDispatcher, DEFAULT_WORKER_AGENTS } from "../services/foreman-dispatch.js";
import { askForemanAboutJob, ForemanAskError } from "../services/foreman-ask.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const taskSchema = z.object({
  instruction: z.string().min(1),
  worker_type: z.string().optional(),
  flavor: z.enum(["generic", "chip"]).optional(),
  depends_on_seq: z.number().int().nonnegative().nullable().optional(),
});

const createSchema = z.object({
  company_id: z.string().uuid(),
  repo: z.string().min(1),
  ask: z.string().min(1),
  base_branch: z.string().optional(),
  job_type: z.enum(["build", "bug_fix"]).optional(), // sideloads a playbook (default 'build')
  context: z.string().nullable().optional(),
  worker_type: z.string().optional(),
  workers: z.number().int().min(1).max(3).optional(), // Phase-1 fan-out cap: 2-3 workers
  external_ref: z.string().nullable().optional(),
  tasks: z.array(taskSchema).max(3).optional(),
});

const askSchema = z.object({
  question: z.string().min(1).max(2000),
});

const runSchema = z.object({
  foreman_project_id: z.string().uuid(),
  verify_command: z.string().nullable().optional(),
  worker_agents: z.record(z.string(), z.string().uuid()).optional(),
  foreman_agent_id: z.string().uuid().optional(),
});

function jobTree(job: unknown, tasks: unknown[]) {
  return { job, tasks };
}

export function jobRoutes(db: Db) {
  const router = Router();
  const foreman = foremanService(db);

  // Create a Job (+ Tasks). Returns immediately in 'planning'. Call /:id/run to execute.
  router.post("/v1/jobs", validate(createSchema), async (req, res) => {
    const companyId = req.body.company_id as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const actorUserId = (req.actor as { userId?: string }).userId ?? null;
    const { job, tasks } = await foreman.createJob(companyId, {
      repo: req.body.repo,
      ask: req.body.ask,
      baseBranch: req.body.base_branch,
      jobType: req.body.job_type ?? null,
      context: req.body.context ?? null,
      workerType: req.body.worker_type ?? null,
      maxWorkers: req.body.workers ?? 1,
      externalRef: req.body.external_ref ?? null,
      createdByUserId: actorUserId,
      tasks: (req.body.tasks as z.infer<typeof taskSchema>[] | undefined)?.map((t) => ({
        instruction: t.instruction,
        workerType: t.worker_type ?? null,
        flavor: t.flavor,
        dependsOnSeq: t.depends_on_seq ?? null,
      })),
    });

    res.status(201).json({
      job_id: job.id,
      status: job.status,
      status_url: `/api/v1/jobs/${job.id}`,
      run_url: `/api/v1/jobs/${job.id}/run`,
      ...jobTree(job, tasks),
    });
  });

  // Kick the orchestrator (dispatch → integrate → verify → report). Fire-and-forget; poll GET.
  router.post("/v1/jobs/:id/run", validate(runSchema), async (req, res) => {
    const id = req.params.id as string;
    const job = await foreman.getJob(id);
    if (!job) {
      res.status(404).json({ error: { code: "job_not_found", message: "job not found" } });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, job.companyId);

    if (job.status !== "planning") {
      res.status(409).json({ error: { code: "job_not_runnable", message: `job is ${job.status}, not planning` } });
      return;
    }

    const dispatcher = paperclipAgentDispatcher(db, {
      companyId: job.companyId,
      foremanProjectId: req.body.foreman_project_id,
      workerAgents: { ...DEFAULT_WORKER_AGENTS, ...(req.body.worker_agents ?? {}) },
      foremanAgentId: req.body.foreman_agent_id,
    });

    foreman
      .runJob(id, { dispatcher, verifyCommand: req.body.verify_command ?? null })
      .catch((err: unknown) => console.error("[foreman] runJob unhandled error", err));

    res.status(202).json({ job_id: id, status: "dispatching", status_url: `/api/v1/jobs/${id}` });
  });

  // Poll the whole tree (tasks, workers, branches, verify results, pr url).
  router.get("/v1/jobs/:id", async (req, res) => {
    const id = req.params.id as string;
    const tree = await foreman.getJobTree(id);
    if (!tree) {
      res.status(404).json({ error: { code: "job_not_found", message: "job not found" } });
      return;
    }
    assertCompanyAccess(req, tree.job.companyId);
    res.json(jobTree(tree.job, tree.tasks));
  });

  // Phase 1 chat: single-shot, read-only Q&A grounded in the Job's own tree (DAR-720).
  // No persisted thread, no ability to steer a running Job — just an accurate answer.
  router.post("/v1/jobs/:id/ask", validate(askSchema), async (req, res) => {
    const id = req.params.id as string;
    const tree = await foreman.getJobTree(id);
    if (!tree) {
      res.status(404).json({ error: { code: "job_not_found", message: "job not found" } });
      return;
    }
    assertCompanyAccess(req, tree.job.companyId);

    try {
      const answer = await askForemanAboutJob(tree.job, tree.tasks, req.body.question as string);
      res.json({ answer });
    } catch (err) {
      if (err instanceof ForemanAskError) {
        const status = err.code === "missing_api_key" ? 501 : 502;
        res.status(status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  });

  // List jobs for a company.
  router.get("/v1/jobs", async (req, res) => {
    const companyId = req.query.companyId as string | undefined;
    if (!companyId) {
      res.status(400).json({ error: { code: "company_id_required", message: "companyId query param required" } });
      return;
    }
    assertCompanyAccess(req, companyId);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const rows = await foreman.listJobs(companyId, { limit, offset });
    res.json({ jobs: rows });
  });

  return router;
}
