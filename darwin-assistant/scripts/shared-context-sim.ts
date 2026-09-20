// SHARED CONTEXT v0 SIM (hopper node #487) — drives the real §1 digest, §2
// recall, and §3 summary-refresher modules against a SCRATCH sqlite DB, plus
// a throwaway express instance of the real router for the two new routes.
// No live model calls anywhere in this file (nothing in shared-context.ts /
// recall.ts / summary-refresh.ts makes one either — see CONTRACT.md §0).
//
//   npm run build
//   npm run shared-context:sim
//   (or: JARVIS_DB_PATH=/tmp/shared-context-sim.db npx tsx scripts/shared-context-sim.ts)
//
// Writes a full pass/fail report to
// /home/kevin/obsidian/paperclip-wiki/outbox/shared-context/sim-report.md.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ── scratch DB guard (must run before any dist/ module is imported —────────
// conversation-db.js opens the sqlite handle at import time) ──────────────
const raw = process.env.JARVIS_DB_PATH ?? '/tmp/shared-context-sim.db';
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db. Use a /tmp scratch path.');
  process.exit(1);
}
process.env.JARVIS_DB_PATH = DB_PATH;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[shared-context-sim] scratch DB: ${DB_PATH}`);

// dist/handlers/api-v1.js transitively imports dist/goals-guards.js, whose
// Overwatch poller auto-starts at module load unless this is set — must be
// set BEFORE that import (same gotcha goals-sim.ts documents).
process.env.GOAL_GUARD_POLLER = '0';
process.env.HOPPER_GOV_ENABLED = process.env.HOPPER_GOV_ENABLED ?? '0';
delete process.env.ANTHROPIC_API_KEY;

// recall's search needle for §2/§6/§7. Kevin's real wiki vault (recall.ts's
// wiki source is hardcoded to it, no scratch override) already has extensive
// real "MBI" content (it's a live Darwin business term — see memory.md
// itself) that would outscore/crowd out our seeded fixtures within the
// default limit=12. A unique nonce guarantees every hit recall() returns for
// this query traces back to something THIS script seeded, in this run.
const NEEDLE = 'SHAREDCTXPROBE';

// A scratch auto-memory dir for §2's auto_memory source — kept separate from
// Kevin's real Claude Code memory dir so this run never touches it.
const AUTO_MEM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-context-sim-memory-'));
process.env.JARVIS_AUTO_MEMORY_DIR = AUTO_MEM_DIR;
fs.writeFileSync(
  path.join(AUTO_MEM_DIR, 'mbi-lead-trace-model.md'),
  [
    '---',
    'name: mbi-lead-trace-model',
    'description: sim fixture — locked per-lead trace rules for the MBI lead ledger',
    '---',
    '',
    `${NEEDLE}: MBI lead trace model test fixture: anchor lg_leads, day-0=24h leads rows, most-recent-purchase attribution.`,
    '',
  ].join('\n'),
  'utf8',
);

const distDir = path.join(repoRoot, 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const { sqliteDb, getOrCreateConversation, setSetting, getSetting } = await import(
  path.join(distDir, 'conversation-db.js')
);
const sharedContext = await import(path.join(distDir, 'shared-context.js'));
const recallModule = await import(path.join(distDir, 'recall.js'));
const summaryRefresh = await import(path.join(distDir, 'summary-refresh.js'));

const {
  collectSharedNow,
  renderSharedNow,
  buildSharedNow,
  getSharedNowSnapshot,
  invalidateSharedNow,
  shouldInjectSharedNow,
  writeSharedNowMirror,
} = sharedContext;
const { recall, ensureTurnsFts, getRecallIndexMode } = recallModule;
const { selectStaleThreads } = summaryRefresh;

// ── real express app, real HTTP, throwaway port (item 9) ───────────────────
const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise<import('node:http').Server>((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s as import('node:http').Server));
});
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const base = `http://127.0.0.1:${port}/api/v1`;
console.log(`[shared-context-sim] server: ${base}`);

const adminKey = mintApiKey('shared-context-sim-admin', 'cockpit').plaintext; // admin scope
const nonAdminKey = mintApiKey('shared-context-sim-jarvis', 'jarvis').plaintext; // non-admin scope

async function getJson(urlPath: string, token: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${urlPath}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// ── result collection — never abort the whole run on one failure ───────────
type Result = { id: string; description: string; pass: boolean; error?: string };
const results: Result[] = [];
function check(id: string, description: string, fn: () => void): void {
  try {
    fn();
    results.push({ id, description, pass: true });
    console.log(`  ✓ [${id}] ${description}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ id, description, pass: false, error: msg });
    console.log(`  ✗ [${id}] ${description}\n      ${msg}`);
  }
}
async function checkAsync(id: string, description: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ id, description, pass: true });
    console.log(`  ✓ [${id}] ${description}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ id, description, pass: false, error: msg });
    console.log(`  ✗ [${id}] ${description}\n      ${msg}`);
  }
}

