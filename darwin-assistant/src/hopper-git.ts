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
import path from 'node:path';
import { getHopperNode, getHopperTree, type HopperNodeRow, type HopperTreeRow } from './hopper-engine.js';

const NOT_IMPLEMENTED = (fn: string): never => {
  throw new Error(`[hopper-git] ${fn} is not implemented yet (docs/hopper/PARALLEL-CONTRACT.md §9)`);
};

/** Every git call is timeout-bounded (§8.8). Worktree adds copy a checkout, so 5m. */
const GIT_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// §8 ENFORCEMENT — one chokepoint. Every git invocation in this module goes
// through runGit(), so the invariants are mechanical rather than remembered.
// ---------------------------------------------------------------------------

/** Anything that force-writes a ref. `--force` survives for exactly one case (below). */
const FORCE_FLAGS = new Set(['-f', '--force', '--force-with-lease', '--force-if-includes']);
/** Branch deletion, in every spelling. §8.2 */
const DELETE_FLAGS = new Set(['-d', '-D', '--delete', '-dr', '--remotes']);

/**
 * Throws unless `args` are legal under §8. Exported so the hermetic check can
 * assert the ban directly (PE-9) instead of trusting a code read:
 *
 *   - `git push` is banned outright — the engine never pushes (§8.6).
 *   - no force flag anywhere, with ONE exception: `worktree remove --force`,
 *     which the contract itself prescribes (§3.5 step 5) and which discards
 *     dirty state in the engine's OWN node worktree, never a ref.
 *   - no `branch -d/-D`, no `push --delete`: branches are never deleted (§8.2).
 *   - no `+refs` refspec (a force-update in disguise) (§8.1).
 *   - `reset --hard` is checked by resetHardTo's own path assertion (§8.5).
 */
export function assertGitArgsSafe(args: readonly string[]): void {
  const sub = args.find((a) => !a.startsWith('-')) ?? '';
  if (sub === 'push') throw new Error('[hopper-git] §8.6 violation: the engine never pushes');
  const forceAllowed = args[0] === 'worktree' && args[1] === 'remove';
  for (const a of args) {
    if (FORCE_FLAGS.has(a) && !forceAllowed) {
      throw new Error(`[hopper-git] §8.1 violation: force flag "${a}" in \`git ${args.join(' ')}\``);
    }
    if (sub === 'branch' && DELETE_FLAGS.has(a)) {
      throw new Error(`[hopper-git] §8.2 violation: branch deletion in \`git ${args.join(' ')}\``);
    }
    if (a.startsWith('+refs/') || /^\+[^-\s]+:/.test(a)) {
      throw new Error(`[hopper-git] §8.1 violation: force refspec "${a}"`);
    }
  }
}

interface GitRun {
  ok: boolean;
  output: string;
  code: number | null;
}

/**
 * execFile (never a shell string — §8.7), timeout-bounded (§8.8), output
 * captured, failure returned as a VALUE. Arg safety is asserted first, and an
 * arg-safety violation DOES throw: reaching one is a bug in a caller, not a
 * runtime condition.
 */
