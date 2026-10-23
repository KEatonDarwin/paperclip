#!/usr/bin/env -S npx tsx
// MEMORY METER TESTS (lean/harness-gaps, 2026-10-17; src/memory-meter.ts).
//
//   npm run memory-meter:test
//
// Scratch DB + scratch vault. No model calls, no network, never touches the live jarvis.db or wiki.
// Covers: budgets match the watchdog, ok/warn/over thresholds, the single and core layouts, a
// missing file, the backup trend, and the size receipt write_memory now returns.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.startsWith('/tmp/')) {
  console.error('FATAL: JARVIS_DB_PATH must be a /tmp scratch path.');
  process.exit(1);
}
for (const f of [raw, `${raw}-wal`, `${raw}-shm`]) fs.rmSync(f, { force: true });

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'memmeter-'));
const vault = path.join(scratch, 'vault');
process.env.JARVIS_VAULT_ROOT = vault;
const jdir = path.join(vault, 'agent-memory/jarvis');
fs.mkdirSync(path.join(jdir, 'memory/packs'), { recursive: true });
const put = (rel: string, bytes: number) => fs.writeFileSync(path.join(jdir, rel), 'x'.repeat(bytes));

put('memory.md', 50_000);
put('memory.md.bak-20261007-105110', 90_000);
put('memory.md.bak-20261013-tokendiet', 100_000);
put('memory.md.bak-pr3-20260824', 60_000);
put('memory.md.bak-20261013-installer', 101_000);
put('worker-core.md', 5_000);

const { setSetting } = await import('../src/conversation-db.js');
const { MEMORY_BUDGETS, budgetFor, levelFor, memoryMeter, writeReceipt } = await import('../src/memory-meter.js');
const { writeMemory } = await import('../src/tools/wiki.js');

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n${(e as Error).stack}`); process.exitCode = 1; }
};

console.log('memory meter tests');

await t('budgets are the watchdog numbers', () => {
  const py = fs.readFileSync(new URL('./jarvis-watchdog.py', import.meta.url), 'utf8');
  for (const [n, rel] of [[MEMORY_BUDGETS.legacy, 'memory.md'], [MEMORY_BUDGETS.core, 'memory/core.md']] as const) {
    assert.ok(py.includes(`${n.toLocaleString('en-US').replace(/,/g, '_')}, "${rel}"`), `watchdog budget for ${rel} != ${n}`);
  }
  assert.ok(py.includes(`(p, ${MEMORY_BUDGETS.pack.toLocaleString('en-US').replace(/,/g, '_')}, "memory/packs/"`));
  assert.equal(budgetFor('agent-memory/jarvis/memory/packs/cpa.md'), 25_000);
  assert.equal(budgetFor('agent-memory/jarvis/worker-core.md'), 15_000);
  assert.equal(budgetFor('agent-memory/personas/alpha/memory.md'), 84_000, 'unknown file falls back to the main budget');
});

await t('ok below 90%, warn from 90%, over past budget', () => {
  assert.equal(levelFor(75_000, 84_000), 'ok');
  assert.equal(levelFor(75_600, 84_000), 'warn');
  assert.equal(levelFor(84_000, 84_000), 'warn');
  assert.equal(levelFor(84_001, 84_000), 'over');
});

await t('single layout measures memory.md and estimates tokens', () => {
  const m = memoryMeter();
  assert.equal(m.layout, 'single');
  assert.equal(m.files[0].rel, 'agent-memory/jarvis/memory.md');
  assert.equal(m.files[0].bytes, 50_000);
  assert.equal(m.files[0].tokens, 12_500);
  assert.equal(m.files[0].level, 'ok');
  assert.equal(m.every_turn_tokens, 12_500, 'worker core is not counted as every-turn');
  assert.ok(m.files.some((f) => f.label === 'Worker core'));
  assert.ok(m.headline.includes('50KB of 84KB'));
});

await t('trend: one point per backup day, oldest first, ending at now', () => {
  const m = memoryMeter();
  assert.deepEqual(m.trend.map((p) => p.date), ['2026-08-24', '2026-10-07', '2026-10-13', 'now']);
  assert.equal(m.trend.at(-1)!.bytes, 50_000);
});

await t('over budget turns the whole meter red and names the file', () => {
  put('memory.md', 123_071);
  const m = memoryMeter();
  assert.equal(m.level, 'over');
  assert.equal(m.files[0].pct, 147);
  assert.ok(m.headline.includes('over budget: Memory'));
  put('memory.md', 50_000);
});

await t('core layout: core every turn, packs on demand, a fat pack is flagged', () => {
  put('memory/core.md', 20_000);
  put('memory/packs/cpa.md', 26_000);
  put('memory/packs/kevin.md', 4_000);
  setSetting('memory_layout', 'core');
  const m = memoryMeter();
  assert.equal(m.layout, 'core');
  assert.deepEqual(m.files.map((f) => f.label), ['Core memory', 'Pack: cpa', 'Pack: kevin', 'Worker core']);
  assert.equal(m.every_turn_tokens, 5_000);
  assert.equal(m.files[1].level, 'over');
  assert.equal(m.level, 'over');
  assert.equal(m.trend.at(-1)!.bytes, 50_000, 'trend still tracks memory.md');
  setSetting('memory_layout', 'single');
});

await t('a missing memory file is reported, not thrown', () => {
  fs.renameSync(path.join(jdir, 'memory.md'), path.join(jdir, 'gone'));
  const m = memoryMeter();
  assert.equal(m.files[0].level, 'missing');
  assert.equal(m.level, 'missing');
  assert.ok(m.headline.includes('missing'));
  fs.renameSync(path.join(jdir, 'gone'), path.join(jdir, 'memory.md'));
});

await t('write receipt: no warning when small, a warning near and over budget', () => {
  assert.equal(writeReceipt('agent-memory/jarvis/memory.md', 40_000).warning, undefined);
  assert.match(writeReceipt('agent-memory/jarvis/memory.md', 80_000).warning!, /95% of its 84KB/);
  const over = writeReceipt('agent-memory/jarvis/memory/core.md', 31_000);
  assert.equal(over.level, 'over');
  assert.match(over.warning!, /OVER its 30KB budget/);
});

await t('write_memory returns the size receipt for what it just wrote', async () => {
  const r = (await writeMemory.execute({ content: 'é'.repeat(45_000) }, {} as never)) as Record<string, any>;
  assert.equal(r.written, true);
  assert.equal(r.size.bytes, 90_000, 'counts UTF-8 bytes, not characters');
  assert.equal(r.size.level, 'over');
  assert.ok(r.size.warning);
  assert.equal(fs.statSync(path.join(jdir, 'memory.md')).size, 90_000);
});

console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
process.exit(process.exitCode ?? 0);
