// THE DENY LIST — extension side. tree-b0198a82, node #1584.
//
//   npm test   (inside page-companion-extension/)
//
// Two jobs:
//   1. src/config.js answers the shared case table correctly.
//   2. src/content.js's inline mirror (it cannot import — MV3) answers
//      IDENTICALLY. The mirror is extracted from the source between the
//      `deny-mirror:begin/end` sentinels and executed, so a hand edit to one
//      copy and not the other fails here rather than in Kevin's browser.
//
// The TS↔JS half of the drift check lives in
// darwin-assistant/scripts/page-companion-check.mjs, which can import both.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DENIED_HOSTS, DENIED_PATH_PREFIXES, DENY_ANY_QUERY_STRING,
  isDeniedHost, isDeniedPath, isDeniedUrl, shouldAskAboutUrl, isAskableUrl,
} from '../src/config.js';
import { DENY_CASES } from './deny-cases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the deny rules are exactly the three Kevin scoped', () => {
  assert.deepEqual([...DENIED_HOSTS], ['thedarwinhub.com', 'www.thedarwinhub.com']);
  assert.deepEqual([...DENIED_PATH_PREFIXES], ['/track', '/api']);
  assert.equal(DENY_ANY_QUERY_STRING, true);
});

// 🔴 THE TEST THAT FAILS ON THE SUFFIX-MATCH IMPLEMENTATION. The bare host is
// denied AND its subdomains are allowed, asserted together — an
// `endsWith('thedarwinhub.com')` deny passes the first line and fails the rest.
test('host deny is an EXACT match, not a domain suffix', () => {
  assert.equal(isDeniedUrl('https://thedarwinhub.com/anything'), true, 'Hub 1.0 is denied');
  assert.equal(isDeniedUrl('https://www.thedarwinhub.com/anything'), true, 'Hub 1.0 www is denied');

  for (const host of [
    'intake.thedarwinhub.com',
    'staging.intake.thedarwinhub.com',
    'accounting.thedarwinhub.com',
    'perclickity.thedarwinhub.com',
  ]) {
    assert.equal(
      isDeniedUrl(`https://${host}/dashboard`),
      false,
      `${host} is IN SCOPE — a suffix-match deny would kill the whole feature`,
    );
  }

  assert.equal(isDeniedHost('thedarwinhub.com'), true);
  assert.equal(isDeniedHost('intake.thedarwinhub.com'), false);
});

test('path deny is on a segment boundary, on every host', () => {
  assert.equal(isDeniedPath('/track'), true);
  assert.equal(isDeniedPath('/track/test'), true);
  assert.equal(isDeniedPath('/api'), true);
  assert.equal(isDeniedPath('/api/v1/x'), true);
  assert.equal(isDeniedPath('/tracking-dashboard'), false, 'startsWith() would wrongly deny this');
  assert.equal(isDeniedPath('/apiary'), false, 'startsWith() would wrongly deny this');
  assert.equal(isDeniedUrl('http://192.168.1.25:8100/api/v1/x'), true, 'LAN hosts are not exempt');
});

test('any query string denies the URL', () => {
  assert.equal(isDeniedUrl('https://intake.thedarwinhub.com/dash?brand=7'), true);
  assert.equal(isDeniedUrl('http://192.168.1.25:8095/leaks?brand=x'), true);
  assert.equal(isDeniedUrl('https://intake.thedarwinhub.com/dash'), false);
  assert.equal(isDeniedUrl('https://intake.thedarwinhub.com/dash#tab'), false, 'a hash is not a query');
});

test('config.js answers the whole shared case table', () => {
  for (const c of DENY_CASES) {
    assert.equal(isDeniedUrl(c.url), c.denied, `${JSON.stringify(c.url)} — ${c.why}`);
  }
});

