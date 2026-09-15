#!/usr/bin/env node
// FINISH-LINE GATE LIFECYCLE SIMULATION — drives the real engine + real HTTP API
// (hopper-engine.ts + handlers/api-v1.ts + ui-server.ts) against a scratch DB and
// a scratch UI port. No model calls: a fake worker stands in for spawned Hopper
// workers, exactly like scripts/foundry-sim.mjs. Never touches the live service
// or the live jarvis.db. Permanent regression script: `npm run finishline:sim`.
//
//   node scripts/finishline-sim.mjs
//
// (run `npm run build` first — this drives the compiled dist/, not tsx.)

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// GUARDS — must run before any dist/ module is imported (conversation-db.js
// reads JARVIS_DB_PATH at import time and opens the sqlite handle immediately).
// ---------------------------------------------------------------------------
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
const DB_PATH = path.resolve(process.env.JARVIS_DB_PATH || `/tmp/finishline-sim-${process.pid}.db`);
if (DB_PATH === LIVE_DB) {
  console.error(`FATAL: refusing to run against the live jarvis.db (${LIVE_DB}). Use a /tmp scratch path.`);
  process.exit(1);
}
fs.rmSync(DB_PATH, { force: true });
process.env.JARVIS_DB_PATH = DB_PATH;
console.log(`[finishline-sim] scratch DB: ${DB_PATH}`);

const UI_PORT = parseInt(process.env.JARVIS_UI_PORT || '39221', 10);
if (UI_PORT === 3201) {
  console.error('FATAL: refusing to bind the live UI port 3201. Pick a throwaway port.');
  process.exit(1);
}
process.env.JARVIS_UI_PORT = String(UI_PORT);
console.log(`[finishline-sim] scratch UI port: ${UI_PORT}`);

// No governor gating for this mechanics-only test; no Slack (index.ts is never
// imported, so Slack never boots regardless); no foundry start (non-foundry
// trees short-circuit the foundation gate with {ok:true, gated:false}).
process.env.HOPPER_GOV_ENABLED = '0';
process.env.HOPPER_ENGINE_SLOTS = process.env.HOPPER_ENGINE_SLOTS || '4';

const BASE_URL = `http://127.0.0.1:${UI_PORT}`;

