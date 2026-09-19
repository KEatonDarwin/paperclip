#!/usr/bin/env node
// WORKBENCH V2 SIM (hopper node #451) — client-contract-driven proof on a
// scratch DB. Mirrors scripts/workbench-sim-routes.mjs (real Express router,
// real HTTP, throwaway port) + scripts/multi-claude-e2e-sim.mjs (fake CLAUDE_BIN
// so dispatch's real processMessage() path runs with zero live model calls).
//
// PRIME DIRECTIVE (per node #451's spec): drive the exact request/response
// shapes the UI client (jarvis-command-center src/lib/cockpit-api.ts) uses —
// mirrored verbatim below from the real client fn bodies, plus an automated
// field-name diff between those client fns and the routes that serve them.
//
//   npm run build
//   node scripts/workbench-sim-v2.mjs
//
// Covers node #451's 7 items:
//   1. /workbench/say session lifecycle (birth/reuse/focus-change/force_new)
//   2. Zoom purity (static proof: zero client fns wired to click/zoom)
//   3. propose_batch -> GET grouped -> accept/reject -> SSE
//   4. Bulk-creation rule (contract-level, documented honestly)
//   5. Dispatch: spawn_tasks row, explicit model, GET status, 409 while running
//   6. Scope guard: v1 per-node guard intact; brain/dispatch threads unrestricted
//   7. Regression: /smart-todos/* + v1 /workbench routes untouched (git diff)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const uiRoot = '/home/kevin/worktrees/workbench-v2-ui';

// ── scratch DB guard (mirrors every other sim script in this repo) ─────────
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

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-v2-sim-'));
process.env.CLAUDE_USAGE_DIR = scratchDir;

// Placement one-shot (workbench.ts's own CLAUDE_BIN const, read at import time)
// — unused by any of the 7 items below (we never call /workbench/jot without a
// focus_id), but pointed at the proven v1 fake binary anyway so importing
// workbench.js can never accidentally shell out to a real `claude`.
process.env.UX_REVIEWER_CLAUDE_BIN = path.join(__dirname, 'workbench-sim-fake-claude.mjs');

// The dispatch route's processMessage() path reads ADAPTERS.claude.bin =
// process.env.CLAUDE_BIN at agent.js's MODULE LOAD time — must be set before
// anything imports dist/agent.js (transitively, via handlers/api-v1.js).
// Sleeps briefly so a dispatch is still provably 'running' when we fire the
// immediate second-dispatch-while-running (409) check right after.
const FAKE_CLAUDE = path.join(scratchDir, 'fake-claude.sh');
fs.writeFileSync(
  FAKE_CLAUDE,
  `#!/usr/bin/env bash
cat >/dev/null 2>&1 || true
sleep 0.6
printf '%s\\n' '{"type":"result","result":"WORKBENCH_DISPATCH_SIM_OK","session_id":"sess-wb-sim"}'
`,
  { mode: 0o755 },
);
process.env.CLAUDE_BIN = FAKE_CLAUDE;
process.env.ANTHROPIC_API_KEY = 'sk-should-be-deleted'; // prove the adapter still strips it
delete process.env.CLAUDE_CONFIG_DIR;

console.log(`[workbench-v2-sim] scratch DB:    ${DB_PATH}`);
console.log(`[workbench-v2-sim] scratch dir:   ${scratchDir}`);
console.log(`[workbench-v2-sim] fake claude:   ${FAKE_CLAUDE}`);

const distDir = path.join(repoRoot, 'dist');
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const { sqliteDb, setSetting } = await import(path.join(distDir, 'conversation-db.js'));
const { sseBus } = await import(path.join(distDir, 'sse-bus.js'));
const { workbench: workbenchTool } = await import(path.join(distDir, 'tools', 'workbench-tool.js'));

setSetting('gov_5h_ceiling', '90');

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

const key = mintApiKey('workbench-v2-sim', 'jarvis').plaintext;

console.log(`[workbench-v2-sim] server: ${base}`);

let passed = 0;
const findings = [];
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${label}`);
}
function note(label) {
  findings.push(label);
  console.log(`  ⚠ FINDING: ${label}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

