// Idle-capacity dispatch tick (DAR-712, Phase 2 core). Surface-agnostic: given idle providers
// (idle-capacity.ts) and the pre-approved backlog (idle-capacity-backlog.ts), kicks a Foreman
// Job per idle worker_type against the oldest unclaimed backlog item that has a resolvable
// repo. Callers own *when* tick() runs — a scheduled poll, an idea-capture event handler,
// whatever the eventual trigger surface turns out to be (see the DAR-712 plan doc's Phase 2c
// open question) — this module doesn't assume one.
//
// One dispatch per idle worker_type per tick, oldest-queued-item-first, each item claimed by
// at most one worker_type per tick. Bake-off mode (same item fanned out to every simultaneously
// idle provider) is a deliberate non-default here — see the plan doc before adding it, since it
// changes how fast the approved queue drains.
//
// `foremanProjectId` is a caller-supplied deployment fact (same as every other Foreman entry
// point — routes/jobs.ts, routes/intake.ts) — never guessed or hardcoded here.

import type { Db } from "@paperclipai/db";
import { foremanService, DEFAULT_VERIFY_COMMAND, type JobRow } from "./foreman.js";
import { paperclipAgentDispatcher, DEFAULT_WORKER_AGENTS } from "./foreman-dispatch.js";
import { getIdleWorkerTypes } from "./idle-capacity.js";
import {
  listAutonomyApprovedBacklog,
  encodeIdleCapacityExternalRef,
  type AutonomyApprovedBacklogItem,
} from "./idle-capacity-backlog.js";

export interface IdleCapacityDispatchConfig {
  companyId: string;
  foremanProjectId: string;
  workerAgents?: Record<string, string>;
  foremanAgentId?: string;
  idleThresholdPercent?: number;
  verifyCommand?: string | null;
}

export type IdleCapacityDispatchOutcome =
  | { kind: "dispatched"; workerType: string; issueIdentifier: string; job: JobRow }
  | { kind: "skipped_no_repo"; workerType: string; issueIdentifier: string };

/**
 * One dispatch tick. Returns [] when no provider is idle or the approved backlog is empty.
 * Backlog items with no resolvable repoPath are reported as `skipped_no_repo` (not silently
 * dropped and not dispatched with a guessed repo) and don't consume that tick's idle slot for
 * another candidate — fix the item's project workspace and it picks up next tick.
 */
export async function tickIdleCapacityDispatch(
  db: Db,
  config: IdleCapacityDispatchConfig,
): Promise<IdleCapacityDispatchOutcome[]> {
  const idleWorkerTypes = await getIdleWorkerTypes({ idleThresholdPercent: config.idleThresholdPercent });
  if (idleWorkerTypes.length === 0) return [];

  const backlog = await listAutonomyApprovedBacklog(db, config.companyId);
  if (backlog.length === 0) return [];

  const foreman = foremanService(db);
  const dispatcher = paperclipAgentDispatcher(db, {
    companyId: config.companyId,
    foremanProjectId: config.foremanProjectId,
    workerAgents: { ...DEFAULT_WORKER_AGENTS, ...(config.workerAgents ?? {}) },
    foremanAgentId: config.foremanAgentId,
  });

  const claimed = new Set<string>();
  const outcomes: IdleCapacityDispatchOutcome[] = [];

  for (const workerType of idleWorkerTypes) {
    const item = backlog.find((candidate) => !claimed.has(candidate.issueId));
    if (!item) break; // ran out of queued work before running out of idle capacity
    claimed.add(item.issueId);

    const outcome = await dispatchOne(foreman, dispatcher, config, workerType, item);
    outcomes.push(outcome);
  }

  return outcomes;
}

async function dispatchOne(
  foreman: ReturnType<typeof foremanService>,
  dispatcher: ReturnType<typeof paperclipAgentDispatcher>,
  config: IdleCapacityDispatchConfig,
  workerType: string,
  item: AutonomyApprovedBacklogItem,
): Promise<IdleCapacityDispatchOutcome> {
  const issueIdentifier = item.identifier ?? item.issueId;

  if (!item.repoPath) {
    return { kind: "skipped_no_repo", workerType, issueIdentifier };
  }

  const { job } = await foreman.createJob(config.companyId, {
    repo: item.repoPath,
    ask: `${item.title}\n\n${item.description ?? ""}`.trim(),
    workerType,
    maxWorkers: 1,
    externalRef: encodeIdleCapacityExternalRef(issueIdentifier),
    createdByAgentId: config.foremanAgentId ?? null,
  });

  foreman
    .runJob(job.id, {
      dispatcher,
      // Same safety floor as routes/jobs.ts's POST /:id/run — auto-merge has no PR/human
      // review left as a backstop, so an omitted verify_command must not fall through unset.
      verifyCommand: config.verifyCommand ?? DEFAULT_VERIFY_COMMAND,
    })
    .catch((err: unknown) => console.error("[idle-capacity-dispatch] runJob unhandled error", err));

  return { kind: "dispatched", workerType, issueIdentifier, job };
}