// Dynamic imports ONLY after the guards pass.
const distDir = path.join(__dirname, '..', 'dist');
const hopperEngine = await import(path.join(distDir, 'hopper-engine.js'));
const uiServer = await import(path.join(distDir, 'ui-server.js'));
const apiKeys = await import(path.join(distDir, 'api-keys.js'));
const convDb = await import(path.join(distDir, 'conversation-db.js'));

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
async function checkAsync(id, description, fn) {
  try {
    await fn();
    results.push({ id, description, pass: true });
  } catch (err) {
    results.push({ id, description, pass: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Fake worker — no model calls. Mirrors what a real spawned worker does:
//   - a normal leaf node just reports done immediately.
//   - a FINISH-LINE AUDIT node runs the scenario-specific verdict logic that a
//     real audit worker would run, via the SAME public HTTP API a real worker
//     uses (POST /hopper-trees[+/agree], POST /hopper-nodes/:id/finish).
// ---------------------------------------------------------------------------
const scenarioForTree = new Map(); // treeId -> 'A' | 'B' | 'C'
const dispatchedNodeIds = new Set();

function buildSimHandoff(treeId, topic, { backfilled = 'no', report = 'outbox/finishline-sim.md' } = {}) {
  return [
    `# ${topic} handoff`,
    '',
    `Tree: \`${treeId}\``,
    'Status: final',
    `Backfilled: ${backfilled}`,
    '',
    '## What was built',
    '',
    '- Simulated tree deliverable completed.',
    '',
    '## Branches & how to install',
    '',
    '| Order | Repo | Branch | Head | Notes |',
    '| --- | --- | --- | --- | --- |',
    '| 1 | `KEatonDarwin/paperclip` | `hopper/finish-line-gate` | `sim` | Scratch simulation only; no install step. |',
    '',
    '## How to use it',
    '',
    '1. Open the finished tree and read the handoff card.',
    '',
    '## Human runthrough',
    '',
    '- [ ] Open the finished tree detail, expect this handoff card to be visible.',
    '- [ ] Try the scratch success path, expect the simulated deliverable to be marked complete.',
    '- [ ] Check the scratch missing-handoff failure path, expect the FULL verdict to be rejected.',
    '',
    '## Next steps / deferred',
    '',
    '- None.',
    '',
    '## Full report',
    '',
    `- Full report: \`${report}\``,
  ].join('\n');
}

async function fakeProcessMessage(prompt) {
  const nodeMatch = /node #(\d+)/.exec(prompt);
  const nodeId = nodeMatch ? Number(nodeMatch[1]) : null;
  if (nodeId != null) dispatchedNodeIds.add(nodeId);

  if (prompt.includes('FINISH-LINE AUDIT')) {
    const treeMatch = /\(tree (tree-[0-9a-f-]+)\)/.exec(prompt);
    const treeId = treeMatch ? treeMatch[1] : null;
    const scenario = scenarioForTree.get(treeId);

    if (scenario === 'A') {
      const tree = hopperEngine.getHopperTree(treeId);
      await httpPost(`/api/v1/hopper-trees/${treeId}/handoff`, {
        handoff: buildSimHandoff(treeId, tree?.topic ?? 'sim-scenario-A'),
        force: false,
      });
      await httpFinish(nodeId, {
        outcome: 'done',
        result: JSON.stringify({
          finishline_verdict: 'FULL',
          summary: 'Sim scenario A: the trivial node satisfied the original ask.',
          gaps: [],
          continuation_tree_id: null,
          continuation_nodes: [],
        }),
      });
    } else if (scenario === 'B') {
      const cont = await httpPost('/api/v1/hopper-trees', {
        topic: `continuation: sim-scenario-B - close the intentional gap`,
        origin_thread: 'cockpit:finishline-sim-origin',
        original_ask: 'Sim scenario B original ask: build the trivial thing AND close the intentional gap.',
        continuation_of: treeId,
        deferred_scope: `Continuation auto-planted by finish-line audit for tree ${treeId}. Shortfall: sim gap was never closed by the parent tree.`,
        nodes: [
          { title: 'Close the sim gap', spec: 'Trivial continuation node for sim scenario B.', depends_on_indexes: [], adapter: 'claude', model: 'claude-sonnet-5' },
        ],
      });
      const newTreeId = cont.tree.id;
      // The continuation tree carries the same original_ask, so once ITS leaf
      // settles the finish-line gate fires again on it too (by design — see
      // FINISHLINE-DESIGN.md's "Continuation tree inherits the same
      // original_ask"). Register it so the fake worker closes that second
      // audit cleanly (FULL) instead of hitting the untracked-tree guard.
      scenarioForTree.set(newTreeId, 'A');
      await httpPost(`/api/v1/hopper-trees/${newTreeId}/agree`, {});
      await httpFinish(nodeId, {
        outcome: 'done',
        result: JSON.stringify({
          finishline_verdict: 'SHORTFALL',
          summary: 'Sim scenario B: intentional gap found, continuation planted and agreed.',
          gaps: ['sim gap was never closed'],
          continuation_tree_id: newTreeId,
          continuation_nodes: ['Close the sim gap'],
        }),
      });
    } else if (scenario === 'C2') {
      // Lowercase verdict must be normalized and hit the SAME gate as 'FULL'
      // (it used to parse as an unreadable verdict and complete the tree with
      // no handoff at all — review #216 item c / #233 P2).
      await expectHttpError(409, 'finishline_full_missing_handoff', () =>
        httpFinish(nodeId, {
          outcome: 'done',
          result: JSON.stringify({ finishline_verdict: 'full', summary: 'Sim scenario C2: lowercase full without a handoff.' }),
        }),
      );
    } else if (scenario === 'C') {
      await expectHttpError(409, 'finishline_full_missing_handoff', () =>
        httpFinish(nodeId, {
          outcome: 'done',
          result: JSON.stringify({
            finishline_verdict: 'FULL',
            summary: 'Sim scenario C: fake audit tried to report FULL without first writing a handoff.',
            gaps: [],
            continuation_tree_id: null,
            continuation_nodes: [],
          }),
        }),
      );
    } else {
      // Depth-cap probe trees (see check D-*) never reach a real audit worker —
      // they are built and torn down purely at the HTTP-plant layer. If one
      // ever does get here, fail loudly rather than silently no-op.
      throw new Error(`fakeProcessMessage saw an audit node for unknown/untracked tree ${treeId}`);
    }
    return 'FAKE_AUDIT_WORKER_OK — no model call made.';
  }

  if (nodeId != null) {
    await httpFinish(nodeId, { outcome: 'done', result: 'Sim leaf node complete — no model call made.' });
  }
  return 'FAKE_WORKER_OK — no model call made.';
}

hopperEngine.startHopperEngine(fakeProcessMessage);
uiServer.startUiServer();

// ---------------------------------------------------------------------------
// HTTP helpers — real network calls against the scratch server, exactly like
// a real caller (a planner chat, a worker's curl finish) would make.
// ---------------------------------------------------------------------------
const { plaintext: API_KEY } = apiKeys.mintApiKey('finishline-sim', 'cockpit');

async function httpFetch(pathAndQuery, init = {}) {
  const res = await fetch(`${BASE_URL}${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${pathAndQuery}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
const httpGet = (p) => httpFetch(p);
const httpPost = (p, json) => httpFetch(p, { method: 'POST', body: JSON.stringify(json ?? {}) });
const httpFinish = (nodeId, payload) => httpFetch(`/api/v1/hopper-nodes/${nodeId}/finish`, { method: 'POST', body: JSON.stringify(payload) });

async function expectHttpError(expectedStatus, expectedCode, fn) {
  let rejected = null;
  try {
    await fn();
  } catch (err) {
    rejected = err;
  }
  assert.ok(rejected, `expected HTTP ${expectedStatus} ${expectedCode}`);
  assert.equal(rejected.status, expectedStatus);
  assert.equal(rejected.body?.error?.code, expectedCode);
  return rejected;
}

async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 150, label = 'condition' } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms${lastErr ? `; last error: ${lastErr.message}` : ''}`);
}

function notificationCount(titleLike) {
  return sqliteDb
    .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE source = 'hopper-engine' AND title LIKE ?`)
    .get(titleLike).n;
}

// Wait for the scratch HTTP server to actually accept connections before
// hitting it — app.listen()'s callback fires async relative to our import.
await waitFor(
  async () => {
    try {
      await httpGet('/api/v1/hopper-trees');
      return true;
    } catch {
      return false;
    }
  },
  { timeoutMs: 10_000, label: 'server up' },
);
console.log('[finishline-sim] scratch server is up');

// ===========================================================================
// SCENARIO H — handoff route validation. This drives the real API route against
// a scratch sqlite DB, without touching the live service or live jarvis.db.
// ===========================================================================
let handoffTree;
await checkAsync('H-1', 'plant a draft tree for handoff route validation', async () => {
  const created = await httpPost('/api/v1/hopper-trees', {
    topic: 'sim-scenario-H: handoff route validation',
    original_ask: 'Validate handoff writes.',
    nodes: [{ title: 'validation node' }],
  });
  handoffTree = created.tree;
});

await checkAsync('H-2', 'handoff route rejects empty markdown with invalid_handoff', async () => {
  await expectHttpError(400, 'invalid_handoff', () =>
    httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, { handoff: '   ' }),
  );
});

await checkAsync('H-3', 'handoff route rejects missing required section headings', async () => {
  await expectHttpError(400, 'invalid_handoff', () =>
    httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, { handoff: '# bad handoff\n\n## What was built\n\n- partial' }),
  );
});

await checkAsync('H-3a', 'handoff route rejects a Human runthrough section with no task items', async () => {
  await expectHttpError(400, 'invalid_handoff', () =>
    httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, {
      handoff: buildSimHandoff(handoffTree.id, handoffTree.topic).replace(
        '- [ ] Open the finished tree detail, expect this handoff card to be visible.\n- [ ] Try the scratch success path, expect the simulated deliverable to be marked complete.\n- [ ] Check the scratch missing-handoff failure path, expect the FULL verdict to be rejected.',
        'No checklist here.',
      ),
    }),
  );
});

await checkAsync('H-4', 'handoff route rejects absolute /home/kevin full-report paths', async () => {
  await expectHttpError(400, 'invalid_handoff', () =>
    httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, {
      handoff: buildSimHandoff(handoffTree.id, handoffTree.topic, { report: '/home/kevin/outbox/bad.md' }),
    }),
  );
});

await checkAsync('H-4a', 'handoff route rejects /home/kevin paths outside the Full report section', async () => {
  await expectHttpError(400, 'invalid_handoff', () =>
    httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, {
      handoff: buildSimHandoff(handoffTree.id, handoffTree.topic).replace(
        '- Simulated tree deliverable completed.',
        '- Updated /home/kevin/obsidian/paperclip-wiki/skills/example/SKILL.md.',
      ),
    }),
  );
});

await checkAsync('H-4b', 'handoff route rejects ~/ paths anywhere in the card', async () => {
  await expectHttpError(400, 'invalid_handoff', () =>
    httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, {
      handoff: buildSimHandoff(handoffTree.id, handoffTree.topic).replace(
        '- Simulated tree deliverable completed.',
        '- Updated ~/paperclip/scratch.md.',
      ),
    }),
  );
});

await checkAsync('H-4c', 'handoff route rejects /tmp paths anywhere in the card', async () => {
  await expectHttpError(400, 'invalid_handoff', () =>
    httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, {
      handoff: buildSimHandoff(handoffTree.id, handoffTree.topic).replace(
        '- Simulated tree deliverable completed.',
        '- Wrote /tmp/finishline-proof.md.',
      ),
    }),
  );
});

await checkAsync('H-4d', 'handoff route requires line-anchored required headings', async () => {
  await expectHttpError(400, 'invalid_handoff', () =>
    httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, {
      handoff: [
        '# fake handoff',
        '',
        '```',
        '## What was built ## Branches & how to install ## How to use it ## Next steps / deferred ## Full report',
        '```',
      ].join('\n'),
    }),
  );
});

