// JARVIS UX Reviewer — portable capture harness (DAR-685, slice 1).
//
// The "eyes" half of the reviewer: drives a running app in a real (headless)
// Chromium via Playwright, walks it across STATES x VIEWPORTS, captures a
// screenshot per cell, and returns a manifest the vision-critique stage reads.
//
// Design notes:
//  - Uses the system Chromium (`/usr/bin/chromium`) via playwright-core — NO
//    bundled browser download. Configurable via UX_REVIEWER_CHROMIUM.
//  - External network is BLOCKED by default (only the target host + explicit
//    allowlist load). This is the fix for the ARM font-hang that made prior
//    headless runs on this Pi time out: third-party font/CDN fetches never
//    resolve headless, so the page never reaches network-idle. Blocking them
//    makes capture fast (~2s) and deterministic.
//  - Per-cell isolation: one failed screenshot (nav timeout, bad selector)
//    records an error on that cell and does NOT abort the run.
//  - Console errors + failed requests are captured per cell as objective
//    signal the rubric/critique stage can use directly.

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Viewport {
  name: string; // e.g. "mobile" | "tablet" | "desktop"
  width: number;
  height: number;
  isMobile?: boolean;
}

// One interaction step run against the page to reach a given STATE.
export type Step =
  | { action: 'goto'; path: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; text: string }
  | { action: 'press'; selector: string; key: string }
  | { action: 'wait'; ms: number }
  | { action: 'waitForSelector'; selector: string }
  | { action: 'scrollTo'; selector: string }
  | { action: 'eval'; fn: string }; // page.evaluate(new Function(fn)) — for custom setup

export interface StateDef {
  name: string; // "idle" | "loading" | "mid-stream" | "post-reply" | "empty" | "error"
  description?: string; // human hint for the rubric ("should show streaming indicator")
  steps: Step[]; // interaction script to reach this state, starting from a fresh page
  fullPage?: boolean; // capture full scroll height instead of just the viewport
}

export interface ScreenDef {
  name: string; // "dashboard" | "thread-detail" | "settings"
  states: StateDef[];
}

export interface CaptureConfig {
  project: string; // project name/id, threaded into findings + bug-intake
  baseUrl: string; // e.g. http://127.0.0.1:3201
  viewports: Viewport[];
  screens: ScreenDef[];
  allowedHosts?: string[]; // extra hostnames allowed past the network block (default: baseUrl host + localhost)
  outDir?: string; // where PNGs + manifest land (default: /tmp/ux-reviewer/<project>/<runId>)
  navTimeoutMs?: number; // default 15000
  stepTimeoutMs?: number; // default 10000
  chromiumPath?: string; // default UX_REVIEWER_CHROMIUM or /usr/bin/chromium
}

export interface CaptureCell {
  screen: string;
  state: string;
  viewport: string;
  ok: boolean;
  file?: string; // absolute path to PNG when ok
  relFile?: string; // path relative to outDir
  bytes?: number;
  title?: string;
  url?: string;
  consoleErrors: string[];
  failedRequests: string[]; // non-allowlisted-abort failures (real errors)
  captureMs?: number;
  error?: string; // set when ok=false
  stateDescription?: string;
}

export interface CaptureManifest {
  project: string;
  baseUrl: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  chromium: string;
  totalCells: number;
  okCells: number;
  outDir: string;
  cells: CaptureCell[];
}

const DEFAULT_CHROMIUM = process.env.UX_REVIEWER_CHROMIUM || '/usr/bin/chromium';

export const DEFAULT_VIEWPORTS: Viewport[] = [
  { name: 'mobile', width: 390, height: 844, isMobile: true },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1440, height: 900 },
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Deterministic-ish run id without Date.now (kept simple; caller may override outDir).
function makeRunId(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return iso;
}

async function runStep(page: Page, step: Step, baseUrl: string, timeouts: { nav: number; step: number }): Promise<void> {
  switch (step.action) {
    case 'goto': {
      const url = step.path.startsWith('http') ? step.path : baseUrl.replace(/\/$/, '') + step.path;
      await page.goto(url, { waitUntil: step.waitUntil ?? 'domcontentloaded', timeout: timeouts.nav });
      return;
    }
    case 'click':
      await page.click(step.selector, { timeout: timeouts.step });
      return;
    case 'fill':
      await page.fill(step.selector, step.text, { timeout: timeouts.step });
      return;
    case 'press':
      await page.press(step.selector, step.key, { timeout: timeouts.step });
      return;
    case 'wait':
      await page.waitForTimeout(step.ms);
      return;
    case 'waitForSelector':
      await page.waitForSelector(step.selector, { timeout: timeouts.step });
      return;
    case 'scrollTo':
      await page.locator(step.selector).scrollIntoViewIfNeeded({ timeout: timeouts.step });
      return;
    case 'eval':
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      await page.evaluate(new Function(step.fn) as any);
      return;
  }
}

