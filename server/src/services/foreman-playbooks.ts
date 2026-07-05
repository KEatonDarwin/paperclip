// Foreman job-type playbooks (DAR-687 — Kevin 2026-07-05).
// A Job carries a `job_type` that sideloads a different instruction set into the worker/
// decomposition brief. Same orchestration core (dispatch → integrate → verify → report),
// different playbook. This is what lets the Universal Bug/Task Intake (DAR-688, Ctrl+Shift+B)
// route straight into Foreman: intake sets job_type=bug_fix and hands over {text, repo, context}.
// Chips remain one flavor of `build` (job_tasks.flavor='chip'), not a separate job_type.

export interface Playbook {
  jobType: string;
  label: string;
  /** Sideloaded, prepended to each worker's task brief. */
  instructions: string;
}

const BUILD: Playbook = {
  jobType: "build",
  label: "Build",
  instructions: [
    "JOB TYPE: build. Follow this playbook:",
    "1. DECOMPOSE — break the feature into the smallest independently-verifiable tasks (a chip is one flavor of build unit).",
    "2. BUILD — implement each task on its own worktree branch; follow the repo's existing patterns and conventions.",
    "3. INTEGRATE — keep the pieces composing cleanly; do not break the build.",
    "4. VERIFY — run the repo's build/typecheck/test gate and fix failures before finishing.",
    "5. DOCUMENT — in the commit message, state what was built and how it was verified.",
  ].join("\n"),
};

const BUG_FIX: Playbook = {
  jobType: "bug_fix",
  label: "Bug fix",
  instructions: [
    "JOB TYPE: bug_fix. Follow this playbook:",
    "1. LOCALIZE — find the exact root cause and cite file:line. Do not patch symptoms.",
    "2. REPRODUCE — write the smallest failing test/repro that demonstrates the bug BEFORE fixing it.",
    "3. SMALLEST SAFE FIX — change the minimum needed to fix the root cause. No refactors, no scope creep.",
    "4. REGRESSION TEST — confirm the repro now passes and the existing tests still pass.",
    "5. DOCUMENT — in the commit message, state the root cause, the fix, and the regression test added.",
  ].join("\n"),
};

// Registry. `build` is the default (matches the original Phase-1 behavior).
export const PLAYBOOKS: Record<string, Playbook> = {
  build: BUILD,
  bug_fix: BUG_FIX,
};

export const DEFAULT_JOB_TYPE = "build";
export const JOB_TYPES = Object.keys(PLAYBOOKS);

// Resolve a job_type to its playbook, defaulting unknown/empty to `build` (never throws —
// an unrecognized type degrades to the general build playbook rather than failing a Job).
export function getPlaybook(jobType: string | null | undefined): Playbook {
  return PLAYBOOKS[(jobType ?? DEFAULT_JOB_TYPE).toLowerCase()] ?? BUILD;
}

// Normalize a caller-supplied job_type to a known key (unknown → default).
export function normalizeJobType(jobType: string | null | undefined): string {
  const key = (jobType ?? DEFAULT_JOB_TYPE).toLowerCase();
  return PLAYBOOKS[key] ? key : DEFAULT_JOB_TYPE;
}
