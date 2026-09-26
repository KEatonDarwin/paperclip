#!/usr/bin/env node
// HOPPER-GIT CHECK — docs/hopper/PARALLEL-CONTRACT.md §1-§2, §3.1-§3.4, §8
// (tree-383bb55b node #948)
//
//   npm run hopper-git:check
//
// Drives the REAL compiled dist/hopper-git.js and dist/hopper-engine.js against
// a scratch DB and a THROWAWAY git repo created under /tmp with `git init`.
//
// Hermetic (§10): scratch DB under JARVIS_DB_PATH, JARVIS_SIM=1, zero model
// calls (the one dispatchTick drive registers a stub that RECORDS instead of
// calling a model, and the check asserts it was never reached). Git is real but
// strictly local — never /home/kevin/paperclip, never a network remote.
//
// Covers, by contract section:
//   HG-1  §3.1 path + name helpers
//   HG-2  §3.1 node branches use '-nID', proven against real git (the '/' form
//         is asserted to fail, which is why the hyphen form is binding)
//   HG-3  §8   guards: merge target, path confinement, forbidden git args
//   HG-4  §3.2 ensureIntegrationWorktree creates then reuses _integration
//   HG-5  §3.2 THE MECHANISM — a branch is cut from the integration head AS OF
//         THE CLAIM: advance the head between two claims, the second node sees
//         the CURRENT head, the first is unaffected
//   HG-6  §3.3/§8.2 prune removes the WORKTREE and keeps the BRANCH; a retry
//         re-materializes onto its predecessor's commits
//   HG-7  §3.2/§3.4 the dispatch seam: prepareIntegrationWorkspace persists
//         worktree_path/node_branch and composeWorkerPrompt gains the
//         WORKTREE:/BRANCH: block — and a LEGACY tree gets neither
//   HG-8  §2   migration is additive: a PRE-MIGRATION db opens, its legacy rows
//         read back null, and they dispatch with nothing done to them
//   HG-9  §3.2 step 5 — a git failure releases the claim and REFUNDS the
//         attempt, driven through the real dispatchTick, with no spawn

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const rawDb = process.env.JARVIS_DB_PATH;
if (!rawDb || !rawDb.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(rawDb);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

process.env.JARVIS_SIM = '1';
process.env.HOPPER_GOV_ENABLED = '0';
process.env.NIGHT_SHIFT_DRIVER = '0';
process.env.NIGHT_SHIFT_KICK_MS = '999999999';
process.env.GOALS_AUTOPILOT_DRIVER = '0';
process.env.GOALS_AUTOPILOT_KICK_MS = '999999999';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function throws(name, fn, match) {
  try {
    fn();
    check(name, false, 'did not throw');
  } catch (err) {
    check(name, match ? String(err.message).includes(match) : true, String(err.message));
  }
}

// ---------------------------------------------------------------------------
// HG-8 (part 1) — seed a PRE-MIGRATION hopper schema BEFORE the engine loads,
// so the additive ALTER TABLE loop is exercised the way a real upgrade does it.
// ---------------------------------------------------------------------------
const Database = (await import('better-sqlite3')).default;
{
  const seed = new Database(DB_PATH);
  seed.exec(`
    CREATE TABLE hopper_trees (
      id                TEXT PRIMARY KEY,
      topic             TEXT NOT NULL,
      origin_thread_ext TEXT,
      status            TEXT NOT NULL DEFAULT 'draft',
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE hopper_nodes (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      tree_id          TEXT NOT NULL REFERENCES hopper_trees(id),
      parent_id        INTEGER REFERENCES hopper_nodes(id),
      title            TEXT NOT NULL,
      spec             TEXT,
      status           TEXT NOT NULL DEFAULT 'draft',
      depends_on       TEXT,
      priority         INTEGER NOT NULL DEFAULT 0,
      attempts         INTEGER NOT NULL DEFAULT 0,
      question         TEXT,
      answer           TEXT,
      result           TEXT,
      worker_thread_ext TEXT,
      lease_expires_at TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO hopper_trees (id, topic, status) VALUES ('tree-premigration', 'a tree that existed before §2', 'draft');
    INSERT INTO hopper_nodes (tree_id, title, status) VALUES ('tree-premigration', 'legacy leaf', 'pending');
  `);
  seed.close();
}

const dist = path.join(repoRoot, 'dist');
const { sqliteDb } = await import(path.join(dist, 'conversation-db.js'));
const hg = await import(path.join(dist, 'hopper-git.js'));
const engine = await import(path.join(dist, 'hopper-engine.js'));

// ---------------------------------------------------------------------------
// Throwaway git repo (§10: "git is real but local"). Nothing here ever points
// at a real repo or a network remote.
// ---------------------------------------------------------------------------
const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hopper-git-check-'));
const REPO = path.join(gitRoot, 'demo-repo');
const INTEGRATION = 'hopper/demo-integration';
fs.mkdirSync(REPO, { recursive: true });
const g = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).toString().trim();
g(REPO, ['init', '-q']);
g(REPO, ['config', 'user.email', 'hopper-git-check@example.com']);
g(REPO, ['config', 'user.name', 'hopper-git-check']);
g(REPO, ['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(REPO, 'README.md'), 'seed\n');
g(REPO, ['add', '.']);
g(REPO, ['commit', '-q', '-m', 'seed']);
const commitIn = (wt, file, body, msg) => {
  fs.writeFileSync(path.join(wt, file), body);
  g(wt, ['add', file]);
  g(wt, ['-c', 'user.email=hopper-git-check@example.com', '-c', 'user.name=hopper-git-check', 'commit', '-q', '-m', msg]);
  return g(wt, ['rev-parse', 'HEAD']);
};
const branchList = () => g(REPO, ['branch', '--format=%(refname:short)']).split('\n').map((x) => x.trim()).filter(Boolean);

// ===========================================================================
console.log('\n[HG-1] §3.1 path + name helpers');
check('repoWorktreeRoot(/home/kevin/paperclip)', hg.repoWorktreeRoot('/home/kevin/paperclip') === '/home/kevin/paperclip-worktrees');
check('a trailing slash does not change the root', hg.repoWorktreeRoot('/home/kevin/paperclip/') === '/home/kevin/paperclip-worktrees');
check('treeWorktreeRoot nests under it', hg.treeWorktreeRoot('/home/kevin/paperclip', 'tree-abc') === '/home/kevin/paperclip-worktrees/tree-abc');
check('integrationWorktreePath', hg.integrationWorktreePath('/home/kevin/paperclip', 'tree-abc') === '/home/kevin/paperclip-worktrees/tree-abc/_integration');
check('nodeWorktreePath', hg.nodeWorktreePath('/home/kevin/paperclip', 'tree-abc', 946) === '/home/kevin/paperclip-worktrees/tree-abc/n946');
throws('a tree id containing a slash is refused (no path escape)', () => hg.treeWorktreeRoot('/home/kevin/paperclip', '../evil'));
throws('a non-positive node id is refused', () => hg.nodeWorktreePath('/home/kevin/paperclip', 'tree-abc', 0));
check('isIntegrationTree needs BOTH columns', hg.isIntegrationTree({ repo_path: REPO, integration_branch: null }) === false);
check('isIntegrationTree false for a legacy tree', hg.isIntegrationTree({ repo_path: null, integration_branch: null }) === false);
check('isIntegrationTree true for both set', hg.isIntegrationTree({ repo_path: REPO, integration_branch: INTEGRATION }) === true);
check('isIntegrationTree false for null tree', hg.isIntegrationTree(null) === false);
check('whitespace-only columns do not make an integration tree', hg.isIntegrationTree({ repo_path: '  ', integration_branch: ' ' }) === false);

// ===========================================================================
console.log('\n[HG-2] §3.1 node branch names use "-nID" — proven against real git');
check('hyphen form', hg.nodeBranchName('hopper/parallel-engine', 946) === 'hopper/parallel-engine-n946');
check('never a slash suffix', !hg.nodeBranchName('hopper/parallel-engine', 946).endsWith('/n946'));
throws('empty integration branch refused', () => hg.nodeBranchName('', 1));
{
  // WHY the hyphen is binding: git refs are files, so refs/heads/<b>/nID cannot
  // coexist with refs/heads/<b>. Proven here, on a throwaway repo, not asserted.
  g(REPO, ['branch', 'hopper/demo-slash']);
  let slashFailed = false;
  try {
    g(REPO, ['branch', 'hopper/demo-slash/n1', 'hopper/demo-slash']);
  } catch {
    slashFailed = true;
  }
  check('real git REFUSES <branch>/nID while <branch> exists', slashFailed);
  g(REPO, ['branch', hg.nodeBranchName('hopper/demo-slash', 1), 'hopper/demo-slash']);
  check('real git ACCEPTS the contract\'s <branch>-nID', branchList().includes('hopper/demo-slash-n1'));
}

// ===========================================================================
console.log('\n[HG-3] §8 guards');
for (const bad of ['master', 'main', 'MAIN', 'refs/heads/master', 'origin/main', 'heads/main', 'HEAD', '  main  ', '']) {
  throws(`merge target refused: "${bad}"`, () => hg.assertMergeTargetSafe(bad), '§8.3');
}
hg.assertMergeTargetSafe('hopper/parallel-engine');
check('a real integration branch is allowed', true);
check('maintenance branches are not confused with main', (() => { hg.assertMergeTargetSafe('feature/mainline-docs'); return true; })());
throws('a path outside the tree root is refused', () => hg.assertPathInTreeRoot(REPO, 'tree-abc', '/home/kevin/paperclip'), '§8.4');
throws('another tree\'s root is refused', () => hg.assertPathInTreeRoot(REPO, 'tree-abc', hg.nodeWorktreePath(REPO, 'tree-other', 1)), '§8.4');
throws('the tree root ITSELF is refused (only children are writable)', () => hg.assertPathInTreeRoot(REPO, 'tree-abc', hg.treeWorktreeRoot(REPO, 'tree-abc')), '§8.4');
hg.assertPathInTreeRoot(REPO, 'tree-abc', hg.nodeWorktreePath(REPO, 'tree-abc', 5));
check('a node worktree inside the tree root is allowed', true);
throws('git push is banned outright', () => hg.assertGitArgsSafe(['push', 'origin', 'x']), '§8.6');
throws('--force is banned', () => hg.assertGitArgsSafe(['merge', '--force', 'x']), '§8.1');
throws('--force-with-lease is banned', () => hg.assertGitArgsSafe(['fetch', '--force-with-lease']), '§8.1');
throws('branch -D is banned', () => hg.assertGitArgsSafe(['branch', '-D', 'x']), '§8.2');
throws('branch --delete is banned', () => hg.assertGitArgsSafe(['branch', '--delete', 'x']), '§8.2');
throws('a +refs force refspec is banned', () => hg.assertGitArgsSafe(['fetch', 'origin', '+refs/heads/x:refs/heads/x']), '§8.1');
hg.assertGitArgsSafe(['worktree', 'remove', '--force', '/tmp/x']);
check('worktree remove --force is the ONE permitted force (§3.5 step 5)', true);
hg.assertGitArgsSafe(['rev-parse', 'HEAD']);
check('ordinary read-only args pass', true);

// ===========================================================================
console.log('\n[HG-4] §3.2 ensureIntegrationWorktree — create, then reuse');
const TREE_ID = 'tree-hgcheck';
let H0;
{
  const first = hg.ensureIntegrationWorktree(REPO, TREE_ID, INTEGRATION);
  check('created ok', first.ok === true, JSON.stringify(first));
  check('path is <root>/<tree>/_integration', first.ok && first.worktree_path === hg.integrationWorktreePath(REPO, TREE_ID));
  check('the branch did not exist, so it was created', first.ok && first.created_branch === true);
  check('worktree exists on disk', fs.existsSync(path.join(hg.integrationWorktreePath(REPO, TREE_ID), 'README.md')));
  check('registered on the integration branch', hg.registeredWorktree(REPO, first.worktree_path)?.branch === INTEGRATION);
  H0 = first.ok ? first.head_sha : null;

  const second = hg.ensureIntegrationWorktree(REPO, TREE_ID, INTEGRATION);
  check('second call is idempotent (reused, nothing created)', second.ok === true && second.reused === true && second.created_branch === false);
  check('same head', second.ok && second.head_sha === H0);
  throws('a master/main integration branch throws before any git runs', () => hg.ensureIntegrationWorktree(REPO, 'tree-nope', 'main'), '§8.3');
  check('...and no worktree was created for it', !fs.existsSync(hg.treeWorktreeRoot(REPO, 'tree-nope')));
}

// ===========================================================================
console.log('\n[HG-5] §3.2 THE MECHANISM — each branch is cut from the head AS OF THE CLAIM');
const tree = { id: TREE_ID, repo_path: REPO, integration_branch: INTEGRATION, build_gate_cmd: null };
let H1;
{
  // t0: node A claims.
  const a = hg.materializeNodeWorktree(tree, { id: 101 });
  check('A materialized', a.ok === true, JSON.stringify(a));
  check('A worktree path', a.ok && a.worktree_path === hg.nodeWorktreePath(REPO, TREE_ID, 101));
  check('A branch name', a.ok && a.node_branch === `${INTEGRATION}-n101`);
  check('A was cut fresh (not reused)', a.ok && a.reused === false);
  check('A base is the integration head H0', a.ok && a.base_sha === H0);

  // t1: A's work lands on the integration branch (the merge-back node's job;
  // here a direct commit in the integration worktree stands in for it).
  H1 = commitIn(hg.integrationWorktreePath(REPO, TREE_ID), 'from-A.txt', 'A did this\n', 'integrate n101');
  check('the integration head advanced H0 -> H1', H1 !== H0);

  // t2: nodes B and C claim AFTER that merge.
  const b = hg.materializeNodeWorktree(tree, { id: 102 });
  const c = hg.materializeNodeWorktree(tree, { id: 103 });
  check('B materialized', b.ok === true, JSON.stringify(b));
  check('C materialized', c.ok === true, JSON.stringify(c));
  check('B was cut from the CURRENT head H1, not H0', b.ok && b.base_sha === H1);
  check('C was cut from the CURRENT head H1, not H0', c.ok && c.base_sha === H1);
  check('B\'s checkout CONTAINS A\'s work', fs.existsSync(path.join(hg.nodeWorktreePath(REPO, TREE_ID, 102), 'from-A.txt')));
  check('C\'s checkout CONTAINS A\'s work', fs.existsSync(path.join(hg.nodeWorktreePath(REPO, TREE_ID, 103), 'from-A.txt')));
  check('A\'s own checkout is untouched by the merge', !fs.existsSync(path.join(hg.nodeWorktreePath(REPO, TREE_ID, 101), 'from-A.txt')));
  check('B and C are separate checkouts', b.ok && c.ok && b.worktree_path !== c.worktree_path);
  check('B and C are separate branches', b.ok && c.ok && b.node_branch !== c.node_branch);
  check('materialize did not move the integration branch', g(REPO, ['rev-parse', `refs/heads/${INTEGRATION}`]) === H1);
}

// ===========================================================================
console.log('\n[HG-6] §3.3/§8.2 prune keeps the branch; a retry resumes on its own commits');
{
  const wtA = hg.nodeWorktreePath(REPO, TREE_ID, 101);
  const workSha = commitIn(wtA, 'attempt-1.txt', 'half-finished work\n', 'n101 attempt 1');
  const pruned = hg.pruneNodeWorktree(REPO, TREE_ID, 101);
  check('prune ok', pruned.ok === true && pruned.removed === true, JSON.stringify(pruned));
  check('the WORKTREE is gone', !fs.existsSync(wtA));
  check('the BRANCH survives (§8.2 — audit trail + retry base)', branchList().includes(`${INTEGRATION}-n101`));
  check('the branch still points at the attempt\'s commit', g(REPO, ['rev-parse', `refs/heads/${INTEGRATION}-n101`]) === workSha);

  const retry = hg.materializeNodeWorktree(tree, { id: 101 });
  check('retry re-materializes', retry.ok === true, JSON.stringify(retry));
  check('retry REUSES the existing branch', retry.ok && retry.reused === true);
  check('retry base is the predecessor\'s commit, not the integration head', retry.ok && retry.base_sha === workSha);
  check('attempt 1\'s work is still there', fs.existsSync(path.join(wtA, 'attempt-1.txt')));

  const again = hg.materializeNodeWorktree(tree, { id: 101 });
  check('materialize is idempotent while the worktree is live', again.ok === true && again.reused === true);
  const noop = hg.pruneNodeWorktree(REPO, TREE_ID, 999);
  check('pruning a worktree that never existed is a no-op, not a failure', noop.ok === true && noop.removed === false);
}

// ===========================================================================
console.log('\n[HG-7] §3.2/§3.4 the dispatch seam — persisted columns + the worker prompt');
const mkTree = (id, integration) => {
  sqliteDb
    .prepare(`INSERT INTO hopper_trees (id, topic, status, repo_path, integration_branch) VALUES (?, ?, 'active', ?, ?)`)
    .run(id, `check tree ${id}`, integration?.repo_path ?? null, integration?.integration_branch ?? null);
  return engine.getHopperTree(id);
};
const mkNode = (treeId, status = 'pending') => {
  const info = sqliteDb.prepare(`INSERT INTO hopper_nodes (tree_id, title, spec, status) VALUES (?, ?, ?, ?)`)
    .run(treeId, 'a leaf', 'do the thing', status);
  return engine.getHopperNode(Number(info.lastInsertRowid));
};
{
  const legacyTree = mkTree('tree-hg-legacy', null);
  const legacyNode = mkNode('tree-hg-legacy');
  const prep = engine.prepareIntegrationWorkspace(legacyNode, legacyTree);
  check('LEGACY tree: prep is a skip', prep.ok === true && prep.skipped === true);
  const afterLegacy = engine.getHopperNode(legacyNode.id);
  check('LEGACY tree: worktree_path stays null', afterLegacy.worktree_path === null);
  check('LEGACY tree: node_branch stays null', afterLegacy.node_branch === null);
  const legacyPrompt = engine.composeWorkerPrompt(afterLegacy, legacyTree);
  check('LEGACY prompt has NO worktree block', !legacyPrompt.includes('WORKTREE:') && !legacyPrompt.includes('Your worktree'));
  check('LEGACY prompt still has the task + finish contract', legacyPrompt.includes('**Your task (node #') && legacyPrompt.includes('/finish'));

  // A DIFFERENT integration branch: one branch can only be checked out in one
  // worktree, so two trees never share an integration branch (asserted below).
  const INTEGRATION_B = 'hopper/demo-integration-b';
  const intTree = mkTree('tree-hg-int', { repo_path: REPO, integration_branch: INTEGRATION_B });
  check('the tree row round-trips its §2 columns', intTree.repo_path === REPO && intTree.integration_branch === INTEGRATION_B && intTree.build_gate_cmd === null);
  const intNode = mkNode('tree-hg-int');
  const prep2 = engine.prepareIntegrationWorkspace(intNode, intTree);
  check('INTEGRATION tree: prep ran', prep2.ok === true && prep2.skipped === false, JSON.stringify(prep2));
  const afterInt = engine.getHopperNode(intNode.id);
  check('worktree_path persisted', afterInt.worktree_path === hg.nodeWorktreePath(REPO, 'tree-hg-int', intNode.id));
  check('node_branch persisted', afterInt.node_branch === `${INTEGRATION_B}-n${intNode.id}`);
  check('the node worktree really exists', fs.existsSync(afterInt.worktree_path));
  const prompt = engine.composeWorkerPrompt(afterInt, intTree);
  check('prompt carries an explicit WORKTREE: line', prompt.includes(`- WORKTREE: ${afterInt.worktree_path}`));
  check('prompt carries an explicit BRANCH: line', prompt.includes(`- BRANCH: ${afterInt.node_branch}`));
  check('prompt says the block overrides the spec', prompt.includes('authoritative — overrides anything the spec says'));
  check('prompt forbids merging/pushing the integration branch', prompt.includes(`do NOT push to ${INTEGRATION_B}`));
  check('prompt names the live checkout as off-limits', prompt.includes(`Never touch ${REPO}`));
  check('the worktree block precedes the spec', prompt.indexOf('WORKTREE:') < prompt.indexOf('**Spec:**'));

  // Two trees CANNOT share one integration branch — git allows a branch in only
  // one worktree. That is reported as a value, never forced. (Found by this very
  // check: the first draft of it reused one branch for two tree ids.)
  const clashTree = mkTree('tree-hg-clash', { repo_path: REPO, integration_branch: INTEGRATION_B });
  const clashNode = mkNode('tree-hg-clash');
  const clash = engine.prepareIntegrationWorkspace(clashNode, clashTree);
  check('a second tree on the same integration branch is refused as a value', clash.ok === false && clash.reason === 'integration_branch_checked_out_elsewhere', JSON.stringify(clash));
  check('...and the clashing node got no worktree columns', engine.getHopperNode(clashNode.id).worktree_path === null);

  // A tree whose columns are half-set is a LEGACY tree, not a broken one.
  const halfTree = mkTree('tree-hg-half', { repo_path: REPO, integration_branch: null });
  const halfNode = mkNode('tree-hg-half');
  const prep3 = engine.prepareIntegrationWorkspace(halfNode, halfTree);
  check('repo_path without integration_branch = legacy skip', prep3.ok === true && prep3.skipped === true);
}

// ===========================================================================
console.log('\n[HG-8] §2 migration is additive — the pre-migration DB opened untouched');
{
  const treeCols = sqliteDb.prepare(`PRAGMA table_info(hopper_trees)`).all();
  for (const name of ['repo_path', 'integration_branch', 'build_gate_cmd']) {
    const col = treeCols.find((c) => c.name === name);
    check(`hopper_trees.${name} exists`, !!col);
    check(`hopper_trees.${name} is nullable with no default`, !!col && col.notnull === 0 && col.dflt_value === null);
  }
  const nodeCols = sqliteDb.prepare(`PRAGMA table_info(hopper_nodes)`).all();
  for (const name of ['worktree_path', 'node_branch']) {
    const col = nodeCols.find((c) => c.name === name);
    check(`hopper_nodes.${name} exists`, !!col);
    check(`hopper_nodes.${name} is nullable with no default`, !!col && col.notnull === 0 && col.dflt_value === null);
  }
  const legacy = engine.getHopperTree('tree-premigration');
  check('the pre-migration tree row survived', !!legacy);
  check('its new columns read back null', legacy.repo_path === null && legacy.integration_branch === null && legacy.build_gate_cmd === null);
  check('so it is NOT an integration tree', hg.isIntegrationTree(legacy) === false);
  const legacyLeaf = engine.listTreeNodes('tree-premigration')[0];
  check('its node\'s new columns read back null', legacyLeaf.worktree_path === null && legacyLeaf.node_branch === null);
  const prep = engine.prepareIntegrationWorkspace(legacyLeaf, legacy);
  check('a pre-migration tree dispatches with NOTHING done to it', prep.ok === true && prep.skipped === true);
  check('no worktree root was created for it', !fs.existsSync(hg.treeWorktreeRoot(REPO, 'tree-premigration')));
}

// ===========================================================================
console.log('\n[HG-9] §3.2 step 5 — a git failure releases the claim AND refunds the attempt');
{
  // Everything else is parked out of the way so this tick has exactly one
  // candidate: an integration tree pointing at a repo that does not exist.
  sqliteDb.prepare(`UPDATE hopper_trees SET status = 'draft' WHERE status = 'active'`).run();
  const badRepo = path.join(gitRoot, 'not-a-repo');
  const badTree = mkTree('tree-hg-badrepo', { repo_path: badRepo, integration_branch: 'hopper/demo-broken' });
  const badNode = mkNode('tree-hg-badrepo');

  let spawnCalls = 0;
  engine.startHopperEngine(async () => {
    spawnCalls += 1; // a REAL model call would be a policy violation; this records instead
    return '';
  });
  await engine.dispatchTick('hopper-git-check');

  const after = engine.getHopperNode(badNode.id);
  check('the node is back to pending (claim released)', after.status === 'pending', after.status);
  check('its lease was cleared', after.lease_expires_at === null);
  check('its worker thread was cleared', after.worker_thread_ext === null);
  check('the attempt was REFUNDED (a git failure never burns one)', after.attempts === 0, `attempts=${after.attempts}`);
  check('no worker was spawned', spawnCalls === 0, `spawnCalls=${spawnCalls}`);
  check('no worktree columns were written', after.worktree_path === null && after.node_branch === null);
  check('no stray worktree root was created', !fs.existsSync(hg.treeWorktreeRoot(badRepo, 'tree-hg-badrepo')));
  check('the demo repo\'s branches are unchanged by the failure', !branchList().some((b) => b.includes('demo-broken')));
}

// ===========================================================================
console.log('\n[HG-10] §8.2 nothing in this whole run deleted a branch');
{
  const branches = branchList();
  for (const expected of [INTEGRATION, `${INTEGRATION}-n101`, `${INTEGRATION}-n102`, `${INTEGRATION}-n103`, 'hopper/demo-integration-b', 'hopper/demo-slash', 'hopper/demo-slash-n1']) {
    check(`branch still present: ${expected}`, branches.includes(expected));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
