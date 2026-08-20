import { promises as fs } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { PluginAdapter, PluginStatus, PluginActionResult } from './types.js';

const ROOT = '/home/kevin/.heb-rx-watch';
const DONE = path.join(ROOT, 'DONE');
const STATE = path.join(ROOT, 'state');
const ERRCOUNT = path.join(ROOT, 'errcount');
const LAST_RESPONSE = path.join(ROOT, 'last-response.json');
const WATCH_LOG = path.join(ROOT, 'watch.log');
const COOKIES = path.join(ROOT, 'cookies.txt');
const CHECK_SH = path.join(ROOT, 'check.sh');

async function readTextSafe(p: string): Promise<string | null> {
  try { return (await fs.readFile(p, 'utf8')).trim(); } catch { return null; }
}

async function statIsoOrNull(p: string): Promise<string | undefined> {
  try { return statSync(p).mtime.toISOString(); } catch { return undefined; }
}

async function nextTimerIso(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const proc = spawn('systemctl', ['list-timers', 'heb-rx-watch.timer', '--no-pager', '--output=json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d.toString(); });
    proc.on('close', () => {
      try {
        const arr = JSON.parse(buf) as Array<{ next?: string }>;
        const next = arr?.[0]?.next;
        resolve(next && next !== 'n/a' ? new Date(next).toISOString() : undefined);
      } catch { resolve(undefined); }
    });
    proc.on('error', () => resolve(undefined));
  });
}

async function buildStatus(): Promise<PluginStatus> {
  const disabled = existsSync(DONE);
  const state = (await readTextSafe(STATE)) ?? '';
  const errcount = Number((await readTextSafe(ERRCOUNT)) ?? '0') || 0;
  const lastCheckAt = await statIsoOrNull(LAST_RESPONSE);
  const nextCheckAt = disabled ? undefined : await nextTimerIso();

  let pluginState: PluginStatus['state'];
  let detail: string;
  if (disabled) { pluginState = 'paused'; detail = 'Paused — will not poll HEB until re-enabled.'; }
  else if (state === 'UNAUTHORIZED' || errcount >= 3) { pluginState = 'attention'; detail = 'Cookie appears expired — paste a fresh cookie to resume.'; }
  else if (state === 'READY') { pluginState = 'running'; detail = 'Rx is READY at HEB (should have DMed Kevin).'; }
  else if (state === 'WAITING' || state === '') { pluginState = 'running'; detail = state === '' ? 'Polling. No status yet.' : 'Polling. No Rx yet (WAITING).'; }
  else { pluginState = 'unknown'; detail = `State: ${state}`; }

  return {
    id: 'heb-rx-watch',
    name: 'HEB Prescription Watcher',
    description: 'Polls HEB pharmacy API every 5 min during 03:30–21:00 CDT; DMs Kevin when an Rx is ready.',
    state: pluginState,
    enabled: !disabled,
    detail,
    lastCheckAt,
    nextCheckAt,
    meta: { state: state || '(empty)', errcount, quietHours: '21:00–03:30 local' },
    actions: [
      { name: 'update_cookies', label: 'Update cookies', kind: 'form', fields: [{ name: 'cookie', label: 'Paste the full Cookie header', type: 'textarea', placeholder: '_ga=...; sat=...; ...', required: true }] },
      { name: 'test_now', label: 'Run one check now', kind: 'button' },
    ],
  };
}

async function runCheckOnce(): Promise<{ token: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('bash', [CHECK_SH], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', () => resolve({ token: (out.trim().split(/\s+/).pop() || '').trim(), stderr: err }));
    proc.on('error', () => resolve({ token: '', stderr: 'spawn failed' }));
  });
}

export const hebRxPlugin: PluginAdapter = {
  id: 'heb-rx-watch',
  name: 'HEB Prescription Watcher',
  description: 'Polls HEB pharmacy API; DMs when an Rx is ready.',

  async status() { return buildStatus(); },

  async toggle(enabled) {
    if (enabled) {
      try { await fs.unlink(DONE); } catch {}
      try { await fs.writeFile(ERRCOUNT, '0\n'); } catch {}
    } else {
      await fs.writeFile(DONE, `paused via plugins pane ${new Date().toISOString()}\n`);
    }
    return buildStatus();
  },

  async action(name, payload): Promise<PluginActionResult> {
    if (name === 'update_cookies') {
      const cookie = String((payload?.cookie ?? '')).trim();
      if (!cookie) return { ok: false, message: 'cookie is required' };
      if (existsSync(COOKIES)) { try { await fs.copyFile(COOKIES, COOKIES + '.bak-' + Date.now()); } catch {} }
      await fs.writeFile(COOKIES, cookie + '\n');
      await fs.writeFile(ERRCOUNT, '0\n');
      try { await fs.writeFile(STATE, ''); } catch {}
      try { await fs.unlink(DONE); } catch {}
      const { token } = await runCheckOnce();
      const status = await buildStatus();
      const ok = token === 'WAITING' || token === 'READY';
      return { ok, message: ok ? `Cookie accepted — HEB returned ${token}.` : `Cookie saved but HEB returned "${token || 'no token'}". Check log.`, status };
    }
    if (name === 'test_now') {
      const { token, stderr } = await runCheckOnce();
      const status = await buildStatus();
      const ok = token === 'WAITING' || token === 'READY';
      return { ok, message: ok ? `HEB returned ${token}.` : `HEB returned "${token || 'no token'}". ${stderr.slice(0, 200)}`, status };
    }
    return { ok: false, message: `Unknown action: ${name}` };
  },
};

export function isHebInstalled(): boolean {
  return existsSync(CHECK_SH) && existsSync(ROOT);
}

export function hebTailLog(lines = 20): string {
  try {
    const buf = require('node:fs').readFileSync(WATCH_LOG, 'utf8') as string;
    return buf.trim().split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}
