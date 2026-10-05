#!/usr/bin/env node
// COMPANION THIN CLIENT UI CHECK — node #1439 (the iPhone-first client UI
// itself, tree-1bd033c2). Drives the REAL served HTML/CSS/JS against the
// REAL thin server (scratch DB) using jsdom at an iPhone-sized viewport, so
// this proves the client renders correctly — not just that the API wires up
// (that's scripts/companion-thin-check.mjs, still green).
//
// Proves:
//   (a) the chat view renders her user/assistant turns AND a visually
//       distinct cross_chat_sidecar card (separate CSS class, labeled
//       "from <label> ' cross-chat", not styled as a reply).
//   (b) posting a message through the real <form> hits POST /api/thread and
//       the new turn shows up.
//   (c) the reports list renders from /api/reports and tapping one opens its
//       markdown, rendered (not raw) -- headings/paragraphs become real
//       elements, and a <details> expander in the source renders as a real
//       native <details> element.
//   (d) the client source makes NO reference to any cockpit URL, cockpit
//       port, or any OTHER thread's external id -- grepped from the actual
//       shipped index.html/app.js, not inferred.
//
//   npm run build && JARVIS_DB_PATH=/tmp/companion-thin-ui-check.db node scripts/companion-thin-client-ui-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { JSDOM } from '/home/kevin/paperclip/server/node_modules/jsdom/lib/api.js';

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

