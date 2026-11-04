#!/usr/bin/env node
// PAGE COMPANION — BRANCH AWARENESS CHECK (tree-b0198a82, node #1586).
//
// Hermetic: scratch sqlite, no live DB, no model calls, and NO network except a
// throwaway 127.0.0.1 express fixture standing in for the deploy-control API.
// The hub file reader is replaced through `deploymentSources`, so this suite
// never touches a Darwin host — but the fixtures it feeds are the REAL bytes
// read off the three live checkouts on 2026-10-09 (see FIXTURES below), so the
// parsing is proven against real data rather than invented data.
//
//   npm run page-companion:deploy-check

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const raw = process.env.JARVIS_DB_PATH;
if (!raw || !/\/tmp\//.test(raw)) {
  console.error('FATAL: JARVIS_DB_PATH must be a scratch path under /tmp.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

// A dead default base, so nothing in this suite can ever reach a real host by
// accident if a test forgets to stub fetchEnvironments.
process.env.DEPLOY_API_BASE = 'http://127.0.0.1:1';
process.env.PAGE_COMPANION_DEPLOY_BUDGET_MS = '400';

const distDir = path.join(__dirname, '..', 'dist');
const PC = await import(path.join(distDir, 'page-companion.js'));
const PCD = await import(path.join(distDir, 'page-companion-deploy.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── FIXTURES: the real bytes, read 2026-10-09 through the approved-roots
// `vhosts` reader. Nothing here is invented.
const FIXTURES = {
  'intake.thedarwinhub.com/.git/HEAD': { content: 'ref: refs/heads/main\n', mtime: '2026-10-08T02:33:41+00:00' },
  'intake.thedarwinhub.com/.git/refs/heads/main': {
    content: 'ac3510d9d3574b1bc34ccb799c92191a19ee36d5\n', mtime: '2026-10-08T02:33:49+00:00',
  },
  'staging.intake.thedarwinhub.com/.git/HEAD': {
    content: 'ref: refs/heads/deploy/atomic-releases-hub2\n', mtime: '2026-10-05T17:13:06+00:00',
  },
  'staging.intake.thedarwinhub.com/.git/refs/heads/deploy/atomic-releases-hub2': {
    content: '53739f343b88e6f41fb78d2453f92542fbe2f166\n', mtime: '2026-10-05T21:29:19+00:00',
  },
  'accounting.thedarwinhub.com/.git/HEAD': {
    content: 'ref: refs/heads/jarvis/qb-sandbox-verify\n', mtime: '2026-08-20T17:39:14+00:00',
  },
  'accounting.thedarwinhub.com/.git/refs/heads/jarvis/qb-sandbox-verify': {
    content: '8f98257cc443ba8d9a50b29ca49669b5b50e9aa4\n', mtime: '2026-10-09T17:45:04+00:00',
  },
};

let hubReads = [];
function fixtureReader(extra = {}) {
  const table = { ...FIXTURES, ...extra };
  return async (_host, _root, p) => {
    hubReads.push(p);
    return table[p] ?? null;
  };
}
const refuse = async () => { throw new Error('source must not be called in this test'); };

function useSources({ fetchEnvironments = refuse, readHubFile = refuse } = {}) {
  PCD.deploymentSources.fetchEnvironments = fetchEnvironments;
  PCD.deploymentSources.readHubFile = readHubFile;
  PCD.clearDeploymentCache();
  hubReads = [];
}

function clearRegistry() {
  sqliteDb.exec('DELETE FROM page_registry');
}

console.log('\nPAGE COMPANION — BRANCH AWARENESS\n');

// ── 1. the migration ────────────────────────────────────────────────────────
console.log('page_registry.deploy_target (additive migration)');
{
  const cols = sqliteDb.prepare(`PRAGMA table_info(page_registry)`).all().map((c) => c.name);
  assert.ok(cols.includes('deploy_target'), `deploy_target missing (saw ${cols.join(', ')})`);
  ok('the column exists after import');

  // A row written BEFORE the column existed reads back as NULL, not an error.
  clearRegistry();
  sqliteDb
    .prepare(`INSERT INTO page_registry (url_pattern, project, source) VALUES (?, ?, 'manual')`)
    .run('legacy.example.com/dash', 'A row from before the column');
  const legacy = PC.listPageRegistry().find((r) => r.url_pattern === 'legacy.example.com/dash');
  assert.equal(legacy.deploy_target, null);
  ok('an existing row survives with deploy_target NULL');

  // Re-running the ALTER is the thing a boot does on every restart.
  let threw = null;
  try { sqliteDb.exec(`ALTER TABLE page_registry ADD COLUMN deploy_target TEXT`); } catch (e) { threw = e; }
  assert.ok(threw, 'a second ALTER does throw (which is why the real one is wrapped in try/catch)');
  assert.equal(
    sqliteDb.prepare(`SELECT COUNT(*) AS n FROM page_registry`).get().n, 1,
    'and the rows are untouched',
  );
  ok('re-running the migration is safe — it throws, is swallowed, and loses no rows');

  // upsert sets it, and a later upsert that omits it does NOT blank it.
  const set = PC.upsertPageRegistry({
    url_pattern: 'https://intake.thedarwinhub.com/suppression-dashboard',
    project: 'Intake · Suppression Dashboard',
    deploy_target: 'intake-prod',
  });
  assert.equal(set.deploy_target, 'intake-prod');
  const again = PC.upsertPageRegistry({
    url_pattern: 'https://intake.thedarwinhub.com/suppression-dashboard',
    project: 'Kevin renamed this',
  });
  assert.equal(again.deploy_target, 'intake-prod', 'an omitting upsert must not blank the target');
  assert.equal(again.project, 'Kevin renamed this');
  ok('upsert stores a target and never blanks an existing one');
}

// ── 2. the seed ─────────────────────────────────────────────────────────────
console.log('\nseeding');
{
  clearRegistry();
  const first = PC.seedPageRegistry();
  assert.ok(first.manual_added >= 79, `expected the full manual map (got ${first.manual_added})`);
  assert.equal(first.deploy_targets_set, 0, 'a fresh seed sets targets inline, not as a back-fill');

  const rows = PC.listPageRegistry();
  const byTarget = (t) => rows.filter((r) => r.deploy_target === t).length;
  assert.equal(byTarget('intake-prod'), 23, 'every prod intake dashboard carries intake-prod');
  assert.equal(byTarget('intake-staging'), 23, 'every staging intake dashboard carries intake-staging');
  assert.equal(byTarget('accounting'), 29, 'every accounting dashboard carries accounting');
  // The LAN dashboards legitimately have none — they are not repo-driven.
  const lan = rows.filter((r) => r.url_pattern.startsWith('192.168.1.25:'));
  assert.equal(lan.length, 4);
  assert.ok(lan.every((r) => r.deploy_target === null), 'LAN dashboards carry no deploy target');
  ok('the seed stamps a deploy target on all 75 repo-driven rows and none of the 4 LAN rows');

  // Every target a seed row names must actually resolve — a typo here would be
  // a dashboard that silently never shows a branch.
  for (const r of rows) {
    if (!r.deploy_target) continue;
    assert.ok(PCD.resolveDeployTarget(r.deploy_target), `seeded target '${r.deploy_target}' does not resolve`);
  }
  ok('every seeded deploy_target resolves in DEPLOY_TARGETS');

  // THE BACK-FILL. Rows seeded before this column existed (which is the state
  // of the live DB) must pick the target up on the next boot.
  sqliteDb.exec(`UPDATE page_registry SET deploy_target = NULL`);
  const second = PC.seedPageRegistry();
  assert.equal(second.manual_added, 0, 'no duplicate rows');
  assert.equal(second.deploy_targets_set, 75, `back-filled 75 rows (got ${second.deploy_targets_set})`);
  const third = PC.seedPageRegistry();
  assert.equal(third.deploy_targets_set, 0, 'and a third seed back-fills nothing');
  ok('re-seeding back-fills a NULL target on existing rows, then stops');

  // A target Kevin (or a future node) re-pointed by hand is not re-pointed back.
  const row = PC.listPageRegistry().find((r) => r.deploy_target === 'intake-prod');
  sqliteDb.prepare(`UPDATE page_registry SET deploy_target = 'sandbox-intake' WHERE id = ?`).run(row.id);
  PC.seedPageRegistry();
  assert.equal(PC.getPageRegistryById(row.id).deploy_target, 'sandbox-intake');
  ok('a hand-edited deploy_target is never clobbered by a re-seed');
}

// ── 3. the git-HEAD source (b) ──────────────────────────────────────────────
console.log('\nsource (b) — .git/HEAD through the hub file reader');
{
  useSources({ readHubFile: fixtureReader() });
  const prod = await PCD.getPageDeployment(7, 'intake-prod');
  assert.equal(prod.known, true);
  assert.equal(prod.source, 'git_head');
  assert.equal(prod.branch, 'main');
  assert.equal(prod.commit, 'ac3510d9d3');
  assert.equal(prod.detached, false);
  assert.equal(prod.as_of, '2026-10-08T02:33:49+00:00');
  assert.equal(prod.registry_id, 7, 'the caller’s registry id is stamped on the cached answer');
  ok('intake prod reads main @ ac3510d9d3 off the real HEAD bytes');

  useSources({ readHubFile: fixtureReader() });
  const staging = await PCD.getPageDeployment(8, 'intake-staging');
  assert.equal(staging.branch, 'deploy/atomic-releases-hub2', 'a slashed branch name survives the ref path');
  assert.equal(staging.commit, '53739f343b');
  ok('staging intake reads a SLASHED branch name (deploy/atomic-releases-hub2)');

  useSources({ readHubFile: fixtureReader() });
  const acct = await PCD.getPageDeployment(9, 'accounting');
  assert.equal(acct.branch, 'jarvis/qb-sandbox-verify');
  assert.equal(acct.commit, '8f98257cc4');
  ok('accounting reads jarvis/qb-sandbox-verify @ 8f98257cc4');

  // DETACHED HEAD — a raw sha, reported as a short sha and flagged.
  useSources({
    readHubFile: fixtureReader({
      'intake.thedarwinhub.com/.git/HEAD': {
        content: 'ac3510d9d3574b1bc34ccb799c92191a19ee36d5\n', mtime: '2026-10-08T02:33:41+00:00',
      },
    }),
  });
  const det = await PCD.getPageDeployment(7, 'intake-prod');
  assert.equal(det.detached, true);
  assert.equal(det.branch, null);
  assert.equal(det.commit, 'ac3510d9d3');
  assert.equal(hubReads.length, 1, 'a detached HEAD needs no second read');
  ok('a detached HEAD reports the short sha and detached:true, with no branch');

  // PACKED REFS — a gc'd repo has no loose ref. Without the fallback this host
  // would read "unknown" forever.
  const noLoose = { ...FIXTURES };
  delete noLoose['intake.thedarwinhub.com/.git/refs/heads/main'];
  useSources({
    readHubFile: async (_h, _r, p) => {
      hubReads.push(p);
      if (p === 'intake.thedarwinhub.com/.git/packed-refs') {
        return {
          content: '# pack-refs with: peeled fully-peeled sorted \n' +
            'ac3510d9d3574b1bc34ccb799c92191a19ee36d5 refs/heads/main\n' +
            'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef refs/remotes/origin/main\n',
          mtime: '2026-10-08T02:30:00+00:00',
        };
      }
      return noLoose[p] ?? null;
    },
  });
  const packed = await PCD.getPageDeployment(7, 'intake-prod');
  assert.equal(packed.branch, 'main');
  assert.equal(packed.commit, 'ac3510d9d3');
  ok('a packed-refs repo still resolves its sha');

  // An unreadable HEAD says nothing rather than guessing.
  useSources({ readHubFile: async () => null });
  const blind = await PCD.getPageDeployment(7, 'intake-prod');
  assert.equal(blind.known, false);
  assert.equal(blind.branch, null);
  assert.equal(blind.commit, null);
  ok('an unreadable checkout is known:false — never a guess');
}

// ── 4. parsers, directly ────────────────────────────────────────────────────
console.log('\nparsers');
{
  assert.deepEqual(PCD.parseGitHead('ref: refs/heads/main\n'), { branch: 'main', sha: null });
  assert.deepEqual(PCD.parseGitHead('ref: refs/heads/a/b/c\n'), { branch: 'a/b/c', sha: null });
  assert.deepEqual(PCD.parseGitHead('ref: refs/tags/v1\n'), { branch: null, sha: null });
  assert.deepEqual(PCD.parseGitHead('ac3510d9d3574b1bc34ccb799c92191a19ee36d5'), {
    branch: null, sha: 'ac3510d9d3574b1bc34ccb799c92191a19ee36d5',
  });
  assert.deepEqual(PCD.parseGitHead('not a head'), { branch: null, sha: null });
  assert.deepEqual(PCD.parseGitHead(null), { branch: null, sha: null });
  ok('parseGitHead: ref, slashed ref, non-branch ref, detached sha, junk, null');

  const pr = '# pack-refs\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA refs/heads/main\n' +
    '^cafebabecafebabecafebabecafebabecafebabe\n' +
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/feat/x\n';
  assert.equal(PCD.shaFromPackedRefs(pr, 'main'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(PCD.shaFromPackedRefs(pr, 'feat/x'), 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(PCD.shaFromPackedRefs(pr, 'nope'), null);
  ok('shaFromPackedRefs: finds a branch, a slashed branch, skips peel lines, misses cleanly');
}

// ── 5. the deploy-control API source (a), against a real-shaped fixture ─────
console.log('\nsource (a) — the deploy-control API');
{
  // The payload is CONTRACT.md §8.2's TargetRollup, verbatim in shape.
  const rollup = {
    key: 'sandbox-intake',
    name: 'Darwin Intake (Sandbox)',
    domain: 'sandbox.intake.thedarwinhub.com',
    env: 'sandbox',
    group: 'sandbox-perclickity',
    status: {
      branch: 'hub2/suppression-dead-end',
      main_branch: 'main',
      is_review_branch: true,
      latest_commit: { hash: 'b0198a82ffc0ffee1234', author: 'kevin', date: '2026-10-07T10:00:00+00:00', message: 'x' },
    },
    drift: { tracking: true, behind: 3, ahead: 0, stale: true, dirty: false, detached: false, fetched_at: '2026-10-09T18:00:00+00:00', error: null },
    doctor: { ready: true, health_http_status: 200, problems: [] },
    last_deploy: { deployed_at: '2026-10-07T10:05:00+00:00', success: true },
  };

  const app = express();
  let calls = 0;
  let seenFetchParam = null;
  app.get('/api/v1/deploy/environments', (req, res) => {
    calls += 1;
    seenFetchParam = req.query.fetch ?? null;
    res.json({ success: true, data: { control_plane: { env: 'prod' }, groups: {}, targets: [rollup] } });
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  process.env.DEPLOY_API_BASE = `http://127.0.0.1:${server.address().port}`;

  // THE SHIPPED HTTP CLIENT, not a re-creation of it: defaultFetchEnvironments
  // is exported precisely so this test exercises the real URL building, the
  // real fetch=false param, the real auth header and the real parser.
  PCD.clearDeploymentCache();
  PCD.deploymentSources.readHubFile = refuse;
  PCD.deploymentSources.fetchEnvironments = PCD.defaultFetchEnvironments;

  const api = await PCD.getPageDeployment(42, 'sandbox-intake');
  assert.equal(api.known, true);
  assert.equal(api.source, 'deploy_api', 'the API wins over the git fallback when it answers');
  assert.equal(api.branch, 'hub2/suppression-dead-end');
  assert.equal(api.commit, 'b0198a82ff', 'commit is shortened to 10');
  assert.equal(api.behind, 3);
  assert.equal(api.stale, true);
  assert.equal(api.dirty, false);
  assert.equal(api.health, 200);
  assert.equal(api.as_of, '2026-10-09T18:00:00+00:00');
  assert.equal(calls, 1, 'the fixture server really was called');
  assert.equal(seenFetchParam, 'false', 'the shipped client asks for fetch=false (no git fetch on a live host)');
  ok('the shipped deploy-API client answers branch + commit + behind/stale + health, and beats the fallback');

  // CACHE: a second read inside the TTL makes no further request.
  const again = await PCD.getPageDeployment(43, 'sandbox-intake');
  assert.equal(calls, 1, 'a second read inside the TTL made no request');
  assert.equal(again.branch, 'hub2/suppression-dead-end');
  assert.equal(again.registry_id, 43, 'but it is stamped with the new caller’s registry id');
  ok('the answer is cached per target (~60s), so reopening a panel cannot hammer the source');

  // THE SOURCE GOING AWAY: (a) fails → (b) answers.
  server.close();
  PCD.clearDeploymentCache();
  PCD.deploymentSources.readHubFile = fixtureReader({
    'sandbox.intake.thedarwinhub.com/.git/HEAD': { content: 'ref: refs/heads/main\n', mtime: '2026-09-30T02:24:33+00:00' },
    'sandbox.intake.thedarwinhub.com/.git/refs/heads/main': {
      content: 'ac3510d9d3574b1bc34ccb799c92191a19ee36d5\n', mtime: '2026-09-30T02:24:40+00:00',
    },
  });
  const fellBack = await PCD.getPageDeployment(42, 'sandbox-intake');
  assert.equal(fellBack.known, true);
  assert.equal(fellBack.source, 'git_head', 'a dead deploy API falls through to .git/HEAD');
  assert.equal(fellBack.branch, 'main');
  ok('a dead deploy API falls back to the git read rather than failing');

  // BOTH sources gone → known:false, still no throw.
  PCD.clearDeploymentCache();
  PCD.deploymentSources.readHubFile = refuse;
  const nothing = await PCD.getPageDeployment(42, 'sandbox-intake');
  assert.equal(nothing.known, false);
  assert.ok(typeof nothing.reason === 'string' && nothing.reason, 'it says why, for the log');
  ok('both sources unavailable → known:false with a reason, never a throw and never a stale value');
}

// ── 6. no target / unknown target / a hanging source ────────────────────────
console.log('\ndegradation');
{
  useSources({});
  const none = await PCD.getPageDeployment(5, null);
  assert.equal(none.known, false);
  assert.equal(none.deploy_target, null);
  ok('a page with no deploy target answers known:false without calling any source');

  const bogus = await PCD.getPageDeployment(5, 'not-a-real-target');
  assert.equal(bogus.known, false);
  assert.match(bogus.reason, /unknown deploy target/);
  ok('an unknown deploy_target answers known:false, not an error');

  // A source that never resolves must not hold the response open.
  useSources({ readHubFile: () => new Promise(() => {}) });
  const started = Date.now();
  const hung = await PCD.getPageDeployment(7, 'intake-prod');
  const waited = Date.now() - started;
  assert.equal(hung.known, false);
  assert.ok(waited < 2_000, `the budget capped the wait (waited ${waited}ms)`);
  ok(`a hanging source is capped by the overall budget (returned in ${waited}ms)`);
}

// ── 7. THE LOAD-BEARING PROPERTY: the lookup is untouched ───────────────────
console.log('\nthe lookup is unaffected by the deployment source — the whole point of the split');
{
  clearRegistry();
  PC.seedPageRegistry();
  const URL_UNDER_TEST = 'https://intake.thedarwinhub.com/suppression-dashboard';

  // lookupPage is SYNCHRONOUS. That is not a style point — a synchronous
  // function cannot await a network read, so it is structurally impossible for
  // a deployment source to slow it or break it.
  const baseline = PC.lookupPage(URL_UNDER_TEST);
  assert.ok(!(baseline instanceof Promise), 'lookupPage must stay synchronous');
  assert.equal(baseline.ours, true);
  assert.equal(baseline.project, 'Intake · Suppression Dashboard');
  assert.ok(typeof baseline.registry_id === 'number');
  assert.ok(!('deployment' in baseline) && !('branch' in baseline),
    'the lookup response carries no deployment fields — the panel asks separately');
  ok('lookupPage is synchronous and its response shape gained nothing');

  // Now rig BOTH sources to be as hostile as possible and re-run the lookup.
  for (const [label, sources] of [
    ['both throw', { fetchEnvironments: refuse, readHubFile: refuse }],
    ['both hang forever', {
      fetchEnvironments: () => new Promise(() => {}),
      readHubFile: () => new Promise(() => {}),
    }],
    ['both return garbage', {
      fetchEnvironments: async () => 'not an array',
      readHubFile: async () => ({ content: 42, mtime: {} }),
    }],
  ]) {
    useSources(sources);
    const after = PC.lookupPage(URL_UNDER_TEST);
    assert.deepEqual(after, baseline, `the lookup changed when ${label}`);
  }
  ok('with the deployment sources throwing, hanging and returning garbage, the lookup is byte-identical');

  // And page-companion.ts must not import the deployment module at all — that
  // is what keeps the above true as the code grows.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'page-companion.ts'), 'utf8');
  assert.ok(!/from '\.\/page-companion-deploy\.js'/.test(src),
    'page-companion.ts must not import page-companion-deploy.js (the lookup must stay network-free)');
  ok('page-companion.ts does not import the deployment module — the split is structural');
}

PCD.clearDeploymentCache();
console.log(`\n[page-companion-deploy-check] ALL ${passed} tests passed ✅\n`);
