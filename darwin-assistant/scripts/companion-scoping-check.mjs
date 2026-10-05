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
//   (2) a companion thread's resolved tool list is exactly the conversation
//       path (plain text turns, which are never gated by tool name) plus the
//       companion_send_to_kevin bridge seam — a representative set of ops
//       tools (goals, hopper, throttle, work_switch, deploy_control, shim_*,
//       create_issue, supabase_execute_sql) is absent.
//   (3) a non-companion thread is completely unaffected: full tool set,
//       JARVIS persona.
//
// Imports the real prompt.js/companion-chat.js/tools/index.js modules so this
// exercises production code, not a re-implementation of it.

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
const { allowedToolsForThread, companionThreadExt, COMPANION_BRIDGE_TOOL_NAME } = await import(
  path.join(distDir, 'companion-chat.js')
);
const { ALL_TOOLS } = await import(path.join(distDir, 'tools/index.js'));

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failures++;
  }
}

// Mirrors agent.ts buildToolsBlock()'s exact filter, against the real
// allowedToolsForThread + ALL_TOOLS this node is scoped to verify.
function resolvedToolNames(externalId) {
  const allowed = allowedToolsForThread(externalId);
  const tools = allowed ? ALL_TOOLS.filter((t) => allowed.has(t.name)) : ALL_TOOLS;
  return tools.map((t) => t.name);
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

// ── (2) resolved tool list ───────────────────────────────────────────────────
const companionTools = resolvedToolNames(companionExternalId);

check(
  '(2) resolved tool list is exactly {companion_send_to_kevin} (the conversation path itself carries no tool name, so is never gated by this allow-list)',
  companionTools.length === 1 && companionTools[0] === COMPANION_BRIDGE_TOOL_NAME,
);

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
for (const name of OPS_TOOLS) {
  check(`(2) ops tool "${name}" is ABSENT from the companion allow-list`, !companionTools.includes(name));
}

// ── (3) a non-companion thread is unaffected ────────────────────────────────
const nonCompanionIds = ['cockpit:goal-12', 'cockpit:hopper-node-1382'];
for (const externalId of nonCompanionIds) {
  const profile = memoryProfileForThread(externalId);
  check(`(3) ${externalId} does NOT resolve to the companion profile`, profile !== 'companion');

  const systemPrompt = buildSystemPrompt(profile, { omitMemory: true });
  check(
    `(3) ${externalId} system context still carries the JARVIS persona`,
    systemPrompt.includes("You are JARVIS — Kevin's personal AI life coach"),
  );
  check(
    `(3) ${externalId} system context does NOT carry the companion persona`,
    !systemPrompt.includes("You're chatting with Kevin's wife"),
  );

  const tools = resolvedToolNames(externalId);
  check(
    `(3) ${externalId} resolved tool list is the full, untouched ALL_TOOLS set (${ALL_TOOLS.length} tools)`,
    tools.length === ALL_TOOLS.length,
  );
  for (const name of OPS_TOOLS) {
    check(`(3) ${externalId} still has ops tool "${name}"`, tools.includes(name));
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
  process.exit(0);
}
