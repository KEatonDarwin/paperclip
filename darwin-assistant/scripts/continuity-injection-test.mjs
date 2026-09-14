#!/usr/bin/env node
// First-turn continuity injection smoke test.
//
// Run after `npm run build`:
//   JARVIS_DB_PATH=/tmp/continuity-injection-test.db node scripts/continuity-injection-test.mjs
//
// This imports compiled dist/agent.js, so the scratch DB guard must run before
// the dynamic import. No model calls are made.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const liveDb = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
const dbPath = path.resolve(process.env.JARVIS_DB_PATH || `/tmp/continuity-injection-test-${process.pid}.db`);
if (dbPath === liveDb) {
  console.error(`FATAL: refusing to run against the live jarvis.db (${liveDb}). Use a /tmp scratch path.`);
  process.exit(1);
}
process.env.JARVIS_DB_PATH = dbPath;
fs.rmSync(dbPath, { force: true });
console.log(`[continuity-injection-test] scratch DB: ${dbPath}`);

const distAgent = await import(path.join(__dirname, '..', 'dist', 'agent.js'));
const {
  buildPromptForNewSession,
  CONTINUITY_BOOT_FILE,
  CONTINUITY_BOOT_HEADER,
  shouldInjectContinuityBoot,
} = distAgent;

const continuityBody = fs.readFileSync(CONTINUITY_BOOT_FILE, 'utf-8').trim();
const contentSentinel = continuityBody.split('\n').find((line) => line.includes('Layer 3'));
assert.ok(contentSentinel, 'continuity fixture should contain a Layer 3 sentinel line');

function turn(role, content, index = 0) {
  return {
    id: index + 1,
    conversation_id: 1,
    turn_index: index,
    role,
    content,
    tool_name: null,
    tool_args: null,
    tool_result: null,
    created_at: '2026-09-14 09:00:00',
    timing_ms: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    model: null,
    claude_input: null,
    claude_output: null,
    error_detail: null,
    images: null,
  };
}

const firstTurn = [turn('user', 'first message', 0)];
const firstPrompt = buildPromptForNewSession(firstTurn, 'first message', 'cockpit:normal-thread', 'claude', 'claude-sonnet-5');
assert.equal(shouldInjectContinuityBoot('cockpit:normal-thread', firstTurn), true);
assert.ok(firstPrompt.includes(CONTINUITY_BOOT_HEADER), 'turn 1 should include the continuity boot header');
assert.ok(firstPrompt.includes(contentSentinel), 'turn 1 should include content from SKILL.md');

const secondTurn = [
  turn('user', 'first message', 0),
  turn('assistant', 'first reply', 1),
  turn('user', 'second message', 2),
];
const secondPrompt = buildPromptForNewSession(secondTurn, 'second message', 'cockpit:normal-thread', 'claude', 'claude-sonnet-5');
assert.equal(shouldInjectContinuityBoot('cockpit:normal-thread', secondTurn), false);
assert.ok(!secondPrompt.includes(CONTINUITY_BOOT_HEADER), 'turn 2 should not include the continuity boot header');
assert.ok(!secondPrompt.includes(contentSentinel), 'turn 2 should not include SKILL.md content');

for (const externalId of ['quick:hub-1:abc123', 'cockpit:hopper-node-182-9b77e677']) {
  const prompt = buildPromptForNewSession(firstTurn, 'first message', externalId, 'claude', 'claude-sonnet-5');
  assert.equal(shouldInjectContinuityBoot(externalId, firstTurn), false);
  assert.ok(!prompt.includes(CONTINUITY_BOOT_HEADER), `${externalId} should skip continuity injection`);
}

console.log('ALL CHECKS PASSED');
