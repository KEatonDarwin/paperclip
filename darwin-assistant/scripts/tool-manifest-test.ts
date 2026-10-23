#!/usr/bin/env -S npx tsx
// TOOL MANIFEST FLOOR TESTS (lean/harness-gaps, 2026-10-18; src/mcp/tool-manifest.ts
// + src/mcp/persona-tools-server.ts).
//
//   npm run tool-manifest:test
//
// Scratch files in /tmp only. No model calls, no jarvis.db, no network except a
// throwaway loopback stub this test starts itself. Proves the "never drop" floor:
// the per-spawn persona-tools-server lists tools from the boot-written cache FIRST,
// so a stalled/dead loopback can no longer hand the model an empty tool set.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'src', 'mcp', 'persona-tools-server.ts');
const TSX = path.join(here, '..', 'node_modules', '.bin', 'tsx');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'toolmanifest-'));

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n${(e as Error).stack}`); process.exitCode = 1; }
};

// ---- unit: the shared, dependency-free module -----------------------------
const mod = await import('../src/mcp/tool-manifest.js');

await t('env override picks the manifest path; round-trips a list', () => {
  const p = path.join(scratch, 'm1.json');
  process.env.JARVIS_TOOL_MANIFEST = p;
  assert.equal(mod.toolManifestPath(), p);
  const wrote = mod.writeToolManifest([{ name: 'a', description: 'A', parameters: { type: 'object' } }]);
  assert.equal(wrote, p);
  const back = mod.readToolManifest();
  assert.equal(back?.length, 1);
  assert.equal(back?.[0].name, 'a');
});

await t('missing file reads as null, not a throw and not an empty list', () => {
  process.env.JARVIS_TOOL_MANIFEST = path.join(scratch, 'does-not-exist.json');
  assert.equal(mod.readToolManifest(), null);
});

await t('malformed JSON reads as null', () => {
  const p = path.join(scratch, 'bad.json');
  fs.writeFileSync(p, '{ not json');
  process.env.JARVIS_TOOL_MANIFEST = p;
  assert.equal(mod.readToolManifest(), null);
});

await t('an empty tool list is treated as null so the loopback fallback runs', () => {
  const p = path.join(scratch, 'empty.json');
  fs.writeFileSync(p, JSON.stringify({ tools: [] }));
  process.env.JARVIS_TOOL_MANIFEST = p;
  assert.equal(mod.readToolManifest(), null);
});

// ---- integration: drive the real stdio server -----------------------------
// Minimal MCP client: initialize, then tools/list. Returns the tool names.
function listToolsFrom(env: Record<string, string>, timeoutMs = 15_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        else if (msg.id === 2) {
          clearTimeout(timer); child.kill('SIGKILL');
          resolve((msg.result?.tools ?? []).map((x: any) => x.name));
        }
      }
    });
    child.on('error', reject);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  });
}

const DEAD_LOOPBACK = 'http://127.0.0.1:9'; // discard port, refuses instantly

await t('cache is served even when the loopback is DEAD (the floor)', async () => {
  const p = path.join(scratch, 'cache.json');
  fs.writeFileSync(p, JSON.stringify({ tools: [
    { name: 'goals', description: 'g', parameters: { type: 'object' } },
    { name: 'thread_todos', description: 't', parameters: { type: 'object' } },
  ] }));
  const names = await listToolsFrom({ JARVIS_TOOL_MANIFEST: p, JARVIS_API_BASE: DEAD_LOOPBACK, JARVIS_INTERNAL_KEY: 'x' });
  assert.deepEqual(names.sort(), ['goals', 'thread_todos']);
});

await t('no cache + live loopback: falls back and still lists (boot window)', async () => {
  // Stand up a tiny loopback that answers /internal/tools.
  const srv = http.createServer((req, res) => {
    if (req.url?.endsWith('/internal/tools')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tools: [{ name: 'from_loopback', description: 'l', parameters: { type: 'object' } }] }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as import('node:net').AddressInfo).port;
  try {
    const names = await listToolsFrom({
      JARVIS_TOOL_MANIFEST: path.join(scratch, 'nope.json'),
      JARVIS_API_BASE: `http://127.0.0.1:${port}/api/v1`,
      JARVIS_INTERNAL_KEY: 'x',
    });
    assert.deepEqual(names, ['from_loopback']);
  } finally { srv.close(); }
});

await t('no cache + dead loopback: empty list, no crash (last resort)', async () => {
  const names = await listToolsFrom({
    JARVIS_TOOL_MANIFEST: path.join(scratch, 'nope2.json'),
    JARVIS_API_BASE: DEAD_LOOPBACK,
    JARVIS_INTERNAL_KEY: 'x',
  });
  assert.deepEqual(names, []);
});

console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
process.exit(process.exitCode ?? 0);