async function captureCell(
  ctx: BrowserContext,
  cfg: Required<Pick<CaptureConfig, 'baseUrl' | 'navTimeoutMs' | 'stepTimeoutMs'>>,
  screen: ScreenDef,
  state: StateDef,
  viewport: Viewport,
  outDir: string,
): Promise<CaptureCell> {
  const cell: CaptureCell = {
    screen: screen.name,
    state: state.name,
    viewport: viewport.name,
    ok: false,
    consoleErrors: [],
    failedRequests: [],
    stateDescription: state.description,
  };
  const page = await ctx.newPage();
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  page.on('console', (msg) => {
    if (msg.type() === 'error') cell.consoleErrors.push(msg.text().slice(0, 500));
  });
  page.on('requestfailed', (req) => {
    // Only record failures we did NOT deliberately abort (network block records nothing here
    // because aborted requests also fire requestfailed — filter by our abort reason).
    const failure = req.failure();
    if (failure && failure.errorText !== 'net::ERR_BLOCKED_BY_CLIENT' && failure.errorText !== 'net::ERR_ABORTED') {
      cell.failedRequests.push(`${req.method()} ${req.url().slice(0, 200)} — ${failure.errorText}`);
    }
  });
  const t0 = Date.now();
  try {
    for (const step of state.steps) {
      await runStep(page, step, cfg.baseUrl, { nav: cfg.navTimeoutMs, step: cfg.stepTimeoutMs });
    }
    const rel = `${screen.name}__${state.name}__${viewport.name}.png`.replace(/[^a-zA-Z0-9._-]/g, '-');
    const abs = join(outDir, rel);
    const buf = await page.screenshot({ path: abs, fullPage: state.fullPage ?? false });
    cell.ok = true;
    cell.file = abs;
    cell.relFile = rel;
    cell.bytes = buf.length;
    cell.title = await page.title().catch(() => undefined);
    cell.url = page.url();
    cell.captureMs = Date.now() - t0;
  } catch (err) {
    cell.error = err instanceof Error ? err.message.slice(0, 500) : String(err);
    cell.captureMs = Date.now() - t0;
  } finally {
    await page.close().catch(() => {});
  }
  return cell;
}

/**
 * Run a full capture pass over a target: screens x states x viewports.
 * Returns the manifest and writes PNGs + manifest.json into outDir.
 */
export async function captureTarget(config: CaptureConfig): Promise<CaptureManifest> {
  const runId = makeRunId();
  const outDir = config.outDir ?? join('/tmp/ux-reviewer', config.project.replace(/[^a-zA-Z0-9._-]/g, '-'), runId);
  await mkdir(outDir, { recursive: true });

  const chromiumPath = config.chromiumPath ?? DEFAULT_CHROMIUM;
  const navTimeoutMs = config.navTimeoutMs ?? 15000;
  const stepTimeoutMs = config.stepTimeoutMs ?? 10000;

  const allowed = new Set<string>([
    hostOf(config.baseUrl),
    'localhost',
    '127.0.0.1',
    ...(config.allowedHosts ?? []),
  ]);

  const startedAt = new Date().toISOString();
  let browser: Browser | undefined;
  const cells: CaptureCell[] = [];
  try {
    browser = await chromium.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    });
    const ctx = await browser.newContext();
    // The network block: abort anything not on an allowed host. This is what
    // keeps headless capture fast + deterministic on the ARM Pi.
    await ctx.route('**/*', (route) => {
      const h = hostOf(route.request().url());
      if (allowed.has(h)) return route.continue();
      return route.abort();
    });

    for (const screen of config.screens) {
      for (const state of screen.states) {
        for (const viewport of config.viewports) {
          const cell = await captureCell(
            ctx,
            { baseUrl: config.baseUrl, navTimeoutMs, stepTimeoutMs },
            screen,
            state,
            viewport,
            outDir,
          );
          cells.push(cell);
        }
      }
    }
  } finally {
    await browser?.close().catch(() => {});
  }

  const manifest: CaptureManifest = {
    project: config.project,
    baseUrl: config.baseUrl,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    chromium: chromiumPath,
    totalCells: cells.length,
    okCells: cells.filter((c) => c.ok).length,
    outDir,
    cells,
  };
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}
