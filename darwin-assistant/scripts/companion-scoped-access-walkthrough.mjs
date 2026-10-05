#!/usr/bin/env node
// COMPANION SCOPED-ACCESS WALKTHROUGH — node #1445. Not a committed acceptance
// test; a one-shot driver that walks the full allowed/denied/scope-escape
// matrix from the node spec against the real server (scratch DB) and prints
// a result table. Companion of companion-thin-check.mjs /
// companion-thin-client-ui-check.mjs, which already cover most of this —
// this adds the extra denied-route list and the body-based scope-escape case.
//
//   npm run build && JARVIS_DB_PATH=/tmp/companion-walkthrough.db \
//     node scripts/companion-scoped-access-walkthrough.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

console.log(`[walkthrough] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getOrCreateCompanionThread } = await import(path.join(distDir, 'companion-chat.js'));
const { addTurn, getConversation, getOrCreateConversation } = await import(path.join(distDir, 'conversation-db.js'));
const { insertCrossChatSidecar } = await import(path.join(distDir, 'cross-chat-sidecar.js'));

// ── seed: her companion thread + turns + sidecar, plus an unrelated thread ──
const WIFE_ID = 'companion-walkthrough';
const { external_id: COMPANION_EXT } = getOrCreateCompanionThread(WIFE_ID);
const companionConv = getConversation(COMPANION_EXT);
addTurn(companionConv.id, 'user', 'Hi love, what did we decide about the beach trip?');
addTurn(companionConv.id, 'assistant', 'We penciled in the first week of June.');

const OTHER_EXT = 'cockpit:goal-5';
const otherConv = getOrCreateConversation(OTHER_EXT);
addTurn(otherConv.id, 'user', 'unrelated goal-5 content that must never appear to her');

insertCrossChatSidecar({
  from_thread_ext: OTHER_EXT,
  to_thread_ext: COMPANION_EXT,
  from_label: 'Goal 5',
  summary: 'Kevin relayed: pick up the dry cleaning',
  origin_turn_ref: null,
});

// ── fixture reports dir: 2 sample wish-catalog reports + an outside secret ──
const REPORTS_DIR = fs.mkdtempSync('/tmp/companion-walkthrough-reports-');
fs.writeFileSync(
  path.join(REPORTS_DIR, 'wish-report-1.md'),
  '# Wish Report 1\n\nSome **bold** intro text.\n\n- item one\n- item two\n',
);
fs.writeFileSync(path.join(REPORTS_DIR, 'wish-report-2.md'), '# Wish Report 2\n\nMore content.\n');
const secretDir = fs.mkdtempSync('/tmp/companion-walkthrough-secret-');
fs.writeFileSync(path.join(secretDir, 'secret.md'), 'TOP SECRET — should never be served');

// ── start the real server ───────────────────────────────────────────────────
const PORT = parseInt(process.env.COMPANION_THIN_PORT ?? '8277', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [path.join(distDir, 'companion-thin-server.js')], {
  env: {
    ...process.env,
    JARVIS_DB_PATH: DB_PATH,
    COMPANION_THREAD_EXT: COMPANION_EXT,
    COMPANION_REPORTS_DIR: REPORTS_DIR,
    COMPANION_THIN_PORT: String(PORT),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
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

const results = { allowed: [], denied: [] };
function recordAllowed(target, observed, verdict) { results.allowed.push({ target, observed, verdict }); }
function recordDenied(target, observed, verdict) { results.denied.push({ target, observed, verdict }); }

let dom;
try {
  const up = await waitForServer();
  if (!up) {
    console.error('FATAL: server failed to start');
    console.error(serverOutput);
    process.exit(1);
  }
  console.log(`[walkthrough] server up on ${BASE} (thread ${COMPANION_EXT})`);

  // ── ALLOWED ────────────────────────────────────────────────────────────
  const rootRes = await fetch(`${BASE}/`);
  recordAllowed('GET /', `${rootRes.status}, content-type ${rootRes.headers.get('content-type')}`, rootRes.status === 200 ? 'PASS' : 'FAIL');

  const threadRes = await fetch(`${BASE}/api/thread`);
  const threadBody = await threadRes.json();
  const hasSidecar = threadBody.turns?.some((t) => t.role === 'cross_chat_sidecar');
  const noLeak = !threadBody.turns?.some((t) => (t.content ?? '').includes('unrelated goal-5 content'));
  recordAllowed(
    'GET /api/thread',
    `${threadRes.status}, external_id=${threadBody.external_id}, turns=${threadBody.turns?.length}, sidecar=${hasSidecar}, no-leak=${noLeak}`,
    threadRes.status === 200 && threadBody.external_id === COMPANION_EXT && hasSidecar && noLeak ? 'PASS' : 'FAIL',
  );

  const beforeCount = threadBody.turns.length;
  const postRes = await fetch(`${BASE}/api/thread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Quick question for you, love.' }),
  });
  await new Promise((r) => setTimeout(r, 500));
  const afterRes = await fetch(`${BASE}/api/thread`);
  const afterBody = await afterRes.json();
  const newTurns = afterBody.turns.length - beforeCount;
  const landedCorrectText = afterBody.turns.some((t) => t.content === 'Quick question for you, love.' && t.role === 'user');
  recordAllowed(
    'POST /api/thread {text}',
    `${postRes.status}, new turns appended=${newTurns}, exact-one-user-turn=${landedCorrectText}`,
    postRes.status === 202 && newTurns === 1 && landedCorrectText ? 'PASS' : 'FAIL',
  );

  const listRes = await fetch(`${BASE}/api/reports`);
  const listBody = await listRes.json();
  const listedBoth = listBody.reports?.sort().join(',') === 'wish-report-1.md,wish-report-2.md';
  recordAllowed('GET /api/reports', `${listRes.status}, reports=${JSON.stringify(listBody.reports)}`, listRes.status === 200 && listedBoth ? 'PASS' : 'FAIL');

  const oneRes = await fetch(`${BASE}/api/reports/wish-report-1.md`);
  const oneText = await oneRes.text();
  recordAllowed(
    'GET /api/reports/<name>',
    `${oneRes.status}, returns markdown=${oneText.includes('# Wish Report 1')}`,
    oneRes.status === 200 && oneText.includes('# Wish Report 1') ? 'PASS' : 'FAIL',
  );

  // ── DENIED / ABSENT (must all 404) ──────────────────────────────────────
  const deniedTargets = [
    '/threads', '/api/v1/threads', '/goals', '/goals/5', '/cockpit', '/flight-deck',
    '/work-switch', '/hopper-trees', '/api/conversations', '/events', '/api/events',
    '/settings', '/notepad', '/app',
  ];
  for (const target of deniedTargets) {
    const r = await fetch(`${BASE}${target}`);
    recordDenied(`GET ${target}`, `${r.status}`, r.status === 404 ? 'PASS' : 'FAIL');
  }

  // ── SCOPE-ESCAPE ATTEMPTS ────────────────────────────────────────────────
  const spoofGetRes = await fetch(`${BASE}/api/thread?ext=${encodeURIComponent(OTHER_EXT)}`);
  const spoofGetBody = await spoofGetRes.json();
  const spoofGetOk = spoofGetBody.external_id === COMPANION_EXT && !spoofGetBody.turns.some((t) => (t.content ?? '').includes('unrelated goal-5 content'));
  recordDenied(
    'GET /api/thread?ext=cockpit:goal-5',
    `${spoofGetRes.status}, external_id=${spoofGetBody.external_id} (her thread returned regardless)`,
    spoofGetRes.status === 200 && spoofGetOk ? 'PASS' : 'FAIL',
  );

  for (const field of ['ext', 'external_id', 'thread']) {
    const beforeSpoof = (await (await fetch(`${BASE}/api/thread`)).json()).turns.length;
    const spoofPostRes = await fetch(`${BASE}/api/thread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `scope escape via ${field}`, [field]: OTHER_EXT }),
    });
    await new Promise((r) => setTimeout(r, 300));
    const afterSpoof = await (await fetch(`${BASE}/api/thread`)).json();
    const landedInHers = afterSpoof.turns.some((t) => t.content === `scope escape via ${field}` && t.role === 'user');
    const otherConvCheck = getConversation(OTHER_EXT);
    const otherTurnsAfter = (await import(path.join(distDir, 'conversation-db.js'))).getTurnsLean(otherConvCheck.id);
    const leakedToOther = otherTurnsAfter.some((t) => t.content === `scope escape via ${field}`);
    recordDenied(
      `POST /api/thread {text, ${field}: cockpit:goal-5}`,
      `${spoofPostRes.status}, landed-in-her-thread=${landedInHers}, leaked-to-other-thread=${leakedToOther}, delta=${afterSpoof.turns.length - beforeSpoof}`,
      spoofPostRes.status === 202 && landedInHers && !leakedToOther ? 'PASS' : 'FAIL',
    );
  }

  const traversalRes = await fetch(`${BASE}/api/reports/..%2f..%2f..%2fetc%2fpasswd`);
  const traversalText = await traversalRes.text();
  recordDenied(
    'GET /api/reports/..%2f..%2f..%2fetc%2fpasswd',
    `${traversalRes.status}, body=${traversalText.slice(0, 60)}`,
    traversalRes.status === 404 && !traversalText.toLowerCase().includes('root:') ? 'PASS' : 'FAIL',
  );

  // ── jsdom iPhone viewport render check ──────────────────────────────────
  const { JSDOM } = await import('/home/kevin/paperclip/server/node_modules/jsdom/lib/api.js');
  dom = await JSDOM.fromURL(`${BASE}/`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url, init) => fetch(new URL(url, BASE).toString(), init);
    },
  });
  const { window } = dom;
  window.innerWidth = 390;
  window.innerHeight = 844;
  await new Promise((r) => setTimeout(r, 800));
  const doc = window.document;
  const bubbles = [...doc.querySelectorAll('.bubble')];
  const sidecarCards = [...doc.querySelectorAll('.sidecar-card')];
  const hasNav = /<nav|sidebar|left-nav/i.test(doc.documentElement.outerHTML);
  const chatRenders = bubbles.some((b) => b.textContent.includes('beach trip'));
  const sidecarRenders = sidecarCards.length === 1;
  console.log(
    `[walkthrough] iPhone viewport (390x844): chat renders=${chatRenders}, sidecar card renders=${sidecarRenders}, no nav/cockpit chrome=${!hasNav}`,
  );
  results.viewport = { chatRenders, sidecarRenders, noChrome: !hasNav };

  // Reports reader at same viewport
  const switchBtn = doc.getElementById('switch-btn');
  switchBtn?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  const reportButtons = [...doc.querySelectorAll('#reports-list button')];
  console.log(`[walkthrough] reports list at viewport renders ${reportButtons.length} entries`);
  results.viewport.reportsRender = reportButtons.length === 2;

  console.log('\n=== ALLOWED ===');
  for (const r of results.allowed) console.log(`${r.verdict}  ${r.target}  —  ${r.observed}`);
  console.log('\n=== DENIED / SCOPE-ESCAPE ===');
  for (const r of results.denied) console.log(`${r.verdict}  ${r.target}  —  ${r.observed}`);

  fs.writeFileSync('/tmp/companion-walkthrough-results.json', JSON.stringify(results, null, 2));
  console.log('\n[walkthrough] results written to /tmp/companion-walkthrough-results.json');

  var exitCode = [...results.allowed, ...results.denied].some((r) => r.verdict === 'FAIL') ? 1 : 0;
  console.log(exitCode ? '\nFAILED' : '\nALL PASS');
} catch (err) {
  console.error(err);
  console.error('--- server output ---');
  console.error(serverOutput);
  exitCode = 1;
} finally {
  if (dom) dom.window.close();
  server.kill('SIGKILL');
  fs.rmSync(REPORTS_DIR, { recursive: true, force: true });
  fs.rmSync(secretDir, { recursive: true, force: true });
}
process.exit(exitCode ?? 1);