function runGit(cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): GitRun {
  assertGitArgsSafe(args);
  try {
    const out = execFileSync('git', args as string[], {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, output: (out ?? '').toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; status?: number | null; message?: string };
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || 'git failed';
    return { ok: false, output, code: typeof e.status === 'number' ? e.status : null };
  }
}

/**
 * Is `repoPath` actually a usable git repo? Checked BEFORE anything is created,
 * so a tree configured with a bad `repo_path` fails as a clean value instead of
 * leaving an empty `<repo>-worktrees/<tree>/` behind (and instead of `git`
 * itself failing with a bare spawn ENOENT, which says nothing useful).
 */
function repoUnavailable(repoPath: string): GitFailure | null {
  if (!repoPath?.trim()) return { ok: false, reason: 'repo_unavailable', output: 'empty repo_path' };
  if (!fs.existsSync(repoPath)) {
    return { ok: false, reason: 'repo_unavailable', output: `repo_path does not exist: ${repoPath}` };
  }
  const probe = runGit(repoPath, ['rev-parse', '--git-dir'], 10_000);
  if (!probe.ok) return { ok: false, reason: 'repo_unavailable', output: `${repoPath} is not a git repo: ${probe.output}` };
  return null;
}

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
export function repoWorktreeRoot(repoPath: string): string {
  const abs = path.resolve(repoPath);
  return path.join(path.dirname(abs), `${path.basename(abs)}-worktrees`);
}

/** `repoWorktreeRoot(repo)/<tree_id>` — every path the engine may write. §3.1, §8.4 */
export function treeWorktreeRoot(repoPath: string, treeId: string): string {
  if (!treeId || /[/\\]/.test(treeId)) throw new Error(`[hopper-git] illegal tree id "${treeId}"`);
  return path.join(repoWorktreeRoot(repoPath), treeId);
}

/** `treeWorktreeRoot/_integration` — where merges and the build gate run. §3.1 */
export function integrationWorktreePath(repoPath: string, treeId: string): string {
  return path.join(treeWorktreeRoot(repoPath, treeId), '_integration');
}

/** `treeWorktreeRoot/n<node_id>` — one node's private checkout. §3.1 */
export function nodeWorktreePath(repoPath: string, treeId: string, nodeId: number): string {
  if (!Number.isInteger(nodeId) || nodeId <= 0) throw new Error(`[hopper-git] illegal node id "${nodeId}"`);
  return path.join(treeWorktreeRoot(repoPath, treeId), `n${nodeId}`);
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
export function nodeBranchName(integrationBranch: string, nodeId: number): string {
  const base = (integrationBranch ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('[hopper-git] nodeBranchName: empty integration branch');
  if (!Number.isInteger(nodeId) || nodeId <= 0) throw new Error(`[hopper-git] illegal node id "${nodeId}"`);
  return `${base}-n${nodeId}`;
}

/**
 * A tree is an INTEGRATION TREE iff `repo_path` AND `integration_branch` are
 * both non-null. Any other combination is a legacy tree and every parallel
 * behavior is skipped — byte-for-byte today's dispatch. §2
 */
export function isIntegrationTree(tree: HopperTreeRow | null | undefined): boolean {
  return !!tree && !!tree.repo_path?.trim() && !!tree.integration_branch?.trim();
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
export function assertMergeTargetSafe(branch: string): void {
  const raw = (branch ?? '').trim();
  if (!raw) throw new Error('[hopper-git] §8.3 violation: empty merge target');
  // Strip the spellings that all resolve to the same protected branch.
  const bare = raw
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^origin\//, '')
    .replace(/^heads\//, '')
    .toLowerCase();
  if (bare === 'master' || bare === 'main' || bare === 'head') {
    throw new Error(`[hopper-git] §8.3 violation: refusing "${raw}" as a merge target — integration branch -> main is Kevin's, always`);
  }
}

/**
 * Throws unless `candidatePath` resolves inside `treeWorktreeRoot(repo, treeId)`.
 * Called by every mutating helper before it runs git, so the live checkout and
 * other trees' worktrees are structurally unreachable. §8.4
 */
export function assertPathInTreeRoot(repoPath: string, treeId: string, candidatePath: string): void {
  const root = treeWorktreeRoot(repoPath, treeId);
  const candidate = path.resolve(candidatePath ?? '');
  const rel = path.relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`[hopper-git] §8.4 violation: "${candidate}" is not inside the engine's tree root "${root}"`);
  }
}

// ---------------------------------------------------------------------------
// Worktree lifecycle (§3.2, §3.5 step 5)
// ---------------------------------------------------------------------------

/**
 * Idempotently create `<tree>/_integration` on `integrationBranch`. A no-op when
 * it already exists and is on the right branch. §3.2 step 2
 */
export function ensureIntegrationWorktree(
  repoPath: string,
  treeId: string,
  integrationBranch: string,
): GitResult<{ worktree_path: string; head_sha: string; reused: boolean; created_branch: boolean }> {
  // The integration branch IS the eventual merge target, so it is checked here,
  // once, at the moment the worktree is born — a tree can never get as far as a
  // merge with master/main in that column. §8.3
  assertMergeTargetSafe(integrationBranch);
  const wt = integrationWorktreePath(repoPath, treeId);
  assertPathInTreeRoot(repoPath, treeId, wt);
  const unusable = repoUnavailable(repoPath);
  if (unusable) return unusable;

  const existing = registeredWorktree(repoPath, wt);
  if (existing) {
    if (existing.branch && existing.branch !== integrationBranch) {
      return {
        ok: false,
        reason: 'integration_worktree_branch_mismatch',
        output: `${wt} is registered on "${existing.branch}", expected "${integrationBranch}"`,
      };
    }
    const head = currentHead(wt);
    if (!head.ok) return head;
    return { ok: true, worktree_path: wt, head_sha: head.sha, reused: true, created_branch: false };
  }

  // A registration left behind by a crash (directory already gone) would make
  // `worktree add` fail; prune metadata first — non-destructive, it only forgets
  // registrations whose directory is missing.
  pruneStaleWorktreeRegistrations(repoPath);
  try {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
  } catch (err) {
    return { ok: false, reason: 'worktree_root_mkdir_failed', output: String(err) };
  }

  let createdBranch = false;
  let added: GitRun;
  if (branchExists(repoPath, integrationBranch)) {
    added = runGit(repoPath, ['worktree', 'add', wt, integrationBranch]);
  } else if (remoteBranchExists(repoPath, integrationBranch)) {
    // Never seen locally but pushed — track the remote, don't invent a base.
    createdBranch = true;
    added = runGit(repoPath, ['worktree', 'add', '-b', integrationBranch, wt, `origin/${integrationBranch}`]);
  } else {
    // Brand-new integration branch: cut it from the repo's CURRENT HEAD. This
    // creates a ref and a new directory; it does not write the live checkout's
    // working tree, and nothing is forced or deleted.
    const base = runGit(repoPath, ['rev-parse', 'HEAD'], 30_000);
    if (!base.ok) return { ok: false, reason: 'repo_head_unreadable', output: base.output };
    createdBranch = true;
    added = runGit(repoPath, ['worktree', 'add', '-b', integrationBranch, wt, base.output.trim()]);
  }
  if (!added.ok) {
    // The common real-world case: the branch is already checked out in another
    // worktree (including the live checkout). Reported, never forced.
    const reason = /already (checked out|used by worktree)/i.test(added.output)
      ? 'integration_branch_checked_out_elsewhere'
      : 'integration_worktree_add_failed';
    return { ok: false, reason, output: added.output };
  }
  const head = currentHead(wt);
  if (!head.ok) return head;
  return { ok: true, worktree_path: wt, head_sha: head.sha, reused: false, created_branch: createdBranch };
}

/** One entry of `git worktree list --porcelain`, for the paths we care about. */
export interface RegisteredWorktree {
  worktree_path: string;
  branch: string | null;
}

/**
 * Is `candidatePath` a live registered worktree of `repoPath`, and on what
 * branch? Read-only. Returns null when unregistered or its directory is gone.
 */
export function registeredWorktree(repoPath: string, candidatePath: string): RegisteredWorktree | null {
  const listed = runGit(repoPath, ['worktree', 'list', '--porcelain'], 30_000);
  if (!listed.ok) return null;
  const want = path.resolve(candidatePath);
  const entries: RegisteredWorktree[] = [];
  let cur: string | null = null;
  let branch: string | null = null;
  const flush = (): void => {
    if (cur) entries.push({ worktree_path: cur, branch });
    cur = null;
    branch = null;
  };
  for (const line of listed.output.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      cur = path.resolve(line.slice('worktree '.length).trim());
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line.trim() === '') {
      flush();
    }
  }
  flush();
  const hit = entries.find((e) => e.worktree_path === want);
  if (!hit) return null;
  return fs.existsSync(hit.worktree_path) ? hit : null;
}

/**
 * `git worktree prune` — forgets registrations whose directory no longer
 * exists. Non-destructive by construction: it touches no branch and no live
 * worktree, and it is what lets a crashed or manually-deleted node worktree be
 * re-materialized instead of wedging the tree. §8.2
 */
export function pruneStaleWorktreeRegistrations(repoPath: string): GitResult<{ output: string }> {
  const res = runGit(repoPath, ['worktree', 'prune'], 60_000);
  return res.ok ? { ok: true, output: res.output } : { ok: false, reason: 'worktree_prune_failed', output: res.output };
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
  tree: HopperTreeRow,
  node: HopperNodeRow,
): GitResult<NodeWorktree> {
  if (!isIntegrationTree(tree)) {
    return { ok: false, reason: 'not_an_integration_tree', output: `tree ${tree.id} has no repo_path/integration_branch` };
  }
  const repoPath = tree.repo_path!;
  const integrationBranch = tree.integration_branch!;
  assertMergeTargetSafe(integrationBranch);
  const branch = nodeBranchName(integrationBranch, node.id);
  const wt = nodeWorktreePath(repoPath, tree.id, node.id);
  assertPathInTreeRoot(repoPath, tree.id, wt);
  const unusable = repoUnavailable(repoPath);
  if (unusable) return unusable;

  // Already materialized (a re-dispatch inside the same lease, or a retry whose
  // worktree was deliberately kept per §3.3) — reuse it untouched.
  const existing = registeredWorktree(repoPath, wt);
  if (existing) {
    if (existing.branch && existing.branch !== branch) {
      return {
        ok: false,
        reason: 'node_worktree_branch_mismatch',
        output: `${wt} is registered on "${existing.branch}", expected "${branch}"`,
      };
    }
    const head = currentHead(wt);
    if (!head.ok) return head;
    return { ok: true, worktree_path: wt, node_branch: branch, base_sha: head.sha, reused: true };
  }

  pruneStaleWorktreeRegistrations(repoPath);
  try {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
  } catch (err) {
    return { ok: false, reason: 'worktree_root_mkdir_failed', output: String(err) };
  }

  const reused = branchExists(repoPath, branch);
  let added: GitRun;
  let baseSha: string;
  if (reused) {
    // A retry: branches are never deleted (§8.2), so the predecessor attempt's
    // commits are still on this branch. Check it out rather than re-cutting —
    // re-cutting would silently throw that work away.
    const head = runGit(repoPath, ['rev-parse', `refs/heads/${branch}`], 30_000);
    if (!head.ok) return { ok: false, reason: 'node_branch_unreadable', output: head.output };
    baseSha = head.output.trim();
    added = runGit(repoPath, ['worktree', 'add', wt, branch]);
  } else {
    // THE MECHANISM (§3.2): cut from the integration branch's head AS OF NOW.
    // A node claimed after its dependency merged therefore starts from a base
    // that contains it; cutting at plant time would hand every node the same
    // stale base and re-create the clobbering under a new name.
    const head = runGit(repoPath, ['rev-parse', `refs/heads/${integrationBranch}`], 30_000);
    if (!head.ok) return { ok: false, reason: 'integration_head_unreadable', output: head.output };
    baseSha = head.output.trim();
    added = runGit(repoPath, ['worktree', 'add', '-b', branch, wt, baseSha]);
  }
  if (!added.ok) {
    const reason = /already (checked out|used by worktree)/i.test(added.output)
      ? 'node_branch_checked_out_elsewhere'
      : 'node_worktree_add_failed';
    return { ok: false, reason, output: added.output };
  }
  return { ok: true, worktree_path: wt, node_branch: branch, base_sha: baseSha, reused };
}

/**
 * Remove a node's worktree after a green integration. **Removes the WORKTREE
 * ONLY — the branch survives** as the audit trail and the retry base. §3.5 step 5, §8.2
 */
export function pruneNodeWorktree(
  repoPath: string,
  treeId: string,
  nodeId: number,
): GitResult<{ removed: boolean }> {
  const wt = nodeWorktreePath(repoPath, treeId, nodeId);
  assertPathInTreeRoot(repoPath, treeId, wt);
  if (!fs.existsSync(wt)) {
    pruneStaleWorktreeRegistrations(repoPath);
    return { ok: true, removed: false };
  }
  // `--force` here is the ONE permitted use (§3.5 step 5): it discards dirty
  // state in the engine's OWN node worktree. It updates no ref, and the node's
  // branch survives as the audit trail and the retry base (§8.2).
  const removed = runGit(repoPath, ['worktree', 'remove', '--force', wt]);
  if (!removed.ok) return { ok: false, reason: 'worktree_remove_failed', output: removed.output };
  pruneStaleWorktreeRegistrations(repoPath);
  return { ok: true, removed: true };
}

// ---------------------------------------------------------------------------
// Merge-back (§3.5)
// ---------------------------------------------------------------------------

/** `git rev-parse HEAD` in a worktree. Read-only. */
export function currentHead(worktreePath: string): GitResult<{ sha: string }> {
  const res = runGit(worktreePath, ['rev-parse', 'HEAD'], 30_000);
  if (!res.ok) return { ok: false, reason: 'head_unreadable', output: res.output };
  return { ok: true, sha: res.output.trim() };
}

/** `git rev-parse --verify refs/heads/<branch>` — read-only existence check. */
export function branchExists(repoPath: string, branch: string): boolean {
  if (!branch?.trim()) return false;
  return runGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], 10_000).ok;
}

/**
 * `git rev-parse --verify refs/remotes/origin/<branch>` — read-only. Backs the
 * `branch_pushed` unpark condition. §6
 *
 * Reads local refs only (no `fetch`, no network) — a failure (unknown ref, not
 * a git repo, timeout) is a value: `false`, never a throw, per §8.8.
 */
export function remoteBranchExists(repoPath: string, branch: string): boolean {
  if (!branch?.trim()) return false;
  return runGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], 10_000).ok;
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
