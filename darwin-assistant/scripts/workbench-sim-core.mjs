#!/usr/bin/env node
// WORKBENCH CORE SIM (hopper node #443) — function/tool-level proof of spec
// items 1-4, 6-9 against a scratch sqlite DB. No live model calls (a fake
// `claude` binary stands in, driven by a control file); no touch of the
// live jarvis.db; never restarts jarvis.service.
//
//   npm run build   (must be re-run after any src change)
//   node /tmp/workbench-sim/workbench-sim-core.mjs
//
// Mirrors the repo's existing scratch-DB + fake-binary conventions (see
// scripts/multi-claude-e2e-sim.mjs, scripts/claude-accounts-route-test.mjs).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

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

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-sim-core-'));
const controlPath = path.join(scratchDir, 'control.json');
process.env.WORKBENCH_SIM_CONTROL = controlPath;
process.env.UX_REVIEWER_CLAUDE_BIN = path.join(__dirname, 'workbench-sim-fake-claude.mjs');
delete process.env.ANTHROPIC_API_KEY;

function setControl(mode, payload) {
  fs.writeFileSync(controlPath, JSON.stringify({ mode, payload }));
}
function clearControl() {
  fs.rmSync(controlPath, { force: true });
}

console.log(`[workbench-sim-core] scratch DB: ${DB_PATH}`);
console.log(`[workbench-sim-core] fake claude: ${process.env.UX_REVIEWER_CLAUDE_BIN}`);

const distDir = path.join(repoRoot, 'dist');
const smartTodos = await import(path.join(distDir, 'smart-todos.js'));
const workbench = await import(path.join(distDir, 'workbench.js'));
const workbenchToolMod = await import(path.join(distDir, 'tools', 'workbench-tool.js'));
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const threadSummaries = await import(path.join(distDir, 'thread-summaries.js'));

const {
  createSmartTodoNode,
  getSmartTodoNode,
  getSmartTodoByThread,
  setSmartTodoThread,
  moveSmartTodoNode,
  deleteSmartTodoNode,
  listSmartTodoNodes,
} = smartTodos;
const { matchOrCreatePlacement, getWorkbenchScope } = workbench;
const { workbench: workbenchTool } = workbenchToolMod;
const { getOrCreateConversation } = convDb;
const { createThreadSummary } = threadSummaries;

