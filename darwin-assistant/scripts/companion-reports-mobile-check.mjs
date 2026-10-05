#!/usr/bin/env node
// COMPANION REPORTS MOBILE CHECK — node #1449, tree-3e6f2be4. Proves the
// reports reader (public/companion/app.js + app.css, served by
// src/companion-thin-server.ts) actually renders legibly at a real iPhone
// viewport, with a REAL headless browser (playwright-core + the cached
// chromium under ~/.cache/ms-playwright) -- jsdom has no layout engine, so
// font-size / scrollWidth assertions need a real renderer, not a DOM shim.
//
// Against a scratch COMPANION_REPORTS_DIR (never the live outbox) and a
// scratch JARVIS_DB_PATH (never jarvis.db), seeds ONE realistic wish-catalog
// report covering: multiple heading levels, a table, a very long unbroken
// URL, a fenced code block with an unbroken token, a blockquote, a bullet +
// numbered list, an image reference, and a <details>/<summary> expander.
// Then renders GET /api/reports/<name> client-side at 390x844 and asserts:
//   (1) paragraph font-size >= 15px
//   (2) no element's bounding box exceeds the 390px viewport width (long
//       URLs/code/tables wrap or scroll WITHIN their own card, never force
//       the whole page to scroll horizontally)
//   (3) the <details> expander toggles open/closed on tap
//   (4) images are constrained to max-width:100%
//   (5) headings/lists/blockquote/table are present and visible
//
//   npm run build && JARVIS_DB_PATH=/tmp/companion-reports-mobile-check.db node scripts/companion-reports-mobile-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard ─────────────────────────────────────────────────────
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

console.log(`[companion-reports-mobile-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getOrCreateCompanionThread } = await import(path.join(distDir, 'companion-chat.js'));

let failed = false;
function check(label, ok, extra) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ''}`);
    failed = true;
  }
}

const { external_id: COMPANION_EXT } = getOrCreateCompanionThread('companion-reports-mobile-check');

// ── scratch reports dir with ONE realistic wish-catalog report ─────────────
const REPORTS_DIR = fs.mkdtempSync('/tmp/companion-reports-mobile-');
const REPORT_NAME = 'wish-catalog-sample.md';
const LONG_URL =
  'https://www.example-retailer.com/catalog/home-goods/kitchen/espresso-machines/deluxe-model/sku/8847293-black-stainless-finish-limited-run';
const LONG_CODE_TOKEN =
  'AVeryLongUnbrokenTokenToStressTestHorizontalOverflowContainmentWithinTheCodeBlockWithoutAnySpacesOrBreaksAtAllForTestingPurposesOnly1234567890';
const REPORT_MD = [
  '# Wish Catalog Report — October',
  '',
  'A short intro paragraph with normal prose, to check paragraph legibility and wrapping behavior on a narrow phone screen.',
  '',
  '## Section One: Items',
  '',
  '| Item | Price | Store |',
  '| --- | --- | --- |',
  '| Espresso Machine | $349.99 | Williams Sonoma |',
  '| Cast Iron Skillet | $89.00 | Le Creuset Outlet |',
  '| Weighted Blanket | $64.50 | Target |',
  '',
  '### A very long link',
  '',
  `Check this doesn't break the layout: ${LONG_URL}`,
  '',
  '#### Setup snippet',
  '',
  '```text',
  LONG_CODE_TOKEN,
  '```',
  '',
  '> Remember: check sizing before ordering. Store policies vary and some items are final sale.',
  '',
  '- Check the espresso machine reviews',
  '- Compare skillet seasoning instructions',
  '- Confirm blanket weight is right for the bed size',
  '',
  '1. Order the skillet first',
  '2. Wait for the espresso machine restock',
  '3. Add the blanket last',
  '',
  '![Blanket texture closeup](https://example.com/images/blanket-texture.png)',
  '',
  '<details>',
  '<summary>More notes</summary>',
  '',
  "Extra detail that's hidden by default: store return windows are 30 days except Williams Sonoma which is 90 days for cookware.",
  '',
  '</details>',
  '',
].join('\n');
fs.writeFileSync(path.join(REPORTS_DIR, REPORT_NAME), REPORT_MD);