await checkAsync('H-4e', 'handoff route ignores required headings inside fenced code blocks', async () => {
  await expectHttpError(400, 'invalid_handoff', () =>
    httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, {
      handoff: [
        '# fake handoff',
        '',
        '```md',
        '## What was built',
        '## Branches & how to install',
        '## How to use it',
        '## Human runthrough',
        '## Next steps / deferred',
        '## Full report',
        '```',
        '',
        '- [ ] This is also inside the wrong section.',
      ].join('\n'),
    }),
  );
});

await checkAsync('H-4f', 'handoff route ignores Human runthrough task items inside fenced code blocks', async () => {
  await expectHttpError(400, 'invalid_handoff', () =>
    httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, {
      handoff: buildSimHandoff(handoffTree.id, handoffTree.topic).replace(
        '- [ ] Open the finished tree detail, expect this handoff card to be visible.\n- [ ] Try the scratch success path, expect the simulated deliverable to be marked complete.\n- [ ] Check the scratch missing-handoff failure path, expect the FULL verdict to be rejected.',
        '```md\n- [ ] Fenced task examples must not count.\n```',
      ),
    }),
  );
});

await checkAsync('H-5', 'handoff route accepts a valid card and GET detail returns it', async () => {
  const handoff = buildSimHandoff(handoffTree.id, handoffTree.topic);
  const posted = await httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, { handoff });
  assert.equal(posted.tree.handoff, handoff);
  const detail = await httpGet(`/api/v1/hopper-trees/${handoffTree.id}`);
  assert.equal(detail.tree.handoff, handoff);
});

