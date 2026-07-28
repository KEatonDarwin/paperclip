// Autonomy-approved backlog source for the idle-capacity trigger (DAR-712, Phase 1b).
//
// There is no existing convention for "Kevin greenlit this in concept for autonomous
// pickup" (see the DAR-712 plan doc's Phase 1b open question). This wraps a plain issue
// label (`autonomy-approved`) rather than the heavier `issue_approvals` table: additive,
// visible in the UI, reversible, no schema change. Defaulting to the label per the plan
// doc unless redirected.
//
// Also excludes any backlog issue that already has an in-flight Foreman Job dispatched
// for it, so the (not-yet-built) Phase 2 trigger loop can't double-dispatch the same
// item every time it polls. Dispatched jobs are expected to tag `external_ref` as
// `idle-capacity:<issue-identifier>` (mirroring the `intake:<source>:<ref>` convention
// in routes/intake.ts) — Phase 2's dispatch step is responsible for setting that tag.

import { and, eq, like } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { jobs } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";

export const AUTONOMY_APPROVED_LABEL = "autonomy-approved";
export const IDLE_CAPACITY_EXTERNAL_REF_PREFIX = "idle-capacity:";

/** Job statuses that count as "already working on this" (see jobs.ts's lifecycle comment). */
const OPEN_JOB_STATUSES = new Set(["planning", "dispatching", "integrating", "verifying"]);

export function encodeIdleCapacityExternalRef(issueIdentifier: string): string {
  return `${IDLE_CAPACITY_EXTERNAL_REF_PREFIX}${issueIdentifier}`;
}

export interface AutonomyApprovedBacklogItem {
  issueId: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  createdAt: Date;
  /**
   * The issue's project's primary workspace repo (cwd, falling back to repoUrl), resolved so
   * Phase 2 dispatch (idle-capacity-dispatch.ts) knows which repo to hand Foreman. null when
   * the issue has no project, or the project has no workspace with a repo configured — such
   * items are surfaced (not silently dropped) so the caller can decide whether to skip them.
   */
  repoPath: string | null;
}

/**
 * Oldest-first, `autonomy-approved`-labeled issues sitting in `backlog`/`todo` with no
 * already-dispatched, still-open Foreman Job. Empty (not an error) when the label hasn't
 * been created yet for this company — that just means nothing has been approved.
 */
export async function listAutonomyApprovedBacklog(
  db: Db,
  companyId: string,
): Promise<AutonomyApprovedBacklogItem[]> {
  const svc = issueService(db);
  const projects = projectService(db);
  const allLabels = await svc.listLabels(companyId);
  const label = allLabels.find((l) => l.name === AUTONOMY_APPROVED_LABEL);
  if (!label) return [];

  const candidates = await svc.list(companyId, { status: "backlog,todo", labelId: label.id });
  if (candidates.length === 0) return [];

  // One IN-ish query per candidate is fine at backlog scale (dozens, not thousands) — a
  // pre-approved queue is meant to be small and hand-curated, not a bulk work generator.
  const [openByIssue, repoPathByIssue] = await Promise.all([
    Promise.all(
      candidates.map(async (issue) => {
        if (!issue.identifier) return false;
        const rows = await db
          .select({ status: jobs.status })
          .from(jobs)
          .where(
            and(
              eq(jobs.companyId, companyId),
              like(jobs.externalRef, `${encodeIdleCapacityExternalRef(issue.identifier)}%`),
            ),
          );
        return rows.some((r) => OPEN_JOB_STATUSES.has(r.status));
      }),
    ),
    Promise.all(
      candidates.map(async (issue) => {
        if (!issue.projectId) return null;
        const workspaces = await projects.listWorkspaces(issue.projectId);
        const primary = workspaces[0]; // listWorkspaces orders isPrimary DESC, createdAt ASC
        return primary?.cwd ?? primary?.repoUrl ?? null;
      }),
    ),
  ]);

  return candidates
    .map((issue, i) => ({
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
      createdAt: issue.createdAt,
      repoPath: repoPathByIssue[i] ?? null,
      isOpen: openByIssue[i],
    }))
    .filter((item) => !item.isOpen)
    .map(({ isOpen: _isOpen, ...item }) => item)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
