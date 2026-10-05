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
// Node #1441 (gap 3) added:
//   (4) the REAL assembled per-turn PREFIX — buildPerTurnContextPrefix(conv,
//       input, images), the exact string agent.ts prepends to stdin every
//       turn — for a companion thread carries none of the operator
//       thread-routing line or the autonomy dial / hard limiter (which names
//       live Hub 2.0, merging to main, and Slack/email-to-Mike), while a
//       non-companion thread's prefix still carries all of it (no regression).
//   (5) the REAL CLI argv the claude adapter builds (getAdapters().claude.
//       buildArgs) for a companion thread includes `--tools ''` (strips every
//       CLI built-in — Bash/Read/Write/Edit/WebFetch/WebSearch/Glob/Grep —
//       while leaving --mcp-config persona tools reachable) AND (node #1455)
//       `--strict-mcp-config` (strips every account-level claude.ai remote
//       connector — Smarty_Pants/Microsoft_365/Supabase/Lovable/Cloudflare —
//       so only the --mcp-config persona server remains), and a non-companion
//       thread's argv is byte-identical to before (neither flag at all).
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
const { buildToolsBlock, buildInitialPrompt, buildContinuationPrompt, buildPerTurnContextPrefix, getAdapters, isPlanModeMessage, PLAN_MODE_MARKER } = await import(
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
  check(`${label}: carries the ${COMPANION_BRIDGE_TOOL_NAME} tool heading`, prompt.includes(`### ${COMPANION_BRIDGE_TOOL_NAME}`));
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

// ── (4) the REAL assembled per-turn PREFIX (node #1441 gap 1/gap 3) ─────────
// buildPerTurnContextPrefix is the exact function agent.ts's
// runConversationTurn calls to build the string prepended to stdin every
// turn — threadContextLine + autonomyDialLine + every other context block.
// Only id/external_id/is_group_chat/group_id are read from the conv row.
function fakeConv(externalId, id) {
  return { id, external_id: externalId, is_group_chat: 0, group_id: null };
}

const OPERATOR_PREFIX_MARKERS = [
  '<jarvis_autonomy_dial', // real tag carries a level="N" attribute, e.g. <jarvis_autonomy_dial level="5">
  'Hard limiter (fixed', // the literal text autonomyDialLine renders, not the JS constant name
  'kuojrvfdjjqhqyvkuiam', // live Hub 2.0 — named in AUTONOMY_HARD_LIMITER_SUMMARY
  'merging to main',
  'Slack/email to Mike',
  '<jarvis_thread',
];

const companionPrefix = await buildPerTurnContextPrefix(fakeConv(companionExternalId, 999001), 'Hi there');
for (const marker of OPERATOR_PREFIX_MARKERS) {
  check(`(4) companion per-turn prefix does NOT contain "${marker}"`, !companionPrefix.includes(marker));
}

for (const externalId of nonCompanionIds) {
  const prefix = await buildPerTurnContextPrefix(fakeConv(externalId, 999002), 'Hi there');
  for (const marker of OPERATOR_PREFIX_MARKERS) {
    check(`(4) ${externalId} per-turn prefix still contains "${marker}" (no regression)`, prefix.includes(marker));
  }
}

// ── (5) the REAL CLI argv the claude adapter builds (node #1441 gap 2) ──────
const claudeAdapter = getAdapters().claude;

const companionArgs = claudeAdapter.buildArgs({ sessionId: null, model: null, isCompanionThread: true });
const companionToolsIdx = companionArgs.indexOf('--tools');
check('(5) companion argv includes the --tools flag', companionToolsIdx !== -1);
check('(5) companion argv\'s --tools value is empty (strips every CLI built-in)', companionArgs[companionToolsIdx + 1] === '');
check('(5) companion argv still carries --dangerously-skip-permissions (no conflict with --tools)', companionArgs.includes('--dangerously-skip-permissions'));
// Node #1455: --tools '' alone doesn't block account-level claude.ai remote
// connectors (Smarty_Pants/Microsoft_365/Supabase/Lovable/Cloudflare/...) —
// --strict-mcp-config is what makes the CLI ignore them and use ONLY the
// --mcp-config persona server. Must ride alongside --tools '' on every
// companion spawn (fail-closed), and never appear on a non-companion one.
check('(5) companion argv includes --strict-mcp-config (node #1455 fail-closed fix)', companionArgs.includes('--strict-mcp-config'));

const nonCompanionArgs = claudeAdapter.buildArgs({ sessionId: null, model: null, isCompanionThread: false });
check('(5) non-companion argv has NO --tools flag (byte-identical to before)', !nonCompanionArgs.includes('--tools'));
check('(5) non-companion argv has NO --strict-mcp-config flag (connectors stay usable)', !nonCompanionArgs.includes('--strict-mcp-config'));

const nonCompanionArgsNoFlag = claudeAdapter.buildArgs({ sessionId: null, model: null });
check(
  '(5) non-companion argv (isCompanionThread omitted) matches the explicit-false argv exactly',
  JSON.stringify(nonCompanionArgsNoFlag) === JSON.stringify(nonCompanionArgs),
);

// ── (6) node #1443 gap A/B regression: the companion signal must survive
// plan mode. Drives the REAL decision runConversationTurn/runClaude now make
// — derive isCompanionThread from the conversation's own external_id via
// memoryProfileForThread (not from a toolContext plan mode can null), feed
// it into isPlanModeMessage (gap B: must short-circuit false for a companion
// thread) and independently into claudeAdapter.buildArgs (gap A: must still
// carry `--tools ''` even though plan mode would have nulled the old
// toolContext-derived signal). Before the fix, a companion turn sent with the
// PLAN_MODE_MARKER prefix lost isCompanionThread (buildArgs got no flag at
// all) because it was derived from toolContext, which plan mode zeroes out.
const planModeInput = `${PLAN_MODE_MARKER} what should I get for dinner?`;
const normalInput = 'what should I get for dinner?';

for (const [label, input] of [
  ['(6) companion conv + plan-mode input', planModeInput],
  ['(6) companion conv + normal input', normalInput],
]) {
  const derivedIsCompanionThread = memoryProfileForThread(companionExternalId) === 'companion';
  check(`${label}: derives isCompanionThread=true from the conversation`, derivedIsCompanionThread === true);

  const derivedPlanModeActive = isPlanModeMessage(input, derivedIsCompanionThread);
  check(`${label}: planModeActive is false for a companion thread (gap B)`, derivedPlanModeActive === false);

  const argv = claudeAdapter.buildArgs({ sessionId: null, model: null, isCompanionThread: derivedIsCompanionThread });
  const toolsIdx = argv.indexOf('--tools');
  check(`${label}: resulting argv carries --tools '' (gap A)`, toolsIdx !== -1 && argv[toolsIdx + 1] === '');
  check(`${label}: resulting argv carries --strict-mcp-config (node #1455, survives plan mode too)`, argv.includes('--strict-mcp-config'));
}

// Same drive, but for a NON-companion conversation — must NOT pick up the
// flag regardless of plan mode, and plan mode must still work normally.
for (const [label, input] of [
  ['(6) non-companion conv + plan-mode input', planModeInput],
  ['(6) non-companion conv + normal input', normalInput],
]) {
  const nonCompanionExternalId = 'cockpit:goal-12';
  const derivedIsCompanionThread = memoryProfileForThread(nonCompanionExternalId) === 'companion';
  check(`${label}: derives isCompanionThread=false from the conversation`, derivedIsCompanionThread === false);

  const derivedPlanModeActive = isPlanModeMessage(input, derivedIsCompanionThread);
  check(
    `${label}: planModeActive matches the raw marker (unaffected by gap B)`,
    derivedPlanModeActive === (input === planModeInput),
  );

  const argv = claudeAdapter.buildArgs({ sessionId: null, model: null, isCompanionThread: derivedIsCompanionThread });
  check(`${label}: resulting argv has NO --tools flag`, !argv.includes('--tools'));
  check(`${label}: resulting argv has NO --strict-mcp-config flag`, !argv.includes('--strict-mcp-config'));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
  process.exit(0);
}
