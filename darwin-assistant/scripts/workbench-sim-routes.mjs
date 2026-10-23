#!/usr/bin/env node
// WORKBENCH ROUTES SIM (hopper node #443) — real Express router, real HTTP,
// throwaway port, scratch sqlite DB. Proves spec item 5 (GET /workbench/scope/:id
// at three zoom depths) and the item-10 regression contract: every existing
// /api/v1/smart-todos/* route still returns its pre-existing response shape.
//
//   npm run build
//   node /tmp/workbench-sim/workbench-sim-routes.mjs
//
// Mirrors scripts/claude-accounts-route-test.mjs (real app.listen(0), real
// fetch(), mintApiKey() for a valid bearer token — no live model calls needed
// for anything in this file, since none of these routes touch claude).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ── scratch DB guard ────────────────────────────────────────────────────────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

// No live model calls in this file's checks, but /workbench/jot with focus_id still
// shells to decomposeNote() internally — point it at the fake binary (default,
// no control file -> harmless empty envelope -> decomposeNote's own fallback) so
// this stays fast/deterministic and makes zero real subscription calls.
process.env.UX_REVIEWER_CLAUDE_BIN = path.join(__dirname, 'workbench-sim-fake-claude.mjs');
delete process.env.ANTHROPIC_API_KEY;

const distDir = path.join(repoRoot, 'dist');
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/v1`;

async function req(method, urlPath, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const key = mintApiKey('workbench-route-sim', 'jarvis').plaintext;

console.log(`[workbench-sim-routes] scratch DB: ${DB_PATH}`);
console.log(`[workbench-sim-routes] server: ${base}`);

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${label}`);
}

