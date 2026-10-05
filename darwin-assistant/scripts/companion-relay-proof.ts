// TWO-WAY RELAY PROOF HARNESS (hopper node #1436, tree-d0ae54c4) — proves the
// actual send-to-Kevin side-message relay (node #1430's bridge_send tool +
// cross_chat_sidecar kind + SSE event) end to end, in both directions.
//
// Extends the #1419 two-way bridge pattern (scripts/companion-context-bridge-proof.ts)
// from the READ-ONLY context digest to the ACTIVE relay tool:
//
//   DIRECTION A (her side → Kevin, via a real model-driven tool call): a real
//   two-turn opus conversation — she's handed a concrete idea, the companion
//   persona (prompt.ts's "ask what she'd like passed along and relay it
//   clearly") must proactively OFFER to send it, and only on her acceptance
//   does it actually emit the <tool_call>{"name":"bridge_send",...}</tool_call>
//   text block. That block is parsed and executed by hand here with the real
//   parseToolCall()/TOOL_MAP()/withToolExecutionContext() agent.ts uses in its
//   own tool loop — processMessage() itself is never callable in this harness
//   because the sim-guard (src/sim-guard.ts) refuses a real model turn through
//   that path on anything but the live jarvis.db (same bypass every companion
//   proof harness in this lineage uses; see companion-thread-proof.ts's header
//   for the standing rationale).
//
//   DIRECTION B (Kevin's side → her, mechanical): bridge_send is called
//   directly from the cockpit:goal-12 context, the same mechanical pattern
//   scripts/bridge-send-check.mjs already proved for companion→goal-12, run
//   in reverse to prove getBridgedThreads()'s symmetric resolver actually
//   delivers the other way too.
//
//   npm run build
//   JARVIS_DB_PATH=/tmp/companion-relay-proof-$(date +%s).db npx tsx scripts/companion-relay-proof.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');

// ── scratch DB guard (must run before any dist/ module is imported) ───────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path (e.g. /tmp/companion-relay-proof-<ts>.db).');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve(__dirname, '..', 'jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db. Use a /tmp scratch path.');
  process.exit(1);
}
if (!DB_PATH.startsWith('/tmp/')) {
  console.error(`FATAL: refusing a scratch path outside /tmp (${DB_PATH}).`);
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

console.log(`[relay-proof] scratch DB: ${DB_PATH}`);
console.log(`[relay-proof] JARVIS_SIM=${process.env.JARVIS_SIM ?? '(unset)'} (must stay unset/0 — real claude CLI turns)`);

let failed = false;
let directionAFailed = false;
let directionBFailed = false;
function check(label: string, ok: boolean, scope?: 'A' | 'B'): void {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
    if (scope === 'A') directionAFailed = true;
    if (scope === 'B') directionBFailed = true;
  }
}

const OFFER_RE = /\b(send|tell kevin|tell him|let (kevin|him) know|pass (it|this|that)?\s*along|share (it|this|that)?\s*with kevin|relay)\b/i;

