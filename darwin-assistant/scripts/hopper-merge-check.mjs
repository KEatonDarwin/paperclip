#!/usr/bin/env node
// HOPPER MERGE-BACK CHECK — docs/hopper/PARALLEL-CONTRACT.md §3.5-§3.6
// (tree-383bb55b node #949)
//
//   npm run hopper-merge:check
//
// Drives the REAL compiled dist/hopper-git.js + dist/hopper-engine.js — the real
// finishHopperNode, the real dispatchTick, the real git — against a scratch DB
// and a THROWAWAY repo created under /tmp with `git init`.
//
// Hermetic (§10): scratch DB via JARVIS_DB_PATH, JARVIS_SIM=1, ZERO model calls
// (the engine is started with a stub that RECORDS a spawn instead of calling a
// model, and every section asserts the recorded count). Git is real but strictly
// local — never /home/kevin/paperclip, never a network remote.
//
// Covers, by contract section:
//   MB-1  §3.6 build-gate resolution: verbatim / '' = skip / null default / none
//   MB-2  §3.5 a clean two-node merge-back, SERIALIZED in finish order
//   MB-3  §3.5 a same-file CONFLICT → `integrate nX` node naming the file,
//         original `integration_pending`, integration branch untouched, and the
//         original's DEPENDENTS STAY BLOCKED (driven through dispatchTick)
//   MB-4  §3.5 step 4 a RED BUILD GATE → same, plus the integration branch reset
//         to its pre-merge sha
//   MB-5  §4.1 KEVIN'S ACCEPTANCE SCENARIO end-to-end: A+D immediately, B+C only
//         after A INTEGRATES, all four land, zero clobbering (file contents)
//   MB-6  §3.5 a repair node landing also lands the node it repaired, which is
//         what finally releases that node's dependents
//   MB-7  §8 safety: reset --hard cannot reach a node worktree, a master/main
//         merge target throws before git runs, and NO branch was deleted

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
// The acceptance scenario is about the IMPLICIT caps going away, not about slots.
// Kevin's dials still cap the machine (§4) — they just have to be wide enough
// here that "A and D together" is the engine's own choice, and wide enough that
// the repair nodes MB-3/MB-4 deliberately leave running are not the reason
// something else is held.
process.env.HOPPER_ENGINE_SLOTS = '8';
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

const dist = path.join(repoRoot, 'dist');
const { sqliteDb } = await import(path.join(dist, 'conversation-db.js'));
const hg = await import(path.join(dist, 'hopper-git.js'));
const engine = await import(path.join(dist, 'hopper-engine.js'));

// A REAL model call would be a policy violation. This records instead, and every
// section asserts the count, so "zero model calls" is proven, not promised.
let spawnCalls = 0;
const spawnedPrompts = [];
engine.startHopperEngine(async (prompt) => {
  spawnCalls += 1;
  spawnedPrompts.push(prompt);
  return '';
});