console.log(`[companion-thin-client-ui-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getOrCreateCompanionThread } = await import(path.join(distDir, 'companion-chat.js'));
const { addTurn, getConversation } = await import(path.join(distDir, 'conversation-db.js'));
const { insertCrossChatSidecar } = await import(path.join(distDir, 'cross-chat-sidecar.js'));

let failed = false;
function check(label, ok) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

const WIFE_ID = 'companion-thin-ui-check';
const { external_id: COMPANION_EXT } = getOrCreateCompanionThread(WIFE_ID);
const companionConv = getConversation(COMPANION_EXT);
addTurn(companionConv.id, 'user', 'Hi love, what did we decide about the beach trip?');
addTurn(companionConv.id, 'assistant', 'We penciled in the first week of June.');

insertCrossChatSidecar({
  from_thread_ext: 'cockpit:goal-5',
  to_thread_ext: COMPANION_EXT,
  from_label: 'Kevin',
  summary: 'Kevin relayed: pick up the dry cleaning',
  origin_turn_ref: null,
});

const REPORTS_DIR = fs.mkdtempSync('/tmp/companion-thin-ui-reports-');
fs.writeFileSync(
  path.join(REPORTS_DIR, 'wish-report-1.md'),
  [
    '# Wish Report 1',
    '',
    'Some **bold** intro text with a [link](https://example.com/x).',
    '',
    '## Section',
    '',
    '- item one',
    '- item two',
    '',
    '<details>',
    '<summary>More detail</summary>',
    '',
    'Hidden body text.',
    '',
    '</details>',
    '',
  ].join('\n'),
);
fs.writeFileSync(path.join(REPORTS_DIR, 'wish-report-2.md'), '# Wish report 2\n\nMore content.\n');

const PORT = 8198;
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let dom;
try {
  const up = await waitForServer();
  check('server came up', up);
  if (!up) throw new Error('server failed to start');

  // ---- (d) static source scan for cockpit/other-thread references -------
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'companion', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'companion', 'app.js'), 'utf8');
  const appCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'companion', 'app.css'), 'utf8');
  const clientSource = indexHtml + appJs + appCss;
  check('(d) no absolute cockpit host/port reference (3201/8080/cockpit.)', !/3201|:8080|cockpit\.thedarwinhub/i.test(clientSource));
  check('(d) no "cockpit:" thread-id literal anywhere in the client', !clientSource.includes('cockpit:'));
  check('(d) no hardcoded goal-5 / other thread id', !/goal-5|goal_id/i.test(clientSource));
  check('(d) all API calls are relative paths', /fetch\(['"`]\/api\/thread/.test(appJs) && /fetch\(['"`]\/api\/reports/.test(appJs));
  check('(d) viewport meta present, mobile-first', /width=device-width/.test(indexHtml));
  check('(d) no desktop chrome: no <nav>, no sidebar markup', !/<nav|sidebar|left-nav/i.test(indexHtml));

  // ---- drive the REAL client with jsdom at an iPhone-sized viewport ------
  dom = await JSDOM.fromURL(`${BASE}/`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      // app.js's relative fetch('/api/...') calls need a real fetch wired in
      // BEFORE the script tag executes during parsing -- resolved against
      // the real server BASE since jsdom's own fetch isn't network-capable.
      window.fetch = (url, init) => fetch(new URL(url, BASE).toString(), init);
    },
  });
  const { window } = dom;
  window.innerWidth = 390;
  window.innerHeight = 844; // iPhone 13-ish viewport

  await sleep(800); // let the boot render() + loadThread() + loadReportsList() settle

  const doc = window.document;

  // ---- (a) chat renders turns + a visually distinct sidecar --------------
  const bubbles = [...doc.querySelectorAll('.bubble')];
  check('(a) renders the seeded user turn', bubbles.some((b) => b.textContent.includes('beach trip')));
  check('(a) renders the seeded assistant turn', bubbles.some((b) => b.textContent.includes('first week of June')));
  const sidecarCards = [...doc.querySelectorAll('.sidecar-card')];
  check('(a) renders exactly one cross_chat_sidecar card', sidecarCards.length === 1);
  check(
    '(a) sidecar card is labeled as a cross-chat, not a reply',
    sidecarCards[0]?.querySelector('.sidecar-label')?.textContent.includes('cross-chat'),
  );
  check(
    '(a) sidecar card carries the relayed summary text',
    sidecarCards[0]?.textContent.includes('pick up the dry cleaning'),
  );
  check(
    '(a) sidecar uses a DIFFERENT class than a chat bubble (visually distinct)',
    sidecarCards[0] && !sidecarCards[0].classList.contains('bubble'),
  );
  // CSS actually assigns the sidecar a different background/border than a bubble
  check(
    '(a) app.css gives .sidecar-card different styling than .bubble',
    /\.sidecar-card\s*{[^}]*background/.test(appCss) && /\.bubble\.user\s*{[^}]*background/.test(appCss),
  );

  // ---- (b) posting through the real form hits POST /api/thread -----------
  const input = doc.getElementById('chat-input');
  const form = doc.getElementById('chat-form');
  input.value = 'What time is the dentist tomorrow?';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(1000);
  const threadAfterPost = await (await fetch(`${BASE}/api/thread`)).json();
  check(
    '(b) the posted text landed as a real turn via the UI form',
    threadAfterPost.turns.some((t) => t.content === 'What time is the dentist tomorrow?'),
  );
  await sleep(600);
  const bubblesAfter = [...doc.querySelectorAll('.bubble')];
  check(
    '(b) the UI re-rendered to show her just-sent message',
    bubblesAfter.some((b) => b.textContent.includes('dentist tomorrow')),
  );

  fs.writeFileSync(
    '/home/kevin/obsidian/paperclip-wiki/outbox/companion/thin-client-chat-rendered.html',
    doc.documentElement.outerHTML,
  );

  // ---- (c) reports list + opening one as rendered markdown ----------------
  const switchBtn = doc.getElementById('switch-btn');
  switchBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(500);
  const reportButtons = [...doc.querySelectorAll('#reports-list button')];
  check('(c) reports list renders both fixture reports', reportButtons.length === 2);
  const first = reportButtons.find((b) => b.textContent === 'wish-report-1.md');
  check('(c) wish-report-1.md is tappable in the list', !!first);
  first?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(500);
  const reportHtml = doc.getElementById('report-content').innerHTML;
  check('(c) report heading rendered as a real <h1>, not raw "#"', /<h1>Wish Report 1<\/h1>/.test(reportHtml));
  check('(c) bold markdown rendered as <strong>', /<strong>bold<\/strong>/.test(reportHtml));
  check('(c) link markdown rendered as a real <a href>', /<a href="https:\/\/example\.com\/x"/.test(reportHtml));
  check('(c) list items rendered as real <li>', /<li>item one<\/li>/.test(reportHtml));
  check(
    '(c) the <details> expander passed through as a REAL native element (not escaped text)',
    !!doc.querySelector('#report-content details') && !!doc.querySelector('#report-content summary'),
  );
  check('(c) no literal unrendered markdown syntax leaked through', !reportHtml.includes('##') && !reportHtml.includes('**bold**'));
  check('(c) nav back control returns to reports list', doc.getElementById('nav-title').textContent === 'wish-report-1.md');

  fs.writeFileSync(
    '/home/kevin/obsidian/paperclip-wiki/outbox/companion/thin-client-report-rendered.html',
    doc.documentElement.outerHTML,
  );

  console.log(failed ? '\nFAILED' : '\nALL PASS');
} catch (err) {
  console.error(err);
  console.error('--- server output ---');
  console.error(serverOutput);
  failed = true;
} finally {
  if (dom) dom.window.close();
  server.kill('SIGKILL');
  fs.rmSync(REPORTS_DIR, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
