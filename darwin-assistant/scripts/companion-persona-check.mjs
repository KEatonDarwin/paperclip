// Scratch acceptance check for node #1382 — run on a scratch DB:
//   JARVIS_DB_PATH=/tmp/companion-persona-check.db node scripts/companion-persona-check.mjs
//
// Verifies: a companion thread's assembled system context contains the
// companion persona + goal-12 (wish-catalog) orientation, and does NOT
// contain Kevin's JARVIS operator prompt markers. Also verifies a
// non-companion thread's assembly is completely untouched.

import { memoryProfileForThread, buildSystemPrompt, loadMemoryBlock } from '../dist/prompt.js';
import { companionThreadExt } from '../dist/companion-chat.js';

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

const companionExternalId = companionThreadExt('kevin-wife');
const companionProfile = memoryProfileForThread(companionExternalId);
check('companion thread resolves to companion profile', companionProfile === 'companion');

const companionSystemPrompt = buildSystemPrompt(companionProfile);

check(
  'companion system prompt contains the companion persona',
  companionSystemPrompt.includes("You're chatting with Kevin's wife"),
);
check(
  'companion system prompt contains the goal-12 wish-catalog orientation',
  companionSystemPrompt.includes('Wish Catalog') && companionSystemPrompt.includes('Circle & Flip'),
);
check(
  'companion system prompt does NOT contain the JARVIS operator persona marker',
  !companionSystemPrompt.includes("You are JARVIS — Kevin's personal AI life coach"),
);
check(
  'companion system prompt does NOT contain the "Who Kevin Is" section',
  !companionSystemPrompt.includes('Who Kevin Is'),
);
check(
  'companion system prompt does NOT contain Paperclip/SHIM ops internals',
  !companionSystemPrompt.includes('Paperclip') && !companionSystemPrompt.includes('SHIM'),
);

check(
  'loadMemoryBlock returns empty for companion profile (no memory.md/worker-core.md leak)',
  loadMemoryBlock(undefined, 'companion') === '',
);

// Non-companion threads must be byte-identical to pre-change behavior.
const fullProfile = memoryProfileForThread('cockpit:goal-12');
check('a goal thread still resolves to full profile', fullProfile === 'full');
const fullSystemPrompt = buildSystemPrompt(fullProfile);
check(
  'non-companion system prompt still carries the JARVIS persona',
  fullSystemPrompt.includes("You are JARVIS — Kevin's personal AI life coach"),
);

const workerProfile = memoryProfileForThread('cockpit:hopper-node-1382');
check('a hopper-node thread still resolves to worker profile', workerProfile === 'worker');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
}
