#!/usr/bin/env node
// NOTEPAD PROVENANCE CHECK (node #879) — the independent, end-to-end check
// this node is judged on: given a realistic day containing all four acted
// kinds plus un-acted lines, every action_ref resolves to a live target
// (zero dangling), a deleted target renders LOUDLY broken (both over the
// API and in the real cockpit UI), un-acted lines never produce action
// rows, and nothing ever resolves to DAR/Paperclip.
//
// Drives the REAL backend (startUiServer() on a spare port, scratch DB —
// never the live jarvis.db, never today's real notepad rows) and the REAL
// cockpit worktree's own vite dev server on a second spare port, exactly
// like scripts/notepad-actions-route-check.mjs and the cockpit's committed
// scripts/notepad-marker-ui-proof.mjs. Never index.js main().
//
//   npm run notepad:provenance-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const UI_DIR = process.env.NOTEPAD_UI_DIR || '/home/kevin/paperclip-worktrees/notepad-ui';

// ── scratch DB guard (same pattern as the sibling notepad checks) ──────────
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
console.log(`[notepad-provenance-check] DB: ${DB_PATH}`);

function claudeProcessCount() {
  try {
    return parseInt(execSync('pgrep -c -f claude', { encoding: 'utf8' }).trim(), 10) || 0;
  } catch (err) {
    if (err && err.status === 1) return 0; // pgrep: nothing matched
    throw err;
  }
}
const spawnsBefore = claudeProcessCount();

process.env.JARVIS_SMARTY_PANTS_URL = 'http://127.0.0.1:1';
process.env.JARVIS_MCP_NATIVE_TIMEOUT_MS = '5000';

const PORT = 35800 + (process.pid % 500);
process.env.JARVIS_UI_PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