function toolCtx(externalId) {
  return {
    externalId,
    conversationId: 0,
    sourceMessageId: 'sim',
    sourceTimestamp: new Date().toISOString(),
    originalText: '',
  };
}

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${label}`);
}

// ─────────────────────────────────────────────────────────────────────────
// ITEM 1 — a jot whose subject already exists in the tree lands UNDER it.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n[1] existing-subject jot lands under the matching node');
let dashboardNodeId;
{
  const dashboardNode = createSmartTodoNode({ title: 'Update Dashboard X', notes: 'the ops KPI dashboard' });
  dashboardNodeId = dashboardNode.id;

  setControl('ok', {
    parent_id: dashboardNode.id,
    confidence: 0.9,
    reason: 'This is clearly the same dashboard refresh work.',
    decomposition: [{ title: 'Change dashboard refresh speed' }],
  });
  const result = await matchOrCreatePlacement('need to change the refresh speed on that dashboard page');
  clearControl();

  check('shortlist surfaced the existing node as a candidate (else the model could not have chosen it)', () => {
    // sanitizeDecision only keeps parent_id if it was in the shortlist it was shown —
    // a non-null result here proves the deterministic shortlist worked, not just the model.
    assert.equal(result.parent_id, dashboardNode.id);
  });
  check('the new node was created AS A CHILD of the existing node, not a new root', () => {
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].parent_id, dashboardNode.id);
    assert.equal(result.created[0].title, 'Change dashboard refresh speed');
    assert.equal(result.created[0].root_id, dashboardNode.id);
  });
  check('confidence + reason are carried through from the placement decision', () => {
    assert.equal(result.confidence, 0.9);
    assert.match(result.reason, /dashboard refresh/);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ITEM 2 — a jot with no existing home creates a new top-level branch AND
// decomposes it into children.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n[2] no-match jot creates a new top-level branch + decomposition');
{
  setControl('ok', {
    parent_id: null,
    confidence: 0.85,
    reason: 'Nothing in the tree resembles a newsletter launch.',
    decomposition: [
      {
        title: 'Launch Q4 newsletter',
        children: [{ title: 'Write content' }, { title: 'Design template' }, { title: 'Schedule send' }],
      },
    ],
  });
  const result = await matchOrCreatePlacement(
    'Plan and launch the Q4 newsletter: write the content, design the template, and schedule the send.',
  );
  clearControl();

  check('landed at root (new top-level branch), not under anything existing', () => {
    assert.equal(result.parent_id, null);
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].parent_id, null);
    assert.equal(result.created[0].title, 'Launch Q4 newsletter');
  });
  const kids = listSmartTodoNodes().filter((n) => n.parent_id === result.created[0].id);
  check('decomposition produced the 3 nested children', () => {
    assert.equal(kids.length, 3);
    assert.deepEqual(
      kids.map((k) => k.title).sort(),
      ['Design template', 'Schedule send', 'Write content'],
    );
    assert.ok(kids.every((k) => k.root_id === result.created[0].id), 'children must share the root of their new branch');
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ITEM 3a — low-confidence placement lands at root, flagged, not a confident
// wrong guess.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n[3a] low-confidence placement falls back to root (never a shaky guess)');
{
  const dashboardNode = getSmartTodoNode(dashboardNodeId); // "Update Dashboard X" from item 1
  setControl('ok', {
    parent_id: dashboardNode.id, // model DID pick a candidate...
    confidence: 0.2, // ...but well under CONFIDENCE_THRESHOLD (0.55)
    reason: 'Might be related to the dashboard, not sure.',
    decomposition: [{ title: 'Some vague dashboard-adjacent thing' }],
  });
  const result = await matchOrCreatePlacement('something about a dashboard maybe, not totally sure what');
  clearControl();

  check('parent_id was forced back to null despite the model naming a candidate', () => {
    assert.equal(result.parent_id, null);
  });
  check('the reason string documents WHY it was overridden (the "flagged" signal the UI reads)', () => {
    assert.match(result.reason, /low confidence/i);
    assert.match(result.reason, /instead of guessing/i);
  });
  check('confidence value itself is preserved (0.2) so the UI can still show how unsure it was', () => {
    assert.equal(result.confidence, 0.2);
  });
  check('it still created something — a jot is never silently dropped', () => {
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].parent_id, null);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ITEM 3b — the one-shot-failure path ALSO lands at root, without hard-
// failing the request.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n[3b] claude one-shot failure falls back to root without throwing');
{
  setControl('fail', null); // fake binary exits 1, no stdout
  const before = listSmartTodoNodes().length;
  const result = await matchOrCreatePlacement('a note that arrives while the placement model is unreachable');
  clearControl();

  check('matchOrCreatePlacement resolved (did not throw / reject)', () => {
    assert.ok(result, 'expected a result object, not an exception');
  });
  check('fell back to a new root item using the raw note as the title (fallbackItem)', () => {
    assert.equal(result.parent_id, null);
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].parent_id, null);
    assert.match(result.created[0].title, /a note that arrives/);
  });
  check('default reason text is used when no decision came back at all', () => {
    assert.equal(result.reason, 'No strong match found; filed as a new top-level item.');
  });
  check('exactly one new node was added (no partial/duplicate writes on failure)', () => {
    assert.equal(listSmartTodoNodes().length, before + 1);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ITEM 4 — focus_id on a jot bypasses matching entirely.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n[4] focus_id bypasses matching — always attaches under the given node');
{
  const target = createSmartTodoNode({ title: 'Fix the login flow' });
  // decomposeNote() also shells to the fake binary (different prompt/shape) —
  // prove focus_id NEVER reaches decidePlacement/buildShortlist by making the
  // control payload use decomposeNote's {title,notes,children} shape, and by
  // never setting a shortlist-shaped {parent_id,...} payload at all.
  setControl('ok', { title: 'Add rate limiting to login', notes: null, children: [] });
  const result = await matchOrCreatePlacement('add rate limiting to login please', { focusId: target.id });
  clearControl();

  check('parent_id is exactly the focus node, confidence is 1 (no ambiguity to resolve)', () => {
    assert.equal(result.parent_id, target.id);
    assert.equal(result.confidence, 1);
    assert.equal(result.reason, 'Placed under the item you were zoomed into.');
  });
  check('the new node was actually attached under the focus node', () => {
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].parent_id, target.id);
    assert.equal(result.created[0].title, 'Add rate limiting to login');
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ITEM 6 — the workbench TOOL adds a child to an in-scope node and is
// REFUSED when writing outside the scope.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n[6] workbench tool: scoped write allowed, cross-scope write refused');
{
  const branchA = createSmartTodoNode({ title: 'Branch A' });
  const branchAChild = createSmartTodoNode({ parent_id: branchA.id, title: 'A child' });
  const branchB = createSmartTodoNode({ title: 'Branch B' }); // sibling branch, NOT in A's scope

  const extA = 'cockpit:workbench-sim-branch-a';
  setSmartTodoThread(branchA.id, extA);

  const inScope = await workbenchTool.execute(
    { operation: 'add_child', parent_id: branchAChild.id, title: 'grandchild under A' },
    toolCtx(extA),
  );
  check('add_child INSIDE scope (a descendant of the focus node) succeeds', () => {
    assert.equal(inScope.ok, true);
    assert.equal(inScope.node.parent_id, branchAChild.id);
  });

  const outOfScope = await workbenchTool.execute(
    { operation: 'add_child', parent_id: branchB.id, title: 'sneaky cross-branch write' },
    toolCtx(extA),
  );
  check('add_child on a DIFFERENT branch (sibling, not a descendant) is refused, not silently redirected', () => {
    assert.ok(outOfScope.error, 'expected an error, got: ' + JSON.stringify(outOfScope));
    assert.match(outOfScope.error, /outside your scope/);
  });
  check('the refused write did NOT actually create anything under branch B', () => {
    const kids = listSmartTodoNodes().filter((n) => n.parent_id === branchB.id);
    assert.equal(kids.length, 0);
  });

  const rootExt = 'cockpit:workbench-sim-root';
  const rootScopeAdd = await workbenchTool.execute(
    { operation: 'add_child', parent_id: branchB.id, title: 'root scope can touch anything' },
    toolCtx(rootExt), // no node bound to this thread -> unrestricted root scope
  );
  check('an UNBOUND thread (root scope) is unrestricted and CAN write to branch B', () => {
    assert.equal(rootScopeAdd.ok, true);
    assert.equal(rootScopeAdd.node.parent_id, branchB.id);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ITEM 7 — write_context APPENDS to context_notes and leaves `notes`
// untouched.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n[7] write_context appends to context_notes, never touches notes');
{
  const node = createSmartTodoNode({ title: 'Migrate billing export', notes: "Kevin's own elaboration — do not touch" });
  const ext = 'cockpit:workbench-sim-billing';
  setSmartTodoThread(node.id, ext);

  const first = await workbenchTool.execute({ operation: 'write_context', text: 'Decided to use CSV, not JSON.' }, toolCtx(ext));
  check('first write_context call succeeds and sets context_notes', () => {
    assert.equal(first.ok, true);
    assert.equal(first.node.context_notes, 'Decided to use CSV, not JSON.');
  });
  const second = await workbenchTool.execute({ operation: 'write_context', text: 'Shipped the CSV exporter.' }, toolCtx(ext));
  check('second call APPENDS (both lines present), does not overwrite the first', () => {
    assert.equal(second.node.context_notes, 'Decided to use CSV, not JSON.\nShipped the CSV exporter.');
  });
  check("Kevin's own `notes` field is untouched by either write_context call", () => {
    assert.equal(second.node.notes, "Kevin's own elaboration — do not touch");
  });
  check('last_activity_at was stamped by the write', () => {
    const reread = getSmartTodoNode(node.id);
    assert.ok(reread.last_activity_at, 'expected last_activity_at to be set');
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ITEM 8 — read_up returns an ancestor summary and does NOT pull a
// transcript.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n[8] read_up: ancestor SUMMARY only, on demand, never a transcript');
{
  const parent = createSmartTodoNode({ title: 'Parent branch with its own chat' });
  const child = createSmartTodoNode({ parent_id: parent.id, title: 'Child branch' });
  const grandchild = createSmartTodoNode({ parent_id: child.id, title: 'Grandchild — where the chat is scoped' });

  const parentThreadExt = 'cockpit:workbench-sim-parent-thread';
  setSmartTodoThread(parent.id, parentThreadExt);
  const parentConv = getOrCreateConversation(parentThreadExt);
  createThreadSummary(parentConv.id, 'Parent branch summary: decided to ship via the existing pipeline.', null, 3);

  const childExt = 'cockpit:workbench-sim-child-thread';
  setSmartTodoThread(grandchild.id, childExt); // chat is scoped to the GRANDCHILD

  const readAncestorAncestor = await workbenchTool.execute({ operation: 'read_up', node_id: parent.id }, toolCtx(childExt));
  check('read_up on a real ancestor (parent, 2 levels up) returns its summary', () => {
    assert.equal(readAncestorAncestor.ok, true);
    assert.equal(readAncestorAncestor.summary.content, 'Parent branch summary: decided to ship via the existing pipeline.');
  });
  check('the payload never includes a transcript field — summary only', () => {
    assert.ok(!('transcript' in readAncestorAncestor), 'read_up leaked a transcript-shaped field');
    assert.ok(!('turns' in readAncestorAncestor));
  });

  const readNonAncestor = await workbenchTool.execute({ operation: 'read_up', node_id: 999999 }, toolCtx(childExt));
  check('read_up on a node that is NOT an ancestor is refused', () => {
    assert.ok(readNonAncestor.error);
    assert.match(readNonAncestor.error, /not one of your ancestors/);
  });

  const noSummaryYet = createSmartTodoNode({ title: 'Ancestor with a chat but no summary yet' });
  const midNoSummary = createSmartTodoNode({ parent_id: noSummaryYet.id, title: 'mid' });
  const leafExt = 'cockpit:workbench-sim-leaf-nosummary';
  setSmartTodoThread(midNoSummary.id, leafExt);
  const ancestorExt = 'cockpit:workbench-sim-ancestor-nosummary';
  getOrCreateConversation(ancestorExt); // a real chat exists...
  setSmartTodoThread(noSummaryYet.id, ancestorExt); // ...but it was never summarized
  const noSummaryResult = await workbenchTool.execute({ operation: 'read_up', node_id: noSummaryYet.id }, toolCtx(leafExt));
  check('an ancestor with a chat but NO summary yet returns null summary + an explanatory note, not an error', () => {
    assert.equal(noSummaryResult.ok, true);
    assert.equal(noSummaryResult.summary, null);
    assert.match(noSummaryResult.note, /no summary has been generated/i);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ITEM 9 — relocate + undo-jot behave (the UI's Move/Undo actions on a jot's
// landing receipt, backed by the pre-existing moveSmartTodoNode /
// deleteSmartTodoNode — proves the jot output interops with them).
// ─────────────────────────────────────────────────────────────────────────
console.log('\n[9] relocate + undo-jot (Move / Undo on a jot landing) behave');
{
  const home1 = createSmartTodoNode({ title: 'Home 1' });
  const home2 = createSmartTodoNode({ title: 'Home 2' });

  setControl('ok', { parent_id: null, confidence: 0.9, reason: 'new item', decomposition: [{ title: 'Undecided item' }] });
  const jotResult = await matchOrCreatePlacement('an item I will move around by hand');
  clearControl();
  const createdId = jotResult.created[0].id;

  // "Move" — relocateJot in the UI calls moveSmartTodo(createdNodeId, newParentId, ...).
  const moved = moveSmartTodoNode(createdId, home1.id, 0);
  check('relocate (move) attaches the jotted node under the chosen home', () => {
    assert.equal(moved.parent_id, home1.id);
    assert.equal(moved.root_id, home1.id);
  });
  const movedAgain = moveSmartTodoNode(createdId, home2.id, 0);
  check('relocate again moves it cleanly to a different home (not stuck / not duplicated)', () => {
    assert.equal(movedAgain.parent_id, home2.id);
    const allWithTitle = listSmartTodoNodes().filter((n) => n.title === 'Undecided item');
    assert.equal(allWithTitle.length, 1, 'moving must not duplicate the node');
  });

  // "Undo" — undoJot in the UI calls deleteSmartTodo(createdNodeId).
  const deleted = deleteSmartTodoNode(createdId);
  check('undo (delete) removes the jotted node entirely', () => {
    assert.equal(deleted.id, createdId);
    assert.equal(getSmartTodoNode(createdId), null);
  });
}

console.log(`\n[workbench-sim-core] ALL ${passed} checks passed ✅`);
