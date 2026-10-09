#!/usr/bin/env node
// PAGE COMPANION EXTENSION — REAL BROWSER E2E (tree-e753d989, node #1575).
//
// Loads the unpacked extension into a real Chromium, points it at the REAL
// Express /page-companion router running over real HTTP on a scratch sqlite DB,
// and proves the two things "done" means:
//
//   1. on a REGISTERED page the floating button appears with the right chat count
//   2. on an UNREGISTERED page nothing is injected at all (zero DOM touch)
//
// Hermetic: scratch /tmp DB, 127.0.0.1 only, zero model calls, the live
// jarvis.db is never opened. Run it under a display:
//
//   xvfb-run -a node test/e2e-browser.mjs
//
// Env: JARVIS_DB_PATH (must be under /tmp), PW_HEADLESS=1 to skip xvfb.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(EXT_DIR, '..');
const ASSISTANT = path.join(REPO, 'darwin-assistant');
// Playwright + its browsers live in the cockpit app, not here (this extension
// deliberately has no dependencies of its own). A worktree has no installed
// node_modules of its own, so fall back to wherever one exists — read-only.
function findPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_DIR,
    path.join(REPO, 'jarvis-command-center', 'node_modules', 'playwright'),
    '/home/kevin/paperclip/jarvis-command-center/node_modules/playwright',
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.js'))) return path.join(dir, 'index.js');
  }
  console.error(`FATAL: playwright not found. Looked in:\n  ${candidates.join('\n  ')}`);
  process.exit(1);
}

// ── guards ───────────────────────────────────────────────────────────────
const raw = process.env.JARVIS_DB_PATH || '/tmp/page-companion-e2e.db';
if (!/^\/tmp\//.test(raw)) {
  console.error('FATAL: JARVIS_DB_PATH must be a scratch path under /tmp.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve(ASSISTANT, 'jarvis.db') || DB_PATH.includes('/home/kevin/paperclip/')) {
  console.error('FATAL: refusing to run against a real jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
process.env.JARVIS_DB_PATH = DB_PATH;
process.env.CLAUDE_USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'page-companion-e2e-usage-'));
process.env.JARVIS_SIM = '1';
process.env.MIKE_RADAR_DRIVER = '0';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

const dist = path.join(ASSISTANT, 'dist');
const express = (await import(path.join(ASSISTANT, 'node_modules', 'express', 'index.js'))).default;
const { createApiV1Router } = await import(path.join(dist, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(dist, 'api-keys.js'));
const { getOrCreateConversation, renameConversation, addTurn } =
  await import(path.join(dist, 'conversation-db.js'));
const { addThreadLink } = await import(path.join(dist, 'thread-links.js'));
const { upsertPageRegistry } = await import(path.join(dist, 'page-companion.js'));
// playwright/index.js is CommonJS — under ESM import the named exports land on
// `default` in some builds and on the namespace in others.
const pw = await import(findPlaywright());
const chromium = pw.chromium ?? pw.default?.chromium;

const cleanup = [];
async function shutdown(code) {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* best effort */ } }
  process.exit(code);
}

// ── the static pages Kevin "opens" ───────────────────────────────────────
const REGISTERED_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="jarvis-page" content="e2e-registered"><title>Registered test page</title></head>
<body><h1 id="own">A page JARVIS built</h1></body></html>`;
const UNREGISTERED_HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>Some other page</title></head><body><h1 id="own">Not ours</h1></body></html>`;

const pagesApp = express();
pagesApp.get('/registered', (_q, r) => r.type('html').send(REGISTERED_HTML));
pagesApp.get('/unregistered', (_q, r) => r.type('html').send(UNREGISTERED_HTML));
const pagesServer = await new Promise((r) => { const s = pagesApp.listen(0, '127.0.0.1', () => r(s)); });
cleanup.push(() => new Promise((r) => pagesServer.close(r)));
const PAGES_ORIGIN = `http://127.0.0.1:${pagesServer.address().port}`;

// ── the real API ─────────────────────────────────────────────────────────
const apiApp = express();
apiApp.use(express.json());
apiApp.use('/api/v1', createApiV1Router());
const apiServer = await new Promise((r) => { const s = apiApp.listen(0, '127.0.0.1', () => r(s)); });
cleanup.push(() => new Promise((r) => apiServer.close(r)));
const API_BASE = `http://127.0.0.1:${apiServer.address().port}/api/v1`;
const KEY = mintApiKey('page-companion-e2e', 'admin').plaintext;

