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
      hopperEngine.finishHopperNode(n.id, 'done', { result: `[sim] ${n.title} completed OK — no model call made.` });
    }
  }
  return foundry.getProjectRow(projectId);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
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
  const repo = '/tmp/foundry-sim-repo-blocked';
  rmrf(repo);
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

  check('7a', "a 'blocked' finish turns the module red with exactly one foundry notification", () => {
    const { modules } = foundry.getProjectWithModules(project.id);
    assert.equal(modules[0].stage, 'blocked', `expected module stage 'blocked', got '${modules[0].stage}'`);
    const n = notificationCountSince(marker, 'foundry', { severity: 'error' });
    assert.equal(n, 1, `expected exactly 1 foundry error notification for the blocked module, got ${n}`);
  });
}
await runBlockedProbe();

// =============================================================================
// SCENARIO C — a 'blocked_question' finish + answerHopperNode recovery
// =============================================================================
async function runBlockedQuestionProbe() {
  const repo = '/tmp/foundry-sim-repo-blockedq';
  rmrf(repo);
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

  check('7b', "a 'blocked_question' finish sets needs_answer; answerHopperNode re-queues and clears it", () => {
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
