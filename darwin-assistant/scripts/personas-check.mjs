// Hermetic check for persona levels (src/personas.ts + prompt.ts + wiki tools).
// Runs against a temp registry + temp persona dirs; never touches the live wiki.
// Usage: node scripts/personas-check.mjs   (after `npx tsc -p .`)
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const tmp = mkdtempSync(join(tmpdir(), 'personas-check-'));
const alphaDir = join(tmp, 'alpha');
mkdirSync(join(alphaDir, 'playbook', 'patterns'), { recursive: true });
mkdirSync(join(alphaDir, 'playbook', 'proposals'), { recursive: true });
writeFileSync(join(alphaDir, 'identity.md'), '# I AM ALPHA IDENTITY');
writeFileSync(join(alphaDir, 'memory.md'), 'ALPHA OWN MEMORY v1');
writeFileSync(join(alphaDir, 'questions.md'), 'Q1 something?');
writeFileSync(join(alphaDir, 'playbook', 'the-method.md'), 'METHOD BODY');
for (const d of ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']) writeFileSync(join(alphaDir, 'playbook', 'patterns', `${d}.md`), `PATTERN ${d}`);
writeFileSync(join(alphaDir, 'playbook', 'proposals', '2026-10-13.md'), 'PROPOSAL 13');
const digestScript = join(tmp, 'digest.sh');
writeFileSync(digestScript, '#!/bin/sh\necho DIGEST-LINE-$$\n'); 
import { chmodSync } from 'node:fs'; chmodSync(digestScript, 0o755);
const reg = join(tmp, 'personas.json');
const writeReg = (extra = {}) => writeFileSync(reg, JSON.stringify({ personas: [
  { key: 'alpha', label: 'Alpha', dir: alphaDir, playbook_recent: 2, live_digest_cmd: [digestScript], live_digest_ttl_seconds: 60, match: { exact: ['cockpit:jarvis-alpha'] }, ...extra },
  { key: 'listener', label: 'L', dir: join(tmp, 'nope'), inherit_shared_memory: false, match: { prefix: ['cockpit:kevin-narrates'] } },
  { bad: true },
] }));
writeReg();
process.env.JARVIS_PERSONAS_FILE = reg;

const personas = await import('../dist/personas.js');
const prompt = await import('../dist/prompt.js');
const wiki = await import('../dist/tools/wiki.js');

let n = 0; const ok = (name) => { n++; console.log(`  ✓ ${name}`); };

// 1. resolver
assert.equal(personas.resolvePersonaForThread('cockpit:jarvis-alpha')?.key, 'alpha'); ok('exact match → alpha');
assert.equal(personas.resolvePersonaForThread('cockpit:kevin-narrates')?.key, 'listener'); ok('prefix match → listener');
assert.equal(personas.resolvePersonaForThread('cockpit:some-other'), null); ok('unbound thread → null');
assert.equal(personas.resolvePersonaForThread(null), null); ok('null id → null');
assert.equal(personas.loadPersonas().length, 2); ok('malformed registry row dropped');

// 2. memory profile precedence
assert.equal(prompt.memoryProfileForThread('cockpit:jarvis-alpha'), 'persona:alpha'); ok('profile = persona:alpha');
assert.equal(prompt.memoryProfileForThread('cockpit:hopper-node-12-ab'), 'worker'); ok('worker keeps precedence');
assert.equal(prompt.memoryProfileForThread('cockpit:anything'), 'full'); ok('plain thread = full');

// 3. persona block content
const block = prompt.loadMemoryBlock(undefined, 'persona:alpha');
assert.match(block, /I AM ALPHA IDENTITY/); ok('block carries identity');
assert.match(block, /ALPHA OWN MEMORY v1/); ok('block carries own memory');
assert.match(block, /METHOD BODY/); ok('block carries playbook method');
assert.match(block, /PATTERN 2026-10-13/); assert.match(block, /PATTERN 2026-10-12/); assert.doesNotMatch(block, /PATTERN 2026-10-11/); ok('newest 2 patterns only');
assert.match(block, /PROPOSAL 13/); ok('latest proposals included');
assert.match(block, /Q1 something/); ok('questions log included');
assert.match(block, /shared JARVIS memory \(inherited/); ok('shared memory inherited by default');
// listener: no inherit, missing dir → still a block, no shared memory
const lb = prompt.loadMemoryBlock(undefined, 'persona:listener');
assert.doesNotMatch(lb, /shared JARVIS memory \(inherited/); assert.match(lb, /identity file missing/); ok('no-inherit persona omits shared memory; missing identity named not thrown');
// full is byte-identical to before: contains the shared header
assert.match(prompt.loadMemoryBlock(undefined, 'full'), /Your Persistent Memory \(auto-loaded every message\)/); ok('full profile unchanged');

// 4. persona-aware memory tools
const ctxAlpha = { conversationId: 1, externalId: 'cockpit:jarvis-alpha', sourceMessageId: 'x', sourceTimestamp: 'y', originalText: '' };
const r = await wiki.readMemory.execute({}, ctxAlpha);
assert.equal(r.content, 'ALPHA OWN MEMORY v1'); ok('read_memory in alpha seat reads alpha file');
const w = await wiki.writeMemory.execute({ content: 'ALPHA OWN MEMORY v2' }, ctxAlpha);
assert.equal(w.persona_memory, true); assert.equal(readFileSync(join(alphaDir, 'memory.md'), 'utf-8'), 'ALPHA OWN MEMORY v2'); ok('write_memory in alpha seat writes alpha file');
assert.equal(personas.personaMemoryPathForThread('cockpit:other'), null); ok('plain thread → shared memory path (null)');

// 5. digest block
const d1 = personas.buildPersonaDigestBlock('cockpit:jarvis-alpha');
assert.match(d1, /<persona_digest persona="alpha"/); assert.match(d1, /DIGEST-LINE-/); ok('digest block from command');
const d2 = personas.buildPersonaDigestBlock('cockpit:jarvis-alpha');
assert.equal(d1.replace(/generated="[^"]+"/, ''), d2.replace(/generated="[^"]+"/, '')); ok('digest cached within ttl');
assert.equal(personas.buildPersonaDigestBlock('cockpit:other'), ''); ok('no digest for unbound thread');
writeReg({ live_digest_cmd: ['/nonexistent/cmd'] }); personas._resetPersonaCaches();
assert.match(personas.buildPersonaDigestBlock('cockpit:jarvis-alpha'), /digest unavailable/); ok('failing digest never throws');

// 6. registry hot-reload + missing registry fallback
writeFileSync(reg, '{ not json'); personas._resetPersonaCaches();
assert.equal(prompt.memoryProfileForThread('cockpit:jarvis-alpha'), 'full'); ok('corrupt registry → plain path');
rmSync(reg); personas._resetPersonaCaches();
assert.equal(prompt.memoryProfileForThread('cockpit:jarvis-alpha'), 'full'); ok('missing registry → plain path');
assert.match(prompt.loadMemoryBlock(undefined, 'persona:alpha'), /Your Persistent Memory/); ok('vanished persona → shared block, not a crash');

rmSync(tmp, { recursive: true, force: true });
console.log(`personas-check: ${n} passed`);