await checkAsync('H-5a', 'checklist route parses, stores, and updates server-owned check state', async () => {
  const initial = await httpGet(`/api/v1/hopper-trees/${handoffTree.id}/checklist`);
  assert.equal(initial.checklist.items.length, 3);
  assert.equal(initial.checklist.items[0].checked, false);
  const updated = await httpPost(`/api/v1/hopper-trees/${handoffTree.id}/checklist/0`, {
    checked: true,
    note: 'looks good in sim',
  });
  assert.equal(updated.checklist.items[0].checked, true);
  assert.equal(updated.checklist.items[0].note, 'looks good in sim');
  assert.ok(updated.checklist.items[0].checked_at, 'checking an item should stamp checked_at');
  const detail = await httpGet(`/api/v1/hopper-trees/${handoffTree.id}/checklist`);
  assert.equal(detail.checklist.items[0].checked, true);
});

await checkAsync('H-5b', 'checklist reparses a force-updated handoff and keeps same-text check state', async () => {
  const replacement = buildSimHandoff(handoffTree.id, handoffTree.topic).replace(
    '- [ ] Try the scratch success path, expect the simulated deliverable to be marked complete.',
    '- [ ] Try a renamed scratch success path, expect the simulated deliverable to be marked complete.',
  );
  await httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, { handoff: replacement, force: true });
  const checklist = await httpGet(`/api/v1/hopper-trees/${handoffTree.id}/checklist`);
  assert.equal(checklist.checklist.items.length, 3);
  assert.equal(checklist.checklist.items[0].checked, true, 'same text item should keep prior checked state');
  assert.equal(checklist.checklist.items[1].checked, false, 'changed text item should not inherit unrelated state');
});

