#!/usr/bin/env node
// TEAMS RADAR TESTS — hermetic unit tests for src/teams-radar.ts (tree-675acbd3,
// node #1552). No live data, no model calls, no network.
//
//   npm run build
//   JARVIS_DB_PATH=/tmp/teams-radar-check.db node scripts/teams-radar-check.mjs
//
// (drives the compiled dist/, like scripts/work-board-test.mjs. Importing
// dist/teams-radar.js pulls in conversation-db.js, which opens a sqlite handle
// at import time, so a JARVIS_DB_PATH scratch guard is required. Catches
// themselves are plain files under a /tmp fixture dir via TEAMS_RADAR_DIR —
// never the live /home/kevin/teams-radar/catches.)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
  const live = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
  if (resolved === live) {
    console.error(`FATAL: refusing to run against the live jarvis.db (${live}). Use a /tmp scratch path.`);
    process.exit(1);
  }
  return resolved;
}

const DB_PATH = guardDbPath();
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[teams-radar-check] scratch DB: ${DB_PATH}`);

// Fixture catches dir — never the live /home/kevin/teams-radar/catches. One
// level under its own tmp root so `../state.json` lands in an isolated spot,
// not directly in /tmp (which other processes may also be writing to).
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-radar-check-'));
const FIXTURE_DIR = path.join(FIXTURE_ROOT, 'catches');
fs.mkdirSync(FIXTURE_DIR);
process.env.TEAMS_RADAR_DIR = FIXTURE_DIR;
console.log(`[teams-radar-check] fixture catches dir: ${FIXTURE_DIR}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getConversation, getTurns } = await import(path.join(distDir, 'conversation-db.js'));
const {
  listTeamsRadarCatches,
  getTeamsRadarCatch,
  openTeamsRadarChat,
  getTeamsRadarLastSweepAt,
} = await import(path.join(distDir, 'teams-radar.js'));

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function isoHoursAgo(h) {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

function writeCatch(id, overrides = {}) {
  const base = {
    id,
    chat_key: 'quantum-300k',
    message_id: id,
    author: 'Test Author',
    created_at: isoHoursAgo(1),
    web_url: `https://teams.microsoft.com/l/message/fake/${id}`,
    quote: 'some quote text',
    kind: 'issue',
    claim: 'A claim about something being broken.',
    subject: 'media_buy',
    probe: { type: 'matrix', ref: 'fake_check', why: 'test fixture' },
    verdict: 'verified_broken',
    verdict_why: 'matrix status bad',
    probe_ran: { cmd: 'echo fake', started_at: new Date().toISOString(), ms: 5, stdout_head: 'fake evidence', exit: 0 },
    verified_at: new Date().toISOString(),
    action: { kind: 'kit', kit_path: 'outbox/fake/', kit_label: 'Fake kit', kevin_do: null, summary: 'did a thing' },
    acted_at: new Date().toISOString(),
  };
  const obj = { ...base, ...overrides, id };
  fs.writeFileSync(path.join(FIXTURE_DIR, `${id}.json`), JSON.stringify(obj, null, 2));
  return obj;
}

// ── TEST 1: sorted created_at DESC ──────────────────────────────────────────
{
  writeCatch('t1-old', { created_at: isoHoursAgo(5) });
  writeCatch('t1-new', { created_at: isoHoursAgo(1) });
  const { catches } = listTeamsRadarCatches({ includeFine: true, days: 0 });
  const idxOld = catches.findIndex((c) => c.id === 't1-old');
  const idxNew = catches.findIndex((c) => c.id === 't1-new');
  assert.ok(idxNew < idxOld, 'newer catch sorts before older catch');
  ok('catches sorted created_at DESC');
}

// ── TEST 2: counts tally all four buckets, including chatter from kind ─────
{
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  writeCatch('t2-broken', { verdict: 'verified_broken' });
  writeCatch('t2-fine', { verdict: 'verified_fine' });
  writeCatch('t2-cant', { verdict: 'cant_verify' });
  writeCatch('t2-chatter', { verdict: 'not_applicable', kind: 'chatter', probe: { type: 'none' } });
  const { counts } = listTeamsRadarCatches({ includeFine: true, days: 0 });
  assert.equal(counts.broken, 1, 'one verified_broken counted');
  assert.equal(counts.fine, 1, 'one verified_fine counted');
  assert.equal(counts.cant_verify, 1, 'one cant_verify counted');
  assert.equal(counts.chatter, 1, 'one not_applicable counted as chatter');
  ok('counts tally broken/fine/cant_verify/chatter correctly');
}

// ── TEST 3: include_fine=false excludes verified_fine from the list but ────
// still counts it ────────────────────────────────────────────────────────
{
  const { catches, counts } = listTeamsRadarCatches({ includeFine: false, days: 0 });
  assert.ok(!catches.some((c) => c.id === 't2-fine'), 'verified_fine catch hidden from the list');
  assert.ok(catches.some((c) => c.id === 't2-broken'), 'verified_broken catch still shown');
  assert.equal(counts.fine, 1, 'verified_fine still reflected in counts even though hidden from the list');
  ok('include_fine=0 hides fine catches from the list, not from the counts');
}

// ── TEST 4: days filter excludes catches older than the cutoff ─────────────
{
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  writeCatch('t4-recent', { created_at: isoHoursAgo(1) });
  writeCatch('t4-stale', { created_at: isoHoursAgo(24 * 10) });
  const { catches } = listTeamsRadarCatches({ includeFine: true, days: 7 });
  assert.ok(catches.some((c) => c.id === 't4-recent'), 'recent catch included within days=7');
  assert.ok(!catches.some((c) => c.id === 't4-stale'), 'stale (10d) catch excluded by days=7');
  ok('days filter excludes catches older than the cutoff');
}

// ── TEST 5: days<=0 means no time filter (all catches on disk) ─────────────
{
  const { catches } = listTeamsRadarCatches({ includeFine: true, days: 0 });
  assert.ok(catches.some((c) => c.id === 't4-stale'), 'days=0 includes the stale (10d) catch too');
  ok('days<=0 applies no time filter');
}

// ── TEST 6: a malformed catch file is skipped, not thrown ──────────────────
{
  fs.writeFileSync(path.join(FIXTURE_DIR, 'broken.json'), '{ not valid json');
  fs.writeFileSync(path.join(FIXTURE_DIR, 'missing-fields.json'), JSON.stringify({ id: 'x' }));
  assert.doesNotThrow(() => listTeamsRadarCatches({ includeFine: true, days: 0 }), 'malformed/incomplete catch files do not throw');
  ok('malformed or incomplete catch files are skipped, not thrown');
}

// ── TEST 7: getTeamsRadarCatch returns null for an unknown id ──────────────
{
  assert.equal(getTeamsRadarCatch('does-not-exist'), null, 'unknown catch id returns null');
  const found = getTeamsRadarCatch('t4-recent');
  assert.ok(found, 'known catch id returns the parsed object');
  assert.equal(found.id, 't4-recent');
  ok('getTeamsRadarCatch: null for unknown id, object for known id');
}

// ── TEST 8: openTeamsRadarChat returns null for an unknown catch id ────────
{
  assert.equal(openTeamsRadarChat('does-not-exist'), null, 'opening a chat for an unknown catch id returns null');
  ok('openTeamsRadarChat returns null for an unknown catch id');
}

// ── TEST 9: first open creates the conversation + one zero-cost assistant ──
// turn, and persists chat_external_id back into the catch file ─────────────
{
  const result = openTeamsRadarChat('t4-recent');
  assert.ok(result, 'open returns a result for a known catch');
  assert.equal(result.external_id, 'cockpit:teams-catch-t4-recent', 'external_id follows the cockpit:teams-catch-<id> convention');
  assert.equal(result.link, `/threads?open=${encodeURIComponent(result.external_id)}`, 'link is the relative, encoded threads?open= form');
  assert.equal(result.created, true, 'first open reports created:true');

  const conv = getConversation(result.external_id);
  assert.ok(conv, 'conversation now exists');
  const turns = getTurns(conv.id);
  assert.equal(turns.length, 1, 'exactly one turn was written — the scope note');
  assert.equal(turns[0].role, 'assistant', 'the scope note is written as an assistant turn, not a user message (zero model cost)');
  assert.ok(turns[0].content.includes('t4-recent'), 'scope note references the catch id');

  const persisted = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 't4-recent.json'), 'utf8'));
  assert.equal(persisted.chat_external_id, result.external_id, 'chat_external_id persisted back into the catch file');
  ok('first open: creates conversation, writes one assistant-role scope note, persists chat_external_id');
}

// ── TEST 10: second open reuses the conversation, no second turn ───────────
{
  const result = openTeamsRadarChat('t4-recent');
  assert.equal(result.created, false, 'second open reports created:false');
  const conv = getConversation(result.external_id);
  const turns = getTurns(conv.id);
  assert.equal(turns.length, 1, 'still exactly one turn — reopening never re-seeds');
  ok('second open reuses the existing conversation and does not duplicate the scope note');
}

// ── TEST 11: last_sweep_at reads state.json one dir up from the catches dir;
// missing state.json → null ─────────────────────────────────────────────────
{
  assert.equal(getTeamsRadarLastSweepAt(), null, 'no state.json next to the fixture dir → null, not a throw');
  const stateFile = path.join(FIXTURE_ROOT, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ updated_at: '2026-10-07T13:36:00Z' }));
  assert.equal(getTeamsRadarLastSweepAt(), '2026-10-07T13:36:00Z', 'reads updated_at from state.json');
  fs.rmSync(stateFile, { force: true });
  ok('last_sweep_at: null when state.json absent, reads updated_at when present');
}

fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`\n[teams-radar-check] ALL ${passed} tests passed ✅`);
