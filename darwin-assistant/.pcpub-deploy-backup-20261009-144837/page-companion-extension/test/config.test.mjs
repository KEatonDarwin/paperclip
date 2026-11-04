// Unit tests for the extension's pure logic. No deps, no network, no browser:
//   npm test   (inside page-companion-extension/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULTS, normalizeBase, resolveApiBase, endpointFor, apiKeyRequired,
  withDefaults, isAskableUrl, pageKey, badgeLabel, normalizeLookup,
} from '../src/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('normalizeBase accepts what a human types', () => {
  assert.equal(normalizeBase('http://192.168.1.25:8080'), 'http://192.168.1.25:8080');
  assert.equal(normalizeBase('  http://192.168.1.25:8080/  '), 'http://192.168.1.25:8080');
  assert.equal(normalizeBase('192.168.1.25:8080'), 'http://192.168.1.25:8080', 'bare host gets http://');
  assert.equal(normalizeBase('pi.tail1234.ts.net'), 'http://pi.tail1234.ts.net', 'Tailscale MagicDNS');
  assert.equal(normalizeBase('https://cockpit.example.com/'), 'https://cockpit.example.com');
  assert.equal(normalizeBase('http://host:3201/api/v1///'), 'http://host:3201/api/v1');
});

test('normalizeBase rejects non-http bases as blank, never throwing', () => {
  for (const bad of ['', '   ', null, undefined, 'chrome://extensions', 'file:///tmp/x', 'ftp://h/x', '://']) {
    assert.equal(normalizeBase(bad), '', `expected blank for ${JSON.stringify(bad)}`);
  }
});

test('resolveApiBase: :8080 goes through the cockpit proxy', () => {
  assert.equal(resolveApiBase('http://192.168.1.25:8080', ''), 'http://192.168.1.25:8080/cockpit-api');
  assert.equal(resolveApiBase('192.168.1.25:8080', ''), 'http://192.168.1.25:8080/cockpit-api');
  assert.equal(resolveApiBase('http://pi:8080/', ''), 'http://pi:8080/cockpit-api');
});

test('resolveApiBase: no double /cockpit-api if it is already there', () => {
  assert.equal(resolveApiBase('http://pi:8080/cockpit-api', ''), 'http://pi:8080/cockpit-api');
});

test('resolveApiBase: a bare non-8080 host means JARVIS direct', () => {
  assert.equal(resolveApiBase('http://192.168.1.25:3201', ''), 'http://192.168.1.25:3201/api/v1');
});

test('resolveApiBase: an explicit path is believed as-is', () => {
  assert.equal(resolveApiBase('http://192.168.1.25:3201/api/v1', ''), 'http://192.168.1.25:3201/api/v1');
});

test('resolveApiBase: the override wins over the derived base', () => {
  assert.equal(
    resolveApiBase('http://192.168.1.25:8080', 'http://127.0.0.1:3201/api/v1'),
    'http://127.0.0.1:3201/api/v1',
  );
  assert.equal(resolveApiBase('http://pi:8080', '   '), 'http://pi:8080/cockpit-api', 'blank override ignored');
  assert.equal(resolveApiBase('', ''), '', 'nothing configured = blank, not a throw');
});

test('endpointFor builds the lookup/new-chat URLs', () => {
  const s = { cockpitBase: 'http://192.168.1.25:8080', apiBase: '' };
  assert.equal(endpointFor(s, 'lookup'), 'http://192.168.1.25:8080/cockpit-api/page-companion/lookup');
  assert.equal(endpointFor(s, '/new-chat'), 'http://192.168.1.25:8080/cockpit-api/page-companion/new-chat');
  assert.equal(endpointFor({ cockpitBase: '' }, 'lookup'), '');
});

test('apiKeyRequired is false only on the proxy path', () => {
  assert.equal(apiKeyRequired({ cockpitBase: 'http://pi:8080' }), false);
  assert.equal(apiKeyRequired({ cockpitBase: 'http://pi:3201' }), true);
  assert.equal(apiKeyRequired({ cockpitBase: '' }), false, 'unconfigured demands nothing');
});