await checkAsync('H-5c', 'GET checklist is read-only for tree.updated_at (card chips poll it); POST toggles do bump it', async () => {
  const before = sqliteDb.prepare('SELECT updated_at, handoff_checklist FROM hopper_trees WHERE id = ?').get(handoffTree.id);
  await new Promise((r) => setTimeout(r, 1100));
  await httpGet(`/api/v1/hopper-trees/${handoffTree.id}/checklist`);
  await httpGet(`/api/v1/hopper-trees/${handoffTree.id}/checklist`);
  const afterGet = sqliteDb.prepare('SELECT updated_at, handoff_checklist FROM hopper_trees WHERE id = ?').get(handoffTree.id);
  assert.equal(afterGet.updated_at, before.updated_at, 'GET /checklist must not bump hopper_trees.updated_at');
  assert.equal(afterGet.handoff_checklist, before.handoff_checklist, 'GET /checklist must not rewrite an unchanged checklist row');
  await httpPost(`/api/v1/hopper-trees/${handoffTree.id}/checklist/2`, { checked: true });
  const afterPost = sqliteDb.prepare('SELECT updated_at FROM hopper_trees WHERE id = ?').get(handoffTree.id);
  assert.notEqual(afterPost.updated_at, before.updated_at, 'a real toggle is tree activity and should bump updated_at');
});

await checkAsync('H-6', 'tree list exposes has_handoff without the full markdown card', async () => {
  const list = await httpGet('/api/v1/hopper-trees');
  const listed = list.trees.find((t) => t.id === handoffTree.id);
  assert.ok(listed, 'expected the handoff test tree in the list payload');
  assert.equal(listed.has_handoff, true);
  assert.equal(Object.prototype.hasOwnProperty.call(listed, 'handoff'), false);
});

await checkAsync('H-7', 'handoff route rejects overwrites unless force=true', async () => {
  await expectHttpError(409, 'handoff_exists', () =>
    httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, { handoff: buildSimHandoff(handoffTree.id, handoffTree.topic) }),
  );
  const replacement = buildSimHandoff(handoffTree.id, handoffTree.topic, { report: 'outbox/finishline-sim-replaced.md' });
  const replaced = await httpPost(`/api/v1/hopper-trees/${handoffTree.id}/handoff`, { handoff: replacement, force: true });
  assert.equal(replaced.tree.handoff, replacement);
});

// ===========================================================================
// SCENARIO A — original_ask set, one trivial node, audit verdict FULL.
// ===========================================================================
let treeA;
await checkAsync('A-1', 'plant tree A via POST /hopper-trees with original_ask', async () => {
  const created = await httpPost('/api/v1/hopper-trees', {
    topic: 'sim-scenario-A: trivial task',
    origin_thread: 'cockpit:finishline-sim-origin-A',
    original_ask: 'Sim scenario A original ask: do the one trivial thing.',
    nodes: [{ title: 'Do the trivial thing', spec: 'Trivial sim node for scenario A.' }],
  });
  assert.equal(created.tree.status, 'draft');
  assert.equal(created.tree.original_ask, 'Sim scenario A original ask: do the one trivial thing.');
  treeA = created.tree;
  scenarioForTree.set(treeA.id, 'A');
});

