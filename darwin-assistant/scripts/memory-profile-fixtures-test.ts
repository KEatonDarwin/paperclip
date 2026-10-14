// Golden prompt fixtures for memory-profile assembly (harness spine S1, 2026-10-13 review §3).
//
// Proves, with no model and no live state:
//   (a) the WORKER profile never carries personal-memory content, on any path or adapter;
//   (b) every recovery-path continuation prompt (session-expired / context-overflow / account-swap)
//       for a worker thread uses the worker profile;
//   (c) a failed delivery does not advance the memory dedup baseline — the next wake re-sends full.
// And snapshots the assembled memory injection per (memoryProfile × adapter) under
// scripts/fixtures/memory-profile/golden/. Regenerate on purpose with UPDATE_GOLDEN=1.
//
// Run: npm run memory-profile:test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures', 'memory-profile');
const GOLDEN = join(FIX, 'golden');
const PERSONAL = 'PERSONAL-MEMORY-MARKER-7f3a';
const WORKER = 'WORKER-CORE-MARKER-c21e';

// Hermetic env BEFORE importing anything (several modules read env at load time).
const scratch = mkdtempSync(join(tmpdir(), 'memory-profile-fixtures-'));
const cliCwd = join(scratch, 'cli-cwd');
const claudeConfig = join(scratch, 'claude-config');
const slug = cliCwd.replace(/[^A-Za-z0-9]/g, '-');
Object.assign(process.env, {
  JARVIS_SIM: '1',
  JARVIS_DB_PATH: join(scratch, 'jarvis.db'),
  JARVIS_MEMORY_FILE: join(FIX, 'memory.md'),
  JARVIS_WORKER_CORE_FILE: join(FIX, 'worker-core.md'),
  JARVIS_MEMORY_STATE_DIR: join(scratch, 'memory-injections'),
  JARVIS_CLI_CWD: cliCwd,
  CLAUDE_CONFIG_DIR: claudeConfig,
  // agent.ts warms model shelves at import; point every CLI at nothing so zero processes start.
  CODEX_BIN: join(scratch, 'no-such-codex'),
  AUGGIE_BIN: join(scratch, 'no-such-auggie'),
  DEVIN_BIN: join(scratch, 'no-such-devin'),
  CLAUDE_BIN: join(scratch, 'no-such-claude'),
});

const { loadMemoryBlock, memoryProfileForThread } = await import('../src/prompt.js');
const { memoryRefreshForResume } = await import('../src/token-diet.js');
const { buildContinuationPrompt, buildInitialPrompt } = await import('../src/agent.js');
type Profile = 'full' | 'worker';

const PROFILES: Profile[] = ['full', 'worker'];
const ADAPTERS = [
  { id: 'claude', model: 'claude-opus-5-5', resumeCap: undefined as number | undefined },
  // codex's window is ≤128k, so agent.ts caps the resume block at 12k chars (resumeMemoryMaxChars).
  { id: 'codex', model: 'gpt-5.5', resumeCap: 12_000 },
];
const WORKER_THREAD = 'cockpit:hopper-node-1662-9af57539';
const KEVIN_THREAD = 'cockpit:4209';
const turns = [
  { id: 1, conversation_id: 1, role: 'user', content: 'Earlier question', turn_index: 0 },
  { id: 2, conversation_id: 1, role: 'assistant', content: 'Earlier answer', turn_index: 1 },
  { id: 3, conversation_id: 1, role: 'user', content: 'Latest question', turn_index: 2 },
] as any[];

let convSeq = 1000;
function claudeSession(compactions = 0): string {
  const sid = `sess-${++convSeq}`;
  const dir = join(claudeConfig, 'projects', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), '{"type":"user"}\n' + '{"type":"system","subtype":"compact_boundary"}\n'.repeat(compactions));
  return sid;
}
const memorySection = (prompt: string) => {
  const start = prompt.indexOf('## Current Memory');
  const end = prompt.indexOf('## Prior Transcript');
  assert.ok(start >= 0 && end > start, 'continuation prompt has a ## Current Memory section');
  return prompt.slice(start, end).trim();
};
const normalize = (s: string) => s.split(FIX).join('<FIXTURES>');

function checkGolden(name: string, actual: string) {
  const file = join(GOLDEN, `${name}.txt`);
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
    if (process.env.UPDATE_GOLDEN !== '1') console.log(`  (wrote new golden ${name}.txt)`);
    return;
  }
  assert.equal(actual, readFileSync(file, 'utf8'), `golden ${name}.txt drifted — rerun with UPDATE_GOLDEN=1 only if the change is intended`);
}

test('thread → profile routing: hopper/unblocker workers get worker, Kevin chats get full', () => {
  assert.equal(memoryProfileForThread(WORKER_THREAD), 'worker');
  assert.equal(memoryProfileForThread('cockpit:unblocker-12'), 'worker');
  assert.equal(memoryProfileForThread(KEVIN_THREAD), 'full');
  assert.equal(memoryProfileForThread(null), 'full');
});