// ── fixtures: one registered page with two chats on it ───────────────────
const REGISTERED_URL = `${PAGES_ORIGIN}/registered`;
upsertPageRegistry({
  url_pattern: `127.0.0.1:${pagesServer.address().port}/registered`,
  project: 'E2E Test Dashboard',
  primary_thread_ext: null,
  source: 'manual',
});
for (const [ext, title] of [['cockpit:e2e-one', 'First chat about the page'], ['cockpit:e2e-two', 'Second chat']]) {
  const c = getOrCreateConversation(ext);
  renameConversation(c.id, title);
  addThreadLink(c.id, REGISTERED_URL, 'E2E Test Dashboard');
  addTurn(c.id, 'user', 'build it');
}

// Sanity: the server agrees before we involve a browser at all.
const probe = await fetch(`${API_BASE}/page-companion/lookup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ url: REGISTERED_URL }),
}).then((r) => r.json());
t('server says the fixture page is ours with 2 chats',
  probe.ours === true && probe.threads?.length === 2, JSON.stringify(probe));

// ── the browser ──────────────────────────────────────────────────────────
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-companion-profile-'));
const headless = process.env.PW_HEADLESS === '1';
const context = await chromium.launchPersistentContext(userDataDir, {
  headless,
  args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
});
cleanup.push(() => context.close());
cleanup.push(() => fs.promises.rm(userDataDir, { recursive: true, force: true }));

// The MV3 service worker registering at all is the "zero manifest errors" proof:
// Chrome refuses to load an extension whose manifest is invalid, and a worker
// that failed to parse never reports in.
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
const extensionId = new URL(worker.url()).host;
t('extension loaded and its MV3 service worker is live', Boolean(extensionId), worker.url());

// Configure it the way Kevin would: through the real options page.
const options = await context.newPage();
await options.goto(`chrome-extension://${extensionId}/options.html`);
await options.fill('#cockpitBase', API_BASE);
await options.fill('#apiBase', '');
await options.fill('#apiKey', KEY);
const resolved = (await options.textContent('#resolved'))?.trim();
t('options page resolves the endpoint it will POST to',
  resolved === `${API_BASE}/page-companion/lookup`, resolved);
await options.click('#save');
await options.click('#test');
await options.waitForFunction(
  () => (document.getElementById('status')?.textContent || '').trim() !== 'Testing…' &&
        (document.getElementById('status')?.textContent || '').trim() !== '',
  null, { timeout: 15_000 },
);
const testStatus = (await options.textContent('#status'))?.trim();
t('options "Test connection" reaches the API', /^Connected\./.test(testStatus ?? ''), testStatus);
await options.close();

// 1. the registered page
const good = await context.newPage();
const logs = [];
good.on('console', (m) => logs.push(m.text()));
await good.goto(REGISTERED_URL);

let injected = true;
try {
  await good.waitForSelector('#jarvis-page-companion-host', { state: 'attached', timeout: 15_000 });
} catch {
  injected = false;
}
t('registered page: the floating button is injected', injected);

if (injected) {
  const host = good.locator('#jarvis-page-companion-host');
  t('button host carries the project name', (await host.getAttribute('data-project')) === 'E2E Test Dashboard',
    String(await host.getAttribute('data-project')));
  // Playwright's selector engine pierces open shadow roots, so this reaches
  // inside the Shadow DOM the same way a human's eye does.
  const badge = good.locator('#jarvis-page-companion-host .badge');
  t('badge shows the related-chat count (2)', (await badge.textContent())?.trim() === '2',
    String(await badge.textContent()));
  t('badge is visible', await badge.isVisible());

  const btn = good.locator('#jarvis-page-companion-host .btn');
  t('button title names the project and the count',
    /E2E Test Dashboard — 2 JARVIS chats about this page/.test((await btn.getAttribute('title')) ?? ''),
    String(await btn.getAttribute('title')));

  // Shadow DOM isolation: nothing of ours is reachable from the page's own tree.
  const leak = await good.evaluate(() => {
    const host = document.getElementById('jarvis-page-companion-host');
    return { children: document.body.children.length, light: host.children.length, shadow: Boolean(host.shadowRoot) };
  });
  t('injection is one shadow host and nothing else',
    leak.children === 2 && leak.light === 0 && leak.shadow === true, JSON.stringify(leak));

  // The real panel: a tab per related chat, an embedded iframe for the active
  // one (both the page and the API mock are plain http here, so embedding is
  // always legal), a manual pop-out, and "+ New" creating a chat server-side.
  await btn.click();
  await good.waitForSelector('#jarvis-page-companion-host .panel:not([hidden])', { timeout: 5_000 });
  const panelTitle = (await good.locator('#jarvis-page-companion-host .panel-title').textContent())?.trim();
  t('panel title shows the project name', panelTitle === 'E2E Test Dashboard', panelTitle ?? '');

  const tabs = good.locator('#jarvis-page-companion-host .tab');
  t('one tab per related chat plus "+ New"', (await tabs.count()) === 3, String(await tabs.count()));

  const GROUP_Q = `?group=${encodeURIComponent('E2E Test Dashboard')}`;
  const expectedSrcs = [
    `${API_BASE}/thread/${encodeURIComponent('cockpit:e2e-one')}${GROUP_Q}`,
    `${API_BASE}/thread/${encodeURIComponent('cockpit:e2e-two')}${GROUP_Q}`,
  ];
  const frameSrc1 = await good.locator('#jarvis-page-companion-host .frame-wrap iframe').getAttribute('src');
  t('the active tab embeds an iframe at /thread/<external_id>', expectedSrcs.includes(frameSrc1 ?? ''), String(frameSrc1));

  // Switch to whichever thread tab isn't already active.
  const firstIsActive = (await tabs.nth(0).getAttribute('class'))?.includes('active');
  await tabs.nth(firstIsActive ? 1 : 0).click();
  await good.waitForTimeout(150);
  const frameSrc2 = await good.locator('#jarvis-page-companion-host .frame-wrap iframe').getAttribute('src');
  t('switching tabs swaps the iframe src',
    expectedSrcs.includes(frameSrc2 ?? '') && frameSrc2 !== frameSrc1, String(frameSrc2));

  // The manual pop-out always works, even on an already-embedded tab.
  const [popup] = await Promise.all([
    context.waitForEvent('page', { timeout: 5_000 }),
    good.locator('#jarvis-page-companion-host .popout-btn').click(),
  ]);
  t('the pop-out button opens the thread in its own window',
    popup.url().startsWith(`${API_BASE}/thread/cockpit%3A`), popup.url());
  await popup.close();

  // "+ New" creates a chat server-side and opens it as a fourth, embedded tab.
  await tabs.last().click();
  await good.waitForFunction(
    () => document.getElementById('jarvis-page-companion-host').shadowRoot.querySelectorAll('.tab').length === 4,
    null, { timeout: 10_000 },
  );
  t('"+ New" adds a fourth tab', true);
  const newFrameSrc = await good.locator('#jarvis-page-companion-host .frame-wrap iframe').getAttribute('src');
  t('the new chat becomes the active, embedded tab',
    (newFrameSrc ?? '').startsWith(`${API_BASE}/thread/cockpit%3A`) && !expectedSrcs.includes(newFrameSrc),
    String(newFrameSrc));
  t('console carries no stray errors from the panel build', !logs.some((l) => /error/i.test(l)), logs.join(' | '));

  if (process.env.E2E_SHOT) {
    await good.screenshot({ path: process.env.E2E_SHOT });
    console.log(`  · screenshot → ${process.env.E2E_SHOT}`);
  }
}
await good.close();

// 2. the unregistered page — the important negative
const other = await context.newPage();
await other.goto(`${PAGES_ORIGIN}/unregistered`);
await other.waitForTimeout(2500); // generous: well past the lookup round trip
const untouched = await other.evaluate(() => ({
  host: Boolean(document.getElementById('jarvis-page-companion-host')),
  bodyChildren: document.body.children.length,
  bodyHtml: document.body.innerHTML.trim(),
  styles: document.querySelectorAll('style,link[rel=stylesheet]').length,
}));
t('unregistered page: no button injected', untouched.host === false);
t('unregistered page: DOM is byte-identical to what the server sent',
  untouched.bodyHtml === '<h1 id="own">Not ours</h1>' && untouched.bodyChildren === 1,
  JSON.stringify(untouched));
t('unregistered page: no stylesheet injected', untouched.styles === 0, String(untouched.styles));
await other.close();

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
await shutdown(fail === 0 ? 0 : 1);
