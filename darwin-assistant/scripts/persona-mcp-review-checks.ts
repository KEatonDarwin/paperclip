// PERSONA-TOOLS MCP — REVIEW REGRESSION CHECKS (hopper node #466)
//
// Zero-model-cost, deterministic guards for the defects found in the
// adversarial review of hopper/persona-mcp. Runs the real api-v1 router on a
// throwaway port against a SCRATCH sqlite DB (never the live jarvis.db).
//
//   npm run persona-mcp:review-checks
//
// Guards:
//   1. GET /settings must NOT leak internal_mcp_key_plaintext (it is a full
//      admin-scope API key and that route is readable by ANY authenticated
//      key → privilege escalation).
//   2. GET /internal/tools requires an admin-scoped key, and returns the same
//      tool surface as ALL_TOOLS (this is what the MCP child's tools/list
//      reads instead of importing the registry, which would open jarvis.db).
//   3. POST /internal/tool-exec rejects non-admin keys (403) and unknown
//      conversation ids (404).
//   4. dist/mcp/persona-tools-server.js must not import the tool registry —
//      spawning it must NOT open/create a sqlite DB.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const DB_PATH = path.resolve(process.env.JARVIS_DB_PATH ?? '/tmp/persona-mcp-review.db');
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
process.env.JARVIS_DB_PATH = DB_PATH;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
delete process.env.ANTHROPIC_API_KEY; // NO API KEYS

const distDir = path.join(repoRoot, 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { getOrCreateInternalMcpKey, mintApiKey, INTERNAL_MCP_KEY_SETTING } = await import(path.join(distDir, 'api-keys.js'));
const { ALL_TOOLS } = await import(path.join(distDir, 'tools', 'index.js'));

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise<import('node:http').Server>((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s as import('node:http').Server));
});
const addr = server.address();
const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/v1`;

const adminKey = getOrCreateInternalMcpKey();            // scope 'cockpit' = admin
const lowKey = mintApiKey('review-low-scope', 'jarvis').plaintext; // non-admin

let pass = 0;
let fail = 0;
async function check(id: string, label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`  ✓ [${id}] ${label}`);
  } catch (err) {
    fail++;
    console.log(`  ✗ [${id}] ${label}\n    ${err instanceof Error ? err.message : String(err)}`);
  }
}
const get = (p: string, key: string) => fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${key}` } });
const post = (p: string, key: string, body: unknown) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

await check('r1', 'GET /settings does not leak the internal admin MCP key (any-scope readable route)', async () => {
  for (const [label, key] of [['admin', adminKey], ['low-scope', lowKey]] as const) {
    const body = (await (await get('/settings', key)).json()) as { settings?: Record<string, string> };
    assert.ok(body.settings, `${label}: no settings in response`);
    assert.equal(body.settings![INTERNAL_MCP_KEY_SETTING], undefined, `${label} caller can read ${INTERNAL_MCP_KEY_SETTING}`);
    assert.ok(!JSON.stringify(body).includes(adminKey), `${label}: the admin key plaintext appears in the /settings payload`);
  }
});

await check('r2', 'GET /internal/tools: admin gets the full ALL_TOOLS manifest, non-admin gets 403', async () => {
  const ok = await get('/internal/tools', adminKey);
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { tools?: { name: string; parameters: unknown }[] };
  assert.equal(body.tools?.length, ALL_TOOLS.length, 'manifest length != ALL_TOOLS length');
  for (const name of ['goals', 'workstreams', 'thread_todos', 'hopper', 'notifications']) {
    assert.ok(body.tools!.some((t) => t.name === name), `manifest missing ${name}`);
  }
  assert.ok(body.tools!.every((t) => t.parameters && typeof t.parameters === 'object'), 'a manifest entry has no parameters schema');
  assert.equal((await get('/internal/tools', lowKey)).status, 403, 'non-admin key was allowed to read the manifest');
});

await check('r3', 'POST /internal/tool-exec: 403 for non-admin, 404 for an unknown conversation', async () => {
  const forbidden = await post('/internal/tool-exec', lowKey, { context: { conversationId: 1 }, name: 'thread_todos', arguments: { operation: 'list' } });
  assert.equal(forbidden.status, 403, 'non-admin key was allowed to execute a tool');
  const missing = await post('/internal/tool-exec', adminKey, { context: { conversationId: 999999 }, name: 'thread_todos', arguments: { operation: 'list' } });
  assert.equal(missing.status, 404, 'unknown conversation id was accepted');
});

await check('r4', 'the MCP child never opens a sqlite DB (no tool-registry import)', async () => {
  const probeDb = '/tmp/persona-mcp-review-child.db';
  for (const p of [probeDb, `${probeDb}-wal`, `${probeDb}-shm`]) fs.rmSync(p, { force: true });
  const child = spawn(process.execPath, [path.join(distDir, 'mcp', 'persona-tools-server.js')], {
    env: { ...process.env, JARVIS_DB_PATH: probeDb, JARVIS_API_BASE: base, JARVIS_INTERNAL_KEY: adminKey, JARVIS_TOOL_CONTEXT: '{}' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await new Promise((r) => setTimeout(r, 1500));
  child.stdin.end();
  const exited = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 4000);
    child.on('exit', () => { clearTimeout(t); resolve(true); });
  });
  if (!exited) child.kill('SIGKILL');
  assert.ok(exited, 'MCP child did not exit on stdin EOF (orphaned process leak)');
  assert.ok(!fs.existsSync(probeDb), 'MCP child opened/created a sqlite DB — it is importing the tool registry again');
});

server.close();
console.log(`\n[persona-mcp-review-checks] ${fail === 0 ? 'PASS' : 'FAIL'} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