async function main() {
  const {
    getOrCreateCompanionThread,
    allowedToolsForThread,
    COMPANION_BRIDGE_TOOL_NAME,
  } = await import(path.join(distDir, 'companion-chat.js'));
  const {
    getConversation,
    getOrCreateConversation,
    addTurn,
    getTurns,
    sqliteDb,
    updateSessionState,
    setThreadModelOverride,
    getBridgedThreads,
  } = await import(path.join(distDir, 'conversation-db.js'));
  const { memoryProfileForThread } = await import(path.join(distDir, 'prompt.js'));
  const { resolveConversationRuntime, buildInitialPrompt, runClaude, parseToolCall } = await import(
    path.join(distDir, 'agent.js')
  );
  const { withToolExecutionContext } = await import(path.join(distDir, 'autonomy-ledger.js'));
  const { ALL_TOOLS, TOOL_MAP } = await import(path.join(distDir, 'tools/index.js'));
  const { sseBus, GLOBAL_STREAM_EVENT_TYPES } = await import(path.join(distDir, 'sse-bus.js'));
  const { CROSS_CHAT_SIDECAR_ROLE } = await import(path.join(distDir, 'cross-chat-sidecar.js'));

  check(
    'bridge_send is registered in TOOL_MAP',
    TOOL_MAP.get(COMPANION_BRIDGE_TOOL_NAME) !== undefined,
  );
  const bridgeSendTool = TOOL_MAP.get(COMPANION_BRIDGE_TOOL_NAME);

  // ── Step 1: create and bridge both real threads ───────────────────────────
  const WIFE_ID = 'relay-proof';
  const { external_id: companionExt, created: companionCreated } = getOrCreateCompanionThread(WIFE_ID);
  check('step 1: companion thread created', companionCreated === true);

  const GOAL_EXT = 'cockpit:goal-12';
  const goalConvInitial = getOrCreateConversation(GOAL_EXT);
  check('step 1: goal-12 thread created', !!goalConvInitial);
  setThreadModelOverride(goalConvInitial.id, 'claude', 'claude-sonnet-5');

  sqliteDb
    .prepare(`INSERT INTO thread_bridges (thread_a_ext, thread_b_ext, kind) VALUES (?, ?, ?)`)
    .run(companionExt, GOAL_EXT, 'companion-goal12');

  check('step 1: getBridgedThreads(companion) resolves goal-12', getBridgedThreads(companionExt).includes(GOAL_EXT));
  check('step 1: getBridgedThreads(goal-12) resolves companion', getBridgedThreads(GOAL_EXT).includes(companionExt));

  let companionConv = getConversation(companionExt)!;
  let goalConv = getConversation(GOAL_EXT)!;
  const companionRuntime = resolveConversationRuntime(companionConv);
  const goalRuntime = resolveConversationRuntime(goalConv);
  check('step 1: companion runtime resolves opus', companionRuntime.adapter.id === 'claude' && !!companionRuntime.model?.startsWith('claude-opus-'));
  check('step 1: goal-12 runtime resolves claude-sonnet-5', goalRuntime.adapter.id === 'claude' && goalRuntime.model === 'claude-sonnet-5');

  const companionProfile = memoryProfileForThread(companionExt);
  check('step 1: companion thread profile is "companion"', companionProfile === 'companion');

  // ── DIRECTION A: real companion turn, idea → offer → acceptance → real
  // bridge_send tool call, parsed and executed by hand (agent.ts's own loop,
  // reimplemented one step at a time since processMessage() is sim-guarded). ─
  console.log('\n[relay-proof] === DIRECTION A: her idea → proactive offer → accepted → bridge_send ===');

  const IDEA_MSG =
    "I thought of something for the wish catalog — what if once a year each kid " +
    'gets a "golden ticket": ONE pick that\'s allowed to go over the normal budget ' +
    "cap, no questions asked? Might make the catalog feel more special instead of " +
    "just a strict spreadsheet of limits.";

  const stdin1 = buildInitialPrompt(IDEA_MSG, companionProfile, companionExt);
  const result1 = await runClaude(stdin1, null, undefined, companionRuntime as never);
  console.log(`--- turn 1 (offer) reply ---\n${result1.text}\n--- end turn 1 reply ---`);
  addTurn(companionConv.id, 'user', IDEA_MSG, undefined, undefined, undefined, { model: companionRuntime.model ?? undefined });
  addTurn(companionConv.id, 'assistant', result1.text, undefined, undefined, undefined, {
    model: result1.model ?? companionRuntime.model ?? undefined,
    claudeOutput: result1.rawOutput,
  });
  updateSessionState(companionConv.id, result1.sessionId ?? null, companionRuntime.adapter.id, result1.accountKey ?? null);
  companionConv = getConversation(companionExt)!;

  check('DIRECTION A turn 1: companion replied with non-empty text', result1.text.trim().length > 0, 'A');
  check(
    `DIRECTION A turn 1: companion PROACTIVELY OFFERS to send/relay the idea to Kevin — evidence: "${result1.text.slice(0, 300)}"`,
    OFFER_RE.test(result1.text),
    'A',
  );
  check(
    'DIRECTION A turn 1: companion does NOT call bridge_send before she has accepted (asks first, sends second)',
    parseToolCall(result1.text) === null,
    'A',
  );

  const ACCEPT_MSG = 'Yes — please send that to Kevin.';
  const result2 = await runClaude(ACCEPT_MSG, result1.sessionId ?? null, undefined, companionRuntime as never);
  console.log(`--- turn 2 (acceptance) reply ---\n${result2.text}\n--- end turn 2 reply ---`);

  const toolCall = parseToolCall(result2.text);
  check(
    `DIRECTION A turn 2: on acceptance, companion emits a bridge_send tool call — evidence: "${result2.text.slice(0, 300)}"`,
    toolCall !== null && toolCall.name === COMPANION_BRIDGE_TOOL_NAME,
    'A',
  );
  check(
    'DIRECTION A turn 2: the tool call carries a non-empty idea argument',
    typeof toolCall?.arguments?.idea === 'string' && (toolCall.arguments.idea as string).trim().length > 0,
    'A',
  );

  addTurn(
    companionConv.id,
    'tool_call',
    toolCall?.precedingText || null,
    toolCall?.name ?? COMPANION_BRIDGE_TOOL_NAME,
    JSON.stringify(toolCall?.arguments ?? {}),
    undefined,
    { model: result2.model ?? companionRuntime.model ?? undefined, claudeOutput: result2.rawOutput },
  );
  sseBus.emit('sse', { type: 'tool_call', conversationId: companionConv.id, toolName: toolCall?.name ?? COMPANION_BRIDGE_TOOL_NAME });

  let capturedSidecarEventA: Record<string, unknown> | null = null;
  const sseHandlerA = (ev: Record<string, unknown>) => {
    if (ev.type === 'cross_chat_sidecar') capturedSidecarEventA = ev;
  };
  sseBus.on('sse', sseHandlerA);

  const toolContextA = {
    conversationId: companionConv.id,
    externalId: companionExt,
    sourceMessageId: 'turn-2-accept',
    sourceTimestamp: new Date().toISOString(),
    originalText: ACCEPT_MSG,
  };
  let toolResultA: unknown = { error: 'bridge_send tool not found' };
  if (toolCall && bridgeSendTool) {
    toolResultA = await withToolExecutionContext(toolContextA as never, () =>
      bridgeSendTool.execute(toolCall.arguments, toolContextA as never),
    );
  }
  sseBus.off('sse', sseHandlerA);

  addTurn(companionConv.id, 'tool_result', null, COMPANION_BRIDGE_TOOL_NAME, undefined, JSON.stringify(toolResultA));

  const toolResultARec = toolResultA as { delivered_to?: string[]; summary?: string; error?: string };
  check(
    `DIRECTION A: bridge_send actually delivered to the goal-12 partner — evidence: ${JSON.stringify(toolResultARec)}`,
    Array.isArray(toolResultARec.delivered_to) && toolResultARec.delivered_to.includes(GOAL_EXT),
    'A',
  );

  const goalTurnsAfterA = getTurns(goalConv.id);
  const sidecarInGoalA = goalTurnsAfterA.find((t: { role: string }) => t.role === CROSS_CHAT_SIDECAR_ROLE);
  check('DIRECTION A: a cross_chat_sidecar row landed in goal-12', !!sidecarInGoalA, 'A');
  const sidecarPayloadA = sidecarInGoalA ? JSON.parse((sidecarInGoalA as { tool_args: string }).tool_args) : null;
  check('DIRECTION A: the sidecar row carries a non-empty summary', !!sidecarPayloadA?.summary?.trim(), 'A');
  check('DIRECTION A: the sidecar row carries a non-empty from_label', !!sidecarPayloadA?.from_label?.trim(), 'A');
  check(
    'DIRECTION A: the dedicated cross_chat_sidecar SSE event fired for goal-12',
    (capturedSidecarEventA as { conversationId?: number } | null)?.conversationId === goalConv.id,
    'A',
  );

  // Feed the tool result back and let the real conversation close out — not
  // itself asserted beyond "didn't throw", just completing the real loop
  // faithfully (agent.ts always feeds the tool_result back for a final reply).
  const stdin3 = `<tool_result name="${COMPANION_BRIDGE_TOOL_NAME}">\n${JSON.stringify(toolResultA, null, 2)}\n</tool_result>`;
  const result3 = await runClaude(stdin3, result2.sessionId ?? result1.sessionId ?? null, undefined, companionRuntime as never);
  console.log(`--- turn 3 (confirmation) reply ---\n${result3.text}\n--- end turn 3 reply ---`);
  addTurn(companionConv.id, 'assistant', result3.text, undefined, undefined, undefined, {
    model: result3.model ?? companionRuntime.model ?? undefined,
    claudeOutput: result3.rawOutput,
  });
  updateSessionState(companionConv.id, result3.sessionId ?? result2.sessionId ?? null, companionRuntime.adapter.id, result3.accountKey ?? null);

  // ── DIRECTION B: bridge_send called directly from Kevin's goal-12 side —
  // mechanical, same pattern bridge-send-check.mjs already proved in reverse. ─
  console.log('\n[relay-proof] === DIRECTION B: Kevin\'s side → her, bridge_send called from goal-12 ===');

  let capturedSidecarEventB: Record<string, unknown> | null = null;
  const sseHandlerB = (ev: Record<string, unknown>) => {
    if (ev.type === 'cross_chat_sidecar') capturedSidecarEventB = ev;
  };
  sseBus.on('sse', sseHandlerB);

  const KEVIN_IDEA =
    "Love the golden-ticket idea — let's cap the over-budget pick at $75 so it still " +
    'has SOME ceiling, and only one golden ticket per kid per year.';
  const toolContextB = {
    conversationId: goalConv.id,
    externalId: GOAL_EXT,
    sourceMessageId: 'direction-b',
    sourceTimestamp: new Date().toISOString(),
    originalText: KEVIN_IDEA,
  };
  const toolResultB = bridgeSendTool
    ? await withToolExecutionContext(toolContextB as never, () => bridgeSendTool.execute({ idea: KEVIN_IDEA }, toolContextB as never))
    : { error: 'bridge_send tool not found' };
  sseBus.off('sse', sseHandlerB);

  addTurn(goalConv.id, 'tool_call', null, COMPANION_BRIDGE_TOOL_NAME, JSON.stringify({ idea: KEVIN_IDEA }));
  addTurn(goalConv.id, 'tool_result', null, COMPANION_BRIDGE_TOOL_NAME, undefined, JSON.stringify(toolResultB));

  const toolResultBRec = toolResultB as { delivered_to?: string[]; summary?: string; error?: string };
  check(
    `DIRECTION B: bridge_send actually delivered to the companion partner — evidence: ${JSON.stringify(toolResultBRec)}`,
    Array.isArray(toolResultBRec.delivered_to) && toolResultBRec.delivered_to.includes(companionExt),
    'B',
  );

  const companionTurnsAfterB = getTurns(companionConv.id);
  const sidecarInCompanionB = companionTurnsAfterB.find((t: { role: string }) => t.role === CROSS_CHAT_SIDECAR_ROLE);
  check('DIRECTION B: a cross_chat_sidecar row landed in the companion thread (reverse direction)', !!sidecarInCompanionB, 'B');
  const sidecarPayloadB = sidecarInCompanionB ? JSON.parse((sidecarInCompanionB as { tool_args: string }).tool_args) : null;
  check('DIRECTION B: the sidecar row carries a non-empty summary', !!sidecarPayloadB?.summary?.trim(), 'B');
  check('DIRECTION B: the sidecar row carries a non-empty from_label', !!sidecarPayloadB?.from_label?.trim(), 'B');
  check(
    'DIRECTION B: the dedicated cross_chat_sidecar SSE event fired for the companion thread',
    (capturedSidecarEventB as { conversationId?: number } | null)?.conversationId === companionConv.id,
    'B',
  );

  // ── Advisory (not scoped A/B): companion thread's tool set is STILL exactly
  // {bridge_send} — this relay proof didn't widen the fail-closed allow-list. ─
  const allToolNames = ALL_TOOLS.map((t: { name: string }) => t.name);
  const allowed = allowedToolsForThread(companionExt);
  const companionTools = allowed ? allToolNames.filter((n: string) => allowed.has(n)) : allToolNames;
  check(
    'ADVISORY: companion thread\'s resolved tool set is still exactly {bridge_send} — conversation + bridge_send only, nothing widened',
    companionTools.length === 1 && companionTools[0] === COMPANION_BRIDGE_TOOL_NAME,
  );

  const verdict = !directionAFailed && !directionBFailed ? 'PASS' : 'FAIL';
  const failingDirections = [directionAFailed ? 'A' : null, directionBFailed ? 'B' : null].filter(Boolean);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scratchDbPath: DB_PATH,
    companionExternalId: companionExt,
    goalExternalId: GOAL_EXT,
    directionA: {
      pass: !directionAFailed,
      ideaMsg: IDEA_MSG,
      offerReply: result1.text,
      acceptMsg: ACCEPT_MSG,
      acceptReply: result2.text,
      toolCall,
      toolResult: toolResultA,
      confirmationReply: result3.text,
      sidecarPayload: sidecarPayloadA,
    },
    directionB: {
      pass: !directionBFailed,
      kevinIdea: KEVIN_IDEA,
      toolResult: toolResultB,
      sidecarPayload: sidecarPayloadB,
    },
    verdict,
    failingDirections,
    overallFailed: failed,
  };
  fs.writeFileSync('/tmp/companion-relay-proof-output.json', JSON.stringify(artifact, null, 2));
  console.log('\n[relay-proof] wrote /tmp/companion-relay-proof-output.json');

  console.log(`\nVERDICT: ${verdict}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
