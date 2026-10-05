/**
 * ntfy-notifications-check — regression suite for the ntfy desktop-push
 * bridge in src/notifications.ts. Runs against the COMPILED dist on a
 * scratch SQLite DB with a stubbed global fetch. Zero network, zero model
 * calls, no live state touched.
 *
 *   npm run build
 *   npm run ntfy-notifications:check
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── scratch DB guard ──────────────────────────────────────────────────────
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

// ── fetch stub ────────────────────────────────────────────────────────────
const fetchCalls = [];
let fetchImpl = async () => ({ ok: true, status: 200 });
let activeFetches = 0;
let maxActiveFetches = 0;
globalThis.fetch = (url, opts) => {
  fetchCalls.push({ url: String(url), opts });
  activeFetches++;
  maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
  const p = fetchImpl(url, opts);
  return p.finally(() => {
    activeFetches--;
  });
};

// console.error capture
const errorLines = [];
const realError = console.error;
console.error = (...args) => {
  errorLines.push(args.map((a) => String(a)).join(' '));
};

const distDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const M = await import(path.join(distDir, 'notifications.js'));

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    realError(`  ✓ ${name}`);
  } else {
    fail++;
    realError(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

function resetEnv() {
  delete process.env.JARVIS_NTFY_TOPIC_URL;
  delete process.env.JARVIS_NTFY_SEVERITIES;
  delete process.env.JARVIS_COCKPIT_PUBLIC_URL;
}

function resetState() {
  fetchCalls.length = 0;
  errorLines.length = 0;
  activeFetches = 0;
  maxActiveFetches = 0;
  fetchImpl = async () => ({ ok: true, status: 200 });
  resetEnv();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls until `cond()` is true or the budget runs out — avoids a fixed sleep per case. */
async function waitFor(cond, { timeoutMs = 500, stepMs = 5 } = {}) {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) await sleep(stepMs);
  return cond();
}

realError('\nNTFY NOTIFICATIONS BRIDGE CHECK\n');

// ── 1. disabled config ──────────────────────────────────────────────────────
realError('disabled config (no JARVIS_NTFY_TOPIC_URL) never calls fetch');
resetState();
M.createNotification({ severity: 'error', title: 'no topic configured' });
await sleep(20);
t('no fetch call with topic unset', fetchCalls.length === 0);

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'not a url';
M.createNotification({ severity: 'error', title: 'malformed topic url' });
await sleep(20);
t('malformed topic url treated as disabled', fetchCalls.length === 0);

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'ftp://ntfy.sh/topic';
M.createNotification({ severity: 'error', title: 'non-http(s) topic url' });
await sleep(20);
t('ftp:// topic url treated as disabled', fetchCalls.length === 0);

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/';
M.createNotification({ severity: 'error', title: 'no topic path' });
await sleep(20);
t('topic url with empty path treated as disabled', fetchCalls.length === 0);

// ── 2. severity filtering ───────────────────────────────────────────────────
realError('\nseverity filtering (default + override)');
resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
M.createNotification({ severity: 'info', title: 'info, default config' });
await sleep(20);
t('info is NOT delivered by default', fetchCalls.length === 0);

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
for (const severity of ['success', 'warning', 'error']) {
  M.createNotification({ severity, title: `${severity}, default config` });
}
await waitFor(() => fetchCalls.length === 3);
t('success/warning/error ARE delivered by default', fetchCalls.length === 3);

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
process.env.JARVIS_NTFY_SEVERITIES = 'info';
M.createNotification({ severity: 'info', title: 'info, overridden allow-list' });
M.createNotification({ severity: 'warning', title: 'warning, overridden allow-list' });
await waitFor(() => fetchCalls.length >= 1);
t('override allows info through', fetchCalls.length === 1);
t('override excludes warning (replaces, not merges)', fetchCalls.every((c) => JSON.parse(c.opts.body).title.startsWith('info')));

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
process.env.JARVIS_NTFY_SEVERITIES = 'not-a-real-severity, also-fake';
M.createNotification({ severity: 'warning', title: 'garbage override falls back to default' });
await waitFor(() => fetchCalls.length >= 1);
t('garbage severities env falls back to default allow-list', fetchCalls.length === 1);

