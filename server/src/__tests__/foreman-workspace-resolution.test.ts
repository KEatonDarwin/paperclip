// DAR-714: Foreman's `repo` job param used to be cosmetic — the worker's actual execution
// workspace always came from the Foreman project's fixed primary project-workspace, regardless
// of what repo was requested. These tests exercise resolveProjectWorkspaceId + resolveRepoPath
// (the two pieces that now drive real workspace selection) directly against a real DB, without
// going through the live agent/heartbeat runtime — same "pure + exported, unit-testable without
// the live agent runtime" discipline the file already uses for composeWorkerBrief.
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companySkills, createDb, projectWorkspaces, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.js";
import { resolveProjectWorkspaceId, resolveRepoPath } from "../services/foreman-dispatch.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const localDatabaseUrl = process.env.DATABASE_URL ?? "postgresql://paperclip:paperclip@127.0.0.1:5432/paperclip";
const canRunAgainstLocalDb = !embeddedPostgresSupport.supported && (await isReachable(localDatabaseUrl));
const describeEmbeddedPostgres =
  embeddedPostgresSupport.supported || canRunAgainstLocalDb ? describe : describe.skip;

async function isReachable(url: string): Promise<boolean> {
  try {
    const db = createDb(url);
    await db.select().from(companies).limit(1);
    return true;
  } catch {
    return false;
  }
}

function sh(repo: string, args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

function initScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-workspace-"));
  sh(dir, ["init", "-b", "master"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  sh(dir, ["config", "user.name", "Foreman Test"]);
  execFileSync("sh", ["-c", `echo hi > ${join(dir, "README.md")}`]);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "initial"]);
  return dir;
}

describeEmbeddedPostgres("Foreman worker workspace resolution (DAR-714)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const scratchRepos: string[] = [];
  const createdCompanyIds: string[] = [];

  beforeAll(async () => {
    if (embeddedPostgresSupport.supported) {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-foreman-workspace-");
      db = createDb(tempDb.connectionString);
    } else {
      db = createDb(localDatabaseUrl);
    }
  }, 20_000);

  afterEach(async () => {
    // project_workspaces + projects both cascade on company delete's referencing rows only if
    // deleted in order; neither table this suite touches has other inbound FKs, so a scoped
    // per-company delete is enough (and safe against the shared local dev DB fallback).
    for (const id of createdCompanyIds.splice(0)) {
      await db.delete(projectWorkspaces).where(eq(projectWorkspaces.companyId, id));
      await db.delete(projects).where(eq(projects.companyId, id));
      // Project creation auto-imports default company skills as a side effect — clean those up
      // too, or the company delete fails on the same RESTRICT FK that bit this suite before.
      await db.delete(companySkills).where(eq(companySkills.companyId, id));
      await db.delete(companies).where(eq(companies.id, id));
    }
    while (scratchRepos.length) rmSync(scratchRepos.pop() as string, { recursive: true, force: true });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setupCompanyAndProject(primaryRepoPath: string) {
    const [company] = await db
      .insert(companies)
      .values({ name: `DAR-714 test co ${Date.now()}-${Math.random()}` })
      .returning();
    createdCompanyIds.push(company.id);
    const projects_ = projectService(db);
    const project = await projects_.create(company.id, {
      name: "Foreman Workers",
      status: "in_progress",
    } as Parameters<typeof projects_.create>[1]);
    // Mirrors the real "Foreman Workers" project: one fixed primary workspace bound to whatever
    // repo happened to be the original proving-ground target (the DAR-714 bug).
    await projects_.createWorkspace(project.id, {
      name: "url-shortener",
      cwd: primaryRepoPath,
      isPrimary: true,
    });
    return { companyId: company.id, projectId: project.id };
  }

  it("resolves to a workspace matching the requested repo, not the project's fixed primary", async () => {
    const primaryRepo = initScratchRepo();
    const otherRepo = initScratchRepo();
    scratchRepos.push(primaryRepo, otherRepo);

    const { projectId } = await setupCompanyAndProject(primaryRepo);

    const workspaceId = await resolveProjectWorkspaceId(db, projectId, otherRepo);

    const [resolvedWorkspace] = await db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, workspaceId))
      .limit(1);
    // The bug: this used to always resolve to the project's fixed primary (primaryRepo). It must
    // now resolve to a workspace actually pointing at the requested repo.
    expect(resolvedWorkspace!.cwd).toBe(otherRepo);
    expect(resolvedWorkspace!.cwd).not.toBe(primaryRepo);
    expect(resolvedWorkspace!.isPrimary).toBe(false); // doesn't clobber the project's primary
  });

  it("reuses an existing project workspace with a matching cwd instead of creating a duplicate", async () => {
    const primaryRepo = initScratchRepo();
    const otherRepo = initScratchRepo();
    scratchRepos.push(primaryRepo, otherRepo);

    const { projectId } = await setupCompanyAndProject(primaryRepo);
    const projects_ = projectService(db);
    const preCreated = await projects_.createWorkspace(projectId, { name: "other-repo", cwd: otherRepo });

    const workspaceId = await resolveProjectWorkspaceId(db, projectId, otherRepo);
    expect(workspaceId).toBe(preCreated!.id);

    const allWorkspaces = await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.projectId, projectId));
    expect(allWorkspaces.filter((w) => w.cwd === otherRepo)).toHaveLength(1);
  });

  it("passes already-absolute repo paths straight through unchanged", () => {
    expect(resolveRepoPath("/home/kevin/paperclip")).toBe("/home/kevin/paperclip");
  });

  it("resolves known short repo names from the registry", () => {
    expect(resolveRepoPath("paperclip")).toBe("/home/kevin/paperclip");
    expect(resolveRepoPath("darwin-assistant")).toBe("/home/kevin/projects/darwin-assistant-dar666");
  });

  it("fails loudly instead of silently defaulting for an unrecognized repo name", () => {
    expect(() => resolveRepoPath("totally-unknown-repo")).toThrow(/unknown repo/i);
  });
});
