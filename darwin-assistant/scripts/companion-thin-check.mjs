#!/usr/bin/env node
// COMPANION THIN CLIENT CHECK — acceptance test for node #1438 (her own
// dedicated thin companion service, tree-1bd033c2). Exercises the real HTTP
// server from dist/companion-thin-server.js against a scratch jarvis.db.
// NEVER the live DB; sim-guard (src/sim-guard.ts) refuses any model turn on a
// scratch DB, so this proves wiring, not a real Opus reply. Proves:
//
//   (a) GET /api/thread returns ONLY her companion thread's messages,
//       including the cross_chat_sidecar card.
//   (b) a client-supplied ?ext= query param is ignored — still only her
//       thread comes back.
//   (c) POST /api/thread appends a real user turn (via the same addTurn()
//       primitive every other ingress uses) and dispatches to the existing
//       processMessage pipeline — sim-guard legitimately blocks the model
//       call on this scratch DB, spawning zero claude processes.
//   (d) GET /api/reports lists the fixture reports dir; GET
//       /api/reports/:name returns one report's raw markdown.
//   (e) a traversal attempt against /api/reports/:name is rejected.
//   (f) everything not in the five wired routes 404s: /threads,
//       /hopper-trees, /goals/5, /work-switch.
//   (g) catalog-only scoping: a sibling report sitting in the PARENT of the
//       configured COMPANION_REPORTS_DIR never leaks into the listing.
//   (h) fail-closed: a COMPANION_REPORTS_DIR that does not exist on disk
//       yields an empty list with a clean 200 -- never a crash, never a
//       fallback to any other directory.
//
//   npm run build && JARVIS_DB_PATH=/tmp/companion-thin-check.db node scripts/companion-thin-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard ─────────────────────────────────────────────────────────
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

