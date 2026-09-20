// PERSONA-TOOLS MCP SIM (hopper node #465) — proves the native
// mcp__jarvis__<name> exposure actually works end to end, on a throwaway
// express server + a SCRATCH sqlite DB (never the live jarvis.db).
//
//   npm run build
//   npm run persona-mcp:sim
//   (or: JARVIS_DB_PATH=/tmp/persona-mcp-sim.db npx tsx scripts/persona-mcp-sim.ts)
//
// Three checks:
//   (a) unit  — spawn dist/mcp/persona-tools-server.js directly as a real MCP
//               stdio server, talk to it with a real MCP client, call
//               thread_todos over MCP, and verify the todo + turn rows + SSE
//               all landed via the /internal/tool-exec loopback route.
//   (b) integration — run ONE real `runClaude()` turn (claude-haiku-4-5,
//               cheapest tier) with a toolContext attached, on a prompt that
//               tells the model ONLY about a native tool (no <tool_call> text
//               instructions at all) — so if the todo lands, the model MUST
//               have used the native mcp__jarvis__thread_todos tool.
//   (c) fallback — proves the OLD <tool_call> text protocol still works
//               unchanged: one real runClaude() turn with NO toolContext (so
//               no --mcp-config is attached, no native tools exist), prompted
//               with the classic text-block instructions, then parseToolCall()
//               + TOOL_MAP dispatch runs exactly like agent.ts's fallback path.
//
// Writes a pass/fail report to
// /home/kevin/obsidian/paperclip-wiki/outbox/persona-mcp/sim-report.md.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ── scratch DB guard (must run before any dist/ module is imported) ───────
const raw = process.env.JARVIS_DB_PATH ?? '/tmp/persona-mcp-sim.db';
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db. Use a /tmp scratch path.');
  process.exit(1);
}
process.env.JARVIS_DB_PATH = DB_PATH;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[persona-mcp-sim] scratch DB: ${DB_PATH}`);
delete process.env.ANTHROPIC_API_KEY; // NO API KEYS — subscription CLI only

const distDir = path.join(repoRoot, 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { getOrCreateInternalMcpKey } = await import(path.join(distDir, 'api-keys.js'));
const { getOrCreateConversation, getTurns } = await import(path.join(distDir, 'conversation-db.js'));
const { TOOL_MAP } = await import(path.join(distDir, 'tools', 'index.js'));
const { listThreadTodos } = await import(path.join(distDir, 'thread-todos.js'));
const { sseBus } = await import(path.join(distDir, 'sse-bus.js'));
const { withToolExecutionContext } = await import(path.join(distDir, 'autonomy-ledger.js'));
const { runClaude, getAdapters, buildInitialPrompt } = await import(path.join(distDir, 'agent.js'));
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

// ── real express app, real HTTP, throwaway port ────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise<import('node:http').Server>((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s as import('node:http').Server));
});
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const apiBase = `http://127.0.0.1:${port}/api/v1`;
console.log(`[persona-mcp-sim] server: ${apiBase}`);

// The real internal key the production loopback route expects — minted /
// cached in settings-KV exactly the way agent.ts's runClaude() does it.
const internalKey: string = getOrCreateInternalMcpKey();

// ── result collection — never abort the whole run on one failure ───────────
type Result = { id: string; description: string; pass: boolean; error?: string };
const results: Result[] = [];
async function check(id: string, description: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ id, description, pass: true });
    console.log(`  ✓ [${id}] ${description}`);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    results.push({ id, description, pass: false, error: message });
    console.log(`  ✗ [${id}] ${description}\n    ${message.split('\n')[0]}`);
  }
}

function makeContext(externalId: string, conversationId: number) {
  return {
    conversationId,
    externalId,
    sourceMessageId: 'sim',
    sourceTimestamp: new Date().toISOString(),
    originalText: 'persona-mcp-sim',
  };
}

// ============================================================================
// (a) UNIT — real MCP client <-> real persona-tools-server.js child process
// ============================================================================

let unitTodoContent = '';
let unitConvId = -1;