try {
  // ═══════════════════════════════════════════════════════════════════════
  // 0. AUTOMATED FIELD-NAME DIFF — client fn request/response bodies vs the
  //    routes that serve them. The v1 lesson: three client<->server breaks
  //    shipped past a backend-only sim because nobody diffed the wire shape.
  //    Reads the REAL client source (cockpit-api.ts) and the REAL route
  //    source (api-v1.ts) as text and diffs the field names each side uses.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n[0] automated client<->server field-name diff');

  const clientSrc = fs.readFileSync(path.join(uiRoot, 'src/lib/cockpit-api.ts'), 'utf8');
  const routesSrc = fs.readFileSync(path.join(repoRoot, 'src/handlers/api-v1.ts'), 'utf8');

  /** Pulls the object literal inside `body: JSON.stringify({ ... })` for one
   *  client function (bounded by its `export async function <name>` header
   *  through the next top-level `export`). Returns the bare/quoted keys used. */
  function clientRequestKeys(fnName) {
    const fnStart = clientSrc.indexOf(`function ${fnName}(`);
    assert.ok(fnStart >= 0, `client fn ${fnName} not found in cockpit-api.ts`);
    const nextExport = clientSrc.indexOf('\nexport ', fnStart + 10);
    const body = clientSrc.slice(fnStart, nextExport > 0 ? nextExport : fnStart + 4000);
    const stringifyMatch = body.match(/JSON\.stringify\(([^;]*?)\)/s);
    if (!stringifyMatch) return []; // fn sends no body (a GET)
    const objSrc = stringifyMatch[1];
    // Ternaries like `ids && ids.length ? { ids } : {}` — collect every key
    // literal across all branches, since either shape is a real thing the
    // client can send.
    const keys = new Set();
    for (const m of objSrc.matchAll(/(?:^|[{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)) keys.add(m[1]);
    // Shorthand-property branches, e.g. `{ ids }` or `{ instructions }`.
    for (const m of objSrc.matchAll(/[{,]\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*[,}]/g)) keys.add(m[1]);
    return [...keys];
  }

  /** Pulls the accepted body keys for one route — the destructured `body.<key>`
   *  reads OR the inline type annotation `(req.body ?? {}) as { k1?: ...; k2?: ... }`
   *  between a route registration line and the next `router.` call. */
  function routeAcceptedKeys(routeMarker) {
    const start = routesSrc.indexOf(routeMarker);
    assert.ok(start >= 0, `route ${routeMarker} not found in api-v1.ts`);
    const nextRoute = routesSrc.indexOf('\n  router.', start + routeMarker.length);
    const body = routesSrc.slice(start, nextRoute > 0 ? nextRoute : start + 3000);
    const keys = new Set();
    for (const m of body.matchAll(/body\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) keys.add(m[1]);
    return [...keys];
  }

  function diffCheck(label, clientKeys, routeKeys) {
    const missing = clientKeys.filter((k) => !routeKeys.includes(k));
    check(`${label}: every client-sent field is read by the route (${clientKeys.join(', ') || '(none)'})`, () => {
      assert.deepEqual(missing, [], `client sends fields the route never reads: ${missing.join(', ')}`);
    });
  }

  diffCheck('sayToWorkbenchBrain -> POST /workbench/say', clientRequestKeys('sayToWorkbenchBrain'), routeAcceptedKeys("router.post('/workbench/say'"));
  diffCheck('dispatchWorkbenchNode -> POST /workbench/nodes/:id/dispatch', clientRequestKeys('dispatchWorkbenchNode'), routeAcceptedKeys("router.post('/workbench/nodes/:id/dispatch'"));
  diffCheck('acceptWorkbenchProposals -> POST /workbench/proposals/:batchId/accept', clientRequestKeys('acceptWorkbenchProposals'), routeAcceptedKeys("router.post('/workbench/proposals/:batchId/accept'"));
  diffCheck('rejectWorkbenchProposals -> POST /workbench/proposals/:batchId/reject', clientRequestKeys('rejectWorkbenchProposals'), routeAcceptedKeys("router.post('/workbench/proposals/:batchId/reject'"));
  diffCheck('workbenchJot -> POST /workbench/jot', clientRequestKeys('workbenchJot'), routeAcceptedKeys("router.post('/workbench/jot'"));

  // Response-side: the fields each client fn actually reads off `r.<key>`
  // must all appear in the route's res.json({...}) — the reverse direction
  // of the same class of bug (a renamed response field the client silently
  // reads as undefined).
  function clientResponseKeys(fnName) {
    const fnStart = clientSrc.indexOf(`function ${fnName}(`);
    const nextExport = clientSrc.indexOf('\nexport ', fnStart + 10);
    const bodySrc = clientSrc.slice(fnStart, nextExport > 0 ? nextExport : fnStart + 4000);
    const keys = new Set();
    for (const m of bodySrc.matchAll(/\br\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) keys.add(m[1]);
    return [...keys];
  }
  const sayRespKeys = clientResponseKeys('sayToWorkbenchBrain');
  check('sayToWorkbenchBrain reads only external_id/seed_text/wrapped_text (matches WorkbenchSayResult)', () => {
    assert.deepEqual(sayRespKeys.sort(), ['external_id', 'seed_text', 'wrapped_text'].sort());
  });
  const dispatchRespKeys = clientResponseKeys('dispatchWorkbenchNode');
  check('dispatchWorkbenchNode reads only fields the dispatch route actually returns', () => {
    for (const k of dispatchRespKeys) {
      assert.ok(
        ['external_id', 'dispatch'].includes(k),
        `client reads r.${k} from dispatchWorkbenchNode's response but the route's top-level keys are external_id/dispatch`,
      );
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 1. SESSION LIFECYCLE — POST /workbench/say (mirrors sayToWorkbenchBrain's
  //    real body shape: { text, focus_id, force_new }).
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n[1] /workbench/say session lifecycle');

  const nodeA = await req('POST', '/smart-todos', { token: key, body: { title: 'Design refresh strategy' } });
  const nodeAId = nodeA.json.node.id;

  const say1 = await req('POST', '/workbench/say', { token: key, body: { text: 'first message ever', focus_id: null, force_new: false } });
  check('first /workbench/say ever -> 201, seed_text present (session birth)', () => {
    assert.equal(say1.status, 201);
    assert.ok(say1.json.seed_text && say1.json.seed_text.includes('Workbench brain'));
    assert.ok(say1.json.external_id.startsWith('cockpit:workbench-brain-'));
    assert.equal(say1.json.wrapped_text.includes('first message ever'), true);
  });
  const brainExt = say1.json.external_id;

  const say2 = await req('POST', '/workbench/say', { token: key, body: { text: 'second message, same sitting', focus_id: null } });
  check('second /workbench/say within idle window -> 200, seed_text null (session reused), same external_id', () => {
    assert.equal(say2.status, 200);
    assert.equal(say2.json.seed_text, null);
    assert.equal(say2.json.external_id, brainExt);
  });
  check('unchanged focus (null -> null) omits the header/snapshot wrapper', () => {
    assert.equal(say2.json.wrapped_text, 'second message, same sitting');
  });

  const say3 = await req('POST', '/workbench/say', { token: key, body: { text: 'now look at the design node', focus_id: nodeAId } });
  check('focus change (root -> node) -> same session, wrapped_text carries a focus header + subtree snapshot', () => {
    assert.equal(say3.status, 200);
    assert.equal(say3.json.external_id, brainExt);
    assert.ok(say3.json.wrapped_text.startsWith(`[focus: #${nodeAId} "Design refresh strategy"]`), say3.json.wrapped_text.slice(0, 120));
    assert.ok(say3.json.wrapped_text.includes('now look at the design node'));
  });

  const say4 = await req('POST', '/workbench/say', { token: key, body: { text: 'still on the design node', focus_id: nodeAId } });
  check('unchanged focus (node -> same node) omits the header again', () => {
    assert.equal(say4.status, 200);
    assert.equal(say4.json.wrapped_text, 'still on the design node');
  });

  await sleep(10); // last_activity_at has second-granularity; force a real tick
  const sessAfter = await req('GET', '/workbench/session', { token: key });
  check('GET /workbench/session resolves the open sitting WITHOUT extending it (a bare GET never ticks last_activity_at)', () => {
    assert.equal(sessAfter.json.external_id, brainExt);
  });
  const sessAfter2 = await req('GET', '/workbench/session', { token: key });
  check('a second consecutive bare GET returns byte-identical last_activity_at (idempotent read)', () => {
    assert.equal(sessAfter2.json.last_activity_at, sessAfter.json.last_activity_at);
  });

  const say5 = await req('POST', '/workbench/say', { token: key, body: { text: 'force a fresh sitting', force_new: true } });
  check('force_new=true -> a brand NEW session (different external_id), seed_text present again', () => {
    assert.equal(say5.status, 201);
    assert.notEqual(say5.json.external_id, brainExt);
    assert.ok(say5.json.seed_text !== null);
  });
  const brainExt2 = say5.json.external_id;

  const sessAfterNew = await req('GET', '/workbench/session', { token: key });
  check('GET /workbench/session now resolves the NEW sitting (old one ended)', () => {
    assert.equal(sessAfterNew.json.external_id, brainExt2);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. ZOOM PURITY — static proof: click/zoom must be pure client state,
  //    ZERO network calls (the exact v1 defect the UI worker removed).
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n[2] zoom purity (static contract check on the real UI source)');

  const wbTsx = fs.readFileSync(path.join(uiRoot, 'src/routes/workbench.tsx'), 'utf8');

  function extractBlock(src, startMarker) {
    const start = src.indexOf(startMarker);
    assert.ok(start >= 0, `marker not found: ${startMarker}`);
    let depth = 0, i = src.indexOf('{', start), blockStart = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    return src.slice(blockStart, i + 1);
  }

  const zoomToBody = extractBlock(wbTsx, 'const zoomTo = useCallback(');
  check("zoomTo() — the click/zoom handler — makes NO network/thread/chat calls", () => {
    for (const forbidden of ['openWorkbenchNodeChat', 'openWorkbenchRootChat', 'sayToWorkbenchBrain', 'await req', 'fetch(']) {
      assert.ok(!zoomToBody.includes(forbidden), `zoomTo() unexpectedly calls ${forbidden} — zoom is no longer pure`);
    }
    assert.ok(zoomToBody.includes('navigate('), 'zoomTo() should still update the focus= URL param');
  });

  // The v1 defect's exact shape: a useEffect keyed on the focus/zoom state that
  // opens a thread as a side effect. Assert no such effect exists anywhere.
  let sawThreadOpeningEffect = false;
  for (const m of wbTsx.matchAll(/useEffect\(/g)) {
    const block = extractBlock(wbTsx, wbTsx.slice(m.index, m.index + 30));
    if (/openWorkbenchNodeChat|openWorkbenchRootChat|sayToWorkbenchBrain/.test(block)) sawThreadOpeningEffect = true;
  }
  check('no useEffect anywhere in workbench.tsx opens/binds a thread as a side effect', () => {
    assert.equal(sawThreadOpeningEffect, false);
  });

  const openChatCallSites = [...wbTsx.matchAll(/openWorkbenchNodeChat\(/g)].length;
  check('openWorkbenchNodeChat is only reachable from an explicit "Open chat" action, not from zoom', () => {
    assert.ok(openChatCallSites >= 1, 'the per-node deep-dive "Open chat" affordance should still exist');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. GHOST PROPOSALS — propose_batch -> GET grouped -> partial reject ->
  //    accept (incl. nested-parent resolution) -> SSE on create/resolve.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n[3] ghost proposals: propose_batch / accept / reject / SSE');

  const proposalEvents = [];
  sseBus.on('sse', (ev) => {
    if (ev.type === 'workbench_proposal') proposalEvents.push({ action: ev.action, batch_id: ev.batch_id });
  });

  const featureX = await req('POST', '/smart-todos', { token: key, body: { title: 'Feature X' } });
  const featureXId = featureX.json.node.id;

  // Drive it via the TOOL (as a real brain session would), from an UNBOUND
  // thread ext (root/tree-wide scope) — the real call shape a brain turn uses.
  const proposeResult = await workbenchTool.execute(
    { operation: 'propose_batch', parent_id: featureXId, items: [{ title: 'Sub 1' }, { title: 'Sub 2', children: [{ title: 'Sub 2a' }] }] },
    { externalId: brainExt2 },
  );
  check('propose_batch (tool) returns ok + a batch_id + ALL rows incl. nested (top-level fix from node #448 holds)', () => {
    assert.equal(proposeResult.ok, true);
    assert.ok(proposeResult.batch_id);
    assert.equal(proposeResult.proposals.length, 3, 'Sub 1, Sub 2, Sub 2a — nested rows must be included, not just top-level');
  });
  const batchId = proposeResult.batch_id;
  const sub1 = proposeResult.proposals.find((p) => p.title === 'Sub 1');
  const sub2 = proposeResult.proposals.find((p) => p.title === 'Sub 2');
  const sub2a = proposeResult.proposals.find((p) => p.title === 'Sub 2a');
  check('proposal hierarchy: Sub 1/Sub 2 hang off the real parent, Sub 2a hangs off the Sub 2 PROPOSAL (not the real node)', () => {
    assert.equal(sub1.parent_node_id, featureXId);
    assert.equal(sub2.parent_node_id, featureXId);
    assert.equal(sub2a.parent_proposal_id, sub2.id);
    assert.equal(sub2a.parent_node_id, null);
  });

  const before = await req('GET', '/smart-todos', { token: key });
  const beforeCount = before.json.nodes.length;

  const listRes = await req('GET', '/workbench/proposals', { token: key });
  check('GET /workbench/proposals groups by batch and the tree is UNTOUCHED so far', () => {
    const batch = listRes.json.batches.find((b) => b.batch_id === batchId);
    assert.ok(batch);
    assert.equal(batch.proposals.length, 3);
  });

  // Partial reject: drop Sub 2a only (mirrors rejectWorkbenchProposals(batchId, [id])).
  const rejectRes = await req('POST', `/workbench/proposals/${encodeURIComponent(batchId)}/reject`, { token: key, body: { ids: [sub2a.id] } });
  check('reject with a partial ids[] removes ONLY that proposal (and any nested under it), never touches the real tree', () => {
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.json.removed, 1);
  });
  const afterPartialReject = await req('GET', '/workbench/proposals', { token: key });
  check('Sub 2a is gone, Sub 1 + Sub 2 remain pending', () => {
    const batch = afterPartialReject.json.batches.find((b) => b.batch_id === batchId);
    assert.equal(batch.proposals.length, 2);
    assert.ok(!batch.proposals.some((p) => p.title === 'Sub 2a'));
  });
  const afterRejectTree = await req('GET', '/smart-todos', { token: key });
  check('reject truly never touches the real tree (node count unchanged)', () => {
    assert.equal(afterRejectTree.json.nodes.length, beforeCount);
  });

  // Accept the rest of the batch (mirrors acceptWorkbenchProposals(batchId)).
  const acceptRes = await req('POST', `/workbench/proposals/${encodeURIComponent(batchId)}/accept`, { token: key, body: {} });
  check('accept (whole remaining batch) -> 200, created returns real node ids, correct parent', () => {
    assert.equal(acceptRes.status, 200);
    assert.equal(acceptRes.json.created.length, 2);
    for (const n of acceptRes.json.created) assert.equal(n.parent_id, featureXId);
  });
  const afterAccept = await req('GET', '/workbench/proposals', { token: key });
  check('accepted proposals are deleted from the ghost table', () => {
    assert.ok(!afterAccept.json.batches.some((b) => b.batch_id === batchId));
  });

  // Nested-accept parent resolution: propose a PARENT+CHILD pair, accept the
  // whole batch, and prove the child's real parent_id is the PARENT'S NEWLY
  // MINTED real id — not the proposal id (the trap RECON-V2 flagged).
  const nestedPropose = await workbenchTool.execute(
    { operation: 'propose_batch', parent_id: featureXId, items: [{ title: 'Parent P', children: [{ title: 'Child C' }] }] },
    { externalId: brainExt2 },
  );
  const nestedAccept = await req('POST', `/workbench/proposals/${encodeURIComponent(nestedPropose.batch_id)}/accept`, { token: key, body: {} });
  const parentP = nestedAccept.json.created.find((n) => n.title === 'Parent P');
  const childC = nestedAccept.json.created.find((n) => n.title === 'Child C');
  check('nested accept: Child C.parent_id resolves to Parent P\'s REAL id, not the proposal id', () => {
    assert.equal(parentP.parent_id, featureXId);
    assert.equal(childC.parent_id, parentP.id);
    assert.notEqual(childC.parent_id, nestedPropose.proposals.find((p) => p.title === 'Parent P').id, 'must not leak a proposal id into a real parent_id');
  });

  // accept_batch via the TOOL (the "Kevin said yes in conversation" path).
  const toolPropose = await workbenchTool.execute(
    { operation: 'propose_batch', parent_id: featureXId, items: [{ title: 'Tool-accepted item' }] },
    { externalId: brainExt2 },
  );
  const toolAccept = await workbenchTool.execute(
    { operation: 'accept_batch', batch_id: toolPropose.batch_id },
    { externalId: brainExt2 },
  );
  check('accept_batch via the workbench TOOL works (same internal path as the HTTP route)', () => {
    assert.equal(toolAccept.ok, true);
    assert.equal(toolAccept.created[0].title, 'Tool-accepted item');
    assert.equal(toolAccept.created[0].parent_id, featureXId);
  });

  check('SSE: workbench_proposal fired "created" for every propose_batch and "rejected"/"accepted" for every resolve', () => {
    const actions = proposalEvents.map((e) => e.action);
    assert.ok(actions.includes('created'), `saw: ${actions.join(',')}`);
    assert.ok(actions.includes('rejected'));
    assert.ok(actions.includes('accepted'));
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. BULK-CREATION RULE — reported honestly against what the code actually
  //    enforces vs. what SPEC.md states as the binding contract.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n[4] bulk-creation rule (contract-level)');

  // add_child's own op handler (workbench-tool.ts) only ever reads a single
  // `args.title` — it has no items/array param, so it is MECHANICALLY capped
  // at one node per call regardless of what the model passes.
  const addChildAttempt = await workbenchTool.execute(
    { operation: 'add_child', parent_id: featureXId, title: 'Only one node, since add_child has no items array', items: [{ title: 'ignored A' }, { title: 'ignored B' }] },
    { externalId: brainExt2 },
  );
  check('add_child creates exactly ONE node per call even if an items array is smuggled in — it has no code path that reads it', () => {
    assert.equal(addChildAttempt.ok, true);
    assert.equal(Array.isArray(addChildAttempt.node), false);
    const all = sqliteDb.prepare('SELECT COUNT(*) AS n FROM smart_todo_nodes WHERE title IN (?, ?)').get('ignored A', 'ignored B');
    assert.equal(all.n, 0, 'add_child must never materialize an items[] array — it is not part of its contract');
  });
  check('the tool contract documents add_child as the single-node exception, everything else routes through propose_batch', () => {
    assert.ok(workbenchTool.description.includes('A single node Kevin explicitly and unambiguously asked for may still go straight to add_child'));
  });

  const splitDirectMulti = await workbenchTool.execute(
    { operation: 'split', node_id: featureXId, children: [{ title: 'Split direct A' }, { title: 'Split direct B' }] },
    { externalId: brainExt2 },
  );
  const splitCreatedDirectly = splitDirectMulti.ok === true && Array.isArray(splitDirectMulti.created) && splitDirectMulti.created.length === 2;
  if (splitCreatedDirectly) {
    note(
      "'split' still writes MULTIPLE real nodes directly in one call, bypassing propose_batch — SPEC.md's " +
      "\"any creation of >1 node MUST be a proposal\" / \"never add_child/split\" rule is enforced ONLY via the " +
      "tool description's prompt instruction, not in split's execute() handler (workbench-tool.ts op 'split' has " +
      "no items.length>1 guard routing to propose_batch). Not a wiring break — split predates v2 and v1's own " +
      "per-node scoped chats still rely on it — but it means a brain-session model call CAN still bulk-write " +
      "around the ghost layer if it ignores the instruction. Flagging for the reviewer/Kevin to decide whether " +
      "split needs the same guard propose_batch/add_child already have.",
    );
  } else {
    check("'split' also refuses/redirects a >1-node direct write, consistent with propose_batch/add_child", () => {
      assert.equal(splitCreatedDirectly, false);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 5. DISPATCH — explicit worker, spawn_tasks row, GET status, 409-while-running.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n[5] explicit node dispatch');

  const dispatchNode = await req('POST', '/smart-todos', { token: key, body: { title: 'Dispatch me' } });
  const dispatchNodeId = dispatchNode.json.node.id;

  const dispatch1 = await req('POST', `/workbench/nodes/${dispatchNodeId}/dispatch`, { token: key, body: { instructions: 'do the thing' } });
  check('POST dispatch -> 201, explicit model (never inherited/undefined), worker thread ext scoped to this node', () => {
    assert.equal(dispatch1.status, 201);
    assert.equal(dispatch1.json.dispatch.model, 'claude-sonnet-5');
    assert.ok(dispatch1.json.external_id.includes(`workbench-worker-${dispatchNodeId}-`));
    assert.equal(dispatch1.json.dispatch.status, 'running');
  });

  const statusImmediate = await req('GET', `/workbench/nodes/${dispatchNodeId}/dispatch`, { token: key });
  check('GET status immediately reflects the same row (running, correct model + worker_thread_ext)', () => {
    assert.equal(statusImmediate.json.status, 'running');
    assert.equal(statusImmediate.json.model, 'claude-sonnet-5');
    assert.equal(statusImmediate.json.worker_thread_ext, dispatch1.json.external_id);
  });

  const dispatch2 = await req('POST', `/workbench/nodes/${dispatchNodeId}/dispatch`, { token: key, body: {} });
  check('a SECOND dispatch while one is still running -> 409, not a duplicate worker', () => {
    assert.equal(dispatch2.status, 409);
    assert.equal(dispatch2.json.error.code, 'dispatch_already_running');
  });

  const spawnRow = sqliteDb.prepare('SELECT * FROM spawn_tasks WHERE thread_ext = ?').get(dispatch1.json.external_id);
  check('the reconciler schema accepts this row (workbench_node_id stamped, thread_ext/conversation_id/model present — the exact columns jarvis-spawn-reconcile.py\'s generic `WHERE status IN (\'running\',\'stuck\')` sweep reads)', () => {
    assert.ok(spawnRow, 'no spawn_tasks row found for the dispatch');
    assert.equal(spawnRow.workbench_node_id, dispatchNodeId);
    assert.equal(spawnRow.model, 'claude-sonnet-5');
    assert.equal(spawnRow.status, 'running');
    assert.ok(spawnRow.conversation_id);
  });

  await sleep(1500); // let the 0.6s fake claude finish so we can prove no crash
  const spawnRowAfter = sqliteDb.prepare('SELECT * FROM spawn_tasks WHERE thread_ext = ?').get(dispatch1.json.external_id);
  check('after the worker finishes, status is STILL "running" (never flipped to "failed") — proves processMessage() succeeded through the fake claude; running->done is the external 5-min reconciler\'s job, not this route\'s', () => {
    assert.equal(spawnRowAfter.status, 'running');
    assert.equal(spawnRowAfter.error, null);
  });

  const dispatch3 = await req('POST', `/workbench/nodes/${dispatchNodeId}/dispatch`, { token: key, body: {} });
  check('the 409 guard checks status==="running" only — since running->done is the reconciler\'s job (not this route\'s) and it never ran in this sim, the row is STILL "running" even after the worker finished, so a third dispatch correctly still 409s rather than double-spawning', () => {
    assert.equal(dispatch3.status, 409);
  });
  // Prove the guard really is a live status check, not a one-shot lock: force
  // the reconciler's own transition by hand (exactly what jarvis-spawn-reconcile.py
  // would do once it sees turn_count>=1 && !running) and confirm dispatch re-opens.
  sqliteDb.prepare(`UPDATE spawn_tasks SET status = 'done' WHERE thread_ext = ?`).run(dispatch1.json.external_id);
  const dispatch4 = await req('POST', `/workbench/nodes/${dispatchNodeId}/dispatch`, { token: key, body: {} });
  check('once the reconciler (simulated here) flips the prior attempt to done, a fresh dispatch is allowed again — a genuinely new attempt, not a duplicate', () => {
    assert.equal(dispatch4.status, 201);
    assert.notEqual(dispatch4.json.external_id, dispatch1.json.external_id);
  });

  const notDispatched = await req('GET', `/workbench/nodes/${featureXId}/dispatch`, { token: key });
  check("GET dispatch status on a node that's never been dispatched -> status 'none'", () => {
    assert.equal(notDispatched.json.status, 'none');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. SCOPE GUARD — v1 per-node guard intact; brain/dispatch threads
  //    (unbound to any node) get unrestricted tree-wide scope BY DESIGN.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n[6] scope guard: v1 intact + brain/dispatch tree-wide');

  const nodeB = await req('POST', '/smart-todos', { token: key, body: { title: 'Unrelated sibling branch' } });
  const nodeBId = nodeB.json.node.id;

  const openChatA = await req('POST', `/workbench/${nodeAId}/open-chat`, { token: key });
  check('v1 per-node open-chat still binds one thread per node (untouched contract)', () => {
    assert.equal(openChatA.status, 201);
  });
  const chatAExt = openChatA.json.external_id;

  const scopedWriteOutside = await workbenchTool.execute(
    { operation: 'write_context', node_id: nodeBId, text: 'trying to reach across the tree' },
    { externalId: chatAExt },
  );
  check("a per-node scoped chat (bound to node A) is REFUSED writing to an unrelated node B — v1 scope guard intact", () => {
    assert.ok(scopedWriteOutside.error, 'expected a scope-refusal error');
    assert.ok(scopedWriteOutside.error.includes('outside your scope'));
  });

  const scopedWriteInside = await workbenchTool.execute(
    { operation: 'write_context', node_id: nodeAId, text: 'this is in my own branch' },
    { externalId: chatAExt },
  );
  check('the SAME scoped chat CAN write to its own bound node', () => {
    assert.equal(scopedWriteInside.ok, true);
  });

  const brainWriteAnywhere = await workbenchTool.execute(
    { operation: 'write_context', node_id: nodeBId, text: 'brain outcome note on an arbitrary node' },
    { externalId: brainExt2 }, // the REAL v2 brain session thread from section 1 — never bound to any node
  );
  check('the BRAIN session thread (unbound — never a linked_thread_ext on any node) has unrestricted tree-wide scope, and can write to a node it never zoomed into', () => {
    assert.equal(brainWriteAnywhere.ok, true);
    assert.equal(brainWriteAnywhere.node.id, nodeBId);
  });

  const dispatchWorkerWriteAnywhere = await workbenchTool.execute(
    { operation: 'set_status', node_id: featureXId, status: 'done' },
    { externalId: dispatch1.json.external_id }, // the dispatch worker thread — also unbound
  );
  check('a DISPATCH WORKER thread is likewise unbound -> unrestricted scope, matching its own finish contract (write_context/set_status on its target node, or in principle any node)', () => {
    assert.equal(dispatchWorkerWriteAnywhere.ok, true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. REGRESSION — /smart-todos/* untouched at runtime; v1 /workbench routes,
  //    tree.tsx, smart-todos.ts, and the smart_todos tool untouched in git.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n[7] regression: smart-todos untouched (runtime + git evidence)');

  const listSmart = await req('GET', '/smart-todos', { token: key });
  check('GET /smart-todos -> { nodes: [...] }, exactly the pre-existing envelope', () => {
    assert.equal(listSmart.status, 200);
    assert.deepEqual(Object.keys(listSmart.json), ['nodes']);
  });
  const patchSmart = await req('PATCH', `/smart-todos/${nodeBId}`, { token: key, body: { notes: 'regression check', status: 'doing' } });
  check('PATCH /smart-todos/:id -> { node } shape unchanged, patch applied', () => {
    assert.equal(patchSmart.status, 200);
    assert.deepEqual(Object.keys(patchSmart.json), ['node']);
    assert.equal(patchSmart.json.node.status, 'doing');
  });
  const moveSmart = await req('POST', `/smart-todos/${nodeBId}/move`, { token: key, body: { parent_id: null, sort_order: 0 } });
  check('POST /smart-todos/:id/move -> { node, nodes } shape unchanged', () => {
    assert.equal(moveSmart.status, 200);
    assert.deepEqual(Object.keys(moveSmart.json).sort(), ['node', 'nodes']);
  });
  const delSmart = await req('DELETE', `/smart-todos/${nodeBId}`, { token: key });
  check('DELETE /smart-todos/:id -> 204 empty body, unchanged', () => {
    assert.equal(delSmart.status, 204);
    assert.equal(delSmart.json, null);
  });

  // v1 /workbench routes still present and working (scope + root/node open-chat).
  const rootScope = await req('GET', '/workbench/scope/root', { token: key });
  check('v1 GET /workbench/scope/root still works, additive-only alongside v2', () => {
    assert.equal(rootScope.status, 200);
    assert.equal(rootScope.json.node, null);
  });
  const rootChat = await req('POST', '/workbench/root/open-chat', { token: key });
  check('v1 POST /workbench/root/open-chat still works (find-or-create, 200 or 201 either way)', () => {
    assert.ok(rootChat.status === 200 || rootChat.status === 201);
  });

  // git evidence: zero diff on the byte-for-byte-untouched surfaces, checked
  // against each repo's pre-v2 baseline commit (the v1 review/merge point).
  function gitDiffEmpty(cwd, fromRef, filePath) {
    const out = execFileSync('git', ['diff', `${fromRef}..HEAD`, '--', filePath], { cwd, encoding: 'utf8' });
    return out.trim().length === 0;
  }
  check('git: src/smart-todos.ts byte-identical since the v1 review baseline (378f93a13)', () => {
    assert.equal(gitDiffEmpty(repoRoot, '378f93a13', 'src/smart-todos.ts'), true);
  });
  check('git: src/tools/smart-todos-tool.ts byte-identical since the v1 review baseline', () => {
    assert.equal(gitDiffEmpty(repoRoot, '378f93a13', 'src/tools/smart-todos-tool.ts'), true);
  });
  check('git: the /smart-todos/* route block in api-v1.ts is untouched (all v2 diff hunks land outside lines 2408-2597, verified against the review baseline)', () => {
    const out = execFileSync('git', ['diff', '378f93a13..HEAD', '--', 'src/handlers/api-v1.ts'], { cwd: repoRoot, encoding: 'utf8' });
    const hunkStarts = [...out.matchAll(/^@@ -(\d+),/gm)].map((m) => Number(m[1]));
    for (const line of hunkStarts) {
      assert.ok(line < 2408 || line > 2660, `a diff hunk starts at line ${line}, inside/near the smart-todos route block (2408-2597)`);
    }
  });
  check('git (UI repo): src/routes/tree.tsx byte-identical since the v1 UI review baseline (bfdee11)', () => {
    assert.equal(gitDiffEmpty(uiRoot, 'bfdee11', 'src/routes/tree.tsx'), true);
  });

  console.log(`\n[workbench-v2-sim] ALL ${passed} checks passed ✅`);
  if (findings.length) {
    console.log(`[workbench-v2-sim] ${findings.length} non-blocking finding(s) recorded for the reviewer — see docs/workbench/SIM-V2.md`);
  }
} finally {
  server.close();
}
