import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  issueComments,
  issueInboxArchives,
  issueLabels,
  issues,
  jobs,
  labels,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  AUTONOMY_APPROVED_LABEL,
  encodeIdleCapacityExternalRef,
  listAutonomyApprovedBacklog,
} from "../services/idle-capacity-backlog.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres idle-capacity-backlog tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("listAutonomyApprovedBacklog", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-idle-capacity-backlog-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueLabels);
    await db.delete(jobs);
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(labels);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setupCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("returns nothing when the autonomy-approved label doesn't exist yet", async () => {
    const companyId = await setupCompany();
    expect(await listAutonomyApprovedBacklog(db, companyId)).toEqual([]);
  });

  it("returns only labeled backlog/todo issues, oldest first, excluding non-backlog statuses and other labels", async () => {
    const companyId = await setupCompany();
    const [approvedLabel] = await db
      .insert(labels)
      .values({ companyId, name: AUTONOMY_APPROVED_LABEL, color: "#8B5CF6" })
      .returning();
    const [otherLabel] = await db
      .insert(labels)
      .values({ companyId, name: "not-autonomy", color: "#000000" })
      .returning();

    const older = randomUUID();
    const newer = randomUUID();
    const wrongStatus = randomUUID();
    const wrongLabel = randomUUID();

    await db.insert(issues).values([
      {
        id: older,
        companyId,
        identifier: "DAR-9001",
        title: "Older approved item",
        status: "backlog",
        priority: "medium",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: newer,
        companyId,
        identifier: "DAR-9002",
        title: "Newer approved item",
        status: "todo",
        priority: "medium",
        createdAt: new Date("2026-02-01T00:00:00Z"),
      },
      {
        id: wrongStatus,
        companyId,
        identifier: "DAR-9003",
        title: "Approved but in_progress already",
        status: "in_progress",
        priority: "medium",
        createdAt: new Date("2026-01-15T00:00:00Z"),
      },
      {
        id: wrongLabel,
        companyId,
        identifier: "DAR-9004",
        title: "Backlog but not autonomy-approved",
        status: "backlog",
        priority: "medium",
        createdAt: new Date("2026-01-10T00:00:00Z"),
      },
    ]);

    await db.insert(issueLabels).values([
      { issueId: older, labelId: approvedLabel.id, companyId },
      { issueId: newer, labelId: approvedLabel.id, companyId },
      { issueId: wrongStatus, labelId: approvedLabel.id, companyId },
      { issueId: wrongLabel, labelId: otherLabel.id, companyId },
    ]);

    const result = await listAutonomyApprovedBacklog(db, companyId);
    expect(result.map((r) => r.identifier)).toEqual(["DAR-9001", "DAR-9002"]);
  });

  it("excludes an approved issue that already has an open Foreman Job dispatched for it", async () => {
    const companyId = await setupCompany();
    const [approvedLabel] = await db
      .insert(labels)
      .values({ companyId, name: AUTONOMY_APPROVED_LABEL, color: "#8B5CF6" })
      .returning();

    const dispatchedId = randomUUID();
    const notDispatchedId = randomUUID();
    const previouslyFailedId = randomUUID();

    await db.insert(issues).values([
      {
        id: dispatchedId,
        companyId,
        identifier: "DAR-9101",
        title: "Already has an open job",
        status: "backlog",
        priority: "medium",
      },
      {
        id: notDispatchedId,
        companyId,
        identifier: "DAR-9102",
        title: "Never dispatched",
        status: "backlog",
        priority: "medium",
      },
      {
        id: previouslyFailedId,
        companyId,
        identifier: "DAR-9103",
        title: "Previously dispatched but that job already finished",
        status: "backlog",
        priority: "medium",
      },
    ]);

    await db.insert(issueLabels).values([
      { issueId: dispatchedId, labelId: approvedLabel.id, companyId },
      { issueId: notDispatchedId, labelId: approvedLabel.id, companyId },
      { issueId: previouslyFailedId, labelId: approvedLabel.id, companyId },
    ]);

    await db.insert(jobs).values([
      {
        companyId,
        repo: "/tmp/whatever",
        ask: "do the thing",
        externalRef: encodeIdleCapacityExternalRef("DAR-9101"),
        status: "dispatching",
      },
      {
        companyId,
        repo: "/tmp/whatever",
        ask: "do the other thing",
        externalRef: encodeIdleCapacityExternalRef("DAR-9103"),
        status: "failed",
      },
    ]);

    const result = await listAutonomyApprovedBacklog(db, companyId);
    expect(result.map((r) => r.identifier).sort()).toEqual(["DAR-9102", "DAR-9103"]);
  });
});
