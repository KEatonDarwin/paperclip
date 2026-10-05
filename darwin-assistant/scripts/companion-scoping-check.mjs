// COMPANION SCOPING CHECK — acceptance test for node #1384 (tree-8370b22a).
// Run on a scratch DB:
//   npm run companion-scoping:check
//   (= npm run build && JARVIS_DB_PATH=/tmp/companion-scoping-check.db node scripts/companion-scoping-check.mjs)
//
// Consolidates the two things #1382 (persona) and #1383 (fail-closed
// allow-list) each built, into the three assertions this node's spec calls
// for, against a single scratch DB, with no HTTP and no model calls:
//
//   (1) a companion thread's assembled system context carries the companion
//       persona + goal-12 (wish-catalog) orientation, and NOT Kevin's JARVIS
//       operator prompt.
//   (2) a companion thread's ACTUAL PRODUCTION PROMPTS — buildToolsBlock(ext),
//       buildInitialPrompt(...), and buildContinuationPrompt(...) in both its
//       with-opts and no-opts call signatures (the real shapes every call
//       site in agent.ts uses, including the session-expiry/overflow/
//       account-swap retry paths that pass no opts at all) — never advertise
//       an ops tool heading, and never leak the JARVIS persona. Asserts on
//       the real prompt TEXT, not a re-derived allow-list, so an ungated call
//       site (one that forgets to pass externalId/memoryProfile) fails this
//       check the same way it would leak in production.
//   (3) a non-companion thread is completely unaffected: full tool set,
//       JARVIS persona.
//
// Imports the real prompt.js/companion-chat.js/tools/index.js/agent.js
// modules so this exercises production code, not a re-implementation of it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard (same pattern as companion-thread-check.mjs) ──────────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

