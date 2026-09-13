#!/usr/bin/env node
// FOUNDRY LIFECYCLE SIMULATION — drives the real engine (foundry.ts + hopper-engine.ts)
// against a scratch DB with a fake worker (no model calls). Permanent regression script:
// `npm run foundry:sim`.
//
//   JARVIS_DB_PATH=/tmp/foundry-sim.db HOPPER_GOV_ENABLED=0 HOPPER_ENGINE_SLOTS=4 \
//     node scripts/foundry-sim.mjs
//
// (run `npm run build` first — this drives the compiled dist/, not tsx.)

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// GUARD — must run before any dist/ module is imported (conversation-db.js
// reads JARVIS_DB_PATH at import time and opens the sqlite handle immediately).
// ---------------------------------------------------------------------------
function guardDbPath() {
  const raw = process.env.JARVIS_DB_PATH;
  if (!raw || !raw.trim()) {
    console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path before running this script.');
    process.exit(1);
  }
  const resolved = path.resolve(raw);
  const live = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
  if (resolved === live) {
    console.error(`FATAL: refusing to run against the live jarvis.db (${live}). Use a /tmp scratch path.`);
    process.exit(1);
  }
  return resolved;
}

const DB_PATH = guardDbPath();
console.log(`[foundry-sim] scratch DB: ${DB_PATH}`);

// Foundation Gate scenarios (I-L below) create real module/integration
// checkout directories to drive the finish-time check runner. Point
// FOUNDRY_WORKTREES at a scratch dir so this never touches the real
// /home/kevin/foundry-worktrees tree.
const WORKTREES_ROOT = process.env.FOUNDRY_WORKTREES ?? '/tmp/foundry-sim-worktrees';
process.env.FOUNDRY_WORKTREES = WORKTREES_ROOT;
fs.rmSync(WORKTREES_ROOT, { recursive: true, force: true });
console.log(`[foundry-sim] scratch worktrees root: ${WORKTREES_ROOT}`);

// This file runs ~15 independent probe scenarios back-to-back in ONE process
// against ONE dispatcher (dispatchTick's running-node count is global, not
// per-project). Several probes deliberately launch a project without ever
// draining it (they only care about the state right after launch/plant), so
// their ready leaves get opportunistically vacuumed into 'running' later by
// an unrelated probe's queueMicrotask(dispatchTick) — and then sit there
// forever, since nobody ever finishes them. With a low slot count that
// starves later probes of a slot to claim their own node into (a real
// blocker hit once already — see FOUNDATION-GATE-CONTRACT.md node #148
// dependencies). None of this reflects a production bug: a live server
// finishes real nodes. Floor the slot count well above what this file could
// ever legitimately need concurrently so the harness itself never starves.
const MIN_SIM_SLOTS = 24;
const requestedSlots = parseInt(process.env.HOPPER_ENGINE_SLOTS ?? '', 10);
process.env.HOPPER_ENGINE_SLOTS = String(Math.max(Number.isFinite(requestedSlots) ? requestedSlots : 0, MIN_SIM_SLOTS));

// Dynamic imports ONLY after the guard passes.
const distDir = path.join(__dirname, '..', 'dist');
const foundry = await import(path.join(distDir, 'foundry.js'));
const hopperEngine = await import(path.join(distDir, 'hopper-engine.js'));
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const { sseBus } = await import(path.join(distDir, 'sse-bus.js'));

const { sqliteDb } = convDb;

// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------
const results = [];
function check(id, description, fn) {
  try {
    fn();
    results.push({ id, description, pass: true });
  } catch (err) {
    results.push({ id, description, pass: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Fake worker — no model calls. Parses the node id out of the worker prompt
// ("node #<id>"), records it, resolves immediately.
// ---------------------------------------------------------------------------
const dispatchedNodeIds = new Set();
async function fakeProcessMessage(prompt) {
  const m = /node #(\d+)/.exec(prompt);
  if (m) dispatchedNodeIds.add(Number(m[1]));
  return 'FAKE_WORKER_OK — no model call made.';
}

hopperEngine.startHopperEngine(fakeProcessMessage);
foundry.startFoundry();

// ---------------------------------------------------------------------------
// foundry_module SSE capture (per project) — drives check #3.
// foundry_project SSE capture — drives check #5 (integration tree plants once).
// ---------------------------------------------------------------------------
const moduleEvents = []; // { project_id, key, stage, action }
const projectEvents = []; // { project_id, status, integration_tree_id, action }
sseBus.on('sse', (ev) => {
  if (ev.type === 'foundry_module') {
    moduleEvents.push({ project_id: ev.project_id, key: ev.module.key, stage: ev.module.stage, action: ev.action });
  } else if (ev.type === 'foundry_project') {
    projectEvents.push({
      project_id: ev.project.id,
      status: ev.project.status,
      integration_tree_id: ev.project.integration_tree_id,
      action: ev.action,
    });
  }
});

const STAGE_ORDER = ['planned', 'building', 'built', 'testing', 'tested', 'documenting', 'documented', 'integrated'];

function notificationCountSince(marker, source, extra = {}) {
  let sql = `SELECT COUNT(*) AS n FROM notifications WHERE id > ? AND source = ?`;
  const params = [marker, source];
  if (extra.severity) {
    sql += ` AND severity = ?`;
    params.push(extra.severity);
  }
  if (extra.titleLike) {
    sql += ` AND title LIKE ?`;
    params.push(extra.titleLike);
  }
  return sqliteDb.prepare(sql).get(...params).n;
}

function notificationMarker() {
  return sqliteDb.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM notifications`).get().id;
}

function warningErrorNotificationCountSince(marker) {
  return sqliteDb.prepare(`
    SELECT COUNT(*) AS n
    FROM notifications
    WHERE id > ?
      AND severity IN ('warning', 'error')
  `).get(marker).n;
}

// ---------------------------------------------------------------------------
// serverFinishNode — mirrors the production POST /hopper-nodes/:id/finish
// route (handlers/api-v1.ts) exactly: run the Foundation Gate first, and only
// hand a raw 'done'/'split'/'blocked_question'/'blocked' to finishHopperNode
// when the gate doesn't reject it. Foundation-less blueprints (scenarios A-H)
// get {ok:true, gated:false} back immediately, so this is a no-op drop-in
// for every pre-existing scenario.
// ---------------------------------------------------------------------------
function serverFinishNode(nodeId, outcome, payload = {}) {
  const gate = foundry.runFoundryFoundationFinishGate(nodeId, outcome);
  if (!gate.ok) {
    return hopperEngine.finishHopperNode(nodeId, 'blocked', { result: gate.result });
  }
  return hopperEngine.finishHopperNode(nodeId, outcome, payload);
}

// ---------------------------------------------------------------------------
// Drain helper — repeatedly ticks the dispatcher and finishes whatever it
// claims as 'done', until the project goes quiescent (ready/blocked) or an
// idle streak suggests nothing more will ever run.
// ---------------------------------------------------------------------------
async function drain(projectId, { maxRounds = 80 } = {}) {
  let idleRounds = 0;
  for (let round = 0; round < maxRounds; round++) {
    await hopperEngine.dispatchTick(`sim-${projectId}-${round}`);
    const { project, modules } = foundry.getProjectWithModules(projectId);
    const treeIds = new Set();
    for (const m of modules) if (m.tree_id) treeIds.add(m.tree_id);
    if (project.integration_tree_id) treeIds.add(project.integration_tree_id);
    const running = [];
    for (const tid of treeIds) running.push(...hopperEngine.listTreeNodes(tid).filter((n) => n.status === 'running'));

    if (running.length === 0) {
      if (project.status === 'ready' || project.status === 'blocked') return project;
      idleRounds += 1;
      if (idleRounds >= 3) return project; // genuinely stuck — let assertions catch it
      continue;
    }
    idleRounds = 0;
    for (const n of running) {
      serverFinishNode(n.id, 'done', { result: `[sim] ${n.title} completed OK — no model call made.` });
    }
  }
  return foundry.getProjectRow(projectId);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

// Foundation Gate checkout-path helpers — mirror the private worktreePath()
// convention in foundry.ts exactly (worktreesRoot() reads FOUNDRY_WORKTREES,
// pinned to WORKTREES_ROOT above).
function moduleCheckoutPath(projectId, moduleKey) {
  return path.join(WORKTREES_ROOT, `${projectId}-${moduleKey}`);
}
function integrationCheckoutPath(projectId) {
  return path.join(WORKTREES_ROOT, `${projectId}-integration`);
}
/** Seed a checkout the way a well-behaved worker does: a git worktree branched
 *  from the project base branch, so it DERIVES from the FOUNDATION commit and
 *  already carries whatever scaffold_cmd produced. */
function seedDerivedCheckout(repoPath, checkoutPath, branch) {
  rmrf(checkoutPath);
  try { execFileSync('git', ['worktree', 'prune'], { cwd: repoPath, stdio: 'ignore' }); } catch {}
  try { execFileSync('git', ['branch', '-D', branch], { cwd: repoPath, stdio: 'ignore' }); } catch {}
  execFileSync('git', ['worktree', 'add', checkoutPath, '-b', branch, 'HEAD'], { cwd: repoPath, stdio: 'ignore' });
}
/** Seed the fake-Laravel shape: a bare directory (or re-initialised repo) that
 *  hand-writes whatever the checks look for but never derived from the scaffold. */
function seedFakeCheckout(checkoutPath, files = {}) {
  rmrf(checkoutPath);
  fs.mkdirSync(checkoutPath, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(checkoutPath, name), content);
}
function moduleBranch(projectId, moduleKey) {
  return `foundry/${projectId}/${moduleKey}`;
}
function gitCommitSubjects(repoPath) {
  return execFileSync('git', ['log', '--format=%s'], { cwd: repoPath, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
}
function appShellModule() {
  return {
    key: 'app-shell',
    name: 'app-shell',
    kind: 'service',
    purpose: 'Owns the scaffolded application skeleton.',
    contract: { provides: [{ type: 'fn', name: 'noop', summary: 'Does nothing' }], requires: [] },
    acceptance: ['noop can be called without throwing'],
    depends_on: [],
  };
}
function foundationBlueprint(name, foundation) {
  return {
    name,
    prompt: `Trivial framework-app probe: ${name}`,
    foundation,
    modules: [appShellModule()],
    wiring: [],
    integration: { test: 'true', docs: 'README.md' },
    run: { command: 'true' },
  };
}

// =============================================================================
// SCENARIO A — the hello-foundry-derived 3-module happy path
//   contracts (no deps) <- store (deps: contracts) <- ingest-api (deps: store)
// =============================================================================

const MAIN_REPO = '/tmp/foundry-sim-repo';
rmrf(MAIN_REPO);

const mainBlueprint = {
  name: 'hello-foundry-sim',
  prompt:
    'Accept records over HTTP, store them, and validate them via a shared contract module. ' +
    '(Simulation-trimmed hello-foundry: dashboard module dropped for a minimal 3-module chain.)',
  modules: [
    {
      key: 'contracts',
      name: 'contracts',
      kind: 'contracts',
      purpose: 'Owns the shared record shape and its validator.',
      contract: {
        provides: [{ type: 'fn', name: 'validateRecord', summary: 'Validate a record object' }],
        requires: [],
      },
      acceptance: ['validateRecord rejects a record missing required fields'],
      depends_on: [],
    },
    {
      key: 'store',
      name: 'store',
      kind: 'library',
      purpose: "In-memory record store; validates via contracts' validateRecord before saving.",
      contract: {
        provides: [
          { type: 'fn', name: 'saveRecord', summary: 'Validate and persist one record' },
          { type: 'fn', name: 'listRecords', summary: 'Return all saved records' },
        ],
        requires: [{ module: 'contracts', interface: 'fn:validateRecord' }],
      },
      acceptance: ['saveRecord rejects an invalid record', 'listRecords returns previously saved records'],
      depends_on: ['contracts'],
    },
    {
      key: 'ingest-api',
      name: 'ingest-api',
      kind: 'service',
      purpose: "Accepts inbound records over HTTP and hands them to the store's saveRecord.",
      contract: {
        provides: [{ type: 'http', name: 'POST /ingest', summary: 'Accept one record as JSON' }],
        requires: [{ module: 'store', interface: 'fn:saveRecord' }],
      },
      acceptance: ['POST /ingest with a valid record returns 201', 'POST /ingest with an invalid record returns 400'],
      depends_on: ['store'],
    },
  ],
  wiring: [
    { from: 'store', requires: 'fn:validateRecord', to: 'contracts' },
    { from: 'ingest-api', requires: 'fn:saveRecord', to: 'store' },
  ],
  integration: { test: 'node --test integration/*.test.mjs', docs: 'README.md' },
  run: { command: 'true' },
  assumptions: ['Simulation run — no real code is built; the fake worker never touches the filesystem.'],
};

const mainMarker = notificationMarker();
const { project: createdMain } = foundry.createProject({
  name: 'hello-foundry-sim',
  prompt: mainBlueprint.prompt,
  repo_path: MAIN_REPO,
});
const mainId = createdMain.id;

foundry.setBlueprint(mainId, mainBlueprint);

// --- check 1: only dependency-free modules plant at launch ---
foundry.launchProject(mainId);
check('1', 'only dependency-free modules plant at launch', () => {
  const { modules } = foundry.getProjectWithModules(mainId);
  const planted = modules.filter((m) => m.tree_id).map((m) => m.key).sort();
  assert.deepEqual(planted, ['contracts'], `expected only 'contracts' planted at launch, got ${JSON.stringify(planted)}`);
});

// --- check 4 instrumentation: snapshot dependency stage the instant a dependent first plants ---
const firstSeenDepStage = {}; // module key -> stage of its (first) dependency at plant time
const seenKeys = new Set();
const depOf = { store: 'contracts', 'ingest-api': 'store' };
sseBus.on('sse', (ev) => {
  if (ev.type !== 'foundry_module' || ev.project_id !== mainId) return;
  const key = ev.module.key;
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  const dep = depOf[key];
  if (!dep) return;
  const { modules } = foundry.getProjectWithModules(mainId);
  const depModule = modules.find((m) => m.key === dep);
  firstSeenDepStage[key] = depModule ? depModule.stage : null;
});

const mainAfterDrain = await drain(mainId);

check('4', 'a dependent module plants only after its dependency is >= tested', () => {
  for (const [key, dep] of Object.entries(depOf)) {
    const stageAtPlant = firstSeenDepStage[key];
    assert.ok(stageAtPlant, `never observed a plant-time snapshot for '${key}' (dep '${dep}')`);
    const rank = STAGE_ORDER.indexOf(stageAtPlant);
    const testedRank = STAGE_ORDER.indexOf('tested');
    assert.ok(
      rank >= testedRank,
      `'${key}' first planted while its dependency '${dep}' was only at '${stageAtPlant}' (rank ${rank}), expected >= 'tested' (rank ${testedRank})`,
    );
  }
});

check('2', 'every hopper node has a non-null adapter and model', () => {
  const { project, modules } = foundry.getProjectWithModules(mainId);
  const treeIds = new Set();
  for (const m of modules) if (m.tree_id) treeIds.add(m.tree_id);
  if (project.integration_tree_id) treeIds.add(project.integration_tree_id);
  assert.ok(treeIds.size >= 4, `expected >= 4 trees (3 module + 1 integration), found ${treeIds.size}`);
  let total = 0;
  for (const tid of treeIds) {
    for (const node of hopperEngine.listTreeNodes(tid)) {
      total += 1;
      assert.ok(node.adapter, `node ${node.id} (${node.title}) has a null adapter`);
      assert.ok(node.model, `node ${node.id} (${node.title}) has a null model`);
      assert.ok(node.spec, `node ${node.id} (${node.title}) has no rendered spec`);
      assert.ok(!node.spec.includes('{{'), `node ${node.id} (${node.title}) has an unrendered template marker`);
      assert.ok(!node.spec.includes('<hopper node id from this worker thread>'), `node ${node.id} (${node.title}) still has the placeholder node id`);
      assert.ok(node.spec.includes(`/hopper-nodes/${node.id}/finish`), `node ${node.id} (${node.title}) spec does not point at its own finish endpoint`);
    }
  }
  assert.ok(total >= 12, `expected >= 12 nodes total (3 modules x 3 stages + 3 integration), found ${total}`);
});

check('3', 'stage walks planned->building->...->documented in order, emitted on change only', () => {
  const byKey = new Map();
  for (const ev of moduleEvents) {
    if (ev.project_id !== mainId) continue;
    if (!byKey.has(ev.key)) byKey.set(ev.key, []);
    byKey.get(ev.key).push(ev.stage);
  }
  assert.deepEqual([...byKey.keys()].sort(), ['contracts', 'ingest-api', 'store']);
  for (const [key, stages] of byKey.entries()) {
    // Redundant-emit check: the ONE known/expected duplicate is the very first
    // pair (setBlueprint's 'created' emit, then plantModuleTree's 'updated'
    // emit, both still 'planned' before the build node ever runs). Any OTHER
    // consecutive duplicate means refreshModuleStage's change-gate is spamming.
    for (let i = 1; i < stages.length; i++) {
      if (stages[i] === stages[i - 1]) {
        assert.ok(
          i === 1 && stages[0] === 'planned',
          `module '${key}' emitted a redundant consecutive '${stages[i]}' foundry_module event at index ${i} (not the expected plant-time double)`,
        );
      }
    }
    // Collapse consecutive duplicates, then require the walk equals the exact
    // canonical order. Every module in this happy path also reaches
    // 'integrated' once the integration tree completes, so that's the full
    // expected walk here (a module whose project never integrates would
    // legitimately stop at 'documented' — this scenario always finishes).
    const collapsed = stages.filter((s, i) => i === 0 || s !== stages[i - 1]);
    const expected = STAGE_ORDER;
    assert.deepEqual(collapsed, expected, `module '${key}' stage walk was ${JSON.stringify(collapsed)}, expected ${JSON.stringify(expected)}`);
  }
});

check('5', 'the integration tree plants exactly once, only after ALL modules are documented', () => {
  const transitions = projectEvents.filter(
    (ev) => ev.project_id === mainId && ev.integration_tree_id,
  );
  const distinctTreeIds = new Set(transitions.map((ev) => ev.integration_tree_id));
  assert.equal(distinctTreeIds.size, 1, `expected exactly one integration_tree_id ever set, saw ${distinctTreeIds.size}`);
  // At the moment the integration tree id first appears, every module must
  // already be documented (deriveStage's stageAtLeast('documented') gate).
  const firstIdx = projectEvents.findIndex((ev) => ev.project_id === mainId && ev.integration_tree_id);
  assert.ok(firstIdx >= 0, 'integration tree id never appeared in project SSE events');
  const { modules } = foundry.getProjectWithModules(mainId);
  for (const m of modules) {
    const rank = STAGE_ORDER.indexOf(m.stage === 'integrated' ? 'documented' : m.stage);
    assert.ok(rank >= STAGE_ORDER.indexOf('documented'), `module '${m.key}' was not yet documented by the time integration planted (final stage '${m.stage}')`);
  }
});

check('6', 'integration done -> project ready + exactly one success notification', () => {
  assert.equal(mainAfterDrain.status, 'ready', `expected project status 'ready' after drain, got '${mainAfterDrain.status}'`);
  const n = notificationCountSince(mainMarker, 'foundry', { severity: 'success', titleLike: '%is ready — all boxes green%' });
  assert.equal(n, 1, `expected exactly 1 foundry 'ready' success notification, got ${n}`);
});

check('8', 'GO runs run.command and flips status to launched', () => {
  const before = foundry.getProjectRow(mainId);
  assert.equal(before.status, 'ready', `GO precondition failed — project status is '${before.status}', expected 'ready'`);
  const goResult = foundry.goProject(mainId);
  assert.equal(goResult.project.status, 'launched');
  const after = foundry.getProjectRow(mainId);
  assert.equal(after.status, 'launched', `expected status 'launched' after GO, got '${after.status}'`);
});

// =============================================================================
// SCENARIO B — a 'blocked' finish on a fresh single-module run
// =============================================================================
async function runBlockedProbe() {
  convDb.setSetting('foundry_auto_decide', '0');
  const repo = '/tmp/foundry-sim-repo-blocked';
  rmrf(repo);
  try {
    const blueprint = {
      name: 'foundry-sim-blocked-probe',
      prompt: 'Trivial single-module probe used to test the blocked lifecycle path.',
      modules: [
        {
          key: 'probe',
          name: 'probe',
          kind: 'library',
          purpose: 'A trivial probe module with no dependencies.',
          contract: { provides: [{ type: 'fn', name: 'noop', summary: 'Does nothing' }], requires: [] },
          acceptance: ['noop can be called without throwing'],
          depends_on: [],
        },
      ],
      wiring: [],
      integration: { test: 'true', docs: 'README.md' },
      run: { command: 'true' },
    };
    const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
    foundry.setBlueprint(project.id, blueprint);
    foundry.launchProject(project.id);
    await hopperEngine.dispatchTick('blocked-probe-claim');
    const { modules: preModules } = foundry.getProjectWithModules(project.id);
    const buildNodeId = preModules[0].stage_nodes.build.node_id;
    assert.ok(buildNodeId, 'blocked probe: build node was never planted/claimed');

    const marker = notificationMarker();
    hopperEngine.finishHopperNode(buildNodeId, 'blocked', { result: 'simulated blocker: missing access to an external system' });

    check('7a', "a 'blocked' finish turns the module red with exactly one foundry notification when auto-decide is off", () => {
      const { modules } = foundry.getProjectWithModules(project.id);
      assert.equal(modules[0].stage, 'blocked', `expected module stage 'blocked', got '${modules[0].stage}'`);
      const n = notificationCountSince(marker, 'foundry', { severity: 'error' });
      assert.equal(n, 1, `expected exactly 1 foundry error notification for the blocked module, got ${n}`);
    });
  } finally {
    convDb.deleteSetting('foundry_auto_decide');
  }
}
await runBlockedProbe();

// =============================================================================
// SCENARIO C — a 'blocked_question' finish + answerHopperNode recovery
// =============================================================================
async function runBlockedQuestionProbe() {
  convDb.setSetting('foundry_auto_decide', '0');
  const repo = '/tmp/foundry-sim-repo-blockedq';
  rmrf(repo);
  try {
    const blueprint = {
      name: 'foundry-sim-blockedq-probe',
      prompt: 'Trivial single-module probe used to test the blocked_question / answer lifecycle path.',
      modules: [
        {
          key: 'probe',
          name: 'probe',
          kind: 'library',
          purpose: 'A trivial probe module with no dependencies.',
          contract: { provides: [{ type: 'fn', name: 'noop', summary: 'Does nothing' }], requires: [] },
          acceptance: ['noop can be called without throwing'],
          depends_on: [],
        },
      ],
      wiring: [],
      integration: { test: 'true', docs: 'README.md' },
      run: { command: 'true' },
    };
    const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
    foundry.setBlueprint(project.id, blueprint);
    foundry.launchProject(project.id);
    await hopperEngine.dispatchTick('blockedq-probe-claim');
    const { modules: preModules } = foundry.getProjectWithModules(project.id);
    const buildNodeId = preModules[0].stage_nodes.build.node_id;
    assert.ok(buildNodeId, 'blocked_question probe: build node was never planted/claimed');

    hopperEngine.finishHopperNode(buildNodeId, 'blocked_question', { question: 'Which storage backend should probe use?' });

    const afterQuestion = foundry.getProjectWithModules(project.id).modules[0];
    const stageAtQuestion = afterQuestion.stage;

    hopperEngine.answerHopperNode(buildNodeId, 'Use an in-memory backend.');
    const afterAnswer = foundry.getProjectWithModules(project.id).modules[0];

    check('7b', "a 'blocked_question' finish sets needs_answer; answerHopperNode re-queues and clears it when auto-decide is off", () => {
      assert.equal(stageAtQuestion, 'needs_answer', `expected module stage 'needs_answer' after blocked_question, got '${stageAtQuestion}'`);
      assert.notEqual(afterAnswer.stage, 'needs_answer', `module stage still 'needs_answer' after answerHopperNode`);
      const node = hopperEngine.getHopperNode(buildNodeId);
      assert.equal(node.status, 'pending', `expected node status 'pending' after answering, got '${node.status}'`);
      assert.equal(node.answer, 'Use an in-memory backend.');
    });

    // Bonus confirmation: the answered node actually resumes and completes cleanly.
    const finalProject = await drain(project.id, { maxRounds: 10 });
    check('7c', 'an answered blocked_question node resumes to normal completion', () => {
      const finalModule = foundry.getProjectWithModules(project.id).modules[0];
      assert.ok(
        STAGE_ORDER.indexOf(finalModule.stage) > STAGE_ORDER.indexOf('planned'),
        `expected the module to progress past 'planned' after resuming, stuck at '${finalModule.stage}' (project status '${finalProject.status}')`,
      );
    });
  } finally {
    convDb.deleteSetting('foundry_auto_decide');
  }
}
await runBlockedQuestionProbe();

// =============================================================================
// SCENARIO D — a 'split' build node must NOT read as built (adversarial review #3/#4)
// The parent node goes 'split' (terminal for itself) while its children still
// run; the module stays 'building', TEST must not dispatch until the children
// settle and the engine bubbles the parent to 'done'.
// =============================================================================
function probeBlueprint(name, purposeSuffix) {
  return {
    name,
    prompt: `Trivial single-module probe: ${purposeSuffix}`,
    modules: [
      {
        key: 'probe',
        name: 'probe',
        kind: 'library',
        purpose: 'A trivial probe module with no dependencies.',
        contract: { provides: [{ type: 'fn', name: 'noop', summary: 'Does nothing' }], requires: [] },
        acceptance: ['noop can be called without throwing'],
        depends_on: [],
      },
    ],
    wiring: [],
    integration: { test: 'true', docs: 'README.md' },
    run: { command: 'true' },
  };
}

async function runSplitProbe() {
  const repo = '/tmp/foundry-sim-repo-split';
  rmrf(repo);
  const blueprint = probeBlueprint('foundry-sim-split-probe', 'split lifecycle path');
  const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
  foundry.setBlueprint(project.id, blueprint);
  foundry.launchProject(project.id);
  await hopperEngine.dispatchTick('split-probe-claim');
  const pre = foundry.getProjectWithModules(project.id).modules[0];
  const buildNodeId = pre.stage_nodes.build.node_id;
  const testNodeId = pre.stage_nodes.test.node_id;
  assert.ok(buildNodeId && testNodeId, 'split probe: stage nodes were never planted');

  hopperEngine.finishHopperNode(buildNodeId, 'split', {
    children: [
      { title: 'probe part 1', spec: 'first half' },
      { title: 'probe part 2', spec: 'second half', depends_on_prev: true },
    ],
  });
  const stageAfterSplit = foundry.getProjectWithModules(project.id).modules[0].stage;
  await hopperEngine.dispatchTick('split-probe-after-split');
  const testAfterSplit = hopperEngine.getHopperNode(testNodeId).status;
  const kids = hopperEngine.listTreeNodes(pre.tree_id).filter((n) => n.parent_id === buildNodeId);

  check('9a', "a 'split' build node keeps the module at 'building' (not 'built')", () => {
    assert.equal(stageAfterSplit, 'building', `expected 'building' while split children run, got '${stageAfterSplit}'`);
    assert.equal(kids.length, 2, `expected 2 split children, got ${kids.length}`);
    assert.ok(kids.every((k) => k.adapter && k.model), 'split children must inherit a non-null adapter/model');
  });
  check('9b', 'TEST does not dispatch while the split BUILD children are still unsettled', () => {
    assert.equal(testAfterSplit, 'pending', `expected TEST node still 'pending', got '${testAfterSplit}'`);
  });

  // Duplicate-delivery probe: re-emit the last hopper_node event twice; nothing may double-plant.
  const treesBefore = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM hopper_trees`).get().n;
  const lastNode = hopperEngine.getHopperNode(buildNodeId);
  sseBus.emit('sse', { type: 'hopper_node', action: 'updated', node: lastNode });
  sseBus.emit('sse', { type: 'hopper_node', action: 'updated', node: lastNode });
  const treesAfter = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM hopper_trees`).get().n;
  check('9c', 'a duplicated hopper_node event plants nothing twice', () => {
    assert.equal(treesAfter, treesBefore, `tree count changed on duplicate event: ${treesBefore} -> ${treesAfter}`);
  });

  const finalProject = await drain(project.id, { maxRounds: 20 });
  check('9d', 'after the split children settle, the module walks to documented/integrated and the project reaches ready', () => {
    const m = foundry.getProjectWithModules(project.id).modules[0];
    assert.equal(hopperEngine.getHopperNode(buildNodeId).status, 'done', 'split parent should bubble to done');
    assert.ok(m.stage === 'integrated' || m.stage === 'documented', `expected integrated/documented, got '${m.stage}'`);
    assert.equal(finalProject.status, 'ready', `expected project 'ready', got '${finalProject.status}'`);
  });
}
await runSplitProbe();

// =============================================================================
// SCENARIO E — settings-KV loadout overrides actually reach the planted nodes
// =============================================================================
async function runSettingsOverrideProbe() {
  const repo = '/tmp/foundry-sim-repo-settings';
  rmrf(repo);
  convDb.setSetting('foundry_build_model', 'auggie/opus4.8');
  convDb.setSetting('foundry_test_model', JSON.stringify({ adapter: 'devin', model: 'swe' }));
  convDb.setSetting('foundry_doc_model', 'gpt-5.5');
  try {
    const blueprint = probeBlueprint('foundry-sim-settings-probe', 'settings override path');
    const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
    foundry.setBlueprint(project.id, blueprint);
    foundry.launchProject(project.id);
    const m = foundry.getProjectWithModules(project.id).modules[0];
    const nodes = hopperEngine.listTreeNodes(m.tree_id);
    const byTitle = Object.fromEntries(nodes.map((n) => [n.title.split(' ')[0], n]));
    check('10', 'foundry_{build,test,doc}_model settings override adapter+model on planted nodes', () => {
      assert.deepEqual([byTitle.BUILD.adapter, byTitle.BUILD.model], ['auggie', 'opus4.8']);
      assert.deepEqual([byTitle.TEST.adapter, byTitle.TEST.model], ['devin', 'swe']);
      assert.deepEqual([byTitle.DOC.adapter, byTitle.DOC.model], ['codex', 'gpt-5.5']);
    });
  } finally {
    convDb.deleteSetting('foundry_build_model');
    convDb.deleteSetting('foundry_test_model');
    convDb.deleteSetting('foundry_doc_model');
  }
}
await runSettingsOverrideProbe();

// =============================================================================
// SCENARIO F — planner-state idempotency guards (no model call: only the
// status transitions are exercised)
// =============================================================================
function runPlannerGuardProbe() {
  const repo = '/tmp/foundry-sim-repo-planguard';
  rmrf(repo);
  const blueprint = probeBlueprint('foundry-sim-planguard-probe', 'planner guard path');
  const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
  const first = foundry.markProjectPlanning(project.id, 'claude-opus-5');
  const second = foundry.markProjectPlanning(project.id, 'claude-opus-5');
  check('11a', 'markProjectPlanning is single-flight: a second call while planning returns null', () => {
    assert.equal(first?.status, 'planning');
    assert.equal(second, null, 'second markProjectPlanning should be refused while already planning');
  });
  foundry.setBlueprint(project.id, blueprint);
  foundry.launchProject(project.id);
  const failed = foundry.markProjectPlannerFailed(project.id, 'late planner failure');
  check('11b', 'a late planner failure cannot drag a building project back to draft', () => {
    assert.equal(failed?.status, 'building', `expected status to stay 'building', got '${failed?.status}'`);
  });
  const latePlan = foundry.markProjectPlanning(project.id, 'claude-opus-5');
  check('11c', 'markProjectPlanning refuses a project that already has build work in flight', () => {
    assert.equal(latePlan, null);
    assert.equal(foundry.getProjectRow(project.id).status, 'building');
  });
}
runPlannerGuardProbe();

// =============================================================================
// SCENARIO G — Foundry's decide-then-ask ladder on an integration MERGE block
// First failure: append the Contract Resolution Rule, route to foundry_integrate_model,
// re-pend once, and emit only an info notification. Second failure: project blocks
// and the normal Kevin-facing warning/error appears.
// =============================================================================
async function runIntegrationAutoDecisionProbe() {
  convDb.deleteSetting('foundry_auto_decide');
  convDb.deleteSetting('foundry_integrate_model');
  const repo = '/tmp/foundry-sim-repo-integration-auto';
  rmrf(repo);
  const blueprint = probeBlueprint('foundry-sim-integration-auto-probe', 'integration auto-decision path');
  const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
  foundry.setBlueprint(project.id, blueprint);
  foundry.launchProject(project.id);

  async function claimMergeNode() {
    for (let round = 0; round < 40; round++) {
      await hopperEngine.dispatchTick(`integration-auto-${round}`);
      const state = foundry.getProjectWithModules(project.id);
      const integrationTreeId = state.project.integration_tree_id;
      if (integrationTreeId) {
        const merge = hopperEngine.listTreeNodes(integrationTreeId).find((n) => n.title.startsWith('MERGE '));
        if (merge?.status === 'running') return merge;
      }
      const treeIds = new Set();
      for (const m of state.modules) if (m.tree_id) treeIds.add(m.tree_id);
      for (const tid of treeIds) {
        for (const node of hopperEngine.listTreeNodes(tid).filter((n) => n.status === 'running')) {
          hopperEngine.finishHopperNode(node.id, 'done', { result: `[sim] ${node.title} completed OK — no model call made.` });
        }
      }
    }
    throw new Error('integration auto-decision probe: MERGE node never reached running');
  }

  const merge = await claimMergeNode();
  const marker = notificationMarker();
  const conflict = 'contracts/RecordInput is strict {source,payload}; api module accepted extra keys and its test expected 201.';
  hopperEngine.finishHopperNode(merge.id, 'blocked', { result: conflict });
  const afterFirstNode = hopperEngine.getHopperNode(merge.id);
  const afterFirstProject = foundry.getProjectWithModules(project.id);

  check('12a', 'integration MERGE first block auto-amends and re-pends once with no Kevin warning/error bell', () => {
    assert.equal(afterFirstNode.status, 'pending', `expected MERGE node re-pended, got '${afterFirstNode.status}'`);
    assert.equal(afterFirstNode.attempts, 0, `expected attempts reset to 0, got ${afterFirstNode.attempts}`);
    assert.equal(afterFirstNode.foundry_auto_retries, 1, `expected foundry_auto_retries=1, got ${afterFirstNode.foundry_auto_retries}`);
    assert.deepEqual([afterFirstNode.adapter, afterFirstNode.model], ['auggie', 'opus4.8']);
    assert.ok(afterFirstNode.spec.includes('## AUTO-DECISION (JARVIS policy)'), 'amended spec is missing AUTO-DECISION section');
    assert.ok(afterFirstNode.spec.includes('Contract Resolution Rule'), 'amended spec is missing Contract Resolution Rule');
    assert.ok(afterFirstNode.spec.includes(conflict), 'amended spec is missing the original conflict');
    assert.equal(afterFirstProject.project.status, 'integrating', `expected project to stay integrating, got '${afterFirstProject.project.status}'`);
    assert.equal(afterFirstProject.integration.auto_retried, true, 'integration.auto_retried should be true after the first auto retry');
    assert.equal(warningErrorNotificationCountSince(marker), 0, 'first auto retry should not create a warning/error notification');
    const info = notificationCountSince(marker, 'foundry', { severity: 'info', titleLike: '%auto-decided per Contract Resolution Rule%' });
    assert.equal(info, 1, `expected exactly 1 foundry info notification for auto retry, got ${info}`);
  });

  await hopperEngine.dispatchTick('integration-auto-second-claim');
  const runningAgain = hopperEngine.getHopperNode(merge.id);
  assert.equal(runningAgain.status, 'running', `expected MERGE node running for second attempt, got '${runningAgain.status}'`);
  const secondMarker = notificationMarker();
  hopperEngine.finishHopperNode(merge.id, 'blocked', { result: 'same conflict remained after the auto-decision retry' });
  const afterSecondNode = hopperEngine.getHopperNode(merge.id);
  const afterSecondProject = foundry.getProjectWithModules(project.id);

  check('12b', 'integration MERGE second block creates the Kevin bell and blocks the project', () => {
    assert.equal(afterSecondNode.status, 'blocked', `expected MERGE node blocked on second failure, got '${afterSecondNode.status}'`);
    assert.equal(afterSecondNode.foundry_auto_retries, 1, `expected no second auto retry, got ${afterSecondNode.foundry_auto_retries}`);
    assert.equal(afterSecondProject.project.status, 'blocked', `expected project blocked, got '${afterSecondProject.project.status}'`);
    assert.equal(afterSecondProject.integration.auto_retried, true, 'integration.auto_retried should remain true after the second failure');
    const foundryErrors = notificationCountSince(secondMarker, 'foundry', { severity: 'error', titleLike: '%integration is blocked%' });
    assert.equal(foundryErrors, 1, `expected exactly 1 foundry integration error notification, got ${foundryErrors}`);
  });
}
await runIntegrationAutoDecisionProbe();

// =============================================================================
// SCENARIO H — a duplicated/replayed hopper_node SSE event carrying a STALE
// pre-retry snapshot (foundry_auto_retries still 0) must not win a second
// auto-retry claim. This is the same "duplicated event" class as check #9c,
// applied to the auto-decision path specifically (prepareFoundryAutoRetry's
// atomic CAS, not the caller's in-memory node object, is what must hold).
// =============================================================================
async function runAutoRetryDuplicateEventProbe() {
  convDb.deleteSetting('foundry_auto_decide');
  const repo = '/tmp/foundry-sim-repo-dup-retry';
  rmrf(repo);
  const blueprint = probeBlueprint('foundry-sim-dup-retry-probe', 'duplicate-event auto-retry path');
  const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
  foundry.setBlueprint(project.id, blueprint);
  foundry.launchProject(project.id);
  await hopperEngine.dispatchTick('dup-retry-claim');
  const pre = foundry.getProjectWithModules(project.id).modules[0];
  const buildNodeId = pre.stage_nodes.build.node_id;
  assert.ok(buildNodeId, 'dup-retry probe: BUILD node was never planted');

  const marker = notificationMarker();
  hopperEngine.finishHopperNode(buildNodeId, 'blocked', { result: 'contract conflict for dup-retry probe' });
  const afterReal = hopperEngine.getHopperNode(buildNodeId);

  // Replay a STALE snapshot of the node as it looked the instant it blocked,
  // before the real auto-retry's atomic UPDATE landed (foundry_auto_retries: 0).
  const staleSnapshot = { ...afterReal, foundry_auto_retries: 0, status: 'blocked' };
  sseBus.emit('sse', { type: 'hopper_node', action: 'updated', node: staleSnapshot });
  const afterReplay = hopperEngine.getHopperNode(buildNodeId);

  check('13', 'a stale/replayed hopper_node event cannot win a second auto-retry claim', () => {
    assert.equal(afterReal.foundry_auto_retries, 1, `expected the real block to auto-retry once, got ${afterReal.foundry_auto_retries}`);
    assert.equal(afterReplay.foundry_auto_retries, 1, `stale replay must not re-increment foundry_auto_retries, got ${afterReplay.foundry_auto_retries}`);
    assert.equal(afterReplay.status, 'pending', `stale replay must not disturb the re-pended node, got status '${afterReplay.status}'`);
    const info = notificationCountSince(marker, 'foundry', { severity: 'info', titleLike: '%auto-decided per Contract Resolution Rule%' });
    assert.equal(info, 1, `expected exactly 1 auto-decided notification despite the duplicate event, got ${info}`);
  });
}
await runAutoRetryDuplicateEventProbe();

// =============================================================================
// SCENARIO I — Foundation Gate: launch scaffolds deterministically, checks run
// green, and module trees plant only after (tree-53a87489 node #145 recon /
// FOUNDATION-GATE-CONTRACT.md "Launch-Time Scaffold Gate").
// =============================================================================
async function runFoundationLaunchHappyProbe() {
  const repo = '/tmp/foundry-sim-repo-foundation-launch';
  rmrf(repo);
  const blueprint = foundationBlueprint('foundry-sim-foundation-launch-probe', {
    stack: 'sim-stack',
    scaffold_cmd: "printf 'scaffolded\\n' > FOUNDATION_MARKER.txt",
    checks: [
      { cmd: 'test -f FOUNDATION_MARKER.txt' },
      { cmd: 'cat FOUNDATION_MARKER.txt', expect_regex: '^scaffolded' },
    ],
  });
  const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
  foundry.setBlueprint(project.id, blueprint);
  assert.ok(!fs.existsSync(path.join(repo, 'FOUNDATION_MARKER.txt')), 'sanity: marker must not exist before launch');

  foundry.launchProject(project.id);

  check('14', 'launch scaffolds a framework foundation deterministically, checks run green, and module trees plant only after', () => {
    assert.ok(fs.existsSync(path.join(repo, 'FOUNDATION_MARKER.txt')), 'scaffold_cmd never ran (marker file missing)');
    assert.equal(fs.readFileSync(path.join(repo, 'FOUNDATION_MARKER.txt'), 'utf8').trim(), 'scaffolded');
    const subjects = gitCommitSubjects(repo);
    assert.ok(subjects.includes('FOUNDATION scaffold: sim-stack'), `expected a FOUNDATION scaffold commit, got subjects: ${JSON.stringify(subjects)}`);
    const { project: after, modules } = foundry.getProjectWithModules(project.id);
    assert.equal(after.status, 'building', `expected project 'building' post-launch, got '${after.status}'`);
    const appShell = modules.find((m) => m.key === 'app-shell');
    assert.ok(appShell?.tree_id, 'app-shell module tree was never planted after a successful foundation scaffold');
  });

  // Drain to completion (rather than leaving nodes dangling) so this probe's
  // module tree can't later get opportunistically claimed by an unrelated
  // scenario's queueMicrotask(dispatchTick) and starve it of a slot — seed
  // both checkouts with the same real scaffold output the checks require.
  seedDerivedCheckout(repo, moduleCheckoutPath(project.id, 'app-shell'), moduleBranch(project.id, 'app-shell'));
  seedDerivedCheckout(repo, integrationCheckoutPath(project.id), moduleBranch(project.id, 'integration'));
  await drain(project.id);
}
await runFoundationLaunchHappyProbe();

// =============================================================================
// SCENARIO J — Foundation Gate: a failing scaffold_cmd blocks the project and
// plants NO module trees (the fake-Laravel incident, prevented at the door).
// =============================================================================
async function runFoundationLaunchScaffoldFailureProbe() {
  const repo = '/tmp/foundry-sim-repo-foundation-scaffold-fail';
  rmrf(repo);
  const blueprint = foundationBlueprint('foundry-sim-foundation-scaffold-fail-probe', {
    stack: 'sim-stack-fail',
    scaffold_cmd: 'exit 1',
    checks: [{ cmd: 'test -f FOUNDATION_MARKER.txt' }],
  });
  const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
  foundry.setBlueprint(project.id, blueprint);

  let threw = null;
  try {
    foundry.launchProject(project.id);
  } catch (err) {
    threw = err;
  }

  check('15', 'a failing scaffold_cmd blocks the project and plants no module trees', () => {
    assert.ok(threw, 'launchProject did not throw on a failing scaffold_cmd');
    const after = foundry.getProjectRow(project.id);
    assert.equal(after?.status, 'blocked', `expected project 'blocked' after scaffold failure, got '${after?.status}'`);
    assert.ok(/FOUNDATION SCAFFOLD FAILED/.test(after?.last_error ?? ''), `last_error missing FOUNDATION SCAFFOLD FAILED marker: ${after?.last_error}`);
    assert.ok(!fs.existsSync(path.join(repo, 'FOUNDATION_MARKER.txt')), 'scaffold_cmd partially ran despite exiting non-zero');
    const { modules } = foundry.getProjectWithModules(project.id);
    assert.ok(modules.every((m) => !m.tree_id), `expected no module trees planted, got ${JSON.stringify(modules.map((m) => [m.key, m.tree_id]))}`);
  });
}
await runFoundationLaunchScaffoldFailureProbe();

// =============================================================================
// SCENARIO K — Foundation Gate: finish-time check on a module BUILD node.
// A worker POSTs done while a foundation check fails -> server rejects to
// blocked with the check output, dependents stay put; fix the checkout and
// finish again -> done is accepted and dependents unblock.
// =============================================================================
async function runFoundationBuildFinishGateProbe() {
  convDb.setSetting('foundry_auto_decide', '0');
  const repo = '/tmp/foundry-sim-repo-foundation-build-gate';
  rmrf(repo);
  try {
    // Foundation checks run at BOTH launch time (cwd=repo_path, right after
    // scaffold_cmd) and finish time (cwd=the node's checkout) — so the single
    // check here must be something scaffold_cmd genuinely produces, not a
    // module-specific deliverable (that would fail launch itself). The
    // "check fails" case is a checkout that didn't actually derive from the
    // real scaffolded commit (the literal fake-Laravel incident shape).
    const blueprint = foundationBlueprint('foundry-sim-foundation-build-gate-probe', {
      stack: 'sim-stack',
      scaffold_cmd: "printf 'scaffolded\\n' > FOUNDATION_MARKER.txt",
      checks: [{ cmd: 'test -f FOUNDATION_MARKER.txt' }],
    });
    const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
    foundry.setBlueprint(project.id, blueprint);
    foundry.launchProject(project.id);
    await hopperEngine.dispatchTick('foundation-build-gate-claim');

    const pre = foundry.getProjectWithModules(project.id).modules[0];
    const buildNodeId = pre.stage_nodes.build.node_id;
    const testNodeId = pre.stage_nodes.test.node_id;
    assert.ok(buildNodeId && testNodeId, 'foundation build-gate probe: stage nodes were never planted');

    // The literal fake-Laravel shape: the worker's checkout is a bare directory
    // that HAND-WRITES the very file the check looks for. The planner check
    // passes; the server must still refuse because the checkout never derived
    // from the FOUNDATION commit.
    const buildCheckout = moduleCheckoutPath(project.id, 'app-shell');
    seedFakeCheckout(buildCheckout, { 'FOUNDATION_MARKER.txt': 'scaffolded\n' });

    const rejected = serverFinishNode(buildNodeId, 'done', { result: 'BUILD complete (hand-built checkout that satisfies the check — should be rejected)' });

    check('16a', "a BUILD node cannot finish 'done' from a hand-built checkout even when the checks pass — derivation from the FOUNDATION commit is enforced", () => {
      assert.equal(rejected?.status, 'blocked', `expected node 'blocked', got '${rejected?.status}'`);
      assert.ok(/FOUNDATION CHECK FAILED/.test(rejected?.result ?? ''), 'blocked result is missing the FOUNDATION CHECK FAILED marker');
      assert.ok(/FOUNDATION DERIVATION FAILED/.test(rejected?.result ?? ''), 'blocked result is missing the FOUNDATION DERIVATION FAILED marker');
      const testNode = hopperEngine.getHopperNode(testNodeId);
      assert.equal(testNode.status, 'pending', `dependents must not dispatch on a rejected done — TEST was '${testNode.status}'`);
      const module = foundry.getProjectWithModules(project.id).modules[0];
      assert.equal(module.stage, 'blocked', `expected module stage 'blocked', got '${module.stage}'`);
    });

    // Fix: the checkout now genuinely derives from the scaffolded commit, and
    // (since this probe also drains to completion below) the integration
    // checkout is seeded the same way so MERGE's own foundation gate — proven
    // separately in scenario L — doesn't block this run on an unrelated
    // missing checkout.
    seedDerivedCheckout(repo, buildCheckout, moduleBranch(project.id, 'app-shell'));
    seedDerivedCheckout(repo, integrationCheckoutPath(project.id), moduleBranch(project.id, 'integration'));

    foundry.retryModule(project.id, 'app-shell');
    await hopperEngine.dispatchTick('foundation-build-gate-retry-claim');
    const runningAgain = hopperEngine.getHopperNode(buildNodeId);
    assert.equal(runningAgain.status, 'running', `expected BUILD node running again after retry, got '${runningAgain.status}'`);
    const accepted = serverFinishNode(buildNodeId, 'done', { result: 'BUILD complete, real files present' });

    check('16b', 'the same BUILD node finishes done once the foundation checks actually pass', () => {
      assert.equal(accepted?.status, 'done', `expected node 'done' once checks pass, got '${accepted?.status}'`);
    });

    const finalProject = await drain(project.id, { maxRounds: 20 });
    check('16c', 'after the BUILD gate clears, dependents unblock and the project walks to ready', () => {
      assert.equal(hopperEngine.getHopperNode(testNodeId).status, 'done', 'TEST never dispatched/completed after BUILD was accepted');
      assert.equal(finalProject.status, 'ready', `expected project 'ready', got '${finalProject.status}' (last_error: ${finalProject.last_error})`);
    });
  } finally {
    convDb.deleteSetting('foundry_auto_decide');
  }
}
await runFoundationBuildFinishGateProbe();

// =============================================================================
// SCENARIO L — Foundation Gate: finish-time check on the integration MERGE
// node. Same gate, same reject/fix/retry shape as K, applied to integration.
// =============================================================================
async function runFoundationIntegrationFinishGateProbe() {
  convDb.setSetting('foundry_auto_decide', '0');
  const repo = '/tmp/foundry-sim-repo-foundation-merge-gate';
  rmrf(repo);
  try {
    const blueprint = foundationBlueprint('foundry-sim-foundation-merge-gate-probe', {
      stack: 'sim-stack',
      scaffold_cmd: "printf 'scaffolded\\n' > FOUNDATION_MARKER.txt",
      checks: [{ cmd: 'test -f FOUNDATION_MARKER.txt' }],
    });
    const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
    foundry.setBlueprint(project.id, blueprint);
    foundry.launchProject(project.id);

    // Walk the single module through BUILD/TEST/DOC — seed its own checkout
    // up front so its BUILD gate passes trivially; this probe targets the
    // MERGE gate specifically (BUILD's own gate is scenario K's job).
    let mergeNode = null;
    for (let round = 0; round < 40 && !mergeNode; round++) {
      await hopperEngine.dispatchTick(`foundation-merge-gate-${round}`);
      const state = foundry.getProjectWithModules(project.id);
      const integrationTreeId = state.project.integration_tree_id;
      if (integrationTreeId) {
        const candidate = hopperEngine.listTreeNodes(integrationTreeId).find((n) => n.title.startsWith('MERGE '));
        if (candidate?.status === 'running') {
          mergeNode = candidate;
          break;
        }
      }
      const moduleTreeId = state.modules[0]?.tree_id;
      if (moduleTreeId) {
        for (const node of hopperEngine.listTreeNodes(moduleTreeId).filter((n) => n.status === 'running')) {
          if (node.title.startsWith('BUILD')) {
            // Its own BUILD gate isn't this probe's focus (that's scenario K)
            // — seed the checkout so it derives from the real scaffold and
            // passes trivially.
            seedDerivedCheckout(repo, moduleCheckoutPath(project.id, 'app-shell'), moduleBranch(project.id, 'app-shell'));
          }
          serverFinishNode(node.id, 'done', { result: `[sim] ${node.title} completed OK — no model call made.` });
        }
      }
    }
    assert.ok(mergeNode, 'foundation merge-gate probe: MERGE node never reached running');

    // The integration checkout exists but does NOT actually derive from the
    // real scaffolded commit — the merge never landed anything real.
    const mergeCheckout = integrationCheckoutPath(project.id);
    seedFakeCheckout(mergeCheckout);

    const rejected = serverFinishNode(mergeNode.id, 'done', { result: 'merge complete (checkout never derived from the real scaffold — should be rejected)' });

    check('17a', "the integration MERGE node cannot finish 'done' while a foundation check fails — the server converts it to blocked", () => {
      assert.equal(rejected?.status, 'blocked', `expected MERGE node 'blocked', got '${rejected?.status}'`);
      assert.ok(/FOUNDATION CHECK FAILED/.test(rejected?.result ?? ''), 'blocked result is missing the FOUNDATION CHECK FAILED marker');
      assert.ok((rejected?.result ?? '').includes('test -f FOUNDATION_MARKER.txt'), 'blocked result does not name the failing check command');
      const reviewNode = hopperEngine.listTreeNodes(mergeNode.tree_id).find((n) => n.title.startsWith('REVIEW'));
      assert.equal(reviewNode?.status, 'pending', `REVIEW must not dispatch on a rejected MERGE done, got '${reviewNode?.status}'`);
      const afterProject = foundry.getProjectRow(project.id);
      assert.equal(afterProject?.status, 'blocked', `expected project 'blocked' after MERGE gate rejection, got '${afterProject?.status}'`);
    });

    // Fix: the merge actually lands real integrated output (derived from the
    // scaffold), then retry via the same production path Kevin's cockpit
    // "retry" button uses.
    seedDerivedCheckout(repo, mergeCheckout, moduleBranch(project.id, 'integration'));
    foundry.retryIntegration(project.id);
    await hopperEngine.dispatchTick('foundation-merge-gate-retry-claim');
    const runningAgain = hopperEngine.getHopperNode(mergeNode.id);
    assert.equal(runningAgain.status, 'running', `expected MERGE node running again after retry, got '${runningAgain.status}'`);
    const accepted = serverFinishNode(mergeNode.id, 'done', { result: 'merge complete, integration verified' });

    check('17b', 'the same MERGE node finishes done once the foundation checks actually pass', () => {
      assert.equal(accepted?.status, 'done', `expected MERGE node 'done' once checks pass, got '${accepted?.status}'`);
    });

    const finalProject = await drain(project.id, { maxRounds: 20 });
    check('17c', 'after the MERGE gate clears, the project reaches ready', () => {
      assert.equal(finalProject.status, 'ready', `expected project 'ready', got '${finalProject.status}' (last_error: ${finalProject.last_error})`);
    });
  } finally {
    convDb.deleteSetting('foundry_auto_decide');
  }
}
await runFoundationIntegrationFinishGateProbe();

// =============================================================================
// SCENARIO M — Foundation Gate hardening (adversarial review, node #149):
//  #18 vacuous checks (pass on an empty repo) are refused at launch, the
//      blueprint stays editable while foundation-blocked, and a fixed
//      blueprint relaunches cleanly.
//  #19 scaffold_cmd runs in an EMPTY staging dir (real scaffolders refuse a
//      non-empty target — `composer create-project … .` dies on `.git/`).
//  #20 a scaffold that exits 0 but whose check is wrong commits the real bones,
//      blocks, and relaunch after fixing the check is idempotent (no re-scaffold).
// =============================================================================
async function runFoundationHardeningProbe() {
  // #18 — vacuous checks
  {
    const repo = '/tmp/foundry-sim-repo-foundation-vacuous';
    rmrf(repo);
    const blueprint = foundationBlueprint('foundry-sim-foundation-vacuous-probe', {
      stack: 'sim-stack-vacuous',
      scaffold_cmd: "printf 'scaffolded\\n' > FOUNDATION_MARKER.txt",
      checks: [{ cmd: 'true' }],
    });
    const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
    foundry.setBlueprint(project.id, blueprint);
    let threw = null;
    try { foundry.launchProject(project.id); } catch (err) { threw = err; }
    let relaunched = null;
    check('18', 'checks that pass on an empty repo are refused at launch; blueprint stays editable while foundation-blocked; fixed blueprint relaunches', () => {
      assert.ok(threw, 'launchProject did not throw on vacuous checks');
      assert.equal(threw?.code, 'foundry_foundation_checks_vacuous', `expected foundry_foundation_checks_vacuous, got ${threw?.code}`);
      const after = foundry.getProjectRow(project.id);
      assert.equal(after?.status, 'blocked');
      assert.ok(!fs.existsSync(path.join(repo, 'FOUNDATION_MARKER.txt')), 'scaffold_cmd must not run when the checks are vacuous');
      // Fix the checks (allowed: nothing planted yet) and relaunch.
      foundry.setBlueprint(project.id, { ...blueprint, foundation: { ...blueprint.foundation, checks: [{ cmd: 'test -f FOUNDATION_MARKER.txt' }] } });
      assert.equal(foundry.getProjectRow(project.id)?.status, 'planned');
      relaunched = foundry.launchProject(project.id);
      assert.equal(relaunched.project.status, 'building');
      assert.ok(gitCommitSubjects(repo).includes('FOUNDATION scaffold: sim-stack-vacuous'));
    });
    if (relaunched) {
      seedDerivedCheckout(repo, moduleCheckoutPath(project.id, 'app-shell'), moduleBranch(project.id, 'app-shell'));
      seedDerivedCheckout(repo, integrationCheckoutPath(project.id), moduleBranch(project.id, 'integration'));
      await drain(project.id);
    }
  }

  // #19 — scaffold sees an empty directory
  {
    const repo = '/tmp/foundry-sim-repo-foundation-staging';
    rmrf(repo);
    const blueprint = foundationBlueprint('foundry-sim-foundation-staging-probe', {
      stack: 'sim-stack-staging',
      // Mirrors composer/create-next-app/rails: refuse a non-empty target.
      scaffold_cmd: "[ -z \"$(ls -A)\" ] && mkdir -p app && printf 'scaffolded\\n' > FOUNDATION_MARKER.txt && git init -q . && printf 'ignored\\n' > .gitignore",
      checks: [{ cmd: 'test -f FOUNDATION_MARKER.txt' }, { cmd: 'test -d app' }],
    });
    const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
    foundry.setBlueprint(project.id, blueprint);
    foundry.launchProject(project.id);
    check('19', 'scaffold_cmd runs in an empty staging dir and its output (minus any .git it made) overlays the repo', () => {
      assert.equal(foundry.getProjectRow(project.id)?.status, 'building');
      assert.ok(fs.existsSync(path.join(repo, 'FOUNDATION_MARKER.txt')));
      assert.ok(fs.existsSync(path.join(repo, 'app')));
      assert.ok(fs.existsSync(path.join(repo, 'foundry.json')), 'bootstrap foundry.json must survive the overlay');
      assert.ok(fs.existsSync(path.join(repo, '.gitignore')), 'scaffold dotfiles must be overlaid too');
      const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      assert.ok(gitCommitSubjects(repo).includes('FOUNDATION scaffold: sim-stack-staging'), 'scaffold commit missing (did the scaffolder\'s own git init clobber the repo?)');
      assert.ok(gitCommitSubjects(repo).includes('Initial Foundry scaffold'), 'repo history was replaced by the scaffolder\'s .git');
      assert.ok(!fs.readdirSync(path.dirname(repo)).some((e) => e.startsWith('.foundry-scaffold-')), 'staging dir leaked');
      assert.ok(head.length > 0);
    });
    seedDerivedCheckout(repo, moduleCheckoutPath(project.id, 'app-shell'), moduleBranch(project.id, 'app-shell'));
    seedDerivedCheckout(repo, integrationCheckoutPath(project.id), moduleBranch(project.id, 'integration'));
    await drain(project.id);
  }

  // #20 — real scaffold, wrong check → commit bones, block, fix, idempotent relaunch
  {
    const repo = '/tmp/foundry-sim-repo-foundation-badcheck';
    rmrf(repo);
    const counter = '/tmp/foundry-sim-foundation-badcheck-runs';
    rmrf(counter);
    const blueprint = foundationBlueprint('foundry-sim-foundation-badcheck-probe', {
      stack: 'sim-stack-badcheck',
      scaffold_cmd: `printf 'scaffolded\\n' > FOUNDATION_MARKER.txt && echo run >> ${counter}`,
      checks: [{ cmd: 'cat FOUNDATION_MARKER.txt', expect_regex: '^Laravel Framework' }],
    });
    const { project } = foundry.createProject({ name: blueprint.name, prompt: blueprint.prompt, repo_path: repo });
    foundry.setBlueprint(project.id, blueprint);
    let threw = null;
    try { foundry.launchProject(project.id); } catch (err) { threw = err; }
    let relaunched = null;
    check('20', 'a scaffold that exits 0 with a wrong check commits the real bones, blocks with the check output, and relaunch after the fix is idempotent', () => {
      assert.equal(threw?.code, 'foundry_foundation_check_failed', `expected foundry_foundation_check_failed, got ${threw?.code}`);
      assert.ok(/FOUNDATION CHECK FAILED/.test(foundry.getProjectRow(project.id)?.last_error ?? ''));
      assert.ok(gitCommitSubjects(repo).includes('FOUNDATION scaffold: sim-stack-badcheck'), 'real bones must be committed even when the check is wrong');
      const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
      assert.equal(dirty, '', `repo left dirty after a post-scaffold check failure: ${dirty}`);
      foundry.setBlueprint(project.id, { ...blueprint, foundation: { ...blueprint.foundation, checks: [{ cmd: 'cat FOUNDATION_MARKER.txt', expect_regex: '^scaffolded' }] } });
      relaunched = foundry.launchProject(project.id);
      assert.equal(relaunched.project.status, 'building');
      assert.equal(fs.readFileSync(counter, 'utf8').trim(), 'run', 'scaffold_cmd re-ran on relaunch (must be idempotent)');
    });
    if (relaunched) {
      seedDerivedCheckout(repo, moduleCheckoutPath(project.id, 'app-shell'), moduleBranch(project.id, 'app-shell'));
      seedDerivedCheckout(repo, integrationCheckoutPath(project.id), moduleBranch(project.id, 'integration'));
      await drain(project.id);
    }
  }
}
await runFoundationHardeningProbe();

// =============================================================================
// Report
// =============================================================================
console.log('');
console.log('FOUNDRY LIFECYCLE SIM — RESULTS');
console.log('================================');
let allPass = true;
for (const r of results) {
  const status = r.pass ? 'PASS' : 'FAIL';
  if (!r.pass) allPass = false;
  console.log(`[${status}] #${r.id} — ${r.description}${r.pass ? '' : `\n        ${r.error}`}`);
}
console.log('');
console.log(`dispatched worker calls observed: ${dispatchedNodeIds.size}`);
console.log(allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');

process.exit(allPass ? 0 : 1);
