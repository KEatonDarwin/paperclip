#!/usr/bin/env node
// CLAUDE ACCOUNTS API ROUTE TESTS — exercises the REAL Express router
// (tree-44d2ff4a node #293: GET/POST /api/v1/claude-accounts) end to end over
// real HTTP on a throwaway port, against a scratch DB. No live model calls,
// no network calls to claude.ai, no touch of the live jarvis.db.
//
//   npm run build
//   npm run claude-accounts-route:test
//
// Proves:
//   1. Both routes require a bearer token (401 with none).
//   2. GET with no `claude_accounts` setting -> the synthesized default
//      account 'a', matching listClaudeAccounts()'s byte-identical fallback.
//   3. POST without an admin-scoped key -> 403 (setup script must use an
//      admin/cockpit-scoped key).
//   4. POST with an admin key registers a NEW account ('b') without dropping
//      the implicit account 'a' (the upsertClaudeAccount seed-from-list
//      behavior scripts/multi-claude-setup.sh depends on).
//   5. A second POST with only a partial body updates just those fields and
//      preserves the rest (idempotent re-run safety for the setup script).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard ─────────────────────────────────────────────────────────
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

const USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-accounts-route-usage-'));
process.env.CLAUDE_USAGE_DIR = USAGE_DIR;

const distDir = path.join(__dirname, '..', 'dist');
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/v1`;

async function req(method, urlPath, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const adminKey = mintApiKey('route-test-admin', 'admin').plaintext;
const plainKey = mintApiKey('route-test-plain', 'jarvis').plaintext;

console.log(`[claude-accounts-route-test] scratch DB: ${DB_PATH}`);
console.log(`[claude-accounts-route-test] server: ${base}`);

try {
  // 1. No bearer token -> 401 on both verbs.
  {
    const get = await req('GET', '/claude-accounts');
    assert.equal(get.status, 401, `expected 401 with no token, got ${get.status}`);
    const post = await req('POST', '/claude-accounts', { body: { key: 'b' } });
    assert.equal(post.status, 401, `expected 401 with no token, got ${post.status}`);
  }
  console.log('  ✓ both routes require a bearer token');

  // 2. GET with nothing configured -> synthesized default account 'a'.
  {
    const get = await req('GET', '/claude-accounts', { token: plainKey });
    assert.equal(get.status, 200);
    assert.equal(get.json.accounts.length, 1, 'expected exactly the implicit default account');
    assert.equal(get.json.accounts[0].key, 'a');
    assert.equal(get.json.accounts[0].config_dir, null);
    assert.equal(get.json.active_account, 'a');
  }
  console.log("  ✓ GET with nothing configured -> implicit default account 'a'");

  // 3. POST without admin scope -> 403.
  {
    const post = await req('POST', '/claude-accounts', { token: plainKey, body: { key: 'b', config_dir: '/home/kevin/.claude-b' } });
    assert.equal(post.status, 403, `expected 403 for non-admin key, got ${post.status}: ${JSON.stringify(post.json)}`);
  }
  console.log('  ✓ POST without an admin-scoped key -> 403');

  // 4. POST with admin key registers 'b' WITHOUT dropping 'a'.
  {
    const post = await req('POST', '/claude-accounts', {
      token: adminKey,
      body: { key: 'b', label: 'Claude B', config_dir: '/home/kevin/.claude-b', org_id: 'org-b-123' },
    });
    assert.equal(post.status, 200, `expected 200, got ${post.status}: ${JSON.stringify(post.json)}`);
    assert.equal(post.json.accounts.length, 2, 'expected a + b after first registration');
    assert.equal(post.json.accounts[0].key, 'a');
    assert.equal(post.json.accounts[0].config_dir, null, "account 'a' must stay implicit-default-shaped");
    assert.equal(post.json.accounts[1].key, 'b');
    assert.equal(post.json.accounts[1].config_dir, '/home/kevin/.claude-b');
    assert.equal(post.json.accounts[1].cookie_file, '/home/kevin/.claude-b/claude-ai-session-cookie');
    assert.equal(post.json.accounts[1].org_id, 'org-b-123');
    assert.equal(post.json.accounts[1].enabled, true);

    const get = await req('GET', '/claude-accounts', { token: plainKey });
    assert.equal(get.status, 200);
    assert.equal(get.json.accounts.length, 2, 'GET should now report both accounts');
    const bEntry = get.json.accounts.find((a) => a.key === 'b');
    assert.ok(bEntry, "account 'b' missing from GET breakdown");
    assert.equal(bEntry.stale, true, "fresh account with no usage file yet should read as stale");
  }
  console.log("  ✓ POST registers account 'b' without dropping 'a'; GET reflects both");

  // 5. Partial re-POST (idempotent setup-script re-run) preserves other fields.
  {
    const post = await req('POST', '/claude-accounts', { token: adminKey, body: { key: 'b', enabled: false } });
    assert.equal(post.status, 200);
    const b = post.json.accounts.find((a) => a.key === 'b');
    assert.equal(b.enabled, false, "'enabled' should now be false");
    assert.equal(b.config_dir, '/home/kevin/.claude-b', 'config_dir must be preserved on a partial update');
    assert.equal(b.org_id, 'org-b-123', 'org_id must be preserved on a partial update');
  }
  console.log('  ✓ partial POST re-run preserves untouched fields (idempotent)');

  // 6. Missing key -> 400.
  {
    const post = await req('POST', '/claude-accounts', { token: adminKey, body: {} });
    assert.equal(post.status, 400, `expected 400 for missing key, got ${post.status}`);
  }
  console.log('  ✓ POST with no key -> 400');

  console.log('\n[claude-accounts-route-test] ALL 6 tests passed ✅');
} finally {
  server.close();
}