await checkAsync('A-2', 'agree tree A → dispatch claims + fake worker finishes the leaf', async () => {
  await httpPost(`/api/v1/hopper-trees/${treeA.id}/agree`, {});
  const got = await waitFor(
    async () => {
      const t = await httpGet(`/api/v1/hopper-trees/${treeA.id}`);
      const leaf = t.nodes.find((n) => !n.title.startsWith('FINISH-LINE AUDIT'));
      return leaf?.status === 'done' ? t : null;
    },
    { label: 'A leaf done' },
  );
  assert.equal(got.nodes.filter((n) => n.title !== 'FINISH-LINE AUDIT').length, 1);
});

await checkAsync('A-3', 'server auto-appends a FINISH-LINE AUDIT node once the leaf settles', async () => {
  const t = await waitFor(
    async () => {
      const t = await httpGet(`/api/v1/hopper-trees/${treeA.id}`);
      return t.nodes.some((n) => n.title === 'FINISH-LINE AUDIT') ? t : null;
    },
    { label: 'A audit node appended' },
  );
  const audit = t.nodes.find((n) => n.title === 'FINISH-LINE AUDIT');
  assert.ok(audit, 'audit node should exist');
  assert.equal(audit.parent_id, null, 'audit node must be flat (no parent_id) — leaf-only dispatcher rule');
});

await checkAsync('A-4', 'FULL verdict finishes the audit node and completes the tree', async () => {
  const t = await waitFor(
    async () => {
      const t = await httpGet(`/api/v1/hopper-trees/${treeA.id}`);
      return t.tree.status === 'done' ? t : null;
    },
    { label: 'A tree done' },
  );
  const audit = t.nodes.find((n) => n.title === 'FINISH-LINE AUDIT');
  assert.equal(audit.status, 'done');
  const verdict = JSON.parse(audit.result);
  assert.equal(verdict.finishline_verdict, 'FULL');
  assert.ok(t.tree.handoff?.includes('## What was built'), 'FULL verdict should persist a handoff before finishing');
});

check('A-5', 'a success notification with the FULL verdict exists', () => {
  assert.ok(notificationCount('🏁 finish-line: FULL%') >= 1, 'expected a "🏁 finish-line: FULL" notification row');
});

// ===========================================================================
// SCENARIO C — server-owned gate rejects FULL audit reports when no handoff was
// persisted first. Mirrors review probe P1.
// ===========================================================================
let treeC;
await checkAsync('C-1', 'plant tree C via POST /hopper-trees with original_ask', async () => {
  const created = await httpPost('/api/v1/hopper-trees', {
    topic: 'sim-scenario-C: FULL without handoff must block',
    origin_thread: 'cockpit:finishline-sim-origin-C',
    original_ask: 'Sim scenario C original ask: do the one trivial thing, then require a persisted handoff before FULL.',
    nodes: [{ title: 'Do the trivial thing (scenario C)', spec: 'Trivial sim node for scenario C.' }],
  });
  treeC = created.tree;
  scenarioForTree.set(treeC.id, 'C');
});

await checkAsync('C-2', 'FULL verdict without a handoff is rejected, audit node blocks, and tree stays active', async () => {
  await httpPost(`/api/v1/hopper-trees/${treeC.id}/agree`, {});
  const t = await waitFor(
    async () => {
      const t = await httpGet(`/api/v1/hopper-trees/${treeC.id}`);
      const audit = t.nodes.find((n) => n.title === 'FINISH-LINE AUDIT');
      return audit?.status === 'blocked' ? t : null;
    },
    { label: 'C audit blocked' },
  );
  const audit = t.nodes.find((n) => n.title === 'FINISH-LINE AUDIT');
  assert.equal(t.tree.status, 'active');
  assert.equal(t.tree.handoff, null);
  assert.equal(audit.result, 'finishline FULL rejected: missing valid handoff/Human runthrough checklist');
});

let treeC2;
await checkAsync('C-3', 'lowercase "full" verdict without a handoff is normalized and rejected the same way (no silent tree completion)', async () => {
  const created = await httpPost('/api/v1/hopper-trees', {
    topic: 'sim-scenario-C2: lowercase full verdict',
    origin_thread: 'cockpit:finishline-sim-origin-C2',
    original_ask: 'Sim scenario C2 original ask.',
    nodes: [{ title: 'Do the trivial thing (scenario C2)', spec: 'Trivial sim node for scenario C2.' }],
  });
  treeC2 = created.tree;
  scenarioForTree.set(treeC2.id, 'C2');
  await httpPost(`/api/v1/hopper-trees/${treeC2.id}/agree`, {});
  const t = await waitFor(
    async () => {
      const t = await httpGet(`/api/v1/hopper-trees/${treeC2.id}`);
      const audit = t.nodes.find((n) => n.title === 'FINISH-LINE AUDIT');
      return audit?.status === 'blocked' ? t : null;
    },
    { label: 'C2 audit blocked' },
  );
  assert.equal(t.tree.status, 'active');
  assert.equal(t.tree.handoff, null);
});