// ── pick a free port, start the real server as a child process ────────────
const PORT = 8199;
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

let browser;
try {
  const up = await waitForServer();
  check('server came up', up);
  if (!up) throw new Error('server failed to start');

  const cachedChrome = '/home/kevin/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
  browser = await chromium.launch(fs.existsSync(cachedChrome) ? { executablePath: cachedChrome } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForSelector('#reports-list-view', { state: 'attached' });

  // navigate chat -> reports list -> the one report
  await page.click('#switch-btn');
  await page.waitForFunction(() => {
    const el = document.getElementById('reports-list');
    return el && el.querySelectorAll('button').length > 0;
  });
  await page.click('#reports-list button');
  await page.waitForFunction(() => {
    const el = document.getElementById('report-content');
    return el && el.querySelector('h1');
  });
  await sleep(200); // settle any layout/paint

  const contentHandle = page.locator('#report-content');

  // ---- sanity: markdown actually rendered, no leaked raw syntax ----------
  const rawHtml = await contentHandle.innerHTML();
  check('heading rendered as real <h1>, not raw "#"', /<h1>Wish Catalog Report/.test(rawHtml));
  check('no literal unrendered "##"/"**" leaked through', !/##\s|(?<!<\/?[a-z]*)\*\*/.test(rawHtml.replace(/<[^>]+>/g, ' ')));

  // ---- (5) headings/lists/blockquote/table present + visible -------------
  const presence = await page.evaluate(() => {
    const root = document.getElementById('report-content');
    const q = (sel) => root.querySelector(sel);
    const visible = (el) => !!el && el.getClientRects().length > 0;
    return {
      h1: visible(q('h1')),
      h2: visible(q('h2')),
      h3: visible(q('h3')),
      h4: visible(q('h4')),
      ul: visible(q('ul')),
      ol: visible(q('ol')),
      blockquote: visible(q('blockquote')),
      table: visible(q('table')),
      thCount: root.querySelectorAll('th').length,
      tdCount: root.querySelectorAll('td').length,
    };
  });
  check('(5) h1 present and visible', presence.h1);
  check('(5) h2 present and visible', presence.h2);
  check('(5) h3 present and visible', presence.h3);
  check('(5) h4 present and visible', presence.h4);
  check('(5) bullet list (ul) present and visible', presence.ul);
  check('(5) numbered list (ol) present and visible', presence.ol);
  check('(5) blockquote present and visible', presence.blockquote);
  check('(5) table present and visible', presence.table);
  check('(5) table has header + body cells', presence.thCount === 3 && presence.tdCount === 9, presence);

  // ---- (1) paragraph font-size >= 15px ------------------------------------
  const pFontPx = await page.evaluate(() => {
    const p = document.querySelector('#report-content p');
    if (!p) return null;
    return parseFloat(getComputedStyle(p).fontSize);
  });
  check('(1) paragraph font-size >= 15px', typeof pFontPx === 'number' && pFontPx >= 15, pFontPx);

  // ---- (2) nothing exceeds the 390px viewport -----------------------------
  const viewportW = 390;
  const overflowReport = await page.evaluate((vw) => {
    const docOverflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const bodyOverflowX = document.body.scrollWidth - document.body.clientWidth;
    const offenders = [];
    const root = document.getElementById('report-content');
    // A descendant may legitimately exceed the viewport if some ancestor
    // between it and the root scrolls it internally (overflow-x:auto/scroll)
    // AND that ancestor's own box is itself within the viewport -- that is
    // exactly the "scroll-contained within its card" case the spec allows
    // (e.g. a wide <code> inside a horizontally-scrollable <pre>).
    function isScrollContained(el) {
      let node = el.parentElement;
      while (node && node !== root.parentElement) {
        const cs = getComputedStyle(node);
        if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') {
          const r = node.getBoundingClientRect();
          if (r.right <= vw + 1 && r.left >= -1) return true;
        }
        node = node.parentElement;
      }
      return false;
    }
    for (const el of root.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      // allow sub-pixel rounding slack
      if ((rect.right > vw + 1 || rect.left < -1) && !isScrollContained(el)) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: el.className || null,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        });
      }
    }
    return { docOverflowX, bodyOverflowX, offenders };
  }, viewportW);
  check('(2) document does not scroll horizontally', overflowReport.docOverflowX <= 1, overflowReport.docOverflowX);
  check('(2) body does not scroll horizontally', overflowReport.bodyOverflowX <= 1, overflowReport.bodyOverflowX);
  check(
    '(2) no element inside the report card exceeds the 390px viewport',
    overflowReport.offenders.length === 0,
    overflowReport.offenders,
  );

  // long URL and long code token specifically stay within their containers
  const containment = await page.evaluate((vw) => {
    const root = document.getElementById('report-content');
    const pre = [...root.querySelectorAll('pre')].find((el) => el.textContent.includes('AVeryLongUnbrokenToken'));
    const urlPara = [...root.querySelectorAll('p')].find((el) => el.textContent.includes('example-retailer.com'));
    const rectOk = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.right <= vw + 1 && r.left >= -1;
    };
    return { preBoxWithinViewport: rectOk(pre), urlParaBoxWithinViewport: rectOk(urlPara) };
  }, viewportW);
  check('(2) long fenced-code token: <pre> box stays within viewport (scrolls internally)', containment.preBoxWithinViewport === true, containment);
  check('(2) long unbroken URL: paragraph box stays within viewport (wraps)', containment.urlParaBoxWithinViewport === true, containment);

  // ---- (4) image constrained to max-width:100% ----------------------------
  const imgCheck = await page.evaluate((vw) => {
    const root = document.getElementById('report-content');
    const img = root.querySelector('img');
    if (!img) return { found: false };
    const cs = getComputedStyle(img);
    const rect = img.getBoundingClientRect();
    return {
      found: true,
      maxWidthCss: cs.maxWidth,
      renderedWidthWithinViewport: rect.width <= vw + 1 && rect.right <= vw + 1,
      hasSrcAndAlt: img.getAttribute('src') === 'https://example.com/images/blanket-texture.png' && img.getAttribute('alt') === 'Blanket texture closeup',
    };
  }, viewportW);
  check('(4) image element rendered from markdown with correct src/alt', imgCheck.found && imgCheck.hasSrcAndAlt, imgCheck);
  check('(4) image max-width is constrained to 100%', imgCheck.maxWidthCss === '100%', imgCheck.maxWidthCss);
  check('(4) image rendered width stays within the viewport', imgCheck.renderedWidthWithinViewport === true, imgCheck);

  // ---- (3) <details> expander toggles open/closed on tap ------------------
  const detailsBefore = await page.evaluate(() => document.getElementById('report-content').querySelector('details')?.open);
  check('(3) <details> expander exists and starts closed', detailsBefore === false, detailsBefore);
  await page.click('#report-content summary');
  await sleep(100);
  const detailsAfterOpen = await page.evaluate(() => document.getElementById('report-content').querySelector('details')?.open);
  check('(3) <details> expander opens on tap', detailsAfterOpen === true, detailsAfterOpen);
  const bodyVisibleWhenOpen = await page.evaluate(() =>
    document.getElementById('report-content').textContent.includes('90 days for cookware'),
  );
  check('(3) expander body text is present once open', bodyVisibleWhenOpen);
  await page.click('#report-content summary');
  await sleep(100);
  const detailsAfterClose = await page.evaluate(() => document.getElementById('report-content').querySelector('details')?.open);
  check('(3) <details> expander closes again on second tap', detailsAfterClose === false, detailsAfterClose);

  await page.screenshot({ path: '/tmp/companion-reports-mobile-check.png', fullPage: true });

  console.log(failed ? '\nFAILED' : '\nALL PASS');
} catch (err) {
  console.error(err);
  console.error('--- server output ---');
  console.error(serverOutput);
  failed = true;
} finally {
  if (browser) await browser.close();
  server.kill('SIGKILL');
  fs.rmSync(REPORTS_DIR, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