test('shouldAskAboutUrl is askable AND not denied', () => {
  assert.equal(shouldAskAboutUrl('https://intake.thedarwinhub.com/suppression-dashboard'), true);
  assert.equal(shouldAskAboutUrl('https://thedarwinhub.com/x'), false, 'denied');
  assert.equal(shouldAskAboutUrl('chrome://extensions'), false, 'not askable');
  assert.equal(shouldAskAboutUrl('nonsense'), false, 'not askable, though the deny list allows it');
  assert.equal(isAskableUrl('nonsense'), false, 'kept pure — the deny list is a separate rule');
  for (const c of DENY_CASES) {
    if (c.denied) assert.equal(shouldAskAboutUrl(c.url), false, `denied must never be asked: ${JSON.stringify(c.url)}`);
  }
});

// ─── The content.js mirror ────────────────────────────────────────────────────

async function loadContentMirror() {
  const src = await readFile(resolve(root, 'src/content.js'), 'utf8');
  const begin = src.indexOf('// deny-mirror:begin');
  const end = src.indexOf('// deny-mirror:end');
  assert.ok(begin !== -1 && end > begin, 'content.js must keep the deny-mirror sentinels');
  const body = src.slice(begin + '// deny-mirror:begin'.length, end);
  // The mirror is self-contained by design — if it ever reaches for anything
  // outside itself (chrome.*, a config import) this evaluation throws.
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${body}\nreturn { isDeniedUrl, isDeniedHost, isDeniedPath, DENIED_HOSTS, DENIED_PATH_PREFIXES, DENY_ANY_QUERY_STRING };`);
  return factory();
}

test('content.js carries the deny mirror and uses it before anything else', async () => {
  const src = await readFile(resolve(root, 'src/content.js'), 'utf8');
  assert.ok(/deny-mirror:begin/.test(src) && /deny-mirror:end/.test(src), 'sentinels present');
  // The gate must be the first thing ask() does — before the page key, before
  // any sendMessage. Matching on the two lines in order is enough to catch the
  // gate being moved below the message or deleted.
  assert.ok(
    /function ask\(\)\s*\{[\s\S]{0,200}?isDeniedUrl\(location\.href\)[\s\S]*?sendMessage/.test(src),
    'ask() must call isDeniedUrl(location.href) before chrome.runtime.sendMessage',
  );
});

test('the content.js mirror is identical in content to config.js', async () => {
  const mirror = await loadContentMirror();
  assert.deepEqual([...mirror.DENIED_HOSTS], [...DENIED_HOSTS], 'host lists must match');
  assert.deepEqual([...mirror.DENIED_PATH_PREFIXES], [...DENIED_PATH_PREFIXES], 'path lists must match');
  assert.equal(mirror.DENY_ANY_QUERY_STRING, DENY_ANY_QUERY_STRING, 'query rule must match');
});

test('the content.js mirror answers the shared case table identically to config.js', async () => {
  const mirror = await loadContentMirror();
  for (const c of DENY_CASES) {
    assert.equal(
      mirror.isDeniedUrl(c.url),
      isDeniedUrl(c.url),
      `content.js and config.js disagree on ${JSON.stringify(c.url)} — ${c.why}`,
    );
    assert.equal(mirror.isDeniedUrl(c.url), c.denied, `${JSON.stringify(c.url)} — ${c.why}`);
  }
});

test('background.js routes every call through the deny gate', async () => {
  const src = await readFile(resolve(root, 'src/background.js'), 'utf8');
  assert.ok(/shouldAskAboutUrl/.test(src), 'the worker must use the deny-aware gate');
  assert.ok(!/\bisAskableUrl\b/.test(src), 'isAskableUrl alone is not a gate any more — it misses the deny list');
  // Both network-calling functions gate before they fetch.
  for (const fn of ['lookup', 'newChat']) {
    const start = src.indexOf(`async function ${fn}(`);
    assert.ok(start !== -1, `${fn}() exists`);
    const slice = src.slice(start, src.indexOf('fetch(', start));
    assert.ok(slice.includes('shouldAskAboutUrl'), `${fn}() must gate before it fetches`);
  }
});