// ===========================================================================
// SCENARIO B — SHORTFALL verdict plants + agrees a continuation tree.
// ===========================================================================
let treeB;
await checkAsync('B-1', 'plant tree B via POST /hopper-trees with original_ask', async () => {
  const created = await httpPost('/api/v1/hopper-trees', {
    topic: 'sim-scenario-B: trivial task with an intentional gap',
    origin_thread: 'cockpit:finishline-sim-origin-B',
    original_ask: 'Sim scenario B original ask: build the trivial thing AND close the intentional gap.',
    nodes: [{ title: 'Do the trivial thing (scenario B)', spec: 'Trivial sim node for scenario B; deliberately leaves a gap.' }],
  });
  treeB = created.tree;
  scenarioForTree.set(treeB.id, 'B');
});

await checkAsync('B-2', 'agree tree B → leaf finishes → audit appended → SHORTFALL plants + agrees a continuation', async () => {
  await httpPost(`/api/v1/hopper-trees/${treeB.id}/agree`, {});
  const t = await waitFor(
    async () => {
      const t = await httpGet(`/api/v1/hopper-trees/${treeB.id}`);
      return t.tree.status === 'done' ? t : null;
    },
    { timeoutMs: 20_000, label: 'B tree done' },
  );
  const audit = t.nodes.find((n) => n.title === 'FINISH-LINE AUDIT');
  assert.equal(audit.status, 'done');
  const verdict = JSON.parse(audit.result);
  assert.equal(verdict.finishline_verdict, 'SHORTFALL');
  assert.ok(verdict.continuation_tree_id, 'SHORTFALL verdict should record the continuation tree id');
  treeB.continuationTreeId = verdict.continuation_tree_id;
});

await checkAsync('B-3', 'continuation tree exists, carries original_ask, and records continuation_of as the depth marker', async () => {
  const cont = await httpGet(`/api/v1/hopper-trees/${treeB.continuationTreeId}`);
  assert.equal(cont.tree.continuation_of, treeB.id, 'continuation_of should link back to the parent tree (the depth marker)');
  assert.equal(cont.tree.original_ask, 'Sim scenario B original ask: build the trivial thing AND close the intentional gap.', 'original_ask must carry over unchanged');
  assert.ok(['active', 'done'].includes(cont.tree.status), 'continuation was agreed by the audit worker, so it should be active or (if its own lifecycle already ran) done');
  const contLeaves = cont.nodes.filter((n) => n.title !== 'FINISH-LINE AUDIT');
  assert.equal(contLeaves.length, 1);
  assert.equal(contLeaves[0].title, 'Close the sim gap');
});

check('B-4', 'a warning notification with the SHORTFALL verdict + continuation id exists', () => {
  assert.ok(notificationCount('⚠️ finish-line: SHORTFALL%') >= 1, 'expected a "⚠️ finish-line: SHORTFALL" notification row');
});

// ===========================================================================
// SCENARIO D (bonus, cheap) — depth cap is enforced at plant time, not just
// described in the audit prompt. Chains continuation_of links directly via
// the same public API scenario B used, without needing another live audit.
// ===========================================================================
await checkAsync('D-1', 'depth 1 and depth 2 continuations plant fine; depth 3 is rejected with 409 finishline_depth_cap', async () => {
  const root = await httpPost('/api/v1/hopper-trees', {
    topic: 'sim-scenario-D: depth cap probe root',
    original_ask: 'Depth cap probe.',
    nodes: [{ title: 'root node' }],
  });
  const depth1 = await httpPost('/api/v1/hopper-trees', {
    topic: 'continuation: depth cap probe - depth 1',
    original_ask: 'Depth cap probe.',
    continuation_of: root.tree.id,
    nodes: [{ title: 'depth1 node' }],
  });
  assert.equal(depth1.tree.continuation_of, root.tree.id);
  const depth2 = await httpPost('/api/v1/hopper-trees', {
    topic: 'continuation: depth cap probe - depth 2',
    original_ask: 'Depth cap probe.',
    continuation_of: depth1.tree.id,
    nodes: [{ title: 'depth2 node' }],
  });
  assert.equal(depth2.tree.continuation_of, depth1.tree.id);
  let rejected = null;
  try {
    await httpPost('/api/v1/hopper-trees', {
      topic: 'continuation: depth cap probe - depth 3',
      original_ask: 'Depth cap probe.',
      continuation_of: depth2.tree.id,
      nodes: [{ title: 'depth3 node' }],
    });
  } catch (err) {
    rejected = err;
  }
  assert.ok(rejected, 'depth-3 continuation should have been rejected');
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body?.error?.code, 'finishline_depth_cap');
});

