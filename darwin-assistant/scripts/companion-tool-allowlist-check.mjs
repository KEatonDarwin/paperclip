// Scratch acceptance check for node #1383 — run on a scratch DB:
//   JARVIS_DB_PATH=/tmp/companion-tool-allowlist-check.db node scripts/companion-tool-allowlist-check.mjs
//
// Verifies: a companion thread's resolved tool list (via the same
// allowedToolsForThread predicate consulted by buildToolsBlock,
// /internal/tools, and both tool-exec dispatch points) is exactly
// {companion_send_to_kevin} — none of the ops tools (goals, hopper, throttle,
// work_switch, deploy_control, shim_deploy_status, create_issue,
// supabase_execute_sql, mcp_call, ...) are present. Also verifies a
// non-companion thread's resolved list is the full, untouched ALL_TOOLS set.

import { allowedToolsForThread, companionThreadExt, COMPANION_BRIDGE_TOOL_NAME } from '../dist/companion-chat.js';
import { ALL_TOOLS } from '../dist/tools/index.js';

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

const allToolNames = ALL_TOOLS.map((t) => t.name);
check('companion_send_to_kevin is a registered tool', allToolNames.includes(COMPANION_BRIDGE_TOOL_NAME));

function resolvedToolNames(externalId) {
  const allowed = allowedToolsForThread(externalId);
  return allowed ? allToolNames.filter((n) => allowed.has(n)) : allToolNames;
}

const companionExternalId = companionThreadExt('kevin-wife');
const companionTools = resolvedToolNames(companionExternalId);

check(
  'companion thread resolved tool list is exactly {companion_send_to_kevin}',
  companionTools.length === 1 && companionTools[0] === COMPANION_BRIDGE_TOOL_NAME,
);

const OPS_TOOLS = [
  'goals', 'hopper', 'throttle', 'work_switch', 'deploy_control',
  'shim_deploy_status', 'create_issue', 'supabase_execute_sql', 'mcp_call',
  'workstreams', 'night_shift', 'health', 'cockpit_deploy', 'intake_deploy',
];
for (const name of OPS_TOOLS) {
  check(`ops tool "${name}" is NOT in the companion allow-list`, !companionTools.includes(name));
}

// Fail-closed: a brand-new/unknown tool name added to ALL_TOOLS tomorrow is
// excluded by default for companion threads (allow-list is an explicit allow,
// not a denylist) — simulate by checking the allow-list Set directly rejects
// an arbitrary unseen name.
const allowedSet = allowedToolsForThread(companionExternalId);
check(
  'fail-closed: an unknown/future tool name is excluded by default',
  allowedSet !== null && !allowedSet.has('some_brand_new_tool_nobody_has_written_yet'),
);

// Non-companion threads: byte-identical to today (no restriction).
const nonCompanionIds = ['cockpit:goal-12', 'cockpit:hopper-node-1382', null, undefined];
for (const externalId of nonCompanionIds) {
  check(
    `allowedToolsForThread(${JSON.stringify(externalId)}) returns null (unrestricted)`,
    allowedToolsForThread(externalId) === null,
  );
  const tools = resolvedToolNames(externalId);
  check(
    `resolved tool list for ${JSON.stringify(externalId)} is the full, untouched ALL_TOOLS set`,
    tools.length === allToolNames.length,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
}
