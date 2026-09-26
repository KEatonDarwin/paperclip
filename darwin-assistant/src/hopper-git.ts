// HOPPER GIT — the ONE git surface for the parallel engine.
//
// Authority: docs/hopper/PARALLEL-CONTRACT.md (v1, node #945 of tree-383bb55b).
// Every section reference below (§1…§10) points into that file. No other module
// in this codebase may shell out to git; if you need a git operation, add it
// here so the safety invariants (§8) hold in exactly one place.
//
// THIS MODULE IS A TYPED STUB. Nodes 2-6 of the tree fill the bodies. It exists
// now so those nodes build against one agreed surface instead of inventing four.
//
// Safety invariants this surface exists to enforce (§8 — do not weaken):
//   1. No force-push, ever (no --force / --force-with-lease / +refs).
//   2. No branch deletion, ever — pruning a worktree keeps its branch.
//   3. Merge-back never targets master/main; only the tree's integration branch.
//   4. All mutating git ops are confined to worktrees the engine created, under
//      repoWorktreeRoot(repo)/<tree_id>/. The live checkout is never written to.
//   5. reset --hard only inside the engine's own integration worktree.
//   6. The engine never pushes.
//   7. execFile, never a shell string — a branch/title can never become a command.
//   8. Every call is timeout-bounded and returns a RESULT, never throws a
//      failure that could strand a node's claim.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { getHopperNode, getHopperTree, type HopperNodeRow, type HopperTreeRow } from './hopper-engine.js';

const NOT_IMPLEMENTED = (fn: string): never => {
  throw new Error(`[hopper-git] ${fn} is not implemented yet (docs/hopper/PARALLEL-CONTRACT.md §9)`);
};

// ---------------------------------------------------------------------------
// Result types (§9) — a git failure is a VALUE the caller handles, never an
// exception that leaves a node claimed with a dead lease.
// ---------------------------------------------------------------------------

/** Failure shape shared by every mutating helper. `output` is captured stdout+stderr. */
export interface GitFailure {
  ok: false;
  /** One-line machine-ish reason, e.g. 'merge_conflict', 'build_failed', 'worktree_add_failed'. */
  reason: string;
  /** Captured process output, for the `integrate nX` node's spec (§3.5). */
  output: string;
}

export type GitResult<T extends object = Record<string, never>> = ({ ok: true } & T) | GitFailure;

/** Result of materializing (or reusing) a per-node worktree. §3.2 */
export interface NodeWorktree {
  /** Absolute path, persisted to hopper_nodes.worktree_path. */
  worktree_path: string;
  /** Branch name, persisted to hopper_nodes.node_branch. */
  node_branch: string;
  /** The integration-branch head this node was cut from — cut AT CLAIM (§3.2). */
  base_sha: string;
  /** True when the branch already existed (a retry reusing its predecessor's work). */
  reused: boolean;
}

/** Result of a build-gate run. §3.5 step 3, §3.6 */
export interface BuildGateOutcome {
  /** True when the gate passed OR was skipped (no command resolved). */
  passed: boolean;
  /** True when no gate command applied — merge alone decided. §3.6 */
  skipped: boolean;
  /** The command that ran, or null when skipped. */
  command: string | null;
  /** Captured stdout+stderr, capped by the caller before it reaches a node spec. */
  output: string;
  /** Process exit code, or null when skipped / timed out. */
  exit_code: number | null;
}

/** §6 — machine-checkable unpark conditions. Stored as JSON. */
export type UnparkCondition =
  | { kind: 'node_done'; node_id: number }
  | { kind: 'tree_done'; tree_id: string }
  | { kind: 'branch_pushed'; repo: string; branch: string }
  | { kind: 'file_exists'; path: string }
  | { kind: 'manual' };

// ---------------------------------------------------------------------------
// Pure path + name helpers (§3.1). No I/O — safe to call anywhere.
// ---------------------------------------------------------------------------

/**
 * `<dirname(repo)>/<basename(repo)>-worktrees`.
 * For `/home/kevin/paperclip` → `/home/kevin/paperclip-worktrees`, i.e. the
 * directory this box already uses, so integration trees nest inside it. §3.1
 */
export function repoWorktreeRoot(_repoPath: string): string {
  return NOT_IMPLEMENTED('repoWorktreeRoot');
}

/** `repoWorktreeRoot(repo)/<tree_id>` — every path the engine may write. §3.1, §8.4 */
export function treeWorktreeRoot(_repoPath: string, _treeId: string): string {
  return NOT_IMPLEMENTED('treeWorktreeRoot');
}

/** `treeWorktreeRoot/_integration` — where merges and the build gate run. §3.1 */
export function integrationWorktreePath(_repoPath: string, _treeId: string): string {
  return NOT_IMPLEMENTED('integrationWorktreePath');
}