const distDir = path.join(repoRoot, 'dist');
const { putNotepadDay, markLineActed } = await import(path.join(distDir, 'notepad.js'));
const { sqliteDb, getOrCreateConversation } = await import(path.join(distDir, 'conversation-db.js'));
const { createGoal, createGoalNode } = await import(path.join(distDir, 'goals.js'));
const { createHopperItem } = await import(path.join(distDir, 'hopper.js'));
const { createWorkstream } = await import(path.join(distDir, 'workstreams.js'));
const { buildActionRef } = await import(path.join(distDir, 'notepad-dispatch.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const { startUiServer } = await import(path.join(distDir, 'ui-server.js'));

let failed = false;
const checked = { dangling: 0 };
function check(label, ok, detail) {
  if (ok) {
    console.log(`PASS  ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    failed = true;
  }
}

function lineIdByText(saved, text) {
  const line = saved.lines.find((l) => l.text === text);
  if (!line) throw new Error(`fixture line '${text}' must exist`);
  return line.id;
}

startUiServer();
const { plaintext: apiKey } = mintApiKey('notepad-provenance-check', 'admin');

async function get(pathAndQuery) {
  const res = await fetch(`${BASE}${pathAndQuery}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ── seed one realistic day: all four acted kinds + un-acted lines ─────────
const DAY = '2026-09-24';
const goal = createGoal({ title: 'Provenance check goal', done_means: 'the check passes', authored_by: 'kevin' });
const node = createGoalNode(goal.goal.id, {
  title: 'A real node the provenance check resolves',
  done_means: 'exists for the fixture',
  authored_by: 'kevin',
});
const hopperItem = createHopperItem({ title: 'Provenance check hopper fixture', source: 'test' });
const workstream = createWorkstream({ title: 'Provenance check workstream', turn: 'jarvis', next_action: 'resolve me' });
const threadExt = 'cockpit:provenance-check-thread';
getOrCreateConversation(threadExt);

const GOAL_REF = buildActionRef({ sink: 'goal_proposal', goal_id: goal.goal.id, node_id: node.id });
const HOPPER_REF = buildActionRef({ sink: 'hopper', candidate_id: hopperItem.id });
const WORKSTREAM_REF = buildActionRef({ sink: 'workstream', workstream_id: workstream.id });
const THREAD_REF = buildActionRef({ sink: 'thread', thread_ext: threadExt });

const GOAL_TEXT = 'Follow up on the goal node proposal from standup';
const HOPPER_TEXT = 'Queue the hopper candidate Mike mentioned';
const WORKSTREAM_TEXT = 'Nudge the flight-deck workstream forward';
const THREAD_TEXT = 'Reply in the thread about the deploy window';
const PLAIN_TEXT = 'Grab coffee before the 10am';
const QUESTION_TEXT = 'Should we raise the ceiling on the governor?';

const saved = putNotepadDay(
  DAY,
  [GOAL_TEXT, HOPPER_TEXT, WORKSTREAM_TEXT, THREAD_TEXT, PLAIN_TEXT, QUESTION_TEXT].join('\n'),
);
markLineActed(lineIdByText(saved, GOAL_TEXT), GOAL_REF);
markLineActed(lineIdByText(saved, HOPPER_TEXT), HOPPER_REF);
markLineActed(lineIdByText(saved, WORKSTREAM_TEXT), WORKSTREAM_REF);
markLineActed(lineIdByText(saved, THREAD_TEXT), THREAD_REF);
// PLAIN_TEXT and QUESTION_TEXT are deliberately left un-acted.

console.log(`\nSeeded day ${DAY}: 4 acted lines (one per sink) + 2 un-acted lines.\n`);

// ── (1) ZERO DANGLING + (2) labels/urls + convention + (4) un-acted omitted
let firstFetch;
{
  const result = await get(`/notepad/${DAY}/actions`);
  firstFetch = result;
  check('GET /notepad/:date/actions returns 200', result.status === 200);
  const rows = Array.isArray(result.body) ? result.body : [];
  checked.dangling = rows.length;
  check(`un-acted lines produce no action rows (4 acted rows returned, not 6)`, rows.length === 4, `rows=${rows.length}`);
  check('un-acted plain line is absent', !rows.some((r) => r.line_text === PLAIN_TEXT));
  check('un-acted question line is absent', !rows.some((r) => r.line_text === QUESTION_TEXT));

  const dangling = rows.filter((r) => r.resolved.exists === false);
  check(`ZERO DANGLING: 0 of ${rows.length} action_refs are dangling before any deletion`, dangling.length === 0, `checked=${rows.length}`);

  for (const r of rows) {
    const okLabel = typeof r.resolved.label === 'string' && r.resolved.label.length > 0;
    const okUrl = typeof r.resolved.url === 'string' && r.resolved.url.length > 0;
    check(`${r.resolved.kind} row has non-empty label`, okLabel, JSON.stringify(r.resolved.label));
    check(`${r.resolved.kind} row has non-empty url`, okUrl, JSON.stringify(r.resolved.url));
  }
  const byKind = Object.fromEntries(rows.map((r) => [r.resolved.kind, r]));
  check('goal url matches convention /goals/<goal_id>', byKind.goal_proposal?.resolved.url === `/goals/${goal.goal.id}`);
  check('hopper url matches convention /hopper', byKind.hopper?.resolved.url === '/hopper');
  check('workstream url matches convention /flight-deck', byKind.workstream?.resolved.url === '/flight-deck');
  check('thread url matches convention /thread/<encoded ext>', byKind.thread?.resolved.url === `/thread/${encodeURIComponent(threadExt)}`);

  // (5) nothing resolves to, or links at, DAR / Paperclip
  const haystack = JSON.stringify(rows).toLowerCase();
  check('no row mentions DAR', !haystack.includes('dar-') && !/\bdar\b/.test(haystack));
  check('no row mentions paperclip', !haystack.includes('paperclip'));
  check('no url points outside the four known kinds', rows.every((r) => ['goal_proposal', 'hopper', 'workstream', 'thread'].includes(r.resolved.kind)));
}

console.log(`\nZERO DANGLING count checked (pre-deletion): ${checked.dangling}\n`);

// ── UI: drive the real cockpit worktree against this backend ──────────────
let uiChild = null;
let browser = null;
let page = null;
const screenshots = {};
try {
  const viteBin = path.join(UI_DIR, 'node_modules', '.bin', 'vite');
  if (!fs.existsSync(viteBin)) throw new Error(`vite binary not found at ${viteBin}`);
  const UI_PORT = PORT + 1;

  function resolvePlaywrightEntry() {
    const npmCache = process.env.npm_config_cache || `${process.env.HOME}/.npm`;
    const npxDir = path.join(npmCache, '_npx');
    if (fs.existsSync(npxDir)) {
      for (const hash of fs.readdirSync(npxDir)) {
        const candidate = path.join(npxDir, hash, 'node_modules', 'playwright', 'index.mjs');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return 'playwright';
  }
  const { chromium } = await import(resolvePlaywrightEntry());

  uiChild = spawn(viteBin, ['dev', '--port', String(UI_PORT), '--strictPort'], {
    cwd: UI_DIR,
    env: { ...process.env, JARVIS_API_BASE: BASE, JARVIS_COCKPIT_KEY: apiKey },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  async function waitForHttp(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url);
        if (res.status > 0) return true;
      } catch {
        // not up yet
      }
      await sleep(300);
    }
    return false;
  }
  const uiUp = await waitForHttp(`http://localhost:${UI_PORT}/notepad`, 30000);
  check('cockpit worktree dev server is reachable', uiUp, `port ${UI_PORT}`);
  if (!uiUp) throw new Error('cockpit dev server never came up');

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  fs.mkdirSync('/tmp/np879-screenshots', { recursive: true });

  // Navigate to the seeded day directly via the date picker input if present,
  // else rely on the app defaulting to "today" — DAY is set to a fixed past
  // date, so step back with the "Previous day" control until we land on it.
  await page.goto(`http://localhost:${UI_PORT}/notepad`, { waitUntil: 'load' });
  await sleep(300);

  // The notepad page has no direct date-jump URL param in this build; drive
  // it via the exposed cockpit-api proxy check plus visual confirmation that
  // SOME acted-line affordance renders, then assert on the specific day via
  // the proxy JSON (authoritative) and the DOM state it produced.
  const proxied = await fetch(`http://localhost:${UI_PORT}/cockpit-api/notepad/${DAY}/actions`).then((r) => r.json());
  check('cockpit-api proxy reaches the actions endpoint (4 rows, before deletion)', Array.isArray(proxied) && proxied.length === 4, `rows=${Array.isArray(proxied) ? proxied.length : proxied}`);

  // Step the visible day back to DAY using the "Previous day" button (the
  // UI defaults to today = the check's execution date, which is after DAY).
  async function gotoSeededDay() {
    for (let i = 0; i < 10; i++) {
      const heading = await page.locator('header .text-center').first().textContent().catch(() => '');
      if (heading && heading.includes('24') && heading.toLowerCase().includes('sep')) return;
      await page.locator('button[title="Previous day"]').click();
      await sleep(250);
    }
  }
  await gotoSeededDay();
  await sleep(400); // let the actions fetch (decoupled from keystrokes) settle

  // Scoped to the action-badge pill's own class (rounded-full), not a bare
  // href prefix — the sidebar's "Threads" back-link also starts with
  // "/thread" and would otherwise be double-counted.
  const badgeLinks = page.locator('a.rounded-full');
  const liveBadgeCount = await badgeLinks.count();
  check('all 4 acted lines show a live badge before anything is deleted', liveBadgeCount === 4, `count=${liveBadgeCount}`);

  const shot1 = '/tmp/np879-screenshots/1-all-four-live.png';
  await page.screenshot({ path: shot1, fullPage: true });
  screenshots.allLive = shot1;
  console.log(`Screenshot saved: ${shot1}`);

  // ── (3) BROKEN IS LOUD — delete the hopper fixture's target row ─────────
  sqliteDb.prepare('DELETE FROM hopper_items WHERE id = ?').run(hopperItem.id);
  {
    const result = await get(`/notepad/${DAY}/actions`);
    check('re-read after delete is a 200, not a 500', result.status === 200);
    const rows = Array.isArray(result.body) ? result.body : [];
    check('still exactly 4 action rows (the broken one is not dropped)', rows.length === 4, `rows=${rows.length}`);
    const h = rows.find((r) => r.line_text === HOPPER_TEXT);
    check('the broken ref is STILL RETURNED (never vanishes from the list)', !!h);
    check('its resolution flips to exists:false', h?.resolved.exists === false);
    check('its broken_reason is non-empty', typeof h?.resolved.broken_reason === 'string' && h.resolved.broken_reason.length > 0, h?.resolved.broken_reason);
    const others = rows.filter((r) => r.line_text !== HOPPER_TEXT);
    check('the other 3 rows are unaffected (still exists:true)', others.every((r) => r.resolved.exists === true));
  }

  await page.reload({ waitUntil: 'load' });
  await gotoSeededDay();
  await sleep(400);

  const badgeCountAfter = await badgeLinks.count();
  check('3 live badges render after the hopper target is deleted', badgeCountAfter === 3, `count=${badgeCountAfter}`);

  const brokenRow = page.locator('div').filter({ hasText: HOPPER_REF }).last();
  const brokenVisible = await brokenRow.isVisible().catch(() => false);
  check('the broken hopper ref renders visibly in the UI (raw ref text present)', brokenVisible);
  const brokenIsLink = await page.locator(`a:has-text("${HOPPER_REF}")`).count();
  check('the broken ref is NOT rendered as a clickable link', brokenIsLink === 0);

  const shot2 = '/tmp/np879-screenshots/2-hopper-target-deleted-visibly-broken.png';
  await page.screenshot({ path: shot2, fullPage: true });
  screenshots.broken = shot2;
  console.log(`Screenshot saved: ${shot2}`);
} catch (err) {
  check('UI check ran without throwing', false, String(err?.message ?? err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (uiChild) {
    uiChild.kill('SIGTERM');
    await sleep(300);
  }
}

// ── (6) no net new claude processes spawned ────────────────────────────────
const spawnsAfter = claudeProcessCount();
check(`no net new claude processes spawned (before=${spawnsBefore}, after=${spawnsAfter})`, spawnsAfter <= spawnsBefore);

console.log('\nScreenshots: ' + JSON.stringify(screenshots));
console.log(failed ? '\nVERDICT: FAIL' : '\nVERDICT: PASS');
process.exit(failed ? 1 : 0);