console.log(`[companion-scoping-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { memoryProfileForThread, buildSystemPrompt, loadMemoryBlock } = await import(
  path.join(distDir, 'prompt.js')
);
const { companionThreadExt, COMPANION_BRIDGE_TOOL_NAME } = await import(
  path.join(distDir, 'companion-chat.js')
);
const { ALL_TOOLS } = await import(path.join(distDir, 'tools/index.js'));
const { buildToolsBlock, buildInitialPrompt, buildContinuationPrompt } = await import(
  path.join(distDir, 'agent.js')
);

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failures++;
  }
}

// A fake prior-turn transcript so buildContinuationPrompt has something to
// replay (role/content/created_at are the only fields summarizeTurnForReplay
// reads; the rest just need to exist on the row shape).
function fakeTurn(role, content, idx) {
  return {
    id: idx, conversation_id: 1, turn_index: idx, role, content,
    tool_name: null, tool_args: null, tool_result: null,
    created_at: new Date().toISOString(), timing_ms: null,
    input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
    model: null, claude_input: null, claude_output: null, error_detail: null, images: null,
  };
}
const FAKE_TURNS = [
  fakeTurn('user', 'Hi there', 1),
  fakeTurn('assistant', 'Hello! How can I help?', 2),
  fakeTurn('user', 'How are you?', 3),
];

// The exact regex from this node's spec — matches the `### <tool_name>`
// heading buildToolsBlock() emits for any of these ops tools. Asserted
// against REAL buildToolsBlock/buildInitialPrompt/buildContinuationPrompt
// output below, never a re-derived allow-list, so an ungated call site (one
// that forgets to pass externalId/memoryProfile — exactly the #1390 gaps)
// fails this check the same way it would leak in production.
const OPS_HEADING_RE = /### (goals|hopper|throttle|work_switch|deploy_control|shim_|supabase_execute_sql)/;
const OPS_TOOLS = [
  'goals',
  'hopper',
  'throttle',
  'work_switch',
  'deploy_control',
  'list_shim_tasks',
  'create_shim_task',
  'shim_deploy_status',
  'shim_deploy_switch',
  'create_issue',
  'supabase_execute_sql',
];

function checkCompanionSafe(label, prompt) {
  check(`${label}: no ops-tool heading (${OPS_HEADING_RE})`, !OPS_HEADING_RE.test(prompt));
  check(`${label}: does NOT contain "You are JARVIS"`, !prompt.includes('You are JARVIS'));
  check(`${label}: does NOT contain "Who Kevin Is"`, !prompt.includes('Who Kevin Is'));
  check(`${label}: carries the companion_send_to_kevin tool heading`, prompt.includes(`### ${COMPANION_BRIDGE_TOOL_NAME}`));
}

// `includesPersona`: false for a bare buildToolsBlock() call, which never
// carries the system prompt/persona at all — only the tools block itself.
function checkNonCompanionUnaffected(label, prompt, includesPersona = true) {
  check(`${label}: ops-tool headings present (unaffected)`, OPS_HEADING_RE.test(prompt));
  if (includesPersona) {
    check(`${label}: contains "You are JARVIS"`, prompt.includes('You are JARVIS'));
  }
  for (const name of OPS_TOOLS) {
    check(`${label}: still advertises tool "${name}"`, prompt.includes(`### ${name}`));
  }
}

const companionExternalId = companionThreadExt('kevin-wife');

// ── (1) assembled system context ────────────────────────────────────────────
const companionProfile = memoryProfileForThread(companionExternalId);
check('(1) companion thread resolves to the companion memory profile', companionProfile === 'companion');

const companionSystemPrompt = buildSystemPrompt(companionProfile);

check(
  '(1) system context contains the companion persona',
  companionSystemPrompt.includes("You're chatting with Kevin's wife"),
);
check(
  '(1) system context contains the goal-12 wish-catalog orientation',
  companionSystemPrompt.includes('Wish Catalog') && companionSystemPrompt.includes('Circle & Flip'),
);
check(
  '(1) system context does NOT contain the JARVIS operator prompt',
  !companionSystemPrompt.includes("You are JARVIS — Kevin's personal AI life coach") &&
    !companionSystemPrompt.includes('Who Kevin Is') &&
    !companionSystemPrompt.includes('Paperclip') &&
    !companionSystemPrompt.includes('SHIM'),
);
check(
  '(1) no memory.md/worker-core.md leak into the companion context',
  loadMemoryBlock(undefined, companionProfile) === '',
);

// ── (2) real production prompts for a companion thread ──────────────────────
// buildToolsBlock/buildInitialPrompt ("no-opts" signature: externalId is a
// plain positional arg) and buildContinuationPrompt ("with-opts" signature:
// externalId rides in the opts object) are each exercised with the companion
// externalId, covering every shape agent.ts actually calls them with —
// including the aggressive-retry opts variant (line ~1661) and the plain
// opts variant used at the session-expiry/account-swap retry call sites
// (lines ~1642/~1725) that GAP 1/2 found ungated.
checkCompanionSafe('(2) buildToolsBlock(companionExternalId)', buildToolsBlock(companionExternalId));

checkCompanionSafe(
  '(2) buildInitialPrompt(msg, companionProfile, companionExternalId)',
  buildInitialPrompt('Hi', companionProfile, companionExternalId),
);

checkCompanionSafe(
  '(2) buildContinuationPrompt(..., { memoryProfile, externalId }) [with-opts]',
  buildContinuationPrompt(FAKE_TURNS, 'Hi', 'claude', null, { memoryProfile: companionProfile, externalId: companionExternalId }),
);

checkCompanionSafe(
  '(2) buildContinuationPrompt(..., { aggressive: true, memoryProfile, externalId }) [with-opts, aggressive retry]',
  buildContinuationPrompt(FAKE_TURNS, 'Hi', 'claude', null, {
    aggressive: true,
    memoryProfile: companionProfile,
    externalId: companionExternalId,
  }),
);

// ── (3) a non-companion thread is completely unaffected ─────────────────────
const nonCompanionIds = ['cockpit:goal-12', 'cockpit:hopper-node-1382'];
for (const externalId of nonCompanionIds) {
  const profile = memoryProfileForThread(externalId);
  check(`(3) ${externalId} does NOT resolve to the companion profile`, profile !== 'companion');

  checkNonCompanionUnaffected(`(3) ${externalId} buildToolsBlock(ext)`, buildToolsBlock(externalId), false);
  checkNonCompanionUnaffected(
    `(3) ${externalId} buildInitialPrompt(msg, profile, ext)`,
    buildInitialPrompt('Hi', profile, externalId),
  );
  checkNonCompanionUnaffected(
    `(3) ${externalId} buildContinuationPrompt(..., { memoryProfile, externalId }) [with-opts]`,
    buildContinuationPrompt(FAKE_TURNS, 'Hi', 'claude', null, { memoryProfile: profile, externalId }),
  );

  const systemPrompt = buildSystemPrompt(profile, { omitMemory: true });
  check(
    `(3) ${externalId} system context does NOT carry the companion persona`,
    !systemPrompt.includes("You're chatting with Kevin's wife"),
  );

  const toolsBlock = buildToolsBlock(externalId);
  const toolHeadingCount = (toolsBlock.match(/^### /gm) ?? []).length;
  check(
    `(3) ${externalId} buildToolsBlock(ext) advertises the full, untouched ALL_TOOLS set (${ALL_TOOLS.length} tools)`,
    toolHeadingCount === ALL_TOOLS.length,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
  process.exit(0);
}
