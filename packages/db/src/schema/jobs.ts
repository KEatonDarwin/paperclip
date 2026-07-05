import { pgTable, uuid, text, timestamp, index, integer } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Foreman — Universal Coding Orchestrator (DAR-687, Phase 1).
// A Job is a natural-language coding request against a repo. Foreman decomposes it
// into one or more Tasks, dispatches each to a worker coder agent in its own git
// worktree/branch, integrates the branches in order, runs the repo's verify command,
// and reports back a single PR. Agents never merge to main.
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    externalRef: text("external_ref"), // caller-supplied idempotency / label
    repo: text("repo").notNull(), // absolute repo path (Phase 1) or registered repo key
    baseBranch: text("base_branch").notNull().default("master"),
    ask: text("ask").notNull(), // the natural-language job
    context: text("context"), // optional extra context bundle
    workerType: text("worker_type"), // default worker adapter for tasks (e.g. 'claude_local')
    maxWorkers: integer("max_workers").notNull().default(1), // Phase-1 fan-out cap (2-3 typical)
    // planning -> dispatching -> integrating -> verifying -> completed | needs_review | failed
    status: text("status").notNull().default("planning"),
    integrationBranch: text("integration_branch"), // branch the task branches merge into
    prUrl: text("pr_url"),
    verifyResult: text("verify_result"), // 'pass' | 'fail' | 'skipped'
    summary: text("summary"), // human-readable report
    errorMessage: text("error_message"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("jobs_company_status_idx").on(table.companyId, table.status),
    companyCreatedIdx: index("jobs_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

export const jobTasks = pgTable(
  "job_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull().default(0), // integration order (serial), 0-based
    instruction: text("instruction").notNull(),
    // Portability hinge: 'generic' worker, or 'chip' (routes to a ChipWarrior worker profile later).
    flavor: text("flavor").notNull().default("generic"),
    workerType: text("worker_type"), // adapter for this task (overrides job default)
    dependsOnSeq: integer("depends_on_seq"), // null => independent (parallelizable); else must follow that seq
    // pending -> dispatched -> running -> committed -> integrated | verify_failed | failed
    status: text("status").notNull().default("pending"),
    issueId: uuid("issue_id"), // backing Paperclip issue (worker dispatch); no FK — issue lifecycle is independent
    runId: uuid("run_id"), // heartbeat run id for the worker
    workerAgentId: uuid("worker_agent_id"),
    branch: text("branch"),
    worktreePath: text("worktree_path"),
    verifyResult: text("verify_result"), // 'pass' | 'fail' | 'skipped'
    artifactDiff: text("artifact_diff"), // short summary of the produced diff (files/±lines)
    retryCount: integer("retry_count").notNull().default(0), // Phase-1 caps at 1 retry
    // HORIZON two-level-gate hinge (Phase 2): split acceptance so a worker can't game the gate.
    // repair_signal = diagnostics SHOWN to the worker during retry; final_gate = the HELD-OUT
    // check (extra tests / independent review / UX-reviewer) the worker never optimizes against.
    repairSignal: text("repair_signal"),
    finalGate: text("final_gate"),
    // HORIZON cost/latency metrics, first-class per Task (populated by the real Verifier/dispatcher).
    tokenSpend: integer("token_spend"),
    verifyLatencyMs: integer("verify_latency_ms"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobSeqIdx: index("job_tasks_job_seq_idx").on(table.jobId, table.seq),
    jobStatusIdx: index("job_tasks_job_status_idx").on(table.jobId, table.status),
  }),
);