try {
  // ───────────────────────────────────────────────────────────────────────
  // ITEM 5 — GET /workbench/scope/:id returns the correct node + ancestors +
  // subtree at three different depths.
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[5] GET /workbench/scope/:id at three zoom depths');

  // Build a 3-level fixture: root -> mid -> leaf1, leaf2 (siblings under mid).
  const rootRes = await req('POST', '/smart-todos', { token: key, body: { title: 'Root branch' } });
  const rootId = rootRes.json.node.id;
  const midRes = await req('POST', '/smart-todos', { token: key, body: { title: 'Mid branch', parent_id: rootId } });
  const midId = midRes.json.node.id;
  const leaf1Res = await req('POST', '/smart-todos', { token: key, body: { title: 'Leaf 1', parent_id: midId } });
  const leaf1Id = leaf1Res.json.node.id;
  const leaf2Res = await req('POST', '/smart-todos', { token: key, body: { title: 'Leaf 2', parent_id: midId } });
  const leaf2Id = leaf2Res.json.node.id;

  // Depth 0 — root/whole-tree scope.
  const rootScope = await req('GET', '/workbench/scope/root', { token: key });
  check('root scope (id="root"): node is null, no ancestors, subtree is the WHOLE tree', () => {
    assert.equal(rootScope.status, 200);
    assert.equal(rootScope.json.node, null);
    assert.deepEqual(rootScope.json.ancestors, []);
    const ids = rootScope.json.subtree.map((n) => n.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [rootId, midId, leaf1Id, leaf2Id].sort((a, b) => a - b));
  });

  // Depth 1 — mid-level zoom (has an ancestor above it and a subtree below it).
  const midScope = await req('GET', `/workbench/scope/${midId}`, { token: key });
  check('mid-level zoom: node is Mid branch, one ancestor (Root), subtree is mid+2 leaves (not the whole tree)', () => {
    assert.equal(midScope.status, 200);
    assert.equal(midScope.json.node.id, midId);
    assert.equal(midScope.json.ancestors.length, 1);
    assert.equal(midScope.json.ancestors[0].id, rootId);
    const ids = midScope.json.subtree.map((n) => n.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [midId, leaf1Id, leaf2Id].sort((a, b) => a - b));
    assert.ok(!ids.includes(rootId), 'a zoomed subtree must not include its own ancestor');
  });

  // Depth 2 — leaf zoom (deepest node, two ancestors, subtree is just itself).
  const leafScope = await req('GET', `/workbench/scope/${leaf1Id}`, { token: key });
  check('leaf zoom: node is Leaf 1, ancestors are [Root, Mid] root-first, subtree is itself only', () => {
    assert.equal(leafScope.status, 200);
    assert.equal(leafScope.json.node.id, leaf1Id);
    assert.equal(leafScope.json.ancestors.length, 2);
    assert.equal(leafScope.json.ancestors[0].id, rootId, 'ancestors must be root-first');
    assert.equal(leafScope.json.ancestors[1].id, midId);
    assert.deepEqual(
      leafScope.json.subtree.map((n) => n.id),
      [leaf1Id],
    );
    assert.ok(!leafScope.json.subtree.some((n) => n.id === leaf2Id), 'a leaf zoom must not see its sibling');
  });

  const notFound = await req('GET', '/workbench/scope/999999', { token: key });
  check('unknown node id -> 404, not a crash', () => {
    assert.equal(notFound.status, 404);
  });

  const noAuth = await req('GET', '/workbench/scope/root');
  check('no bearer token -> 401 (same bearerAuth as every other /api/v1 route)', () => {
    assert.equal(noAuth.status, 401);
  });

  // ───────────────────────────────────────────────────────────────────────
  // ITEM 10 (routes half) — every existing /smart-todos/* route still
  // returns its pre-existing response shape (untouched behavior).
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[10] regression: /smart-todos/* routes are behaviorally untouched');

  const listRes = await req('GET', '/smart-todos', { token: key });
  check('GET /smart-todos -> { nodes: [...] } (same envelope key as before)', () => {
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listRes.json.nodes));
    assert.equal(Object.keys(listRes.json).length, 1, 'envelope must be exactly { nodes }, no new top-level keys');
  });

  const preExistingKeys = [
    'id', 'parent_id', 'root_id', 'title', 'notes', 'original_prompt', 'origin',
    'sort_order', 'collapsed', 'status', 'group_id', 'linked_thread_ext', 'created_at', 'updated_at',
  ];
  const sample = listRes.json.nodes[0];
  check('every pre-existing node field is still present with its original meaning', () => {
    for (const k of preExistingKeys) assert.ok(k in sample, `missing pre-existing field ${k}`);
    assert.equal(sample.title, 'Root branch');
  });
  check(
    'the 3 additive Workbench columns DO appear (nullable, spec-sanctioned "two views, one tree" — ' +
      'not a regression: /tree\'s own type ignores unknown keys, see docs/workbench/SIM.md)',
    () => {
      assert.ok('context_notes' in sample);
      assert.ok('match_key' in sample);
      assert.ok('last_activity_at' in sample);
      assert.equal(sample.context_notes, null);
    },
  );

  const patchRes = await req('PATCH', `/smart-todos/${leaf2Id}`, { token: key, body: { notes: 'a note', status: 'doing' } });
  check('PATCH /smart-todos/:id -> { node } shape unchanged, patch applied', () => {
    assert.equal(patchRes.status, 200);
    assert.equal(Object.keys(patchRes.json).length, 1);
    assert.equal(patchRes.json.node.notes, 'a note');
    assert.equal(patchRes.json.node.status, 'doing');
  });

  const moveRes = await req('POST', `/smart-todos/${leaf2Id}/move`, { token: key, body: { parent_id: null, sort_order: 0 } });
  check('POST /smart-todos/:id/move -> { node, nodes } shape unchanged', () => {
    assert.equal(moveRes.status, 200);
    assert.deepEqual(Object.keys(moveRes.json).sort(), ['node', 'nodes']);
    assert.equal(moveRes.json.node.parent_id, null);
  });

  const delRes = await req('DELETE', `/smart-todos/${leaf2Id}`, { token: key });
  check('DELETE /smart-todos/:id -> 204 empty body, unchanged', () => {
    assert.equal(delRes.status, 204);
    assert.equal(delRes.json, null);
  });

  const notFoundPatch = await req('PATCH', '/smart-todos/999999', { token: key, body: { title: 'x' } });
  check('PATCH on an unknown node still 404s exactly as before', () => {
    assert.equal(notFoundPatch.status, 404);
  });

  // Prove /workbench/jot lives on its own namespace and never collides with
  // /smart-todos/jot (both exist side by side, different response shapes).
  const wbJot = await req('POST', '/workbench/jot', { token: key, body: { text: 'quick workbench-only jot', focus_id: rootId } });
  check('POST /workbench/jot works independently of /smart-todos/jot and honors focus_id', () => {
    assert.equal(wbJot.status, 201);
    assert.equal(wbJot.json.parent_id, rootId);
  });

  console.log(`\n[workbench-sim-routes] ALL ${passed} checks passed ✅`);
} finally {
  server.close();
}