// ── seed helpers ─────────────────────────────────────────────────────────
function sqliteNow(offsetSec = 0): string {
  return new Date(Date.now() + offsetSec * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function insertTurnRaw(conversationId: number, turnIndex: number, role: 'user' | 'assistant', content: string, createdAt: string): void {
  sqliteDb
    .prepare(`INSERT INTO turns (conversation_id, turn_index, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(conversationId, turnIndex, role, content, createdAt);
}

function insertSummaryRaw(conversationId: number, content: string, anchorTurnIndex: number, createdAt: string): void {
  sqliteDb
    .prepare(`INSERT INTO thread_summaries (conversation_id, content, anchor_turn_id, anchor_turn_index, created_at) VALUES (?, ?, NULL, ?, ?)`)
    .run(conversationId, content, anchorTurnIndex, createdAt);
}

let owServer: import('node:http').Server | undefined; // unused placeholder for symmetry with the finally block below (no fake external server needed here)

// wiki fixture — recall.ts's VAULT_ROOT is hardcoded to the real vault (no
// env override like AUTO_MEMORY_DIR), so §2's "wiki" source is exercised
// against a short-lived, uniquely-named fixture under it and removed in the
// `finally` block below regardless of pass/fail.
const VAULT_ROOT = '/home/kevin/obsidian/paperclip-wiki';
const WIKI_FIXTURE_DIR = path.join(VAULT_ROOT, 'skills', '__shared_context_sim_tmp__');
const WIKI_FIXTURE_FILE = path.join(WIKI_FIXTURE_DIR, 'SKILL.md');

// ═══════════════════════════════════════════════════════════════════════════
try {
  fs.mkdirSync(WIKI_FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(
    WIKI_FIXTURE_FILE,
    `# Sim fixture\n\n${NEEDLE}: MBI ledger v2 lives in the intake repo, branch mbi/ledger-v2. Deleted automatically by shared-context-sim.ts.\n`,
    'utf8',
  );

  console.log('\n[SEED] workstreams, trees, goal, commitment, conversations');

  // -- 2 workstreams (CONTRACT §5 seed) --------------------------------------
  const ws1 = sqliteDb
    .prepare(`INSERT INTO workstreams (title, turn, next_action, next_owner, waiting_since) VALUES (?, 'kevin', ?, 'kevin', ?)`)
    .run('Perclickity media-buy rollout', 'Deploy the reviewed code-rules branch', sqliteNow(-3600));
  const ws1Id = Number(ws1.lastInsertRowid);
  sqliteDb.prepare(`INSERT INTO workstream_links (workstream_id, kind, ref) VALUES (?, 'thread', 'cockpit:sim-a')`).run(ws1Id);
  sqliteDb.prepare(`INSERT INTO workstreams (title, turn, next_action, next_owner) VALUES (?, 'jarvis', ?, 'jarvis')`).run(
    'Foundry foundation gate',
    'Watch the retry land',
  );

  // -- 2 hopper trees ---------------------------------------------------------
  sqliteDb.prepare(`INSERT INTO hopper_trees (id, topic, origin_thread_ext, status) VALUES (?, ?, ?, 'active')`).run(
    'tree-sim00000001',
    'Sim active tree — shared context v0',
    'cockpit:sim-a',
  );
  sqliteDb.prepare(`INSERT INTO hopper_nodes (tree_id, title, status) VALUES (?, 'Recon', 'running')`).run('tree-sim00000001');
  sqliteDb.prepare(`INSERT INTO hopper_nodes (tree_id, title, status) VALUES (?, 'Backend build', 'pending')`).run('tree-sim00000001');
  sqliteDb.prepare(`INSERT INTO hopper_nodes (tree_id, title, status) VALUES (?, 'Sim + review', 'pending')`).run('tree-sim00000001');

  sqliteDb.prepare(`INSERT INTO hopper_trees (id, topic, origin_thread_ext, status) VALUES (?, ?, ?, 'done')`).run(
    'tree-sim00000002',
    'Sim done tree — MBI ledger v2',
    'cockpit:sim-tree-origin',
  );
  sqliteDb.prepare(`INSERT INTO hopper_nodes (tree_id, title, status, result) VALUES (?, 'Recon', 'done', 'Recon complete.')`).run('tree-sim00000002');
  sqliteDb.prepare(`INSERT INTO hopper_nodes (tree_id, title, status, result) VALUES (?, 'Backend build', 'done', 'Backend built and tested.')`).run(
    'tree-sim00000002',
  );
  sqliteDb
    .prepare(`INSERT INTO hopper_nodes (tree_id, title, status, result) VALUES (?, 'Docs + push', 'done', ?)`)
    .run('tree-sim00000002', `${NEEDLE}: branch mbi/ledger-v2 @1840574 — review PASS-with-fixes, pushed.`);

  // -- 1 goal, 3 nodes deep, focus on the deepest ------------------------------
  const goalIns = sqliteDb
    .prepare(`INSERT INTO goals (title, done_means, status, authored_by, thread_ext) VALUES (?, ?, 'set', 'kevin', ?)`)
    .run('Hub 1.0 monitoring', 'Every part of Hub 1.0 has a live monitor', 'cockpit:goal-sim-1');
  const goalId = Number(goalIns.lastInsertRowid);
  const rootNode = sqliteDb
    .prepare(`INSERT INTO goal_nodes (goal_id, parent_id, title, done_means, state) VALUES (?, NULL, ?, ?, 'set')`)
    .run(goalId, 'Hub 1.0 monitoring', 'Every part of Hub 1.0 has a live monitor');
  const rootId = Number(rootNode.lastInsertRowid);
  const childNode = sqliteDb
    .prepare(`INSERT INTO goal_nodes (goal_id, parent_id, title, done_means, state) VALUES (?, ?, ?, ?, 'set')`)
    .run(goalId, rootId, 'Lead flow', 'The full lead flow is traced end to end');
  const childId = Number(childNode.lastInsertRowid);
  const grandchildNode = sqliteDb
    .prepare(`INSERT INTO goal_nodes (goal_id, parent_id, title, done_means, state) VALUES (?, ?, ?, ?, 'working')`)
    .run(goalId, childId, 'Day-0 leads', 'Day-0 leads reconcile against lg_leads');
  const grandchildId = Number(grandchildNode.lastInsertRowid);
  sqliteDb.prepare(`INSERT INTO goal_focus (goal_id, node_id, set_by) VALUES (?, ?, 'kevin')`).run(goalId, grandchildId);

  // -- 1 open watch_commitments row (table owned by the Python watchdog; ------
  // create it exactly as scripts/jarvis-watchdog.py does — CONTRACT §5 seed) --
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS watch_commitments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      thread_ext TEXT,
      check_type TEXT NOT NULL DEFAULT 'manual',
      check_ref TEXT,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      recovery_attempts INTEGER NOT NULL DEFAULT 0,
      last_checked TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      notes TEXT
    );
  `);
  sqliteDb
    .prepare(`INSERT INTO watch_commitments (subject, thread_ext, check_type, due_at, status) VALUES (?, 'cockpit:sim-a', 'manual', ?, 'open')`)
    .run('Review + deploy the shared-context branches', sqliteNow(3600));

  // -- 3 conversations (CONTRACT §5 seed) --------------------------------------
  const convSimA = getOrCreateConversation('cockpit:sim-a');
  const convWorker = getOrCreateConversation('cockpit:hopper-node-999-abcd');
  const convQuick = getOrCreateConversation('quick:hub1:xyz');

  insertTurnRaw(convSimA.id, 0, 'user', 'What is the status of the media buy rollout?', sqliteNow(-600));
  insertTurnRaw(convSimA.id, 1, 'assistant', `${NEEDLE}: MBI code lives in intake branch mbi/ledger-v2.`, sqliteNow(-590));
  insertTurnRaw(convSimA.id, 2, 'user', 'Great, thanks.', sqliteNow(-580));
  insertSummaryRaw(convSimA.id, `${NEEDLE}: MBI ledger v2 shipped and pushed; awaiting deploy checklist.`, 2, sqliteNow(-570));

  for (let i = 0; i < 7; i++) {
    insertTurnRaw(
      convWorker.id,
      i,
      i % 2 === 0 ? 'user' : 'assistant',
      i === 3 ? `${NEEDLE}: worker-thread fixture line — must never surface in recall/digest.` : `worker turn ${i}`,
      sqliteNow(-500 + i * 10),
    );
  }
  for (let i = 0; i < 7; i++) {
    insertTurnRaw(
      convQuick.id,
      i,
      i % 2 === 0 ? 'user' : 'assistant',
      i === 3 ? `${NEEDLE}: quick-chat fixture line — must never surface in recall/digest.` : `quick turn ${i}`,
      sqliteNow(-400 + i * 10),
    );
  }

  // rebuild the FTS index now that turns exist beyond whatever module-load-time
  // rebuild already ran (idempotent; picks up anything inserted since).
  ensureTurnsFts();

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[1] collectSharedNow()');
  let baseData: any;
  check('1', 'collectSharedNow() returns 2 workstreams, 2 trees (done tree branch/commit), 1 goal w/ 3-title focus_path, 1 commitment, exactly 1 summary', () => {
    baseData = collectSharedNow();
    assert.equal(baseData.workstreams.length, 2, `workstreams: ${JSON.stringify(baseData.workstreams)}`);
    assert.equal(baseData.trees.length, 2, `trees: ${JSON.stringify(baseData.trees)}`);
    const done = baseData.trees.find((t: any) => t.id === 'tree-sim00000002');
    assert.ok(done, 'done tree present');
    assert.equal(done.branch, 'mbi/ledger-v2');
    assert.equal(done.commit, '1840574');
    assert.equal(baseData.goals.length, 1);
    assert.equal(baseData.goals[0].focus_path, 'Hub 1.0 monitoring › Lead flow › Day-0 leads');
    assert.equal(baseData.commitments.length, 1);
    assert.equal(baseData.summaries.length, 1, `summaries: ${JSON.stringify(baseData.summaries)}`);
    assert.equal(baseData.summaries[0].external_id, 'cockpit:sim-a');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[2] renderSharedNow()');
  check('2a', 'renderSharedNow() starts with the <shared_now as_of= tag and has all five ## headers', () => {
    const text = renderSharedNow(baseData);
    assert.ok(text.startsWith('<shared_now as_of='), text.slice(0, 40));
    for (const h of ['## Workstreams', '## Trees', '## Goals', '## Commitments', '## Recent thread summaries']) {
      assert.ok(text.includes(h), `missing header ${h}`);
    }
  });
  check('2b', 'renderSharedNow(data, 600) fits the cap and flags truncated when it had to trim', () => {
    const data = collectSharedNow();
    const text = renderSharedNow(data, 600);
    assert.ok(text.length <= 600, `length ${text.length} > 600`);
    if (data.truncated) {
      assert.ok(text.includes('digest truncated to fit'), 'truncated=true but no footer text');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[3] shouldInjectSharedNow()');
  const nowMs = Date.now();
  check('3a', '1 turn (first turn of the thread) -> true', () => {
    assert.equal(
      shouldInjectSharedNow({ externalId: 'cockpit:sim-a', turns: [{ role: 'user', created_at: sqliteNow(0) }], nowMs }),
      true,
    );
  });
  check('3b', '2 turns, previous turn "now" -> false', () => {
    const turns = [
      { role: 'user', created_at: sqliteNow(-2) },
      { role: 'assistant', created_at: sqliteNow(-1) },
    ];
    assert.equal(shouldInjectSharedNow({ externalId: 'cockpit:sim-a', turns, nowMs }), false);
  });
  check('3c', '2 turns, previous turn 3h old -> true (past the 120min reinject window)', () => {
    const turns = [
      { role: 'user', created_at: sqliteNow(-3 * 3600) },
      { role: 'assistant', created_at: sqliteNow(0) },
    ];
    assert.equal(shouldInjectSharedNow({ externalId: 'cockpit:sim-a', turns, nowMs }), true);
  });
  check('3d', 'hopper-node worker thread, 1 turn -> false (ineligible)', () => {
    assert.equal(
      shouldInjectSharedNow({ externalId: 'cockpit:hopper-node-999-abcd', turns: [{ role: 'user', created_at: sqliteNow(0) }], nowMs }),
      false,
    );
  });
  check('3e', 'same worker thread with shared_now_workers=1 -> true', () => {
    setSetting('shared_now_workers', '1');
    try {
      assert.equal(
        shouldInjectSharedNow({ externalId: 'cockpit:hopper-node-999-abcd', turns: [{ role: 'user', created_at: sqliteNow(0) }], nowMs }),
        true,
      );
    } finally {
      setSetting('shared_now_workers', '0');
    }
  });
  check('3f', 'shared_now_enabled=0 -> false regardless of turn count', () => {
    setSetting('shared_now_enabled', '0');
    try {
      assert.equal(
        shouldInjectSharedNow({ externalId: 'cockpit:sim-a', turns: [{ role: 'user', created_at: sqliteNow(0) }], nowMs }),
        false,
      );
    } finally {
      setSetting('shared_now_enabled', '1');
    }
  });
  check('3g', 'settings restored to defaults after the toggles above (workers=off, enabled=on)', () => {
    assert.equal(getSetting('shared_now_workers'), '0');
    assert.equal(getSetting('shared_now_enabled'), '1');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[4] cache: buildSharedNow() / invalidateSharedNow()');
  check('4', 'two calls within TTL are byte-identical; a seed change is invisible until invalidate; visible after', () => {
    invalidateSharedNow();
    const snap1 = getSharedNowSnapshot();
    assert.equal(snap1.cached, false, 'first call after invalidate is a fresh build');
    const b1 = buildSharedNow();
    const b2 = buildSharedNow();
    assert.equal(b1, b2, 'two calls within TTL must be identical (cached)');
    const snap2 = getSharedNowSnapshot();
    assert.equal(snap2.cached, true, 'second snapshot read from cache');

    sqliteDb.prepare(`INSERT INTO workstreams (title, turn) VALUES ('Cache-busting workstream', 'kevin')`).run();
    const b3 = buildSharedNow();
    assert.equal(b3, b1, 'a DB change must NOT appear before invalidateSharedNow()');

    invalidateSharedNow();
    const b4 = buildSharedNow();
    assert.notEqual(b4, b1, 'after invalidate, the new content must appear');
    assert.ok(b4.includes('Cache-busting workstream'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[5] writeSharedNowMirror()');
  check('5', 'first call writes agent-memory/jarvis/now.md; second call (unchanged) reports written:false', () => {
    const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-context-sim-vault-'));
    try {
      const r1 = writeSharedNowMirror(tmpVault);
      assert.ok(r1, 'first mirror write returned a result');
      assert.equal(r1.written, true);
      const mirrorPath = path.join(tmpVault, 'agent-memory', 'jarvis', 'now.md');
      assert.equal(r1.path, mirrorPath);
      assert.ok(fs.existsSync(mirrorPath), 'mirror file exists on disk');
      const content = fs.readFileSync(mirrorPath, 'utf8');
      assert.ok(content.includes('<shared_now'), 'mirror file contains the digest block');

      const r2 = writeSharedNowMirror(tmpVault);
      assert.ok(r2);
      assert.equal(r2.written, false, 'unchanged content must not rewrite the file');
    } finally {
      fs.rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n[6] recall("${NEEDLE}")`);
  let mbiHits: any[] = [];
  check('6a', `recall('${NEEDLE}') hits cover turn/thread_summary/tree/wiki/auto_memory; no worker/quick refs; snippets <= 280 chars`, () => {
    const result = recall(NEEDLE);
    mbiHits = result.hits;
    assert.ok(mbiHits.length > 0, 'at least one hit');
    const gotSources = new Set(mbiHits.map((h) => h.source));
    for (const s of ['turn', 'thread_summary', 'tree', 'wiki', 'auto_memory']) {
      assert.ok(gotSources.has(s), `missing source ${s}; got ${[...gotSources].join(',')}`);
    }
    for (const h of mbiHits) {
      assert.ok(h.snippet.length <= 280, `snippet too long (${h.snippet.length}) for ${h.source}/${h.ref}`);
      assert.notEqual(h.ref, 'cockpit:hopper-node-999-abcd', 'worker thread must never surface');
      assert.notEqual(h.ref, 'quick:hub1:xyz', 'quick thread must never surface');
    }
  });
  check('6b', 'the turn hit is the eligible cockpit:sim-a thread, not the worker/quick fixtures', () => {
    const turnHit = mbiHits.find((h) => h.source === 'turn');
    assert.ok(turnHit, 'a turn hit exists');
    assert.equal(turnHit.ref, 'cockpit:sim-a');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[7] recall in forced LIKE mode (child process)');
  await checkAsync('7', "JARVIS_RECALL_FORCE_LIKE=1 in a fresh process -> mode 'like', same turn hit as the default-mode run", async () => {
    const child = spawnSync(
      process.execPath,
      [path.join(__dirname, 'shared-context-like-check.mjs'), distDir, NEEDLE],
      {
        env: { ...process.env, JARVIS_DB_PATH: DB_PATH, JARVIS_RECALL_FORCE_LIKE: '1', JARVIS_AUTO_MEMORY_DIR: AUTO_MEM_DIR },
        encoding: 'utf8',
      },
    );
    assert.equal(child.status, 0, `subprocess failed: ${child.stderr}`);
    const likeResult = JSON.parse(child.stdout);
    assert.equal(likeResult.mode, 'like');
    const likeTurnHit = likeResult.hits.find((h: any) => h.source === 'turn' && h.ref === 'cockpit:sim-a');
    assert.ok(likeTurnHit, 'LIKE mode still finds the cockpit:sim-a turn hit');
    const defaultTurnHit = mbiHits.find((h) => h.source === 'turn' && h.ref === 'cockpit:sim-a');
    assert.equal(likeTurnHit.snippet, defaultTurnHit.snippet, 'snippet text is identical regardless of FTS5 vs LIKE candidate discovery');
    console.log(`      (this process ran in '${getRecallIndexMode()}' mode; child forced 'like')`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[8] selectStaleThreads()');
  const staleNever = getOrCreateConversation('cockpit:sim-stale-never');
  for (let i = 0; i < 7; i++) insertTurnRaw(staleNever.id, i, i % 2 === 0 ? 'user' : 'assistant', `never-summarized turn ${i}`, sqliteNow(-300 + i * 5));

  const staleAfterSummary = getOrCreateConversation('cockpit:sim-stale-after-summary');
  insertTurnRaw(staleAfterSummary.id, 0, 'user', 'pre-summary turn 0', sqliteNow(-600));
  insertTurnRaw(staleAfterSummary.id, 1, 'assistant', 'pre-summary turn 1', sqliteNow(-599));
  insertSummaryRaw(staleAfterSummary.id, 'old summary', 1, sqliteNow(-598));
  for (let i = 2; i < 8; i++) insertTurnRaw(staleAfterSummary.id, i, i % 2 === 0 ? 'user' : 'assistant', `post-summary turn ${i}`, sqliteNow(-590 + i));

  const freshSummary = getOrCreateConversation('cockpit:sim-fresh-summary');
  insertTurnRaw(freshSummary.id, 0, 'user', 'pre-summary turn 0', sqliteNow(-600));
  insertTurnRaw(freshSummary.id, 1, 'assistant', 'pre-summary turn 1', sqliteNow(-599));
  insertSummaryRaw(freshSummary.id, 'fresh summary, no new turns since', 1, sqliteNow(-598));

  const fewTurns = getOrCreateConversation('cockpit:sim-few-turns');
  insertTurnRaw(fewTurns.id, 0, 'user', 'pre-summary turn 0', sqliteNow(-600));
  insertTurnRaw(fewTurns.id, 1, 'assistant', 'pre-summary turn 1', sqliteNow(-599));
  insertSummaryRaw(fewTurns.id, 'summary before the 3 new turns', 1, sqliteNow(-598));
  insertTurnRaw(fewTurns.id, 2, 'user', 'new turn 2', sqliteNow(-595));
  insertTurnRaw(fewTurns.id, 3, 'assistant', 'new turn 3', sqliteNow(-594));
  insertTurnRaw(fewTurns.id, 4, 'user', 'new turn 4', sqliteNow(-593));

  check('8', 'returns never-summarized + post-summary-stale threads; skips fresh-summary + few-turns; never worker/quick', () => {
    const stale = selectStaleThreads({ minTurns: 6, batch: 15 });
    const refs = stale.map((s: any) => s.external_id);
    assert.ok(refs.includes('cockpit:sim-stale-never'), `expected never-summarized thread in ${JSON.stringify(refs)}`);
    assert.ok(refs.includes('cockpit:sim-stale-after-summary'), `expected post-summary-stale thread in ${JSON.stringify(refs)}`);
    assert.ok(!refs.includes('cockpit:sim-fresh-summary'), 'fresh summary must be skipped');
    assert.ok(!refs.includes('cockpit:sim-few-turns'), 'only-3-new-turns thread must be skipped');
    assert.ok(!refs.includes('cockpit:hopper-node-999-abcd'), 'worker thread must never appear, even with >=6 turns');
    assert.ok(!refs.includes('quick:hub1:xyz'), 'quick thread must never appear, even with >=6 turns');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[9] build + routes reachable through the real router');
  check('9a', 'npm run build produced dist/ (this whole script only runs by importing compiled dist/ modules)', () => {
    assert.ok(fs.existsSync(path.join(distDir, 'shared-context.js')));
    assert.ok(fs.existsSync(path.join(distDir, 'recall.js')));
    assert.ok(fs.existsSync(path.join(distDir, 'summary-refresh.js')));
  });
  await checkAsync('9b', 'GET /shared-context/now (admin key) -> 200 with the same <shared_now> text shape', async () => {
    const r = await getJson('/shared-context/now?refresh=1', adminKey);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(typeof r.json.text === 'string' && r.json.text.startsWith('<shared_now as_of='));
    assert.ok(r.json.data && Array.isArray(r.json.data.workstreams));
  });
  await checkAsync('9c', 'GET /shared-context/now (non-admin key) -> 403', async () => {
    const r = await getJson('/shared-context/now', nonAdminKey);
    assert.equal(r.status, 403, JSON.stringify(r.json));
  });
  await checkAsync('9d', `GET /recall?q=${NEEDLE} (admin key) -> 200 with hits[]`, async () => {
    const r = await getJson(`/recall?q=${NEEDLE}`, adminKey);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(Array.isArray(r.json.hits) && r.json.hits.length > 0);
  });
  await checkAsync('9e', `GET /recall?q=${NEEDLE} (non-admin key) -> 403`, async () => {
    const r = await getJson(`/recall?q=${NEEDLE}`, nonAdminKey);
    assert.equal(r.status, 403, JSON.stringify(r.json));
  });

  // ═══════════════════════════════════════════════════════════════════════
  // [10] ADVERSARIAL-REVIEW REGRESSIONS (node #488). Each of these failed
  // against the LIVE DB before the review fixes; they are locked in here so a
  // later change can't quietly undo them.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n[10] adversarial-review regressions (node #488)');

  const SECRET_CONV = getOrCreateConversation('cockpit:sim-secrets');
  insertTurnRaw(
    SECRET_CONV.id,
    0,
    'user',
    `${NEEDLE}REDACT here is the config: export BROWSERBASE_API_KEY=bb_live_kyjGKRtcEmZiU1ibkW and ` +
      `CHIP_RUNNER_API_KEY=crk_lT_iOyMBGxx_KvFC95jF5WZXX58qNRpFGjojnwo2uEU plus Authorization: Bearer abcdef0123456789abcdef`,
    sqliteNow(-300),
  );
  ensureTurnsFts();

  check('10a', 'recall snippets redact pasted credentials (bb_live_/crk_/KEY=/Bearer) — verified leaking on the live DB before the fix', () => {
    const res = recall(`${NEEDLE}REDACT`, { sources: ['turn'], days: 3650 });
    assert.ok(res.hits.length >= 1, `expected the seeded secret turn, got ${JSON.stringify(res.hits)}`);
    const joined = res.hits.map((h: any) => h.snippet).join(' ');
    assert.ok(!/bb_live_kyjGKRtcEmZiU1ibkW/.test(joined), `bb_live key leaked: ${joined}`);
    assert.ok(!/crk_lT_iOyMBGxx/.test(joined), `crk_ token leaked: ${joined}`);
    assert.ok(!/abcdef0123456789abcdef/.test(joined), `bearer token leaked: ${joined}`);
    assert.ok(/\[redacted\]/.test(joined), `expected a [redacted] marker: ${joined}`);
  });

  await checkAsync(
    '10b',
    'recall is term-ORDER independent for terms containing `_` — forced LIKE mode (SQLite binds ESCAPE to the LAST LIKE only)',
    async () => {
      const runChild = (query: string) => {
        const child = spawnSync(
          process.execPath,
          [path.join(__dirname, 'shared-context-like-check.mjs'), distDir, query],
          {
            env: { ...process.env, JARVIS_DB_PATH: DB_PATH, JARVIS_RECALL_FORCE_LIKE: '1', JARVIS_AUTO_MEMORY_DIR: AUTO_MEM_DIR },
            encoding: 'utf8',
          },
        );
        assert.equal(child.status, 0, `subprocess failed: ${child.stderr}`);
        const parsed = JSON.parse(child.stdout);
        assert.equal(parsed.mode, 'like', 'child must run in LIKE mode');
        return parsed.hits.filter((h: any) => h.source === 'turn');
      };
      const underscoreFirst = runChild(`CHIP_RUNNER_API_KEY ${NEEDLE}REDACT`);
      const underscoreLast = runChild(`${NEEDLE}REDACT CHIP_RUNNER_API_KEY`);
      assert.ok(underscoreLast.length >= 1, 'expected the seeded secret turn when the underscore term is last');
      assert.equal(
        underscoreFirst.length,
        underscoreLast.length,
        `LIKE mode is term-order dependent: underscore-first -> ${underscoreFirst.length} turn hit(s), ` +
          `underscore-last -> ${underscoreLast.length}`,
      );
    },
  );

  check('10c', 'branch extraction ignores prose like "status 0 on network/timeout" (the live digest advertised `branch network/timeout`)', () => {
    sqliteDb.prepare(`INSERT INTO hopper_trees (id, topic, origin_thread_ext, status) VALUES (?, ?, ?, 'done')`).run(
      'tree-sim00000004',
      'Sim tree — prose that used to look like a branch',
      'cockpit:sim-a',
    );
    sqliteDb
      .prepare(`INSERT INTO hopper_nodes (tree_id, title, status, result) VALUES (?, 'Review', 'done', ?)`)
      .run('tree-sim00000004', 'client never throws (status 0 on network/timeout), poller tick catch-wrapped.');
    const data = collectSharedNow();
    const prose = data.trees.find((t: any) => t.id === 'tree-sim00000004');
    assert.ok(prose, 'prose tree present');
    assert.equal(prose.branch, null, `expected no branch, got ${prose.branch}`);
    // The real "branch mbi/ledger-v2" form must still be extracted.
    const real = data.trees.find((t: any) => t.id === 'tree-sim00000002');
    assert.equal(real.branch, 'mbi/ledger-v2', `real branch extraction regressed: ${real.branch}`);
  });

  check('10d', 'recall returns a DIVERSE source mix — one long tree cannot take every slot (live "MBI" returned 12/12 tree hits before the fix)', () => {
    // Make one tree overwhelmingly "relevant" by repetition, the exact shape
    // that crowded out the wiki/auto-memory/thread answers on live data.
    // On the live DB "MBI" produced 23 separate tree hits, each scoring in the
    // hundreds — enough to fill all 12 slots. Reproduce that shape: MANY fat
    // trees, not one.
    for (let t = 0; t < 15; t++) {
      const treeId = `tree-simfat${String(t).padStart(5, '0')}`;
      sqliteDb.prepare(`INSERT INTO hopper_trees (id, topic, origin_thread_ext, status) VALUES (?, ?, ?, 'done')`).run(
        treeId,
        `${NEEDLE} fat tree ${t}`,
        'cockpit:sim-a',
      );
      for (let i = 0; i < 8; i++) {
        sqliteDb
          .prepare(`INSERT INTO hopper_nodes (tree_id, title, status, result) VALUES (?, ?, 'done', ?)`)
          .run(treeId, `${NEEDLE} node ${i}`, `${NEEDLE} ${NEEDLE} ${NEEDLE} ${NEEDLE} ${NEEDLE} repeated payload ${i}`);
      }
    }
    const res = recall(NEEDLE, { days: 3650 });
    const sources = new Set(res.hits.map((h: any) => h.source));
    assert.ok(sources.size >= 3, `expected >=3 distinct sources, got ${JSON.stringify([...sources])}`);
    assert.ok(sources.has('auto_memory'), `auto_memory crowded out: ${JSON.stringify([...sources])}`);
    assert.ok(sources.has('thread_summary'), `thread_summary crowded out: ${JSON.stringify([...sources])}`);
  });

  check('10e', 'digest truncation keeps every section alive — no section is wiped to feed another (live digest lost ALL summaries before the fix)', () => {
    const data = collectSharedNow();
    // Enough sections/bullets that a strict tail-first trim MUST wipe the tail
    // sections (that is exactly what happened on live data at the real cap).
    assert.ok(data.trees.length >= 5, `expected the fat trees seeded in 10c: ${data.trees.length}`);
    const text = renderSharedNow(data, 2600);
    assert.ok(data.truncated, 'expected the 2600-char cap to truncate');
    const perSection: Record<string, number> = {};
    let cur: string | null = null;
    for (const line of text.split('\n')) {
      const m = /^## (.+)$/.exec(line);
      if (m) {
        cur = m[1];
        perSection[cur] = 0;
        continue;
      }
      if (cur && line.startsWith('- ') && line !== '- …' && line !== '- (none)') perSection[cur]++;
    }
    const headers = Object.keys(perSection);
    assert.equal(headers.length, 5, `expected all 5 section headers to survive: ${headers.join(' | ')}`);
    const emptied = headers.filter((h) => perSection[h] === 0 && !/\(0 open\)/.test(h));
    assert.equal(emptied.length, 0, `section(s) starved to zero bullets: ${emptied.join(', ')} — ${JSON.stringify(perSection)}`);
  });

} finally {
  server.close();
  owServer?.close();
  fs.rmSync(WIKI_FIXTURE_DIR, { recursive: true, force: true });
  fs.rmSync(AUTO_MEM_DIR, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log(`\n[shared-context-sim] ${passed}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ' ✅'}`);

const outDir = '/home/kevin/obsidian/paperclip-wiki/outbox/shared-context';
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'sim-report.md');
const lines: string[] = [];
lines.push('# SHARED CONTEXT v0 — sim report (hopper node #487)');
lines.push('');
lines.push(`Run at ${new Date().toISOString()}. Scratch DB: \`${DB_PATH}\`. ${passed}/${results.length} checks passed.`);
lines.push('');
lines.push(
  'Drives the real `collectSharedNow`/`renderSharedNow`/`buildSharedNow`/`shouldInjectSharedNow`/`writeSharedNowMirror` ' +
    '(`src/shared-context.ts`), `recall`/`ensureTurnsFts` (`src/recall.ts`), and `selectStaleThreads` (`src/summary-refresh.ts`) ' +
    'from `dist/`, plus the real `createApiV1Router()` over real HTTP on a throwaway port — all against a scratch sqlite copy, ' +
    'never `jarvis.db`. Item 7 (the LIKE-fallback path) runs in a dedicated child process ' +
    '(`scripts/shared-context-like-check.mjs`) because `recall.ts` caches its FTS5-vs-LIKE decision in a module-level variable ' +
    'set at first module load — the only way to exercise the LIKE path for real, not just assert a flag, is a fresh process ' +
    'with `JARVIS_RECALL_FORCE_LIKE=1` set before `dist/recall.js` is ever imported. **Zero live model calls anywhere in this ' +
    'file or its child process** — none of the three modules under test make one either.',
);
lines.push('');
lines.push('| # | Check | Result |');
lines.push('|---|---|---|');
for (const r of results) {
  lines.push(`| ${r.id} | ${r.description} | ${r.pass ? '✅ pass' : `❌ **FAIL** — ${r.error}`} |`);
}
lines.push('');
if (failed.length) {
  lines.push('## Failures');
  lines.push('');
  for (const r of failed) {
    lines.push(`### [${r.id}] ${r.description}`);
    lines.push('');
    lines.push('```');
    lines.push(r.error ?? '(no error captured)');
    lines.push('```');
    lines.push('');
  }
} else {
  lines.push("All checks passed against `CONTRACT.md` §5's acceptance list during this run.");
}
lines.push('');
lines.push('## Notes for JARVIS (review time)');
lines.push('');
lines.push(
  '1. **Wiki fixture touches the real vault, briefly.** `recall.ts`’s `VAULT_ROOT` is hardcoded to ' +
    '`/home/kevin/obsidian/paperclip-wiki` with no env override (unlike `JARVIS_AUTO_MEMORY_DIR`, which the auto-memory ' +
    'source does support). To exercise the real `wiki` source this sim writes one file to ' +
    '`skills/__shared_context_sim_tmp__/SKILL.md` in the real vault and deletes the whole directory in a `finally` block ' +
    'regardless of pass/fail. If the process is killed hard enough to skip the `finally` (e.g. `kill -9`), that directory ' +
    'would be left behind — harmless (clearly-named, easy to spot) but worth a `find` sweep if this sim is ever run unattended.',
);
lines.push(
  '2. **`items 6/7` compare snippet text, not exact hit sets.** FTS5 and LIKE mode discover candidates differently but ' +
    '`buildSnippet` is pure and mode-independent, so the check asserts the `cockpit:sim-a` turn hit’s snippet is byte-identical ' +
    'across both modes rather than asserting the full hit list matches (LIKE mode’s 200-row cap and ordering can differ from ' +
    "FTS5's in ways that don't affect correctness).",
);
fs.writeFileSync(reportPath, lines.join('\n') + '\n');
console.log(`[shared-context-sim] report written: ${reportPath}`);

if (failed.length) process.exitCode = 1;