await check('a1', 'unit: MCP client connects to persona-tools-server.js and lists tools', async () => {
  const conv = getOrCreateConversation('persona-mcp-sim:unit');
  unitConvId = conv.id;
  unitTodoContent = `SIM-UNIT-OK-${Date.now()}`;
  const ctx = makeContext(conv.external_id, conv.id);

  const serverEntry = path.join(distDir, 'mcp', 'persona-tools-server.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...(process.env as Record<string, string>),
      JARVIS_API_BASE: apiBase,
      JARVIS_INTERNAL_KEY: internalKey,
      JARVIS_TOOL_CONTEXT: JSON.stringify(ctx),
    },
  });
  const client = new Client({ name: 'persona-mcp-sim-client', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);

  try {
    const listed = await client.listTools();
    assert.ok(Array.isArray(listed.tools), 'listTools() returned no tools array');
    assert.ok(listed.tools.length >= 50, `expected >=50 tools, got ${listed.tools.length}`);
    const names = new Set(listed.tools.map((t: { name: string }) => t.name));
    for (const expected of ['goals', 'workstreams', 'thread_todos', 'hopper', 'notifications']) {
      assert.ok(names.has(expected), `tool list missing '${expected}'`);
    }

    const called = await client.callTool({
      name: 'thread_todos',
      arguments: { operation: 'create', content: unitTodoContent },
    });
    assert.ok(!called.isError, `thread_todos create returned isError: ${JSON.stringify(called)}`);
    const text = (called.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    const parsed = JSON.parse(text) as { error?: string };
    assert.ok(!parsed.error, `tool-exec returned an error payload: ${text}`);
  } finally {
    await client.close().catch(() => {});
  }
});

await check('a2', 'unit: the MCP call actually created the todo row (via the loopback route, not in-process)', () => {
  const todos = listThreadTodos(unitConvId) as Array<{ content: string }>;
  assert.ok(
    todos.some((t) => t.content === unitTodoContent),
    `todo '${unitTodoContent}' not found among ${JSON.stringify(todos)}`,
  );
});

await check('a3', 'unit: the loopback route recorded tool_call + tool_result turns for the MCP call', () => {
  const turns = getTurns(unitConvId) as Array<{ role: string; tool_name: string | null; tool_args: string | null }>;
  const call = turns.find((t) => t.role === 'tool_call' && t.tool_name === 'thread_todos');
  const result = turns.find((t) => t.role === 'tool_result' && t.tool_name === 'thread_todos');
  assert.ok(call, `no tool_call turn recorded; turns: ${JSON.stringify(turns)}`);
  assert.ok(result, `no tool_result turn recorded; turns: ${JSON.stringify(turns)}`);
  assert.ok(call!.tool_args && call!.tool_args.includes(unitTodoContent), 'tool_call args missing our content');
});

await check('a4', 'unit: the loopback route emitted an SSE tool_call event for the MCP call', async () => {
  // Re-drive a second call so we can observe the SSE emission live (a1's call
  // already happened before we attached a listener).
  const conv = getOrCreateConversation('persona-mcp-sim:unit-sse');
  const ctx = makeContext(conv.external_id, conv.id);
  const events: Array<Record<string, unknown>> = [];
  const listener = (evt: Record<string, unknown>) => events.push(evt);
  sseBus.on('sse', listener);
  try {
    const serverEntry = path.join(distDir, 'mcp', 'persona-tools-server.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: {
        ...(process.env as Record<string, string>),
        JARVIS_API_BASE: apiBase,
        JARVIS_INTERNAL_KEY: internalKey,
        JARVIS_TOOL_CONTEXT: JSON.stringify(ctx),
      },
    });
    const client = new Client({ name: 'persona-mcp-sim-client-2', version: '0.0.1' }, { capabilities: {} });
    await client.connect(transport);
    try {
      await client.callTool({ name: 'thread_todos', arguments: { operation: 'list' } });
    } finally {
      await client.close().catch(() => {});
    }
    // Give the async .then() handler in the route a tick to fire its own
    // (separate) tool_result addTurn — the tool_call emit is synchronous.
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    sseBus.off('sse', listener);
  }
  const hit = events.find(
    (e) => e.type === 'tool_call' && e.conversationId === conv.id && e.toolName === 'thread_todos',
  );
  assert.ok(hit, `no matching SSE tool_call event observed; saw: ${JSON.stringify(events)}`);
});

// ============================================================================
// (b) INTEGRATION — real runClaude() turn, native MCP tool, no text fallback
//     instructions given at all (so success PROVES the native path was used)
// ============================================================================

const adapters = getAdapters();
const claudeAdapter = adapters['claude'];
// Default tier is haiku (cheapest). The model-facing halves of this sim (b: a
// native mcp__jarvis__* call, c: the <tool_call> text fallback) are real model
// behaviour, so they are inherently nondeterministic — haiku in particular will
// sometimes refuse a deferred MCP tool ("I cannot invoke MCP tools directly").
// Override with PERSONA_SIM_MODEL to re-run at the tier real workers use.
const HAIKU_MODEL = process.env.PERSONA_SIM_MODEL ?? 'claude-haiku-4-5-20251001';

