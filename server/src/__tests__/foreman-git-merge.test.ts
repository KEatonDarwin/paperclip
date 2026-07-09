// DAR-711: mergeToBase is the new "no PR, Foreman merges its own verified work" step. These
// tests run against real scratch git repos on disk (matching foreman-git.ts's own stated
// design — "unit-exercisable on a scratch repo" — no DB, no live paperclip repo required).
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mergeToBase } from "../services/foreman-git.js";

function sh(repo: string, args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-merge-test-"));
  sh(dir, ["init", "-b", "master"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  sh(dir, ["config", "user.name", "Foreman Test"]);
  writeFileSync(join(dir, "README.md"), "base\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "base commit"]);
  return dir;
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("mergeToBase", () => {
  it("merges a clean integration branch into baseBranch with no remote configured", () => {
    const repo = initRepo();
    dirs.push(repo);
    sh(repo, ["checkout", "-b", "integration"]);
    writeFileSync(join(repo, "feature.txt"), "new feature\n");
    sh(repo, ["add", "."]);
    sh(repo, ["commit", "-m", "add feature"]);

    const result = mergeToBase(repo, "master", "integration");

    expect(result.merged).toBe(true);
    expect(result.conflict).toBe(false);
    expect(result.pushed).toBe(false); // no remote in a scratch repo
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

    sh(repo, ["checkout", "master"]);
    const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: repo, encoding: "utf8" });
    expect(log).toContain("Merge branch");
  });

  it("reports a conflict and leaves baseBranch clean when the merge cannot be resolved", () => {
    const repo = initRepo();
    dirs.push(repo);
    writeFileSync(join(repo, "README.md"), "base changed on master\n");
    sh(repo, ["add", "."]);
    sh(repo, ["commit", "-m", "master diverges"]);

    sh(repo, ["checkout", "-b", "integration", "HEAD~1"]);
    writeFileSync(join(repo, "README.md"), "base changed on integration\n");
    sh(repo, ["add", "."]);
    sh(repo, ["commit", "-m", "integration diverges"]);

    const result = mergeToBase(repo, "master", "integration");

    expect(result.merged).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.pushed).toBe(false);

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(status.trim()).toBe(""); // merge was aborted, working tree is clean
  });
});