// ── 3. click link resolution ────────────────────────────────────────────────
realError('\nclick link resolution');
resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
process.env.JARVIS_COCKPIT_PUBLIC_URL = 'https://cockpit.example.com';
M.createNotification({ severity: 'error', title: 'relative link', link: '/foundry?project=abc' });
await waitFor(() => fetchCalls.length >= 1);
{
  const body = JSON.parse(fetchCalls[0].opts.body);
  t('relative link resolved against cockpit base', body.click === 'https://cockpit.example.com/foundry?project=abc', body.click);
}

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
process.env.JARVIS_COCKPIT_PUBLIC_URL = 'https://cockpit.example.com';
M.createNotification({ severity: 'error', title: 'absolute link', link: 'https://other.example.com/x?y=1' });
await waitFor(() => fetchCalls.length >= 1);
{
  const body = JSON.parse(fetchCalls[0].opts.body);
  t('absolute link kept as-is, base ignored', body.click === 'https://other.example.com/x?y=1', body.click);
}

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
process.env.JARVIS_COCKPIT_PUBLIC_URL = 'https://cockpit.example.com';
const created = M.createNotification({ severity: 'error', title: 'no link set' });
await waitFor(() => fetchCalls.length >= 1);
{
  const body = JSON.parse(fetchCalls[0].opts.body);
  t('missing link deep-links to /notifications?notification=<id>', body.click === `https://cockpit.example.com/notifications?notification=${created.id}`, body.click);
}

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
// No JARVIS_COCKPIT_PUBLIC_URL set — relative link can't be resolved.
M.createNotification({ severity: 'error', title: 'relative link, no base configured', link: '/foundry' });
await waitFor(() => fetchCalls.length >= 1);
{
  const body = JSON.parse(fetchCalls[0].opts.body);
  t('relative link with no base omits click entirely', !('click' in body), JSON.stringify(body));
}

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
process.env.JARVIS_COCKPIT_PUBLIC_URL = 'https://cockpit.example.com';
M.createNotification({ severity: 'error', title: 'non-http(s) link rejected', link: 'javascript:alert(1)' });
await waitFor(() => fetchCalls.length >= 1);
{
  const body = JSON.parse(fetchCalls[0].opts.body);
  t('javascript: link is rejected, not forwarded as click', !('click' in body), JSON.stringify(body));
}

// ── 4. payload mapping ──────────────────────────────────────────────────────
realError('\npayload mapping');
resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-secret-topic';
M.createNotification({ severity: 'error', title: 'Boom', body: 'Something broke' });
await waitFor(() => fetchCalls.length >= 1);
{
  const call = fetchCalls[0];
  const body = JSON.parse(call.opts.body);
  t('posts to the ntfy server origin, not the topic path', call.url === 'https://ntfy.sh', call.url);
  t('topic carried in the JSON body', body.topic === 'jarvis-kev-secret-topic');
  t('title mapped', body.title === 'Boom');
  t('message mapped from body', body.message === 'Something broke');
  t('error severity -> priority 5', body.priority === 5);
  t('error severity -> rotating_light tag', Array.isArray(body.tags) && body.tags.includes('rotating_light'));
  t('method is POST', call.opts.method === 'POST');
  t('content-type json', call.opts.headers['Content-Type'] === 'application/json');
}

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
M.createNotification({ severity: 'warning', title: 'no body set' });
await waitFor(() => fetchCalls.length >= 1);
{
  const body = JSON.parse(fetchCalls[0].opts.body);
  t('falls back to title when body is absent', body.message === 'no body set');
  t('warning severity -> priority 4', body.priority === 4);
  t('warning severity -> warning tag', body.tags.includes('warning'));
}

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
process.env.JARVIS_NTFY_SEVERITIES = 'success';
M.createNotification({ severity: 'success', title: 'yay' });
await waitFor(() => fetchCalls.length >= 1);
{
  const body = JSON.parse(fetchCalls[0].opts.body);
  t('success severity -> priority 3', body.priority === 3);
  t('success severity -> white_check_mark tag', body.tags.includes('white_check_mark'));
}