let integrationConvId = -1;
let integrationTodoContent = '';
let integrationResultText = '';

await check('b1', 'integration: real claude-haiku-4-5 turn with toolContext (native MCP) creates a todo', async () => {
  assert.ok(claudeAdapter, 'claude adapter not found in getAdapters()');
  const conv = getOrCreateConversation('persona-mcp-sim:integration');
  integrationConvId = conv.id;
  integrationTodoContent = `SIM-NATIVE-OK-${Date.now()}`;
  const ctx = makeContext(conv.external_id, conv.id);

  // The MCP config baked by runClaude() points the child at JARVIS_UI_PORT —
  // aim it at THIS throwaway server for the duration of the call.
  const prevPort = process.env.JARVIS_UI_PORT;
  process.env.JARVIS_UI_PORT = String(port);
  try {
    const prompt =
      'You are a test harness probe. You have a native tool available named ' +
      "mcp__jarvis__thread_todos with operations list|create|set_status|edit. " +
      `Call it now with operation "create" and content "${integrationTodoContent}". ` +
      'Do not explain, do not ask questions, do not use any other tool. After the ' +
      'tool call succeeds, reply with the single word: DONE';

    const result = await runClaude(
      prompt,
      null,
      undefined,
      { adapter: claudeAdapter, model: HAIKU_MODEL, options: {} },
      undefined,
      undefined,
      undefined,
      ctx,
    );
    integrationResultText = result.text ?? '';
  } finally {
    if (prevPort === undefined) delete process.env.JARVIS_UI_PORT;
    else process.env.JARVIS_UI_PORT = prevPort;
  }

  assert.ok(integrationResultText.length > 0, 'runClaude returned empty text');
});

await check('b2', 'integration: the todo the model created via the native tool actually exists', () => {
  const todos = listThreadTodos(integrationConvId) as Array<{ content: string }>;
  assert.ok(
    todos.some((t) => t.content === integrationTodoContent),
    `todo '${integrationTodoContent}' not found; got ${JSON.stringify(todos)}; model said: ${integrationResultText.slice(0, 300)}`,
  );
});

await check('b3', 'integration: the loopback route (not any in-process shortcut) recorded the native call', () => {
  const turns = getTurns(integrationConvId) as Array<{ role: string; tool_name: string | null; tool_args: string | null }>;
  const call = turns.find((t) => t.role === 'tool_call' && t.tool_name === 'thread_todos');
  assert.ok(call, `no tool_call turn recorded for the native run; turns: ${JSON.stringify(turns)}`);
  assert.ok(
    call!.tool_args && call!.tool_args.includes(integrationTodoContent),
    'recorded tool_call args do not contain our marker content — cannot confirm it was THIS run',
  );
});

await check(
  'b4',
  'integration: the model was never told about the <tool_call> text protocol, so this had to be the native mcp__jarvis__ path',
  () => {
    assert.ok(
      !/<tool_call>/i.test(integrationResultText),
      `model output contains a <tool_call> text block even though none was taught — native path may not actually be wired: ${integrationResultText.slice(0, 300)}`,
    );
  },
);

// ============================================================================
// (c) FALLBACK — the OLD text protocol still works, unchanged, when no
//     toolContext is attached at all (so no --mcp-config, no native tools)
// ============================================================================

const { parseToolCall } = await import(path.join(distDir, 'agent.js'));

let fallbackConvId = -1;
let fallbackResultText = '';

await check('c1', 'fallback: real claude-haiku-4-5 turn with NO toolContext emits a <tool_call> text block', async () => {
  const conv = getOrCreateConversation('persona-mcp-sim:fallback');
  fallbackConvId = conv.id;

  // Use the REAL system-prompt tools block (buildToolsBlock), not a hand-rolled
  // one: this feature rewrote that block to describe the tools as native-first,
  // and every non-MCP spawn (auggie/devin/codex, or a claude spawn whose MCP
  // server failed to start) still sees exactly this text with no native tools
  // behind it. If the block's new wording makes a model give up instead of
  // emitting the text block, that IS the regression — so test it verbatim.
  // Compose with the REAL production prompt builder (system prompt + the real
  // tools block + `Human:` turn). This feature rewrote that tools block to
  // describe the tools as native-first, and every non-MCP spawn (auggie /
  // devin / codex, or a claude spawn whose MCP server failed to start) sees
  // exactly this text with no native tools behind it — if the new wording makes
  // a model give up instead of emitting the text block, THAT is the regression.
  const prompt =
    `<jarvis_thread external_id="${conv.external_id}" conversation_id="${conv.id}"/>\n\n` +
    buildInitialPrompt('Call the thread_todos tool now with operation "create" and content "SIM-FALLBACK-PROBE".');

  // Deliberately NO toolContext argument here — mirrors a one-shot utility
  // caller (search/summarize/briefing) that gets byte-identical pre-feature
  // behavior: no --mcp-config, so the model has nothing native to call.
  const result = await runClaude(prompt, null, undefined, { adapter: claudeAdapter, model: HAIKU_MODEL, options: {} });
  fallbackResultText = result.text ?? '';
  assert.ok(fallbackResultText.length > 0, 'runClaude returned empty text');
});