/** `treeWorktreeRoot/n<node_id>` — one node's private checkout. §3.1 */
export function nodeWorktreePath(_repoPath: string, _treeId: string, _nodeId: number): string {
  return NOT_IMPLEMENTED('nodeWorktreePath');
}

/**
 * `<integrationBranch>-n<nodeId>` — **hyphen, never a slash**.
 *
 * Git refs are files in a directory tree: `refs/heads/hopper/x` cannot be both a
 * file and the directory `refs/heads/hopper/x/`, so `<branch>/n<id>` fails on
 * EVERY node of EVERY integration tree:
 *
 *     $ git branch hopper/parallel-engine/n945 hopper/parallel-engine
 *     fatal: cannot lock ref 'refs/heads/hopper/parallel-engine/n945':
 *            'refs/heads/hopper/parallel-engine' exists; cannot create ...
 *
 * §3.1 is binding on this. PE-2 in the check suite asserts no '/' suffix.
 */
export function nodeBranchName(_integrationBranch: string, _nodeId: number): string {
  return NOT_IMPLEMENTED('nodeBranchName');
}

/**
 * A tree is an INTEGRATION TREE iff `repo_path` AND `integration_branch` are
 * both non-null. Any other combination is a legacy tree and every parallel
 * behavior is skipped — byte-for-byte today's dispatch. §2
 */
export function isIntegrationTree(_tree: HopperTreeRow | null | undefined): boolean {
  return NOT_IMPLEMENTED('isIntegrationTree');
}

// ---------------------------------------------------------------------------
// Guards (§8). These THROW on violation — deliberately, because reaching one
// means a caller is about to do something the contract forbids outright, which
// is a bug to surface loudly, not a runtime condition to handle.
// ---------------------------------------------------------------------------

/**
 * Throws unless `branch` is a legal merge target: non-empty, and neither
 * `master` nor `main` (nor a remote-qualified form of either). Integration
 * branch → main is Kevin's, always. §8.3
 */
export function assertMergeTargetSafe(_branch: string): void {
  NOT_IMPLEMENTED('assertMergeTargetSafe');
}

/**
 * Throws unless `candidatePath` resolves inside `treeWorktreeRoot(repo, treeId)`.
 * Called by every mutating helper before it runs git, so the live checkout and
 * other trees' worktrees are structurally unreachable. §8.4
 */
export function assertPathInTreeRoot(_repoPath: string, _treeId: string, _candidatePath: string): void {
  NOT_IMPLEMENTED('assertPathInTreeRoot');
}

// ---------------------------------------------------------------------------
// Worktree lifecycle (§3.2, §3.5 step 5)
// ---------------------------------------------------------------------------

/**
 * Idempotently create `<tree>/_integration` on `integrationBranch`. A no-op when
 * it already exists and is on the right branch. §3.2 step 2
 */
export function ensureIntegrationWorktree(
  _repoPath: string,
  _treeId: string,
  _integrationBranch: string,
): GitResult<{ worktree_path: string; head_sha: string }> {
  return NOT_IMPLEMENTED('ensureIntegrationWorktree');
}

/**
 * Materialize this node's worktree AT CLAIM TIME, cutting `nodeBranchName(...)`
 * from the integration branch's **current head** — never from a sha captured at
 * plant time. That is the whole mechanism: a node claimed after its dependency
 * merged starts from a base containing it.
 *
 * If the branch already exists (a retry), REUSE it rather than re-cutting —
 * branches are never deleted (§8.2), so a retry finds its predecessor's work.
 *
 * On failure the caller must release the claim exactly the way spawnWorker's
 * catch does (status → 'pending', worker_thread_ext/lease cleared) so a git
 * failure never burns an attempt. §3.2
 */
export function materializeNodeWorktree(
  _tree: HopperTreeRow,
  _node: HopperNodeRow,
): GitResult<NodeWorktree> {
  return NOT_IMPLEMENTED('materializeNodeWorktree');
}

/**
 * Remove a node's worktree after a green integration. **Removes the WORKTREE
 * ONLY — the branch survives** as the audit trail and the retry base. §3.5 step 5, §8.2
 */
export function pruneNodeWorktree(
  _repoPath: string,
  _treeId: string,
  _nodeId: number,
): GitResult<{ removed: boolean }> {
  return NOT_IMPLEMENTED('pruneNodeWorktree');
}

// ---------------------------------------------------------------------------
// Merge-back (§3.5)
// ---------------------------------------------------------------------------

/** `git rev-parse HEAD` in a worktree. Read-only. */
export function currentHead(_worktreePath: string): GitResult<{ sha: string }> {
  return NOT_IMPLEMENTED('currentHead');
}