for (const profile of PROFILES) {
  for (const adapter of ADAPTERS) {
    test(`golden memory injection: ${profile} × ${adapter.id}`, () => {
      const sid = adapter.id === 'claude' ? claudeSession() : `codex-thread-${++convSeq}`;
      const resume = memoryRefreshForResume(++convSeq, sid, loadMemoryBlock(adapter.resumeCap, profile)).block;
      const cont = memorySection(buildContinuationPrompt(turns, 'Latest question', adapter.id, adapter.model, { memoryProfile: profile }));
      const recovery = memorySection(buildContinuationPrompt(turns, 'Latest question', adapter.id, adapter.model, { memoryProfile: profile, aggressive: true }));
      const initial = buildInitialPrompt('Latest question', profile);
      for (const [path, text] of [['resume', resume], ['continuation', cont], ['recovery', recovery], ['initial', initial]] as const) {
        if (profile === 'worker') {
          assert.ok(!text.includes(PERSONAL), `(a) worker ${path} prompt (${adapter.id}) leaked personal memory`);
          assert.ok(text.includes(WORKER), `worker ${path} prompt (${adapter.id}) carries the worker core`);
        } else {
          assert.ok(text.includes(PERSONAL), `full ${path} prompt (${adapter.id}) carries the memory`);
          assert.ok(!text.includes(WORKER), `full ${path} prompt (${adapter.id}) is not the worker core`);
        }
      }
      checkGolden(`${profile}-${adapter.id}`, normalize([
        '=== resume (first wake) ===', resume,
        '=== continuation ===', cont,
        '=== recovery (aggressive) ===', recovery, '',
      ].join('\n')));
    });
  }
}

test('(b) recovery-path prompts for a worker thread use the worker profile', () => {
  const memoryProfile = memoryProfileForThread(WORKER_THREAD);
  for (const adapter of ADAPTERS) {
    for (const aggressive of [false, true]) {
      const p = buildContinuationPrompt(turns, 'Latest question', adapter.id, adapter.model, { memoryProfile, aggressive });
      assert.ok(!p.includes(PERSONAL), `${adapter.id} aggressive=${aggressive} leaked personal memory`);
      assert.ok(p.includes(WORKER), `${adapter.id} aggressive=${aggressive} lacks the worker core`);
    }
  }
  // And the agent wires its real thread profile into EVERY call site (the leak was call sites that
  // omitted it and fell back to 'full'). memoryProfile is now required by the type, this pins the wiring.
  const src = readFileSync(join(here, '..', 'src', 'agent.ts'), 'utf8');
  const calls = [...src.matchAll(/buildContinuationPrompt\(turns,[^\n]*/g)].map((m) => m[0]);
  assert.ok(calls.length >= 4, `expected the normal + 3 recovery call sites, found ${calls.length}`);
  for (const c of calls) assert.match(c, /memoryProfile\b/, `call site without memoryProfile: ${c}`);
  assert.match(src, /const memoryProfile = memoryProfileForThread\(conv\.external_id\);/);
  assert.match(src, /loadMemoryBlock\(resumeMemoryMaxChars, memoryProfile\)/);
  assert.match(src, /buildInitialPrompt\(modelInput, memoryProfile\)/);
});

test('(c) a failed delivery does not advance the baseline — next wake re-sends full', () => {
  const conv = ++convSeq;
  const sid = claudeSession();
  const block = loadMemoryBlock(undefined, 'worker');
  const first = memoryRefreshForResume(conv, sid, block);
  assert.ok(first.block.startsWith('<memory_refresh>\n'), 'first wake is a full refresh');
  // spawn failed → commit() never called
  const retry = memoryRefreshForResume(conv, sid, block);
  assert.ok(retry.block.startsWith('<memory_refresh>\n'), 'after a failed delivery the next wake must re-send FULL, not "unchanged"');
  assert.ok(retry.block.includes(WORKER));
  retry.commit(); // delivered
  const after = memoryRefreshForResume(conv, sid, block);
  assert.match(after.block, /unchanged="true"/, 'after an acknowledged delivery the next wake dedups');
});

test('(c) a failed diff delivery re-sends the same diff (baseline still the last delivered copy)', () => {
  const conv = ++convSeq;
  const sid = claudeSession();
  const v1 = loadMemoryBlock(undefined, 'full');
  memoryRefreshForResume(conv, sid, v1).commit();
  const v2 = `${v1}\nNEW-LINE-ADDED`;
  const d1 = memoryRefreshForResume(conv, sid, v2);
  assert.match(d1.block, /mode="diff"/);
  assert.match(d1.block, /\+ NEW-LINE-ADDED/);
  // not committed (failed) → still diffs against v1
  const d2 = memoryRefreshForResume(conv, sid, v2);
  assert.equal(d2.block, d1.block);
  d2.commit();
  assert.match(memoryRefreshForResume(conv, sid, v2).block, /unchanged="true"/);
});

test('unknown compaction state (codex sessions: no Claude session file) always forces FULL', () => {
  const conv = ++convSeq;
  const sid = `codex-thread-${conv}`;
  const block = loadMemoryBlock(12_000, 'worker');
  for (let i = 0; i < 3; i++) {
    const r = memoryRefreshForResume(conv, sid, block);
    assert.ok(r.block.startsWith('<memory_refresh>\n'), `codex wake ${i} must be full`);
    r.commit();
  }
});

test('a new compaction since the last delivery forces FULL', () => {
  const conv = ++convSeq;
  const sid = claudeSession(0);
  const block = loadMemoryBlock(undefined, 'full');
  memoryRefreshForResume(conv, sid, block).commit();
  writeFileSync(join(claudeConfig, 'projects', slug, `${sid}.jsonl`), '{"type":"system","subtype":"compact_boundary"}\n');
  assert.ok(memoryRefreshForResume(conv, sid, block).block.startsWith('<memory_refresh>\n'));
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