test('withDefaults fills and type-guards whatever storage returns', () => {
  assert.deepEqual(withDefaults(undefined), DEFAULTS);
  assert.deepEqual(withDefaults({}), DEFAULTS);
  assert.equal(withDefaults({ enabled: 'yes' }).enabled, true, 'non-boolean falls back to the default');
  assert.equal(withDefaults({ enabled: false }).enabled, false);
  assert.equal(withDefaults({ apiKey: 'k' }).apiKey, 'k');
  assert.equal(withDefaults({ cockpitBase: 42 }).cockpitBase, DEFAULTS.cockpitBase);
});

test('isAskableUrl only asks about real http(s) pages', () => {
  assert.equal(isAskableUrl('http://192.168.1.25:8100/heartbeat'), true);
  assert.equal(isAskableUrl('https://example.com'), true);
  for (const bad of ['chrome://extensions', 'about:blank', 'file:///tmp/a.html',
    'chrome-extension://abc/options.html', '/goals', '', null]) {
    assert.equal(isAskableUrl(bad), false, `expected not askable: ${JSON.stringify(bad)}`);
  }
});

// Must agree with darwin-assistant/docs/page-companion/CONTRACT.md — the key is
// only used client-side to dedupe, but a disagreement here means we'd ask twice
// (or not at all) for pages the server considers identical.
test('pageKey matches the server contract', () => {
  assert.equal(pageKey('https://HOST:8100/goals/?x=1#y'), 'host:8100/goals');
  assert.equal(pageKey('http://Host/A/b/'), 'host/A/b', 'host lowercased, path case preserved');
  assert.equal(pageKey('http://host:80/x'), 'host/x', 'default port dropped');
  assert.equal(pageKey('https://host:443/x'), 'host/x');
  assert.equal(pageKey('http://host:8080/'), 'host:8080', 'trailing slash stripped to nothing');
  assert.equal(pageKey('chrome://extensions'), null);
  assert.equal(pageKey('nonsense'), null);
});

test('badgeLabel caps at 9+', () => {
  assert.equal(badgeLabel([]), '');
  assert.equal(badgeLabel(undefined), '');
  assert.equal(badgeLabel([1]), '1');
  assert.equal(badgeLabel(new Array(9).fill(0)), '9');
  assert.equal(badgeLabel(new Array(10).fill(0)), '9+');
});

test('normalizeLookup survives a hostile/garbled answer', () => {
  assert.deepEqual(normalizeLookup(null),
    { ours: false, project: null, registry_id: null, normalized_url: null, threads: [] });
  assert.deepEqual(normalizeLookup({ ours: 'true', threads: 'nope' }).threads, []);
  const good = normalizeLookup({
    ours: true, project: 'Heartbeat', registry_id: 3, normalized_url: 'h:8100/x',
    threads: [{ external_id: 'cockpit:a', title: 'T', last_active: 'now' }, { title: 'no id' }, null],
  });
  assert.equal(good.ours, true);
  assert.equal(good.threads.length, 1, 'threads without an external_id are dropped');
  assert.deepEqual(good.threads[0], { external_id: 'cockpit:a', title: 'T', last_active: 'now' });
  assert.equal(normalizeLookup({ threads: [{ external_id: 'c:a', title: '' }] }).threads[0].title, null);
});

// The manifest is the one file a typo in turns into "this extension won't load".
test('manifest is a loadable MV3 manifest and every referenced file exists', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, 'module', 'background.js uses ES imports');
  assert.deepEqual(manifest.permissions, ['storage'], 'storage is all we need');
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['http://*/*', 'https://*/*']);

  const referenced = [
    manifest.background.service_worker,
    manifest.options_page,
    ...manifest.content_scripts.flatMap((cs) => cs.js),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const rel of referenced) {
    await readFile(resolve(root, rel)); // throws if missing
  }
});

test('the content script never imports (MV3 forbids it) and never reads the key', async () => {
  const src = await readFile(resolve(root, 'src/content.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'content scripts cannot use ES imports');
  assert.ok(!/apiKey|chrome\.storage|Authorization/.test(src),
    'the key must stay in the background worker — the content script runs next to the page');
  assert.ok(!/\bfetch\s*\(/.test(src), 'all network goes through the background worker');
  assert.ok(/attachShadow/.test(src), 'the button lives in a Shadow DOM');
});