/** `git rev-parse --verify refs/heads/<branch>` — read-only existence check. */
export function branchExists(_repoPath: string, _branch: string): boolean {
  return NOT_IMPLEMENTED('branchExists');
}

/**
 * `git rev-parse --verify refs/remotes/origin/<branch>` — read-only. Backs the
 * `branch_pushed` unpark condition. §6
 *
 * Reads local refs only (no `fetch`, no network) — a failure (unknown ref, not
 * a git repo, timeout) is a value: `false`, never a throw, per §8.8.
 */
export function remoteBranchExists(repoPath: string, branch: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
      cwd: repoPath,
      timeout: 10_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * `git merge --no-ff <nodeBranch>` INSIDE the integration worktree. Calls
 * `assertMergeTargetSafe` first (§8.3). On conflict: `git merge --abort`, then
 * return `{ok:false, reason:'merge_conflict', output}` — the caller turns that
 * into the `integrate nX` node. §3.5 steps 1-2
 */
export function mergeNodeBranch(
  _integrationWorktreePath: string,
  _integrationBranch: string,
  _nodeBranch: string,
  _message: string,
): GitResult<{ merge_sha: string; pre_merge_sha: string }> {
  return NOT_IMPLEMENTED('mergeNodeBranch');
}

/**
 * Resolve the tree's build gate. §3.6
 *   - tree.build_gate_cmd non-null      → use verbatim
 *   - null + <repo>/darwin-assistant/package.json exists
 *                                       → 'npm run build', cwd = <wt>/darwin-assistant
 *   - otherwise, or explicit ''         → null = SKIP the gate, merge alone decides
 */
export function resolveBuildGateCmd(
  _tree: HopperTreeRow,
  _integrationWorktreePath: string,
): { command: string; cwd: string } | null {
  return NOT_IMPLEMENTED('resolveBuildGateCmd');
}

/**
 * Run the resolved build gate in the integration worktree, 20-minute timeout,
 * capturing stdout+stderr. A skipped gate returns `{passed:true, skipped:true}`.
 *
 * Runs `npm ci --include=dev` first when the gate cwd has no `node_modules/.bin`:
 * a fresh worktree has none, and hopper workers run with `NODE_ENV=production`,
 * under which a plain `npm ci` omits devDependencies and `npm run build` dies
 * with `tsc: not found` (exit 127) — a green merge reported as a red build.
 * Exit 127 is surfaced as `reason:'build_toolchain_missing'`, never as a code
 * failure. §3.5 step 3, §3.6
 */
export function runBuildGate(
  _tree: HopperTreeRow,
  _integrationWorktreePath: string,
): Promise<BuildGateOutcome> {
  return NOT_IMPLEMENTED('runBuildGate');
}

/**
 * `git reset --hard <sha>` — the ONLY permitted use is undoing a merge the
 * engine itself just made, inside the engine's own integration worktree, after
 * a red build gate. Asserts the path is under the tree root first. §3.5 step 4, §8.5
 */
export function resetHardTo(
  _repoPath: string,
  _treeId: string,
  _integrationWorktreePath: string,
  _sha: string,
): GitResult<{ sha: string }> {
  return NOT_IMPLEMENTED('resetHardTo');
}

// ---------------------------------------------------------------------------
// Unpark evaluation (§6) — pure-ish: sqlite + fs + read-only git. No model
// calls, no network. Re-run every tick by the night driver and goals autopilot.
// ---------------------------------------------------------------------------

/** Parse a stored `unpark_when` JSON blob. Returns null for null/invalid input. */
export function parseUnparkCondition(json: string | null | undefined): UnparkCondition | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { kind?: unknown }).kind !== 'string') return null;
    const kind = (parsed as { kind: string }).kind;
    if (!['node_done', 'tree_done', 'branch_pushed', 'file_exists', 'manual'].includes(kind)) return null;
    return parsed as UnparkCondition;
  } catch {
    return null;
  }
}

/**
 * True when the condition is met and the item/node should re-enter the queue.
 * `{kind:'manual'}` (and a null condition) is NEVER met — that is today's
 * behavior: only Kevin unparks it. §6
 */
export function evaluateUnpark(cond: UnparkCondition | null): boolean {
  if (!cond) return false;
  switch (cond.kind) {
    case 'manual':
      return false;
    case 'node_done':
      return getHopperNode(cond.node_id)?.status === 'done';
    case 'tree_done':
      return getHopperTree(cond.tree_id)?.status === 'done';
    case 'branch_pushed':
      return remoteBranchExists(cond.repo, cond.branch);
    case 'file_exists':
      return fs.existsSync(cond.path);
    default:
      return false;
  }
}
