#!/usr/bin/env -S npx tsx
// LIVE OPERATIONS TESTS (lean/harness-gaps, 2026-10-17; src/live-ops.ts).
//
//   npm run live-ops:test
//
// Pure — no DB, no model, no network. Fixture events follow the exact shapes found in real
// persisted `claude_output` rows (assistant tool_use / user tool_result / parent_tool_use_id /
// result). Covers pairing, sub-agent nesting, failure tails, redaction, the cut-off sweep on the
// result line, retry dedupe, the per-turn cap, Codex items, and rebuilding from a raw stream.
import assert from 'node:assert/strict';
import { createOpsTracker, describeToolUse, parseTurnOps, redact, summarizeOps } from '../src/live-ops.js';

let pass = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n${(e as Error).stack}`); process.exitCode = 1; }
};

const use = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) => ({
  type: 'assistant', parent_tool_use_id: parent,
  message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input }] },
});
const res = (id: string, text: string, isError = false, parent: string | null = null) => ({
  type: 'user', parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }] },
});

console.log('live-ops tests');

t('a tool_use starts a running op and its tool_result finishes it with a duration', () => {
  let clock = 1000;
  const tr = createOpsTracker(() => clock);
  const a = tr.handle(use('t1', 'Bash', { command: 'npm run build' }));
  assert.equal(a.length, 1);
  assert.equal(a[0].status, 'running');
  assert.equal(a[0].active, 'Running npm run build');
  clock = 4500;
  const b = tr.handle(res('t1', 'ok'));
  assert.equal(b[0].status, 'done');
  assert.equal(b[0].label, 'Ran npm run build');
  assert.equal(b[0].ms, 3500);
  assert.equal(b[0].error, undefined, 'output of a passing step is never kept');
});

t('Bash with a description shows the description, command goes to detail', () => {
  const d = describeToolUse('Bash', { command: 'git status -sb', description: 'Show working tree status' });
  assert.equal(d.label, 'Show working tree status');
  assert.equal(d.detail, 'git status -sb');
});

t('a failed step keeps a short redacted tail of its output', () => {
  const tr = createOpsTracker();
  tr.handle(use('t2', 'Bash', { command: 'curl x' }));
  const [op] = tr.handle(res('t2', `${'x'.repeat(900)} Authorization: Bearer abcdef1234567890 failed`, true));
  assert.equal(op.status, 'error');
  assert.ok(op.error!.length <= 301);
  assert.ok(op.error!.includes('failed'));
  assert.ok(!op.error!.includes('abcdef1234567890'));
});

t('secrets never reach a label or detail', () => {
  const cases = [
    'mysql -u root -pS3cretPass tdhmike_dhub',
    'curl -H "Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAA" https://x',
    'OPENAI_API_KEY=sk-proj-1234567890abcdef1234 node x.js',
    'psql postgres://kevin:hunter22@localhost/db',
    'gh auth --token ghp_abcdefghijklmnopqrstuvwxyz0123 status',
    'JARVIS_COCKPIT_KEY=deadbeefcafe123 curl localhost',
  ];
  const leaks = ['S3cretPass', 'AAAAAAAAAAAAAAAAAAAA', '1234567890abcdef1234', 'hunter22', 'abcdefghijklmnopqrstuvwxyz0123', 'deadbeefcafe123'];
  cases.forEach((c, i) => {
    const d = describeToolUse('Bash', { command: c });
    assert.ok(!(d.label + (d.detail ?? '')).includes(leaks[i]), `leaked: ${d.label}`);
  });
  assert.equal(redact('npm run build'), 'npm run build', 'ordinary commands untouched');
});

t('a tool name the CLI refuses reads as such, without the error tags', () => {
  const tr = createOpsTracker();
  tr.handle(use('m1', 'thread_todos', { operation: 'list' }));
  const [op] = tr.handle(res('m1', '<tool_use_error>Error: No such tool available: thread_todos</tool_use_error>', true));
  assert.equal(op.label, "Called a tool that doesn't exist here: thread_todos");
  assert.equal(op.error, 'Error: No such tool available: thread_todos');
});

t('sub-agent steps carry their parent helper id', () => {
  const tr = createOpsTracker();
  tr.handle(use('h1', 'Task', { description: 'Research resume sites', prompt: 'go' }));
  const [child] = tr.handle(use('c1', 'WebSearch', { query: 'portfolio sites' }, 'h1'));
  assert.equal(child.parent, 'h1');
  assert.equal(child.kind, 'web');
  assert.equal(tr.ops[0].label, 'Helper: Research resume sites');
});

t('the final result line closes anything still running (stop / cut-off)', () => {
  const tr = createOpsTracker();
  tr.handle(use('t3', 'Read', { file_path: '/a/b/agent.ts' }));
  const changed = tr.handle({ type: 'result', is_error: true });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status, 'error');
  assert.equal(tr.handle({ type: 'result' }).length, 0, 'second sweep is a no-op');
});

t('a retried tool_use id is not duplicated', () => {
  const tr = createOpsTracker();
  tr.handle(use('t4', 'Grep', { pattern: 'foo' }));
  assert.equal(tr.handle(use('t4', 'Grep', { pattern: 'foo' })).length, 0);
  assert.equal(tr.ops.length, 1);
});

t('the per-turn list is capped so a runaway turn cannot grow without bound', () => {
  const tr = createOpsTracker();
  for (let i = 0; i < 450; i++) tr.handle(use(`x${i}`, 'Read', { file_path: `/f${i}` }));
  assert.equal(tr.ops.length, 400);
  assert.equal(tr.ops[0].id, 'x50');
});

t('connector and JARVIS tools get readable names', () => {
  assert.equal(describeToolUse('mcp__jarvis__goals', { operation: 'list' }).label, 'JARVIS tool: goals (list)');
  assert.equal(describeToolUse('mcp__claude_ai_Smarty_Pants__cheatsheet-tool', { operation: 'get_cheatsheet' }).label, 'Smarty Pants: cheatsheet (get_cheatsheet)');
  assert.equal(describeToolUse('Edit', { file_path: '/x/y/agent.ts' }).label, 'Edited agent.ts');
  assert.equal(describeToolUse('Edit', { file_path: '/x/y/agent.ts' }).detail, '/x/y/agent.ts');
  assert.equal(describeToolUse('SomethingNew', {}).label, 'Used SomethingNew');
});

t('Codex command items map to shell steps, non-zero exit = failed', () => {
  const tr = createOpsTracker();
  tr.handle({ type: 'codex_item', phase: 'started', item: { id: 'i1', type: 'command_execution', command: 'ls -la' } });
  const [op] = tr.handle({ type: 'codex_item', phase: 'completed', item: { id: 'i1', type: 'command_execution', command: 'ls -la', exit_code: 2, aggregated_output: 'no such file' } });
  assert.equal(op.status, 'error');
  assert.equal(op.label, 'Ran ls -la');
});

t('a finished turn is rebuilt from its raw stream, ignoring junk lines', () => {
  const raw = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    'not json',
    JSON.stringify(use('a', 'Bash', { command: 'echo hi' })),
    JSON.stringify(res('a', 'hi')),
    JSON.stringify(use('b', 'Write', { file_path: '/tmp/x.md' })),
    JSON.stringify({ type: 'result', is_error: false }),
  ].join('\n');
  const ops = parseTurnOps(raw)!;
  assert.deepEqual(ops.map((o) => [o.label, o.status]), [['Ran echo hi', 'done'], ['Wrote x.md', 'done']]);
  assert.equal(parseTurnOps(JSON.stringify({ type: 'result' })), null);
  assert.equal(parseTurnOps(null), null);
});

t('the collapsed summary line counts running and failed', () => {
  const tr = createOpsTracker();
  tr.handle(use('s1', 'Read', { file_path: '/a' }));
  tr.handle(use('s2', 'Read', { file_path: '/b' }));
  tr.handle(res('s2', 'boom', true));
  assert.equal(summarizeOps(tr.ops), '2 operations · 1 running · 1 failed');
  assert.equal(summarizeOps([]), '');
});

console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
process.exit(process.exitCode ?? 0);