// ---------------------------------------------------------------------------
// Throwaway git repo (§10: "git is real but local").
// ---------------------------------------------------------------------------
const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hopper-merge-check-'));
const REPO = path.join(gitRoot, 'demo-repo');
fs.mkdirSync(REPO, { recursive: true });
const g = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).toString().trim();
g(REPO, ['init', '-q']);
g(REPO, ['config', 'user.email', 'hopper-merge-check@example.com']);
g(REPO, ['config', 'user.name', 'hopper-merge-check']);
g(REPO, ['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(REPO, 'shared.txt'), 'seed line\n');
g(REPO, ['add', '.']);
g(REPO, ['commit', '-q', '-m', 'seed']);

/** Whatever `git init` called it here — asserted untouched in MB-7. */
const DEFAULT_BRANCH = g(REPO, ['symbolic-ref', '--short', 'HEAD']);

const branchList = () => g(REPO, ['branch', '--format=%(refname:short)']).split('\n').map((x) => x.trim()).filter(Boolean);
const headOf = (branch) => g(REPO, ['rev-parse', `refs/heads/${branch}`]);
const logOf = (branch, n = 20) => g(REPO, ['log', `--format=%s`, `-n${n}`, `refs/heads/${branch}`]).split('\n');
const fileOnBranch = (branch, file) => {
  try {
    return g(REPO, ['show', `refs/heads/${branch}:${file}`]);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Fixtures: a tree + its nodes, and a stand-in for a worker doing its job.
// ---------------------------------------------------------------------------
const mkTree = (id, branch, gateCmd = null) => {
  sqliteDb
    .prepare(`INSERT INTO hopper_trees (id, topic, status, repo_path, integration_branch, build_gate_cmd) VALUES (?, ?, 'active', ?, ?, ?)`)
    .run(id, `merge check ${id}`, REPO, branch, gateCmd);
  return engine.getHopperTree(id);
};
const mkNode = (treeId, title, deps = null, status = 'pending') => {
  const info = sqliteDb
    .prepare(`INSERT INTO hopper_nodes (tree_id, title, spec, status, depends_on) VALUES (?, ?, ?, ?, ?)`)
    .run(treeId, title, `do ${title}`, status, deps ? JSON.stringify(deps) : null);
  return engine.getHopperNode(Number(info.lastInsertRowid));
};
/** Claim a node the way dispatchTick does, without needing a whole tick. */
const claim = (nodeId) => {
  const node = engine.getHopperNode(nodeId);
  const tree = engine.getHopperTree(node.tree_id);
  const prep = engine.prepareIntegrationWorkspace(node, tree);
  sqliteDb.prepare(`UPDATE hopper_nodes SET status='running', worker_thread_ext=?, attempts=attempts+1 WHERE id=?`).run(`check-ext-${nodeId}`, nodeId);
  return prep;
};
/** What a worker does: commit in its OWN worktree, on its OWN branch. */
const workIn = (nodeId, files) => {
  const node = engine.getHopperNode(nodeId);
  for (const [file, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(node.worktree_path, file), body);
    g(node.worktree_path, ['add', file]);
  }
  g(node.worktree_path, ['commit', '-q', '-m', `n${nodeId} work`]);
  return g(node.worktree_path, ['rev-parse', 'HEAD']);
};
const repairNodeFor = (treeId, nodeId) =>
  engine.listTreeNodes(treeId).find((n) => n.integrates_node_id === nodeId) ?? null;

// ===========================================================================
console.log('\n[MB-1] §3.6 build-gate resolution');
{
  const WT = '/tmp/does-not-matter/_integration';
  check('an explicit command is used VERBATIM', (() => {
    const r = hg.resolveBuildGateCmd({ repo_path: REPO, integration_branch: 'x', build_gate_cmd: 'make check' }, WT);
    return r?.command === 'make check' && r?.cwd === WT;
  })());
  check('an EXPLICIT empty string SKIPS the gate (merge alone decides)',
    hg.resolveBuildGateCmd({ repo_path: REPO, integration_branch: 'x', build_gate_cmd: '' }, WT) === null);
  check('a whitespace-only command also skips',
    hg.resolveBuildGateCmd({ repo_path: REPO, integration_branch: 'x', build_gate_cmd: '   ' }, WT) === null);
  check('null + no darwin-assistant/package.json = skip',
    hg.resolveBuildGateCmd({ repo_path: REPO, integration_branch: 'x', build_gate_cmd: null }, WT) === null);
  // The default that matters on this box: the paperclip monorepo's own gate.
  check('null + darwin-assistant/package.json = npm run build in darwin-assistant', (() => {
    const monorepo = path.resolve(repoRoot, '..');
    const r = hg.resolveBuildGateCmd({ repo_path: monorepo, integration_branch: 'x', build_gate_cmd: null }, WT);
    return r?.command === 'npm run build' && r?.cwd === path.join(WT, 'darwin-assistant');
  })(), `repoRoot=${repoRoot}`);
  check('a skipped gate passes without running anything', await (async () => {
    const out = await hg.runBuildGate({ repo_path: REPO, integration_branch: 'x', build_gate_cmd: '' }, WT);
    return out.passed === true && out.skipped === true && out.command === null && out.exit_code === null;
  })());
}

// ===========================================================================
console.log('\n[MB-2] §3.5 clean two-node merge-back, serialized in finish order');
{
  const TREE = 'tree-mb-clean';
  const BR = 'hopper/mb-clean';
  mkTree(TREE, BR);
  const a = mkNode(TREE, 'node A');
  const b = mkNode(TREE, 'node B');
  const prepA = claim(a.id);
  const prepB = claim(b.id);
  check('both nodes got their own worktree', prepA.ok && prepB.ok && prepA.worktree_path !== prepB.worktree_path, JSON.stringify([prepA, prepB]));
  const H0 = headOf(BR);
  check('both were cut from the same head H0', prepA.base_sha === H0 && prepB.base_sha === H0);

  workIn(a.id, { 'a.txt': 'from A\n' });
  workIn(b.id, { 'b.txt': 'from B\n' });

  // Both finish in the SAME tick — the merges must serialize, not race.
  engine.finishHopperNode(a.id, 'done', { result: 'A done' });
  engine.finishHopperNode(b.id, 'done', { result: 'B done' });
  check('finish marks them integration_pending immediately (before the merge)',
    engine.getHopperNode(a.id).integration_state === 'integration_pending' &&
    engine.getHopperNode(b.id).integration_state === 'integration_pending');
  await engine.integrationIdle(TREE);

  const afterA = engine.getHopperNode(a.id);
  const afterB = engine.getHopperNode(b.id);
  check('A integrated', afterA.integration_state === 'merged', afterA.integration_state);
  check('B integrated', afterB.integration_state === 'merged', afterB.integration_state);
  check('both are still status=done', afterA.status === 'done' && afterB.status === 'done');
  check('A\'s file is on the integration branch', fileOnBranch(BR, 'a.txt') === 'from A');
  check('B\'s file is on the integration branch', fileOnBranch(BR, 'b.txt') === 'from B');
  const subjects = logOf(BR);
  check('each merge is its own --no-ff merge commit, named by node',
    subjects.includes(`hopper: integrate n${a.id} node A`) && subjects.includes(`hopper: integrate n${b.id} node B`), subjects.join(' | '));
  check('SERIALIZED: B\'s merge sits ON TOP of A\'s (finish order), not beside it',
    subjects.indexOf(`hopper: integrate n${b.id} node B`) < subjects.indexOf(`hopper: integrate n${a.id} node A`), subjects.join(' | '));
  check('the integration head advanced', headOf(BR) !== H0);
  check('both node worktrees were PRUNED', !fs.existsSync(afterA.worktree_path) && !fs.existsSync(afterB.worktree_path));
  check('both node BRANCHES survive (§8.2)', branchList().includes(`${BR}-n${a.id}`) && branchList().includes(`${BR}-n${b.id}`));
  check('the tree finished', engine.getHopperTree(TREE).status === 'done');
  check('still zero model calls', spawnCalls === 0, `spawnCalls=${spawnCalls}`);
}

// ===========================================================================
console.log('\n[MB-3] §3.5 a same-file conflict becomes a visible integrate node');
const CONFLICT = { tree: 'tree-mb-conflict', br: 'hopper/mb-conflict' };
{
  const { tree: TREE, br: BR } = CONFLICT;
  mkTree(TREE, BR);
  const a = mkNode(TREE, 'node A');
  const b = mkNode(TREE, 'node B');
  const c = mkNode(TREE, 'node C depends on B', [b.id]);
  CONFLICT.ids = { a: a.id, b: b.id, c: c.id };
  claim(a.id);
  claim(b.id);
  // Both edit the SAME line of the SAME file from the SAME base — the thing the
  // whole contract exists to make safe.
  workIn(a.id, { 'shared.txt': 'A rewrote this line\n' });
  workIn(b.id, { 'shared.txt': 'B rewrote this line\n' });

  engine.finishHopperNode(a.id, 'done', { result: 'A done' });
  await engine.integrationIdle(TREE);
  const headAfterA = headOf(BR);
  check('A merged cleanly first', engine.getHopperNode(a.id).integration_state === 'merged');

  engine.finishHopperNode(b.id, 'done', { result: 'B done' });
  await engine.integrationIdle(TREE);

  const afterB = engine.getHopperNode(b.id);
  check('B is still status=done (the worker did its job)', afterB.status === 'done', afterB.status);
  check('B is integration_pending (its work is NOT on the branch)', afterB.integration_state === 'integration_pending', String(afterB.integration_state));
  check('the integration branch is UNCHANGED by the failed merge', headOf(BR) === headAfterA);
  check('...and still holds A\'s version of the file, not B\'s', fileOnBranch(BR, 'shared.txt') === 'A rewrote this line');
  check('B\'s worktree was NOT pruned (§3.3 — Kevin can look at it)', fs.existsSync(afterB.worktree_path));
  check('the integration worktree is left clean (the merge was aborted)',
    g(hg.integrationWorktreePath(REPO, TREE), ['status', '--porcelain']) === '');

  const repair = repairNodeFor(TREE, b.id);
  check('an integrate node was created', !!repair);
  check('titled "integrate nX"', repair?.title === `integrate n${b.id}`, repair?.title);
  check('it depends on NOTHING (claimable on the very next tick)', repair?.depends_on === null);
  // `depends_on = null` means the engine's own post-finish tick may already have
  // claimed it — which is the point. Either state proves "claimable immediately".
  check('it is claimable immediately (pending, or already claimed on the finish tick)',
    repair?.status === 'pending' || repair?.status === 'running', repair?.status);
  check('it holds the §5 integration lease name', repair?.resources === JSON.stringify([`integration:${TREE}`]), String(repair?.resources));
  check('it points back at the node it repairs', repair?.integrates_node_id === b.id);
  check('its spec NAMES the conflicted file', !!repair?.spec?.includes('shared.txt'), repair?.spec?.slice(0, 400));
  check('its spec names the failing branch', !!repair?.spec?.includes(`${BR}-n${b.id}`));
  check('its spec names the reason', !!repair?.spec?.includes('merge conflict'));
  check('its spec forbids touching the integration branch', !!repair?.spec?.includes('Do NOT push'));

  // THE POINT: B is "done", but its dependent must NOT start, because B's work
  // is not on the branch it would be cut from.
  await engine.dispatchTick('mb-3');
  const afterC = engine.getHopperNode(c.id);
  check('C (depends on B) is STILL PENDING — a dependent never unblocks on an unmerged dep',
    afterC.status === 'pending', afterC.status);
  check('C got no worktree', afterC.worktree_path === null);
  check('the integrate node WAS dispatched by that same tick', engine.getHopperNode(repair.id).status === 'running');
  check('exactly one worker was spawned on this tree — the repair node',
    spawnedPrompts.filter((p) => p.includes(TREE)).length === 1, `${spawnedPrompts.filter((p) => p.includes(TREE)).length}`);
  check('the repair worker was told its own worktree', spawnedPrompts.at(-1).includes(`- WORKTREE: ${engine.getHopperNode(repair.id).worktree_path}`));
  check('the tree did NOT flip done with an unmerged node', engine.getHopperTree(TREE).status === 'active');
}

// ===========================================================================
console.log('\n[MB-4] §3.5 step 4 — a red build gate is a failure too, and the branch is put back');
{
  const TREE = 'tree-mb-gate';
  const BR = 'hopper/mb-gate';
  // A gate that is simply, reliably red.
  mkTree(TREE, BR, 'echo "GATE-SAYS-NO: two exports named the same thing" 1>&2; exit 1');
  const a = mkNode(TREE, 'node A');
  claim(a.id);
  workIn(a.id, { 'a.txt': 'from A\n' });
  const H0 = headOf(BR);
  engine.finishHopperNode(a.id, 'done', { result: 'A done' });
  await engine.integrationIdle(TREE);

  const after = engine.getHopperNode(a.id);
  check('the node is integration_pending', after.integration_state === 'integration_pending', String(after.integration_state));
  check('the merge was UNDONE — the integration branch is back at its pre-merge sha', headOf(BR) === H0, `${headOf(BR)} vs ${H0}`);
  check('the node\'s file never reached the integration branch', fileOnBranch(BR, 'a.txt') === null);
  check('the integration worktree is clean and back on the branch',
    g(hg.integrationWorktreePath(REPO, TREE), ['status', '--porcelain']) === '' &&
    g(hg.integrationWorktreePath(REPO, TREE), ['rev-parse', 'HEAD']) === H0);
  const repair = repairNodeFor(TREE, a.id);
  check('an integrate node was created for the red gate too',
    !!repair && (repair.status === 'pending' || repair.status === 'running'), repair?.status);
  check('its spec carries the GATE OUTPUT, not a guess', !!repair?.spec?.includes('GATE-SAYS-NO'), repair?.spec?.slice(0, 300));
  check('its spec names the gate command', !!repair?.spec?.includes('exit 1'));
  check('its spec says the reason was the build gate', !!repair?.spec?.includes('build_failed'));
  check('its spec records that the branch was reset', !!repair?.spec?.includes('the integration branch is unchanged'));
  check('the node\'s worktree survives so the repair can merge from it', fs.existsSync(after.worktree_path));
  check('a toolchain failure would be reported DISTINCTLY from a code failure', await (async () => {
    const out = await hg.runBuildGate({ repo_path: REPO, integration_branch: BR, build_gate_cmd: 'definitely-not-a-real-binary' }, hg.integrationWorktreePath(REPO, TREE));
    return out.passed === false && out.reason === 'build_toolchain_missing' && out.exit_code === 127;
  })());
}

// ===========================================================================
console.log("\n[MB-5] §4.1 KEVIN'S ACCEPTANCE SCENARIO — A+D now, B+C after A INTEGRATES, nothing clobbered");
{
  const TREE = 'tree-mb-accept';
  const BR = 'hopper/mb-accept';
  // A gate that takes a beat: it makes "B and C could not have started while A
  // was integrating" an OBSERVED fact rather than a timing accident.
  mkTree(TREE, BR, 'sleep 1');
  const a = mkNode(TREE, 'A — the one the others depend on');
  const d = mkNode(TREE, 'D — depends on nothing');
  const b = mkNode(TREE, 'B — depends on A');
  const c = mkNode(TREE, 'C — depends on A');
  sqliteDb.prepare(`UPDATE hopper_nodes SET depends_on = ? WHERE id IN (?, ?)`).run(JSON.stringify([a.id]), b.id, c.id);

  // --- t0 -----------------------------------------------------------------
  // (the integration branch itself is born here, at the first claim — §3.2)
  await engine.dispatchTick('mb-5 t0');
  const H0 = headOf(BR);
  const t0 = [a, b, c, d].map((n) => engine.getHopperNode(n.id));
  check('t0: A claimed', t0[0].status === 'running', t0[0].status);
  check('t0: D claimed IN THE SAME TICK (parallel on one tree)', t0[3].status === 'running', t0[3].status);
  check('t0: B did not (its dep is unfinished)', t0[1].status === 'pending');
  check('t0: C did not (its dep is unfinished)', t0[2].status === 'pending');
  check('t0: A and D have SEPARATE worktrees', t0[0].worktree_path !== t0[3].worktree_path && fs.existsSync(t0[0].worktree_path) && fs.existsSync(t0[3].worktree_path));
  check('t0: A and D have SEPARATE branches', t0[0].node_branch === `${BR}-n${a.id}` && t0[3].node_branch === `${BR}-n${d.id}`);
  check('t0: both were cut from the integration head H0',
    g(REPO, ['rev-parse', `${t0[0].node_branch}^{commit}`]) === H0 && g(REPO, ['rev-parse', `${t0[3].node_branch}^{commit}`]) === H0);

  // --- t1: A finishes; D keeps working -----------------------------------
  workIn(a.id, { 'a.txt': 'A wrote this\n', 'shared.txt': 'A owns this line\n' });
  workIn(d.id, { 'd.txt': 'D wrote this\n' });
  engine.finishHopperNode(a.id, 'done', { result: 'A done' });
  // While A's gate is still running, a tick must NOT release B or C.
  await engine.dispatchTick('mb-5 t1-mid-integration');
  check('t1: mid-integration, A is done but integration_pending',
    engine.getHopperNode(a.id).status === 'done' && engine.getHopperNode(a.id).integration_state === 'integration_pending');
  check('t1: B stayed PENDING while A was still integrating', engine.getHopperNode(b.id).status === 'pending');
  check('t1: C stayed PENDING while A was still integrating', engine.getHopperNode(c.id).status === 'pending');
  await engine.integrationIdle(TREE);
  const H1 = headOf(BR);
  check('t1: A integrated', engine.getHopperNode(a.id).integration_state === 'merged');
  check('t1: the integration head advanced H0 -> H1', H1 !== H0);
  check('t1: A\'s worktree was pruned', !fs.existsSync(t0[0].worktree_path));
  check('t1: A\'s branch survives', branchList().includes(`${BR}-n${a.id}`));
  const dMid = engine.getHopperNode(d.id);
  check('t1: D is untouched and still running', dMid.status === 'running' && fs.existsSync(dMid.worktree_path));
  check('t1: D\'s checkout did NOT get A\'s work under it', !fs.existsSync(path.join(dMid.worktree_path, 'a.txt')));

  // --- t2: B and C claim, and they contain A's work ----------------------
  await engine.dispatchTick('mb-5 t2');
  const t2b = engine.getHopperNode(b.id);
  const t2c = engine.getHopperNode(c.id);
  check('t2: B claimed now that A INTEGRATED', t2b.status === 'running', t2b.status);
  check('t2: C claimed in the SAME tick (no same-branch refusal, no per-goal cap)', t2c.status === 'running', t2c.status);
  check('t2: B and C are separate worktrees', t2b.worktree_path !== t2c.worktree_path);
  check('t2: they ran CONCURRENTLY on one tree (two running nodes, same tree, same branch lineage)',
    engine.listTreeNodes(TREE).filter((n) => n.status === 'running').length === 3, // B, C and D
    engine.listTreeNodes(TREE).filter((n) => n.status === 'running').map((n) => n.id).join(','));
  check('t2: B was cut from H1 (the head CONTAINING A)', g(REPO, ['rev-parse', `${t2b.node_branch}^{commit}`]) === H1);
  check('t2: C was cut from H1', g(REPO, ['rev-parse', `${t2c.node_branch}^{commit}`]) === H1);
  check('t2: B\'s checkout CONTAINS A\'s file', fs.readFileSync(path.join(t2b.worktree_path, 'a.txt'), 'utf8') === 'A wrote this\n');
  check('t2: C\'s checkout CONTAINS A\'s file', fs.existsSync(path.join(t2c.worktree_path, 'a.txt')));
  check('t2: C sees A\'s version of the shared file', fs.readFileSync(path.join(t2c.worktree_path, 'shared.txt'), 'utf8') === 'A owns this line\n');

  // --- t3: everyone finishes; the merges serialize ------------------------
  workIn(b.id, { 'b.txt': 'B wrote this\n' });
  workIn(c.id, { 'c.txt': 'C wrote this\n' });
  engine.finishHopperNode(d.id, 'done', { result: 'D done' });
  engine.finishHopperNode(b.id, 'done', { result: 'B done' });
  engine.finishHopperNode(c.id, 'done', { result: 'C done' });
  await engine.integrationIdle(TREE);

  const final = [a, b, c, d].map((n) => engine.getHopperNode(n.id));
  check('all four are done', final.every((n) => n.status === 'done'), final.map((n) => n.status).join(','));
  check('all four INTEGRATED', final.every((n) => n.integration_state === 'merged'), final.map((n) => String(n.integration_state)).join(','));
  check('no integrate/repair node was ever needed', engine.listTreeNodes(TREE).every((n) => n.integrates_node_id === null));
  // ZERO CLOBBERING, asserted on contents.
  check('a.txt is exactly A\'s', fileOnBranch(BR, 'a.txt') === 'A wrote this');
  check('b.txt is exactly B\'s', fileOnBranch(BR, 'b.txt') === 'B wrote this');
  check('c.txt is exactly C\'s', fileOnBranch(BR, 'c.txt') === 'C wrote this');
  check('d.txt is exactly D\'s', fileOnBranch(BR, 'd.txt') === 'D wrote this');
  check('shared.txt is exactly A\'s line — nobody overwrote anybody', fileOnBranch(BR, 'shared.txt') === 'A owns this line');
  check('every node worktree was pruned', final.every((n) => !fs.existsSync(n.worktree_path)));
  check('every node branch survives (§8.2)', final.every((n) => branchList().includes(n.node_branch)));
  check('four integrate merge commits, one per node', logOf(BR, 40).filter((l) => l.startsWith('hopper: integrate n')).length === 4);
  check('the tree flipped done', engine.getHopperTree(TREE).status === 'done');
  check('exactly 4 workers were spawned for 4 nodes', spawnedPrompts.filter((p) => p.includes(TREE)).length === 4);
}

// ===========================================================================
console.log('\n[MB-6] §3.5 landing a repair node also lands the node it repaired');
{
  const { tree: TREE, br: BR, ids } = CONFLICT;
  const repair = repairNodeFor(TREE, ids.b);
  const fresh = engine.getHopperNode(repair.id);
  // What the repair worker is told to do: merge the failed branch into its own
  // branch and resolve by hand.
  const bBranch = engine.getHopperNode(ids.b).node_branch;
  let conflicted = false;
  try {
    g(fresh.worktree_path, ['merge', '--no-ff', '-m', 'resolve n' + ids.b, bBranch]);
  } catch {
    conflicted = true;
  }
  check('the repair worker really hits the conflict in ITS OWN worktree', conflicted);
  fs.writeFileSync(path.join(fresh.worktree_path, 'shared.txt'), 'A rewrote this line\nB rewrote this line\n');
  g(fresh.worktree_path, ['add', 'shared.txt']);
  g(fresh.worktree_path, ['commit', '-q', '-m', `resolve n${ids.b} by hand`]);

  engine.finishHopperNode(repair.id, 'done', { result: 'conflict resolved by hand' });
  await engine.integrationIdle(TREE);

  check('the repair node integrated', engine.getHopperNode(repair.id).integration_state === 'merged');
  check('the ORIGINAL node is now merged too — its work landed inside the repair',
    engine.getHopperNode(ids.b).integration_state === 'merged', String(engine.getHopperNode(ids.b).integration_state));
  check('the resolved file holds BOTH sides', fileOnBranch(BR, 'shared.txt') === 'A rewrote this line\nB rewrote this line');
  check('the original\'s worktree was pruned once its work landed', !fs.existsSync(engine.getHopperNode(ids.b).worktree_path));
  check('the original\'s branch survives', branchList().includes(engine.getHopperNode(ids.b).node_branch));

  // And NOW the dependent runs — the whole reason the rule exists.
  await engine.dispatchTick('mb-6');
  const c = engine.getHopperNode(ids.c);
  check('C finally claimed, now that B\'s work is actually ON the branch', c.status === 'running', c.status);
  check('C was cut from a head containing BOTH A\'s and B\'s work',
    fs.readFileSync(path.join(c.worktree_path, 'shared.txt'), 'utf8') === 'A rewrote this line\nB rewrote this line\n');
  engine.finishHopperNode(c.id, 'done', { result: 'C done' });
  await engine.integrationIdle(TREE);
  check('C integrated and the tree finished',
    engine.getHopperNode(ids.c).integration_state === 'merged' && engine.getHopperTree(TREE).status === 'done');
}

// ===========================================================================
console.log('\n[MB-7] §8 safety invariants held through all of it');
{
  const TREE = 'tree-mb-accept';
  const intWt = hg.integrationWorktreePath(REPO, TREE);
  const nodeWt = hg.nodeWorktreePath(REPO, TREE, 12345);
  throws('reset --hard CANNOT reach a node worktree (§8.5)', () => hg.resetHardTo(REPO, TREE, nodeWt, headOf('hopper/mb-accept')), '§8.5');
  throws('reset --hard cannot reach the live checkout either', () => hg.resetHardTo(REPO, TREE, REPO, headOf('hopper/mb-accept')), '§8.4');
  check('reset --hard refuses a non-sha target', (() => {
    const r = hg.resetHardTo(REPO, TREE, intWt, 'refs/heads/master');
    return r.ok === false && r.reason === 'invalid_reset_target';
  })());
  throws('a merge INTO master throws before any git runs (§8.3)', () => hg.mergeNodeBranch(intWt, 'master', 'x', 'm'), '§8.3');
  throws('a merge INTO main throws before any git runs (§8.3)', () => hg.mergeNodeBranch(intWt, 'main', 'x', 'm'), '§8.3');
  check('a merge of a branch that does not exist is a VALUE, not a throw', (() => {
    const r = hg.mergeNodeBranch(intWt, 'hopper/mb-accept', 'hopper/no-such-branch', 'm');
    return r.ok === false && (r.reason === 'merge_failed' || r.reason === 'merge_conflict');
  })());
  check('...and it left the integration worktree clean', g(intWt, ['status', '--porcelain']) === '');

  const branches = branchList();
  const expected = [
    'hopper/mb-clean', 'hopper/mb-conflict', 'hopper/mb-gate', 'hopper/mb-accept',
  ];
  for (const b of expected) check(`integration branch still present: ${b}`, branches.includes(b));
  const nodeBranches = branches.filter((b) => /-n\d+$/.test(b));
  check('every per-node branch ever cut still exists (§8.2 — nothing deleted)', nodeBranches.length >= 10, `${nodeBranches.length}: ${nodeBranches.join(', ')}`);
  const seedCommit = g(REPO, ['rev-list', '--max-parents=0', `refs/heads/${DEFAULT_BRANCH}`]);
  check(`the repo's default branch (${DEFAULT_BRANCH}) still points at the seed commit — the engine never touched it`,
    headOf(DEFAULT_BRANCH) === seedCommit, `${headOf(DEFAULT_BRANCH)} vs ${seedCommit}`);
  check('the engine never created a main/master of its own', branches.filter((b) => b === 'main' || b === 'master').length <= 1);
  check('no reflog entry force-updated a ref', !g(REPO, ['reflog', '--all', '--format=%gs']).includes('forced-update'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