// ── 5. timeout / failure isolation ──────────────────────────────────────────
realError('\ntimeout / failure isolation (createNotification must never fail or block)');
resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
fetchImpl = async () => {
  throw new TypeError('fetch failed: network unreachable');
};
let threw = false;
try {
  M.createNotification({ severity: 'error', title: 'network failure' });
} catch {
  threw = true;
}
t('createNotification does not throw when ntfy publish rejects', !threw);
await waitFor(() => fetchCalls.length >= 1);
t('fetch was still attempted', fetchCalls.length === 1);

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
fetchImpl = () => new Promise(() => {}); // never resolves/rejects
const startedAt = Date.now();
let hungResult;
try {
  hungResult = M.createNotification({ severity: 'error', title: 'hung ntfy server' });
} catch {
  threw = true;
}
const elapsed = Date.now() - startedAt;
t('createNotification returns promptly even if ntfy publish never settles', elapsed < 200, `${elapsed}ms`);
t('createNotification still returns the created row', !!hungResult && typeof hungResult.id === 'number');

resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
fetchImpl = async () => ({ ok: false, status: 500 });
M.createNotification({ severity: 'error', title: 'server 500' });
await waitFor(() => errorLines.length >= 1);
t('non-ok response logs a failure', errorLines.some((l) => l.includes('500')));

// ── 6. no secret leakage ────────────────────────────────────────────────────
realError('\nno secret leakage in logs or request URL');
resetState();
const SECRET_TOPIC = 'jarvis-kev-f87c3ce6-super-secret';
process.env.JARVIS_NTFY_TOPIC_URL = `https://ntfy.sh/${SECRET_TOPIC}`;
fetchImpl = async () => ({ ok: false, status: 503 });
M.createNotification({ severity: 'error', title: 'trigger a logged failure' });
await waitFor(() => errorLines.length >= 1);
t('request URL does not contain the topic slug', fetchCalls.every((c) => !c.url.includes(SECRET_TOPIC)));
t('logged error lines never contain the topic slug', errorLines.every((l) => !l.includes(SECRET_TOPIC)));

fetchImpl = async () => {
  throw new TypeError(`fetch failed, connecting to https://ntfy.sh/${SECRET_TOPIC}`);
};
errorLines.length = 0;
fetchCalls.length = 0;
M.createNotification({ severity: 'error', title: 'trigger a thrown-error log' });
await waitFor(() => errorLines.length >= 1);
t('even a thrown-error message path is not the sole source of the secret (request itself never carries it)', fetchCalls.every((c) => !c.url.includes(SECRET_TOPIC)));

// ── 7. concurrency limiter ──────────────────────────────────────────────────
realError('\nconcurrency limiter caps in-flight ntfy publishes');
resetState();
process.env.JARVIS_NTFY_TOPIC_URL = 'https://ntfy.sh/jarvis-kev-test';
fetchImpl = async () => {
  await sleep(40);
  return { ok: true, status: 200 };
};
for (let i = 0; i < 6; i++) {
  M.createNotification({ severity: 'error', title: `burst ${i}` });
}
await waitFor(() => fetchCalls.length === 6, { timeoutMs: 2000 });
t('all queued publishes eventually fire', fetchCalls.length === 6, String(fetchCalls.length));
t('concurrency never exceeded the in-process limit (<=2)', maxActiveFetches <= 2, String(maxActiveFetches));

// ── wrap up ──────────────────────────────────────────────────────────────
console.error = realError;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ntfy-notifications-check: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
