import { and, eq, isNull, lte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issues, issueComments } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { heartbeatService } from "./heartbeat.js";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";

const GRACE_MINUTES = Math.max(1, Number(process.env.ISSUE_AUTO_ASSIGN_GRACE_MINUTES) || 5);

export function issueAutoAssign(db: Db) {
  const heartbeat = heartbeatService(db);

  async function tick(): Promise<{ assigned: number }> {
    const cutoff = new Date(Date.now() - GRACE_MINUTES * 60 * 1000);

    const unassigned = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(
          inArray(issues.status, ["todo", "backlog"]),
          isNull(issues.assigneeAgentId),
          isNull(issues.assigneeUserId),
          isNull(issues.hiddenAt),
          lte(issues.createdAt, cutoff),
        ),
      );

    if (unassigned.length === 0) return { assigned: 0 };

    const companyIds = [...new Set(unassigned.map((i) => i.companyId))];

    const ceoAgents = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(
        and(
          inArray(agents.companyId, companyIds),
          isNull(agents.reportsTo),
          eq(agents.status, "active"),
        ),
      );

    const ceoByCompany = new Map<string, string>();
    for (const a of ceoAgents) {
      if (!ceoByCompany.has(a.companyId)) {
        ceoByCompany.set(a.companyId, a.id);
      }
    }

    let assigned = 0;
    for (const issue of unassigned) {
      const targetAgentId = ceoByCompany.get(issue.companyId);
      if (!targetAgentId) continue;

      try {
        await db
          .update(issues)
          .set({
            assigneeAgentId: targetAgentId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(issues.id, issue.id),
              isNull(issues.assigneeAgentId),
              isNull(issues.assigneeUserId),
            ),
          );

        await db.insert(issueComments).values({
          companyId: issue.companyId,
          issueId: issue.id,
          authorAgentId: null,
          authorUserId: null,
          body: `Auto-routed to top-level manager after ${GRACE_MINUTES} min unassigned grace period.`,
        });

        void queueIssueAssignmentWakeup({
          heartbeat,
          issue: { id: issue.id, assigneeAgentId: targetAgentId, status: issue.status },
          reason: "auto_assign_unowned",
          mutation: "auto_assign",
          contextSource: "issue-auto-assign",
          requestedByActorType: "system",
          requestedByActorId: null,
        });

        assigned++;
        logger.info(
          { issueId: issue.id, identifier: issue.identifier, targetAgentId },
          "issue-auto-assign: routed unassigned issue",
        );
      } catch (err) {
        logger.error(
          { err, issueId: issue.id },
          "issue-auto-assign: failed to assign issue",
        );
      }
    }

    return { assigned };
  }

  return { tick };
}
