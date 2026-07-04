// Foreman git engine (DAR-687, Phase 1).
// The integration + verification machinery — "the merge-back IS the work" and the
// "verify gate + retry" closed loop (the two hard problems the spec calls the value).
// Pure git/shell operations, no DB or agent coupling, so it is unit-exercisable on a
// scratch repo independently of the live agent runtime.
import { execFileSync, execSync } from "node:child_process";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(repo: string, args: string[]): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout ?? "", stderr: "" };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      stdout: e.stdout ? e.stdout.toString() : "",
      stderr: e.stderr ? e.stderr.toString() : String(err),
    };
  }
}

export function branchExists(repo: string, branch: string): boolean {
  return git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

// Create (or reset) the integration branch off the job's base ref.
export function createIntegrationBranch(repo: string, baseBranch: string, integrationBranch: string): GitResult {
  if (branchExists(repo, integrationBranch)) {
    const co = git(repo, ["checkout", integrationBranch]);
    if (!co.ok) return co;
    return git(repo, ["reset", "--hard", baseBranch]);
  }
  return git(repo, ["checkout", "-B", integrationBranch, baseBranch]);
}

export interface MergeOutcome {
  branch: string;
  merged: boolean;
  conflict: boolean;
  message: string;
}

// Merge one task branch into the currently-checked-out integration branch.
// On conflict, aborts the merge so the integration branch stays clean for the report.
export function mergeTaskBranch(repo: string, integrationBranch: string, taskBranch: string): MergeOutcome {
  const co = git(repo, ["checkout", integrationBranch]);
  if (!co.ok) {
    return { branch: taskBranch, merged: false, conflict: false, message: `checkout failed: ${co.stderr}` };
  }
  const merge = git(repo, ["merge", "--no-ff", "--no-edit", taskBranch]);
  if (merge.ok) {
    return { branch: taskBranch, merged: true, conflict: false, message: "merged" };
  }
  // Detect conflict vs other failure.
  const status = git(repo, ["status", "--porcelain"]);
  const conflict = /^(?:UU|AA|DD|AU|UA|DU|UD) /m.test(status.stdout);
  git(repo, ["merge", "--abort"]); // keep the integration branch clean
  return {
    branch: taskBranch,
    merged: false,
    conflict,
    message: conflict ? `merge conflict merging ${taskBranch}` : `merge failed: ${merge.stderr || merge.stdout}`,
  };
}

export interface IntegrationResult {
  integrationBranch: string;
  outcomes: MergeOutcome[];
  allMerged: boolean;
}

// Serially merge task branches (in the given order) into a fresh integration branch.
// Conservative: stops at the first conflict — Phase 1 reports it rather than auto-resolving.
export function integrateBranches(
  repo: string,
  baseBranch: string,
  integrationBranch: string,
  taskBranches: string[],
): IntegrationResult {
  const create = createIntegrationBranch(repo, baseBranch, integrationBranch);
  if (!create.ok) {
    return {
      integrationBranch,
      outcomes: [{ branch: integrationBranch, merged: false, conflict: false, message: `could not create integration branch: ${create.stderr}` }],
      allMerged: false,
    };
  }
  const outcomes: MergeOutcome[] = [];
  for (const tb of taskBranches) {
    const outcome = mergeTaskBranch(repo, integrationBranch, tb);
    outcomes.push(outcome);
    if (!outcome.merged) break; // stop at first failure/conflict
  }
  return { integrationBranch, outcomes, allMerged: outcomes.length === taskBranches.length && outcomes.every((o) => o.merged) };
}

export interface VerifyResult {
  pass: boolean;
  skipped: boolean;
  exitCode: number | null;
  output: string;
}

// Run the repo's verify command (build/typecheck/test) in the given branch's checkout.
// A null/empty command means "no verify configured" → skipped (not a failure).
export function runVerify(repo: string, command: string | null | undefined, timeoutMs = 15 * 60_000): VerifyResult {
  if (!command || !command.trim()) {
    return { pass: true, skipped: true, exitCode: null, output: "no verify command configured" };
  }
  try {
    const output = execSync(command, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { pass: true, skipped: false, exitCode: 0, output: tail(output ?? "") };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    const combined = `${e.stdout ? e.stdout.toString() : ""}\n${e.stderr ? e.stderr.toString() : String(err)}`;
    return { pass: false, skipped: false, exitCode: e.status ?? null, output: tail(combined) };
  }
}

// Short diff summary for a task branch vs the base (files + ± lines).
export function diffSummary(repo: string, baseBranch: string, taskBranch: string): string {
  const res = git(repo, ["diff", "--stat", `${baseBranch}...${taskBranch}`]);
  return res.ok ? tail(res.stdout, 4000).trim() : `diff unavailable: ${res.stderr}`;
}

// Resolve the branch a worker created for its task. The worktree runtime names branches
// `{{issue.identifier}}-{{slug}}` (slug not caller-controlled), so we find it by identifier prefix.
export function listBranchesMatching(repo: string, prefix: string): string[] {
  const res = git(repo, ["branch", "--list", `${prefix}*`, "--format=%(refname:short)"]);
  if (!res.ok) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// True if `branch` has commits beyond `baseBranch` (worker actually produced work).
export function branchHasCommitsAhead(repo: string, baseBranch: string, branch: string): boolean {
  const res = git(repo, ["rev-list", "--count", `${baseBranch}..${branch}`]);
  if (!res.ok) return false;
  return (parseInt(res.stdout.trim(), 10) || 0) > 0;
}

function tail(s: string, max = 8000): string {
  if (s.length <= max) return s;
  return `…(${s.length - max} chars truncated)…\n${s.slice(s.length - max)}`;
}
