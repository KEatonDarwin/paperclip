#!/usr/bin/env -S npx tsx
// MEMORY LAYOUT TESTS (lean/prompt-diet, 2026-10-17; src/memory-layout.ts).
//
//   npm run memory-layout:test
//
// Scratch DB + scratch vault + scratch HOME. No model calls, no network, never touches the live
// jarvis.db or the live wiki. Covers: the 'single' default is byte-identical to before, a missing
// core.md falls back to single, the core layout fills the pack index, trigger matching on word
// edges + the per-turn cap, once-per-session pack dedupe (and re-send after a compaction or a pack
// edit), read_memory/write_memory follow the layout, and rollback by setting alone.
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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'memlayout-'));
const vault = path.join(scratch, 'vault');
const home = path.join(scratch, 'home');
const cliCwd = path.join(scratch, 'cli-cwd');
process.env.JARVIS_VAULT_ROOT = vault;
process.env.HOME = home;
process.env.JARVIS_CLI_CWD = cliCwd;
delete process.env.CLAUDE_CONFIG_DIR;

const jdir = path.join(vault, 'agent-memory/jarvis');
fs.mkdirSync(path.join(jdir, 'memory/packs'), { recursive: true });
const LEGACY = '# legacy memory\n- the one big file';
fs.writeFileSync(path.join(jdir, 'memory.md'), LEGACY);
const pack = (name: string, triggers: string, body: string) =>
  fs.writeFileSync(path.join(jdir, 'memory/packs', `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} pack\ntriggers: ${triggers}\n---\n\n${body}\n`);
pack('cpa-accounting', 'cpa, invoice, quickbooks', '## CPA\n- match by ID');
pack('kevin', 'resume, job', '## job search\n- sensitive');
pack('engine', 'hopper, tree', '## engine');
pack('leads-rebuild', 'rebuild, invoice', '## rebuild');

const { getSetting, setSetting } = await import('../src/conversation-db.js');
const { loadMemoryBlock } = await import('../src/prompt.js');
const ml = await import('../src/memory-layout.js');
const { readMemory, writeMemory } = await import('../src/tools/wiki.js');

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n${(e as Error).stack}`); process.exitCode = 1; }
};

console.log('memory-layout tests');

await t('default layout is single and loads memory.md whole', () => {
  assert.equal(getSetting('memory_layout'), null);
  assert.equal(ml.memoryLayout(), 'single');
  const block = loadMemoryBlock();
  assert.ok(block.includes(LEGACY));
  assert.ok(!block.includes('{{PACK_INDEX}}'));
  assert.equal(ml.memoryPacksForTurn(1, null, 'what is the cpa invoice?'), '', 'no packs on single');
});

await t('core requested but core.md missing -> single (never strips memory)', () => {
  setSetting('memory_layout', 'core');
  assert.equal(ml.memoryLayout(), 'single');
  assert.ok(loadMemoryBlock().includes(LEGACY));
});

fs.writeFileSync(path.join(jdir, 'memory/core.md'), '# CORE\n- rule one\n\n# PACKS\n{{PACK_INDEX}}\n');

await t('core layout loads core.md with the pack index filled in, not the packs', () => {
  assert.equal(ml.memoryLayout(), 'core');
  const block = loadMemoryBlock();
  assert.ok(block.includes('- rule one'));
  assert.ok(!block.includes(LEGACY));
  assert.ok(!block.includes('{{PACK_INDEX}}'));
  assert.ok(block.includes('**cpa-accounting** — `agent-memory/jarvis/memory/packs/cpa-accounting.md`'));
  assert.ok(!block.includes('match by ID'), 'pack bodies are not in the core block');
});

await t('triggers match on word edges, case-insensitive, best score first', () => {
  const names = (s: string) => ml.packsForMessage(s).map((p) => p.name);
  assert.deepEqual(names('Is the CPA invoice right?'), ['cpa-accounting', 'leads-rebuild']);
  assert.deepEqual(names('log into cpanel'), [], '"cpa" must not match inside "cpanel"');
  assert.deepEqual(names('nothing relevant here'), []);
  assert.deepEqual(names('update my resume'), ['kevin']);
});

await t('at most 3 packs per turn', () => {
  assert.equal(ml.packsForMessage('cpa invoice resume hopper rebuild').length, 3);
});

await t('no session: matched packs are sent every time', () => {
  const a = ml.memoryPacksForTurn(7, null, 'cpa question');
  const b = ml.memoryPacksForTurn(7, null, 'cpa question');
  assert.ok(a.includes('<pack name="cpa-accounting"') && a.includes('match by ID'));
  assert.equal(a, b);
});

const slug = cliCwd.replace(/[^A-Za-z0-9]/g, '-');
const sessDir = path.join(home, '.claude', 'projects', slug);
fs.mkdirSync(sessDir, { recursive: true });
const sessFile = path.join(sessDir, 'sess-1.jsonl');
fs.writeFileSync(sessFile, '{"type":"user"}\n');

await t('live session: a pack is sent once, then not again', () => {
  const first = ml.memoryPacksForTurn(9, 'sess-1', 'cpa question');
  assert.ok(first.includes('<pack name="cpa-accounting"'));
  assert.equal(ml.memoryPacksForTurn(9, 'sess-1', 'another cpa question'), '');
  const mixed = ml.memoryPacksForTurn(9, 'sess-1', 'cpa and my resume');
  assert.ok(mixed.includes('<pack name="kevin"') && !mixed.includes('<pack name="cpa-accounting"'));
});

await t('after a compaction the pack is sent again', () => {
  fs.appendFileSync(sessFile, '{"type":"system","subtype":"compact_boundary"}\n');
  assert.ok(ml.memoryPacksForTurn(9, 'sess-1', 'cpa question').includes('<pack name="cpa-accounting"'));
  assert.equal(ml.memoryPacksForTurn(9, 'sess-1', 'cpa question'), '');
});

await t('an edited pack is sent again in the same session', async () => {
  await new Promise((r) => setTimeout(r, 15)); // distinct mtime for the pack cache
  pack('cpa-accounting', 'cpa, invoice, quickbooks', '## CPA\n- match by ID\n- NEW FACT');
  const out = ml.memoryPacksForTurn(9, 'sess-1', 'cpa question');
  assert.ok(out.includes('NEW FACT'));
});

await t('a new session starts clean', () => {
  fs.writeFileSync(path.join(sessDir, 'sess-2.jsonl'), '{"type":"user"}\n');
  assert.ok(ml.memoryPacksForTurn(9, 'sess-2', 'cpa question').includes('<pack name="cpa-accounting"'));
});

await t('read_memory / write_memory follow the layout (core)', async () => {
  const r = (await readMemory.execute({}, { externalId: 'cockpit:x' } as never)) as { content: string };
  assert.ok(r.content.includes('- rule one'));
  const w = (await writeMemory.execute({ content: '# CORE v2\n{{PACK_INDEX}}' }, { externalId: 'cockpit:x' } as never)) as { path: string };
  assert.equal(w.path, 'agent-memory/jarvis/memory/core.md');
  assert.equal(fs.readFileSync(path.join(jdir, 'memory/core.md'), 'utf8'), '# CORE v2\n{{PACK_INDEX}}');
  assert.equal(fs.readFileSync(path.join(jdir, 'memory.md'), 'utf8'), LEGACY, 'legacy file untouched');
});

await t('rollback by setting alone: memory_layout=single -> memory.md again', async () => {
  setSetting('memory_layout', 'single');
  assert.ok(loadMemoryBlock().includes(LEGACY));
  const r = (await readMemory.execute({}, { externalId: 'cockpit:x' } as never)) as { content: string };
  assert.equal(r.content, LEGACY);
  assert.equal(ml.memoryPacksForTurn(9, 'sess-2', 'cpa question'), '');
});

await t('worker profile is unaffected by the layout', () => {
  setSetting('memory_layout', 'core');
  const w = loadMemoryBlock(undefined, 'worker');
  assert.ok(w.includes('Worker Rules'));
  assert.ok(!w.includes('CORE v2'));
});

console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);