await check('c2', 'fallback: parseToolCall() correctly parses the text block the model produced', () => {
  const parsed = parseToolCall(fallbackResultText);
  assert.ok(parsed, `parseToolCall found nothing in: ${fallbackResultText.slice(0, 400)}`);
  assert.equal(parsed!.name, 'thread_todos');
  assert.equal(parsed!.arguments.operation, 'create');
});

await check('c3', 'fallback: dispatching the parsed call through TOOL_MAP (agent.ts\'s own fallback path) creates the todo', async () => {
  const parsed = parseToolCall(fallbackResultText);
  assert.ok(parsed, 'no parsed tool call to dispatch (c2 already failed)');
  const conv = getOrCreateConversation('persona-mcp-sim:fallback');
  const ctx = makeContext(conv.external_id, conv.id);
  const tool = TOOL_MAP.get(parsed!.name);
  assert.ok(tool, `TOOL_MAP has no entry for '${parsed!.name}'`);
  const execResult = await withToolExecutionContext(ctx, () => tool.execute(parsed!.arguments, ctx));
  assert.ok(!(execResult as { error?: string })?.error, `tool execution errored: ${JSON.stringify(execResult)}`);
  const todos = listThreadTodos(fallbackConvId) as Array<{ content: string }>;
  assert.ok(
    todos.some((t) => t.content === parsed!.arguments.content),
    `fallback-created todo not found; got ${JSON.stringify(todos)}`,
  );
});

// ============================================================================
// report
// ============================================================================

server.close();

const passCount = results.filter((r) => r.pass).length;
const failCount = results.length - passCount;
const overall = failCount === 0 ? 'PASS' : 'FAIL';

const lines: string[] = [];
lines.push('# Persona-tools MCP sim report (hopper node #465)');
lines.push('');
lines.push(`Ran: ${new Date().toISOString()}`);
lines.push(`Scratch DB: ${DB_PATH}`);
lines.push(`Overall: **${overall}** (${passCount}/${results.length} checks passed)`);
lines.push('');
lines.push('## Checks');
lines.push('');
for (const r of results) {
  lines.push(`- ${r.pass ? '✓' : '✗'} **[${r.id}]** ${r.description}`);
  if (!r.pass) lines.push(`  - error: \`${r.error?.split('\n')[0]}\``);
}
lines.push('');
lines.push('## What each group proves');
lines.push('');
lines.push('- **(a) unit** — a real MCP client talking stdio JSON-RPC to the real compiled ' +
  '`persona-tools-server.js`, calling a persona tool, and confirming the effect landed ' +
  'through the `/internal/tool-exec` loopback route (turn rows + SSE), not some in-process shortcut.');
lines.push('- **(b) integration** — one real `claude-haiku-4-5` CLI turn, wired with a real ' +
  'toolContext (so `runClaude()` attaches `--mcp-config`), given NO instructions about the ' +
  '`<tool_call>` text protocol at all. It created a real todo, which is only possible if the ' +
  'native `mcp__jarvis__thread_todos` tool actually works end-to-end from inside a real claude spawn.');
lines.push('- **(c) fallback** — one real `claude-haiku-4-5` CLI turn with NO toolContext (so no ' +
  '`--mcp-config`, no native tools exist), taught only the `<tool_call>` text format. Confirms ' +
  '`parseToolCall()` + `TOOL_MAP` dispatch — the pre-existing fallback path — is unchanged and still works.');
lines.push('');

const reportPath = '/home/kevin/obsidian/paperclip-wiki/outbox/persona-mcp/sim-report.md';
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
console.log(`\n[persona-mcp-sim] ${overall} (${passCount}/${results.length}) — report: ${reportPath}`);

if (failCount > 0) process.exitCode = 1;