console.log(`[companion-thin-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getOrCreateCompanionThread } = await import(path.join(distDir, 'companion-chat.js'));
const { addTurn, getConversation } = await import(path.join(distDir, 'conversation-db.js'));
const { insertCrossChatSidecar } = await import(path.join(distDir, 'cross-chat-sidecar.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

// ── seed: her companion thread + a couple of turns + one sidecar ───────────
const WIFE_ID = 'companion-thin-check';
const { external_id: COMPANION_EXT } = getOrCreateCompanionThread(WIFE_ID);
const companionConv = getConversation(COMPANION_EXT);
addTurn(companionConv.id, 'user', 'Hi, what did we decide about the beach trip?');
addTurn(companionConv.id, 'assistant', 'We penciled in the first week of June.');

// a second, unrelated thread the service must NEVER leak into her view
const OTHER_EXT = 'cockpit:goal-5';
const { getOrCreateConversation } = await import(path.join(distDir, 'conversation-db.js'));
const otherConv = getOrCreateConversation(OTHER_EXT);
addTurn(otherConv.id, 'user', 'unrelated goal-5 content that must never appear to her');

const sidecarResult = insertCrossChatSidecar({
  from_thread_ext: OTHER_EXT,
  to_thread_ext: COMPANION_EXT,
  from_label: 'Goal 5',
  summary: 'Kevin relayed: pick up the dry cleaning',
  origin_turn_ref: null,
});
check('seed: cross_chat_sidecar landed in her thread', sidecarResult !== null);

// ── fixture reports dir ──────────────────────────────────────────────────────
// REPORTS_DIR is a catalog-only subdir of a PARENT that also holds an
// unrelated report -- proves (g) the parent's sibling file never leaks into
// her listing just because it shares a parent with the configured dir.
const REPORTS_PARENT = fs.mkdtempSync('/tmp/companion-thin-parent-');
const REPORTS_DIR = path.join(REPORTS_PARENT, 'wish-catalog');
fs.mkdirSync(REPORTS_DIR);
fs.writeFileSync(path.join(REPORTS_DIR, 'wish-report-1.md'), '# Wish report 1\n\nSome content.\n');
fs.writeFileSync(path.join(REPORTS_DIR, 'wish-report-2.md'), '# Wish report 2\n\nMore content.\n');
fs.writeFileSync(path.join(REPORTS_PARENT, 'unrelated-accounting-report.md'), 'SHOULD NEVER APPEAR TO HER — outside the catalog dir');
// a secret OUTSIDE the reports dir a traversal attempt must never reach
const secretDir = fs.mkdtempSync('/tmp/companion-thin-secret-');
fs.writeFileSync(path.join(secretDir, 'secret.md'), 'TOP SECRET — should never be served');

// ── start the real server as a child process ────────────────────────────────
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(
  process.execPath,
  [path.join(distDir, 'companion-thin-server.js')],
  {
    env: {
      ...process.env,
      JARVIS_DB_PATH: DB_PATH,
      COMPANION_THREAD_EXT: COMPANION_EXT,
      COMPANION_REPORTS_DIR: REPORTS_DIR,
      COMPANION_THIN_PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverOutput = '';
server.stdout.on('data', (d) => { serverOutput += d.toString(); });
server.stderr.on('data', (d) => { serverOutput += d.toString(); });

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function countClaudeProcesses() {
  // Best-effort: count live `claude` CLI processes so we can show the delta
  // is zero across the POST below (the hard "zero claude processes" rule).
  return new Promise((resolve) => {
    const ps = spawn('pgrep', ['-c', '-f', 'bin/claude']);
    let out = '';
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.on('close', () => resolve(parseInt(out.trim(), 10) || 0));
    ps.on('error', () => resolve(0));
  });
}

let missingDirServer;
try {
  const up = await waitForServer();
  check('server came up', up);
  if (!up) {
    console.error(serverOutput);
    throw new Error('server failed to start');
  }

  // -- (a) GET /api/thread returns only her thread, including the sidecar ----
  const threadRes = await fetch(`${BASE}/api/thread`);
  check('(a) GET /api/thread -> 200', threadRes.status === 200);
  const threadBody = await threadRes.json();
  check('(a) external_id is her companion thread', threadBody.external_id === COMPANION_EXT);
  const roles = threadBody.turns.map((t) => t.role);
  check('(a) contains both seeded turns', roles.filter((r) => r === 'user' || r === 'assistant').length === 2);
  const sidecarTurn = threadBody.turns.find((t) => t.role === 'cross_chat_sidecar');
  check('(a) contains the cross_chat_sidecar card', !!sidecarTurn);
  check(
    '(a) sidecar content matches the relayed summary',
    sidecarTurn?.content === 'Kevin relayed: pick up the dry cleaning',
  );
  check(
    '(a) no content from the unrelated goal-5 thread leaked in',
    !threadBody.turns.some((t) => (t.content ?? '').includes('unrelated goal-5 content')),
  );

  // -- (b) a client-supplied ?ext= is ignored ----------------------------------
  const spoofRes = await fetch(`${BASE}/api/thread?ext=${encodeURIComponent(OTHER_EXT)}`);
  const spoofBody = await spoofRes.json();
  check('(b) ?ext= override is ignored — still her thread', spoofBody.external_id === COMPANION_EXT);
  check(
    '(b) still no goal-5 content leaked via the spoofed ext',
    !spoofBody.turns.some((t) => (t.content ?? '').includes('unrelated goal-5 content')),
  );

  // -- (c) POST /api/thread appends a real user turn; zero claude spawned -----
  const beforeClaudeCount = await countClaudeProcesses();
  const beforeTurns = threadBody.turns.length;
  const postRes = await fetch(`${BASE}/api/thread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Quick question for you, love.' }),
  });
  check('(c) POST /api/thread -> 202', postRes.status === 202);
  // give the fire-and-forget processMessage() call a moment to be refused by sim-guard
  await new Promise((r) => setTimeout(r, 500));
  const afterRes = await fetch(`${BASE}/api/thread`);
  const afterBody = await afterRes.json();
  const newUserTurn = afterBody.turns.find((t) => t.content === 'Quick question for you, love.');
  check('(c) the posted text landed as a real user turn', !!newUserTurn);
  check('(c) role is user', newUserTurn?.role === 'user');
  check('(c) exactly one new turn appended (no duplicate from resumeLastUserTurn)', afterBody.turns.length === beforeTurns + 1);
  const afterClaudeCount = await countClaudeProcesses();
  check('(c) zero claude processes spawned by the POST (sim-guard held)', afterClaudeCount === beforeClaudeCount);
  check(
    '(c) sim-guard actually fired (visible in server output)',
    serverOutput.includes('[sim-guard]') || serverOutput.includes('sim-guard'),
  );

  // -- (d) reports listing + single-report fetch -------------------------------
  const listRes = await fetch(`${BASE}/api/reports`);
  const listBody = await listRes.json();
  check('(d) GET /api/reports lists both fixtures', listBody.reports?.sort().join(',') === 'wish-report-1.md,wish-report-2.md');
  const oneRes = await fetch(`${BASE}/api/reports/wish-report-1.md`);
  const oneText = await oneRes.text();
  check('(d) GET /api/reports/:name -> 200', oneRes.status === 200);
  check('(d) returns the raw markdown', oneText.includes('# Wish report 1'));

  // -- (g) catalog-only scoping: the parent's sibling report never leaks ------
  check(
    '(g) sibling report in the PARENT of REPORTS_DIR is NOT listed',
    !listBody.reports?.includes('unrelated-accounting-report.md'),
  );
  const siblingFetch = await fetch(`${BASE}/api/reports/unrelated-accounting-report.md`);
  check('(g) fetching the sibling report by name -> 404 (not in the live listing)', siblingFetch.status === 404);

  // -- (e) traversal attempt is rejected ---------------------------------------
  const traversalRes = await fetch(`${BASE}/api/reports/${encodeURIComponent('../../etc/passwd')}`);
  check('(e) traversal via encoded ../../ -> 404', traversalRes.status === 404);
  const traversal2 = await fetch(`${BASE}/api/reports/..%2F..%2Fetc%2Fpasswd`);
  check('(e) traversal via %2F-encoded slashes -> 404', traversal2.status === 404);
  const secretName = encodeURIComponent(`../${path.basename(secretDir)}/secret.md`);
  const traversal3 = await fetch(`${BASE}/api/reports/${secretName}`);
  check('(e) traversal to the real secret file outside REPORTS_DIR -> 404', traversal3.status === 404);

  // -- (f) everything else 404s -------------------------------------------------
  for (const p of ['/threads', '/hopper-trees', '/goals/5', '/work-switch']) {
    const r = await fetch(`${BASE}${p}`);
    check(`(f) GET ${p} -> 404`, r.status === 404);
  }

  // -- (h) fail-closed: a COMPANION_REPORTS_DIR that does not exist on disk ---
  const MISSING_DIR = path.join(REPORTS_PARENT, 'does-not-exist-at-all');
  const PORT2 = 8198;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  missingDirServer = spawn(process.execPath, [path.join(distDir, 'companion-thin-server.js')], {
    env: {
      ...process.env,
      JARVIS_DB_PATH: DB_PATH,
      COMPANION_THREAD_EXT: COMPANION_EXT,
      COMPANION_REPORTS_DIR: MISSING_DIR,
      COMPANION_THIN_PORT: String(PORT2),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let up2Actual = false;
  {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE2}/`);
        if (r.status === 200) { up2Actual = true; break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  check('(h) server with a nonexistent COMPANION_REPORTS_DIR still comes up', up2Actual);
  if (up2Actual) {
    const missingListRes = await fetch(`${BASE2}/api/reports`);
    check('(h) GET /api/reports -> 200 even with a missing dir (no crash)', missingListRes.status === 200);
    const missingListBody = await missingListRes.json();
    check('(h) reports list is empty, not a crash and not the whole outbox', Array.isArray(missingListBody.reports) && missingListBody.reports.length === 0);
  }

  console.log(failed ? '\nFAILED' : '\nALL PASS');
} catch (err) {
  console.error(err);
  console.error('--- server output ---');
  console.error(serverOutput);
  failed = true;
} finally {
  server.kill('SIGKILL');
  if (missingDirServer) missingDirServer.kill('SIGKILL');
  fs.rmSync(REPORTS_PARENT, { recursive: true, force: true });
  fs.rmSync(secretDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
