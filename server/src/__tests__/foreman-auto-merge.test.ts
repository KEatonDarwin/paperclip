// DAR-711: end-to-end proof of the "submit -> Foreman fixes -> merged, no PR" loop, driven
// through foremanService against a real DB (embedded Postgres) and a real scratch git repo —
// the closest thing to the acceptance criteria ("Foreman picks up the submitted bug as a Job,
// dispatches a worker, verifies the fix, and merges the fix directly into the target branch")
// that's exercisable without a browser + live paperclip repo.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { foremanService, type WorkerDispatcher, type DispatchHandle, type PollState } from "../services/foreman.js";

// Prefer an isolated embedded Postgres; fall back to the local dev DATABASE_URL when the host
// can't run embedded Postgres (no initdb binary available in this sandbox) — same DB the repo's
// own `pnpm db:migrate` already targets. Every row this suite creates is deleted in afterEach.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const localDatabaseUrl = process.env.DATABASE_URL ?? "postgresql://paperclip:paperclip@127.0.0.1:5432/paperclip";
const canRunAgainstLocalDb = !embeddedPostgresSupport.supported && (await isReachable(localDatabaseUrl));
const describeEmbeddedPostgres =
  embeddedPostgresSupport.supported || canRunAgainstLocalDb ? describe : describe.skip;

if (!embeddedPostgresSupport.supported && !canRunAgainstLocalDb) {
  console.warn(
    `Skipping Foreman auto-merge tests: no embedded Postgres (${embeddedPostgresSupport.reason ?? "unsupported"}) and local DATABASE_URL unreachable.`,
  );
}

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

// A scratch repo with a deliberate bug, mirroring what a real bug_fix job would target.
function initScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-e2e-"));
  sh(dir, ["init", "-b", "master"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  sh(dir, ["config", "user.name", "Foreman Test"]);
  writeFileSync(join(dir, "add.js"), "function add(a, b) { return a - b; } // BUG\nmodule.exports = { add };\n");
  writeFileSync(join(dir, "check.sh"), "#!/bin/sh\nnode -e \"if (require('./add.js').add(2,2) !== 4) process.exit(1)\"\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "initial (buggy add)"]);
  return dir;
}

// Scripted worker: "fixes" the bug by committing a corrected add.js to its own task branch,
// simulating what a real worker coder agent does in foreman-dispatch.ts.
class ScriptedFixDispatcher implements WorkerDispatcher {
  constructor(private repo: string) {}
  async dispatch(): Promise<DispatchHandle> {
    const branch = `foreman/task-${randomUUID().slice(0, 8)}`;
    sh(this.repo, ["checkout", "-b", branch, "master"]);
    writeFileSync(join(this.repo, "add.js"), "function add(a, b) { return a + b; }\nmodule.exports = { add };\n");
    sh(this.repo, ["add", "."]);
    sh(this.repo, ["commit", "-m", "fix add() bug"]);
    return { branch };
  }
  async poll(_job: unknown, _task: unknown, handle: DispatchHandle): Promise<PollState> {
    return { state: "done", branch: handle.branch };
  }
}

describeEmbeddedPostgres("Foreman auto-merge (DAR-711)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const scratchRepos: string[] = [];

  const createdCompanyIds: string[] = [];

  beforeAll(async () => {
    if (embeddedPostgresSupport.supported) {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-foreman-automerge-");
      db = createDb(tempDb.connectionString);
    } else {
      db = createDb(localDatabaseUrl);
    }
  }, 20_000);

  afterEach(async () => {
    // jobs.company_id and job_tasks.job_id both cascade on delete, so removing just the
    // companies this suite created is enough — and, critically, scoped: this can run against
    // the shared local dev DB, so a blanket `delete(jobs)`/`delete(companies)` would be unsafe.
    for (const id of createdCompanyIds.splice(0)) {
      await db.delete(companies).where(eq(companies.id, id));
    }
    while (scratchRepos.length) rmSync(scratchRepos.pop() as string, { recursive: true, force: true });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("submit -> dispatch -> verify -> merges into baseBranch with no PR step", async () => {
    const repo = initScratchRepo();
    scratchRepos.push(repo);

    const [company] = await db.insert(companies).values({ name: "DAR-711 test co" }).returning();
    createdCompanyIds.push(company.id);
    const foreman = foremanService(db);

    const { job } = await foreman.createJob(company.id, {
      repo,
      ask: "add() returns the wrong result — fix the bug",
      baseBranch: "master",
      jobType: "bug_fix",
    });

    const finished = await foreman.runJob(job.id, {
      dispatcher: new ScriptedFixDispatcher(repo),
      verifyCommand: "sh check.sh",
      pollIntervalMs: 5,
    });

    expect(finished.status).toBe("merged");
    expect(finished.verifyResult).toBe("pass");
    expect(finished.mergeCommitSha).toBeTruthy();
    expect(finished.mergedAt).toBeTruthy();
    // No PR: prUrl is never populated, and the fix must actually be on baseBranch — that's the
    // "no PR, no manual intervention" acceptance bar, not just a job-status flag.
    expect(finished.prUrl).toBeNull();

    sh(repo, ["checkout", "master"]);
    const addJs = execFileSync("node", ["-e", "console.log(require('./add.js').add(2, 2))"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(addJs).toBe("4"); // the fix landed on master, not just an integration branch
  });

  it("does not merge when verify fails — lands in needs_review instead", async () => {
    const repo = initScratchRepo();
    scratchRepos.push(repo);

    const [company] = await db.insert(companies).values({ name: "DAR-711 test co 2" }).returning();
    createdCompanyIds.push(company.id);
    const foreman = foremanService(db);

    // Dispatcher that "fixes" nothing — leaves the bug in place, so the same verify command fails.
    class NoOpDispatcher implements WorkerDispatcher {
      async dispatch(): Promise<DispatchHandle> {
        const branch = `foreman/task-${randomUUID().slice(0, 8)}`;
        sh(repo, ["checkout", "-b", branch, "master"]);
        return { branch };
      }
      async poll(_job: unknown, _task: unknown, handle: DispatchHandle): Promise<PollState> {
        return { state: "done", branch: handle.branch };
      }
    }

    const { job } = await foreman.createJob(company.id, {
      repo,
      ask: "add() returns the wrong result — fix the bug",
      baseBranch: "master",
      jobType: "bug_fix",
    });

    const finished = await foreman.runJob(job.id, {
      dispatcher: new NoOpDispatcher(),
      verifyCommand: "sh check.sh",
      pollIntervalMs: 5,
    });

    expect(finished.status).toBe("needs_review");
    expect(finished.mergeCommitSha).toBeNull();

    sh(repo, ["checkout", "master"]);
    const addJs = execFileSync("node", ["-e", "console.log(require('./add.js').add(2, 2))"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(addJs).toBe("0"); // master untouched — nothing merged when verify fails
  });
});