// ===========================================================================
// SCENARIO E (review #184) — one open continuation per parent. A retried audit
// worker (lease expired after it planted) must NOT plant a sibling duplicate;
// the API answers 409 finishline_continuation_exists with the existing id.
// Also: a continuation's audit spec must carry the ancestor chain's digest so
// it judges cumulative delivery, not this tree alone (the spurious-cascade bug).
// ===========================================================================
await checkAsync('E-1', 'a second open continuation of the same parent is rejected with 409 finishline_continuation_exists (existing id returned)', async () => {
  const root = await httpPost('/api/v1/hopper-trees', {
    topic: 'sim-scenario-E: dedupe probe root',
    original_ask: 'Dedupe probe.',
    nodes: [{ title: 'root node' }],
  });
  const first = await httpPost('/api/v1/hopper-trees', {
    topic: 'continuation: dedupe probe - first',
    original_ask: 'Dedupe probe.',
    continuation_of: root.tree.id,
    nodes: [{ title: 'first cont node' }],
  });
  let rejected = null;
  try {
    await httpPost('/api/v1/hopper-trees', {
      topic: 'continuation: dedupe probe - duplicate',
      original_ask: 'Dedupe probe.',
      continuation_of: root.tree.id,
      nodes: [{ title: 'dup cont node' }],
    });
  } catch (err) {
    rejected = err;
  }
  assert.ok(rejected, 'duplicate continuation should have been rejected');
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body?.error?.code, 'finishline_continuation_exists');
  assert.equal(rejected.body?.error?.existing_tree_id, first.tree.id);
});

await checkAsync('E-2', "a continuation tree's FINISH-LINE AUDIT spec includes the ancestor tree's node digest", async () => {
  const contTrees = hopperEngine.listHopperTrees().filter((t) => t.continuation_of && t.status !== 'draft');
  assert.ok(contTrees.length >= 1, 'expected at least one agreed continuation tree from scenario B');
  const audits = contTrees.flatMap((t) => hopperEngine.listTreeNodes(t.id).filter((n) => n.is_finishline === 1));
  assert.ok(audits.length >= 1, 'expected the scenario-B continuation to have received its own audit node');
  const withAncestors = audits.filter((a) => /Ancestor trees in this continuation chain/.test(a.spec ?? ''));
  assert.equal(withAncestors.length, audits.length, 'every continuation audit spec must carry the ancestor chain block');
  for (const a of withAncestors) {
    const parentId = hopperEngine.getHopperTree(a.tree_id)?.continuation_of;
    assert.ok(parentId && a.spec.includes(`Tree ${parentId}`), `audit spec for ${a.tree_id} must name its parent tree ${parentId}`);
  }
});

// ===========================================================================
// Report
// ===========================================================================
console.log('\n=== FINISH-LINE SIM RESULTS ===');
let failCount = 0;
for (const r of results) {
  if (r.pass) {
    console.log(`  [PASS] ${r.id}: ${r.description}`);
  } else {
    failCount++;
    console.log(`  [FAIL] ${r.id}: ${r.description}\n         ${r.error}`);
  }
}
console.log(`\n${results.length - failCount}/${results.length} checks passed.`);

if (failCount > 0) {
  process.exitCode = 1;
}

// Best-effort clean shutdown of the scratch HTTP listener so the process can
// exit instead of hanging on an open socket.
process.exit(process.exitCode ?? 0);
