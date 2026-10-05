#!/usr/bin/env node
// SEARCH-LITERAL CHECK — regression suite for the non-AI literal thread search
// (bug 2d4301d1). Drives the compiled dist/ against a scratch jarvis.db, like
// scripts/claude-accounts-test.mjs.
//
//   npm run build
//   npm run search-literal:check

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function guardDbPath() {
  const raw = process.env.JARVIS_DB_PATH;
  if (!raw || !raw.trim()) {
    console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path before running this script.');
    process.exit(1);
  }
  const resolved = path.resolve(raw);
  const live = path.resolve(path.join(__dirname, '..', 'jarvis.db'));
  if (resolved === live) {
    console.error(`FATAL: refusing to run against the live jarvis.db (${live}). Use a /tmp scratch path.`);
    process.exit(1);
  }
  return resolved;
}

const DB_PATH = guardDbPath();
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[search-literal-check] scratch DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getOrCreateConversation, getConversation, addTurn, renameConversation } = await import(path.join(distDir, 'conversation-db.js'));
const { searchThreadsLiteral } = await import(path.join(distDir, 'thread-search.js'));
const Database = (await import('better-sqlite3')).default;

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('\nSEARCH-LITERAL CHECK\n');

// -- static: literal search never touches runClaude --------------------------
// The AI path (searchThreadsByQuery) calls runClaude; the literal path must
// not, so a worker never pays for or waits on a model turn for a plain
// substring search. Checked at the source level rather than by actually
// invoking the AI path, which would spawn a real `claude` CLI process.
console.log('literal search source contains no model call');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'thread-search.ts'), 'utf8');
  const start = src.indexOf('export function searchThreadsLiteral');
  assert.ok(start !== -1, 'searchThreadsLiteral not found in source');
  const body = src.slice(start, src.length);
  const closeIdx = (() => {
    // Walk braces from the function's opening '{' to its matching close.
    const open = body.indexOf('{');
    let depth = 0;
    for (let i = open; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
  })();
  const fnBody = body.slice(0, closeIdx + 1);
  t('searchThreadsLiteral body never references runClaude', !fnBody.includes('runClaude'));
}

// -- fixtures ------------------------------------------------------------
const deepConv = getOrCreateConversation('cockpit:search-literal-deep');
renameConversation(deepConv.id, 'Totally unrelated title');
const FILLER = 'just some ordinary filler message with nothing special in it';
const MAGIC = 'zzzqueenvil42';
addTurn(deepConv.id, 'user', FILLER);
addTurn(deepConv.id, 'assistant', FILLER);
addTurn(deepConv.id, 'user', `here is the secret token ${MAGIC} buried early in the thread`);
for (let i = 0; i < 8; i++) {
  addTurn(deepConv.id, i % 2 === 0 ? 'user' : 'assistant', `${FILLER} #${i}`);
}

const noMatchConv = getOrCreateConversation('cockpit:search-literal-nomatch');
addTurn(noMatchConv.id, 'user', FILLER);
addTurn(noMatchConv.id, 'assistant', FILLER);

const titleMatchConv = getOrCreateConversation('cockpit:search-literal-title');
renameConversation(titleMatchConv.id, `Thread about ${MAGIC} rollout`);
addTurn(titleMatchConv.id, 'user', FILLER);

// Re-fetch so the renameConversation() title writes are reflected (candidates
// passed to searchThreadsLiteral must carry the current title, same as the
// route does via listAllConversations()).
const candidates = [deepConv, noMatchConv, titleMatchConv].map((c) => getConversation(c.external_id));

console.log('\nfinds a thread by a substring buried deep in history (not title, not recent turns)');
{
  const results = searchThreadsLiteral(MAGIC, candidates);
  const ids = results.map((r) => r.thread_id);
  t('deep-match thread is found', ids.includes('cockpit:search-literal-deep'));
  t('no-match thread is excluded', !ids.includes('cockpit:search-literal-nomatch'));
  t('title-match thread is found', ids.includes('cockpit:search-literal-title'));
  const deepResult = results.find((r) => r.thread_id === 'cockpit:search-literal-deep');
  t('deep match reason carries a snippet of the hit', deepResult && deepResult.reason.includes(MAGIC), JSON.stringify(deepResult));
  const titleResult = results.find((r) => r.thread_id === 'cockpit:search-literal-title');
  t('title match reason says "Title match"', titleResult && titleResult.reason.startsWith('Title match'), JSON.stringify(titleResult));
}

console.log('\ncase-insensitive');
{
  const results = searchThreadsLiteral('ZzzQueenVil42', candidates);
  t('matches regardless of case', results.some((r) => r.thread_id === 'cockpit:search-literal-deep'));
}

console.log('\nno query match returns nothing');
{
  const results = searchThreadsLiteral('this-string-appears-nowhere-xyz', candidates);
  t('empty results for a non-matching query', results.length === 0);
}

console.log('\n% and _ in the query are treated as literal characters, not SQL wildcards');
{
  const pctConv = getOrCreateConversation('cockpit:search-literal-pct');
  addTurn(pctConv.id, 'user', 'the 50% off sale starts tomorrow');
  const decoyConv = getOrCreateConversation('cockpit:search-literal-pct-decoy');
  // If '%' were left as a live SQL wildcard, searching "50% off" would also
  // match this row (any char in place of '%').
  addTurn(decoyConv.id, 'user', 'the 50X off sale starts tomorrow');

  const results = searchThreadsLiteral('50% off', [pctConv, decoyConv]);
  const ids = results.map((r) => r.thread_id);
  t('literal % matches the exact text', ids.includes('cockpit:search-literal-pct'));
  t('literal % does NOT act as a wildcard against the decoy', !ids.includes('cockpit:search-literal-pct-decoy'));
}

console.log('\nordered by most-recent activity');
{
  // SQLite's datetime('now') is 1s-resolution, so real-time insert order can't
  // be trusted to produce distinct updated_at values — set them explicitly.
  const older = getOrCreateConversation('cockpit:search-literal-older');
  addTurn(older.id, 'user', `older thread mentions ${MAGIC}`);
  const newer = getOrCreateConversation('cockpit:search-literal-newer');
  addTurn(newer.id, 'user', `newer thread mentions ${MAGIC}`);

  const raw = new Database(DB_PATH);
  raw.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run('2020-01-01 00:00:00', older.id);
  raw.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run('2030-01-01 00:00:00', newer.id);
  raw.close();

  const results = searchThreadsLiteral(MAGIC, [getConversation(older.external_id), getConversation(newer.external_id)]);
  t('most recently-updated thread sorts first', results[0]?.thread_id === 'cockpit:search-literal-newer', JSON.stringify(results));
}

console.log('\ncapped at a sane number of results');
{
  const many = [];
  for (let i = 0; i < 60; i++) {
    const c = getOrCreateConversation(`cockpit:search-literal-bulk-${i}`);
    addTurn(c.id, 'user', `bulk thread ${i} mentions ${MAGIC}`);
    many.push(getConversation(c.external_id));
  }
  const results = searchThreadsLiteral(MAGIC, many);
  t('capped at 50 results', results.length === 50, `got ${results.length}`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} search-literal-check: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
