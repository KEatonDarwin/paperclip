// Honest child-process outcomes + stream hygiene (harness spine S2, 2026-10-13 review §3).
//
// Proves, with fake CLI children (tiny shell scripts) and no model:
//   - nonzero exit + stdout + NO final event  → failure (stdout is not success)
//   - nonzero exit + parsed final result      → success-with-warning (result kept, warning logged)
//   - claude is_error result / codex error or turn.failed / codex missing final → failure
//   - a multi-byte UTF-8 char split across two chunks decodes intact
//   - EPIPE on stdin (child exits without reading its prompt) does not throw
//   - group kill reaps a grandchild that ignores SIGTERM (SIGKILL escalation)
//
// Run: npm run child-outcome:test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Hermetic env BEFORE importing anything (several modules read env at load time).
const scratch = mkdtempSync(join(tmpdir(), 'child-outcome-test-'));
Object.assign(process.env, {
  JARVIS_SIM: '1',
  JARVIS_DB_PATH: join(scratch, 'jarvis.db'),
  JARVIS_MEMORY_STATE_DIR: join(scratch, 'memory-injections'),
  JARVIS_CLI_CWD: scratch,
  CLAUDE_CONFIG_DIR: join(scratch, 'claude-config'),
  CLAUDE_USAGE_DIR: join(scratch, 'usage'),
  JARVIS_CHILD_KILL_GRACE_MS: '400',
  // agent.ts warms model shelves at import; point every CLI at nothing so zero real CLIs start.
  CODEX_BIN: join(scratch, 'no-such-codex'),
  AUGGIE_BIN: join(scratch, 'no-such-auggie'),
  DEVIN_BIN: join(scratch, 'no-such-devin'),
  CLAUDE_BIN: join(scratch, 'no-such-claude'),
});

const cr = await import('../src/child-run.js');
const { runClaude, getAdapters, activeRunsDrained } = await import('../src/agent.js');

function fake(name: string, body: string): string {
  const p = join(scratch, `${name}.sh`);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return p;
}
const claudeWith = (bin: string) => ({ adapter: { ...getAdapters().claude, bin }, model: null, options: {}, claudeAccount: null });
const codexWith = (bin: string) => ({ adapter: { ...getAdapters().codex, bin }, model: null, options: {} });

async function captureWarn<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
  try { return { value: await fn(), warnings }; } finally { console.warn = orig; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ── pure: the outcome matrix ──────────────────────────────────────────────────
test('outcome matrix: every (exit, signal, parse) cell', () => {
  const base = { requiresFinal: true, diagnostic: null } as const;
  assert.deepEqual(cr.classifyChildOutcome({ ...base, code: 0, signal: null, final: 'ok' }), { kind: 'success' });
  assert.equal(cr.classifyChildOutcome({ ...base, code: 3, signal: null, final: 'ok' }).kind, 'success_with_warning');
  const noFinal = cr.classifyChildOutcome({ ...base, code: 1, signal: null, final: 'none', diagnostic: 'boom' });
  assert.deepEqual(noFinal, { kind: 'failure', reason: 'boom' });
  assert.deepEqual(cr.classifyChildOutcome({ ...base, code: 1, signal: null, final: 'none' }), { kind: 'failure', reason: 'exit code 1' });
  assert.equal(cr.classifyChildOutcome({ ...base, code: 0, signal: null, final: 'none' }).kind, 'failure');
  assert.equal(cr.classifyChildOutcome({ ...base, requiresFinal: false, code: 0, signal: null, final: 'none' }).kind, 'success');
  assert.equal(cr.classifyChildOutcome({ ...base, requiresFinal: false, code: 1, signal: null, final: 'none' }).kind, 'failure');
  assert.deepEqual(cr.classifyChildOutcome({ ...base, code: null, signal: 'SIGKILL', final: 'ok' }), { kind: 'failure', reason: 'killed by signal SIGKILL' });
  assert.deepEqual(cr.classifyChildOutcome({ ...base, code: 0, signal: null, final: 'error', finalError: 'nope' }), { kind: 'failure', reason: 'nope' });
});

// ── pure: stream hygiene ──────────────────────────────────────────────────────
test('LineSplitter: multi-byte UTF-8 split across chunks decodes intact', () => {
  const bytes = Buffer.from('{"t":"café 😀 €"}\nnext\n', 'utf8');
  const s = new cr.LineSplitter();
  const out: string[] = [];
  // Split INSIDE é (2 bytes), inside 😀 (4 bytes) and inside € (3 bytes): one byte at a time.
  for (let i = 0; i < bytes.length; i++) out.push(...s.push(bytes.subarray(i, i + 1)));
  out.push(...s.end());
  assert.deepEqual(out, ['{"t":"café 😀 €"}', 'next']);
  // The naive per-chunk toString this replaces corrupts the same input.
  const naive = [bytes.subarray(0, 10), bytes.subarray(10)].map((b) => b.toString('utf8')).join('');
  assert.notEqual(naive, bytes.toString('utf8'));
});

test('ByteTail caps the diagnostic tail; codex structural lines survive', () => {
  const t = new cr.ByteTail(100);
  for (let i = 0; i < 50; i++) t.push(`noise line ${i}`);
  assert.ok(t.size <= 100, `tail ${t.size}B over cap`);
  assert.ok(t.dropped > 0);
  assert.ok(t.toString().endsWith('noise line 49'));

  const acc = cr.createCodexAccumulator({ tailBytes: 200 });
  const feed = (o: unknown) => { const l = JSON.stringify(o); acc.line(l, cr.parseJsonLine(l)); };
  feed({ type: 'thread.started', thread_id: 'th1' });
  for (let i = 0; i < 500; i++) feed({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x'.repeat(100) } });
  feed({ type: 'item.completed', item: { type: 'agent_message', text: 'FINAL' } });
  feed({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } });
  const r = acc.finish();
  assert.equal(r.final, 'ok');
  assert.equal(r.result.text, 'FINAL');
  assert.ok((r.result.rawOutput ?? '').length < 2_000, `raw ${r.result.rawOutput?.length} not capped`);
  assert.match(r.result.rawOutput ?? '', /"agent_message"/);
});

test('accumulators: claude is_error and codex error/turn.failed/no-final are not successes', () => {
  const c = cr.accumulateString(cr.createClaudeAccumulator(), '{"type":"result","is_error":true,"result":"Claude AI usage limit reached"}\n');
  assert.equal(c.final, 'error');
  assert.match(c.finalError ?? '', /usage limit/);
  const e = cr.accumulateString(cr.createCodexAccumulator(), '{"type":"thread.started","thread_id":"t"}\n{"type":"error","message":"stream disconnected"}\n');
  assert.deepEqual([e.final, e.finalError], ['error', 'stream disconnected']);
  const f = cr.accumulateString(cr.createCodexAccumulator(), '{"type":"turn.failed","error":{"message":"quota"}}\n');
  assert.deepEqual([f.final, f.finalError], ['error', 'quota']);
  const n = cr.accumulateString(cr.createCodexAccumulator(), '{"type":"item.completed","item":{"type":"agent_message","text":""}}\n{"type":"turn.completed"}\n');
  assert.equal(n.final, 'none');
  // A transient error followed by a completed turn is a recovery, not a failure.
  const ok = cr.accumulateString(cr.createCodexAccumulator(), '{"type":"error","message":"Reconnecting 1/5"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed"}\n');
  assert.equal(ok.final, 'ok');
});

// ── through the real runClaude() with fake children ──────────────────────────
test('runClaude: nonzero exit + stdout + no final event = failure', async () => {
  const bin = fake('nofinal', `cat >/dev/null
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"half an answer"}]}}'
echo 'some non-json noise'
echo 'fatal: model backend went away' >&2
exit 1`);
  await assert.rejects(runClaude('hi', null, undefined, claudeWith(bin)), /claude: fatal: model backend went away/);
});

test('runClaude: nonzero exit + parsed final = success-with-warning', async () => {
  const bin = fake('finalnonzero', `cat >/dev/null
echo '{"type":"system","subtype":"init","session_id":"s-1"}'
echo '{"type":"result","result":"THE ANSWER","session_id":"s-1"}'
exit 2`);
  const { value, warnings } = await captureWarn(() => runClaude('hi', null, undefined, claudeWith(bin)));
  assert.equal(value.text, 'THE ANSWER');
  assert.equal(value.sessionId, 's-1');
  assert.ok(warnings.some((w) => /exited with code 2 after a final result/.test(w)), `no warning logged: ${warnings.join(' | ')}`);
});

test('runClaude: claude is_error result is a failure carrying its message (rate-limit rescue can see it)', async () => {
  const bin = fake('iserror', `cat >/dev/null
echo '{"type":"result","is_error":true,"result":"Claude AI usage limit reached - 5-hour limit reached"}'
exit 1`);
  await assert.rejects(runClaude('hi', null, undefined, claudeWith(bin)), /claude: Claude AI usage limit reached/);
});

test('runClaude: codex error event with no completed turn = failure; happy path = success', async () => {
  const bad = fake('codexerr', `cat >/dev/null
echo '{"type":"thread.started","thread_id":"th-9"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"working on it"}}'
echo '{"type":"error","message":"unexpected status 401"}'
exit 1`);
  await assert.rejects(runClaude('hi', null, undefined, codexWith(bad)), /codex: unexpected status 401/);
  const good = fake('codexok', `cat >/dev/null
echo '{"type":"thread.started","thread_id":"th-9"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"ALL DONE"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":7}}'`);
  const r = await runClaude('hi', null, undefined, codexWith(good));
  assert.equal(r.text, 'ALL DONE');
  assert.equal(r.sessionId, 'th-9');
});

test('runClaude: UTF-8 char split across two stdout chunks decodes intact (live + persisted)', async () => {
  const bin = fake('utf8split', `cat >/dev/null
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"caf\\xc3'
sleep 0.2
printf '\\xa9 \\xf0\\x9f\\x98'
sleep 0.2
printf '\\x80"}]}}\\n{"type":"result","result":"caf\\xc3\\xa9 \\xf0\\x9f\\x98\\x80"}\\n'`);
  const events: Record<string, unknown>[] = [];
  const r = await runClaude('hi', null, (e) => events.push(e), claudeWith(bin));
  assert.equal(r.text, 'café 😀');
  const live = events.find((e) => e.type === 'assistant') as { message: { content: Array<{ text: string }> } } | undefined;
  assert.equal(live?.message.content[0].text, 'café 😀');
  assert.ok(!(r.rawOutput ?? '').includes('�'), 'replacement char in persisted raw output');
});

test('runClaude: EPIPE on stdin (child exits without reading a big prompt) does not throw', async () => {
  const bin = fake('epipe', `exec 0<&-
echo '{"type":"result","result":"ok without reading"}'
exit 0`);
  const big = 'x'.repeat(8 * 1024 * 1024);
  const r = await runClaude(big, null, undefined, claudeWith(bin));
  assert.equal(r.text, 'ok without reading');
  // And the helper on its own, against a child that is already gone.
  const child = spawn('true', [], { stdio: ['pipe', 'ignore', 'ignore'] });
  cr.tolerateStdinErrors(child, 'test');
  await new Promise((res) => child.on('exit', res));
  child.stdin!.write(Buffer.alloc(1024 * 1024));
  child.stdin!.end();
  await new Promise((res) => setTimeout(res, 100));
});

test('group kill: Stop reaps a grandchild that ignores SIGTERM', async () => {
  const pidfile = join(scratch, 'grandchild.pid');
  const bin = fake('grandparent', `cat >/dev/null
bash -c 'trap "" TERM; exec sleep 300' &
echo $! > '${pidfile}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"started"}]}}'
wait`);
  const ac = new AbortController();
  const run = runClaude('hi', null, undefined, claudeWith(bin), ac.signal);
  for (let i = 0; i < 100 && !existsSync(pidfile); i++) await new Promise((r) => setTimeout(r, 20));
  const gpid = Number(readFileSync(pidfile, 'utf8').trim());
  assert.ok(gpid > 0 && alive(gpid), 'grandchild not running before the kill');
  ac.abort();
  await assert.rejects(run, /Run stopped by user/);
  await activeRunsDrained();
  for (let i = 0; i < 50 && alive(gpid); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(gpid), false, `grandchild ${gpid} survived the group kill`);
});

test('killProcessGroup: awaits the real exit of a cooperative child (no SIGKILL needed)', async () => {
  const child = spawn('bash', ['-c', 'sleep 300 & wait'], { detached: true, stdio: 'ignore' });
  await new Promise((r) => child.on('spawn', r));
  const t0 = Date.now();
  await cr.killProcessGroup(child, 5_000);
  assert.ok(cr.hasExited(child), 'resolved before the child exited');
  assert.ok(Date.now() - t0 < 4_000, 'waited for the grace period on a child that exited on SIGTERM');
  assert.equal(child.signalCode, 'SIGTERM');
});

// ── done-evidence: stored on finish, surfaced to dependents, optional ─────────
test('finish evidence: stored on the node, surfaced in a dependent prompt, omitted = null', async () => {
  const { sqliteDb } = await import('../src/conversation-db.js');
  const engine = await import('../src/hopper-engine.js');
  sqliteDb.prepare(`INSERT INTO hopper_trees (id, topic, status) VALUES ('tree-s2-ev', 'evidence check', 'active')`).run();
  const mk = (title: string, deps: number[] | null) => Number(
    sqliteDb.prepare(`INSERT INTO hopper_nodes (tree_id, title, spec, status, depends_on) VALUES ('tree-s2-ev', ?, 'x', 'running', ?)`)
      .run(title, deps ? JSON.stringify(deps) : null).lastInsertRowid,
  );
  const a = mk('with evidence', null);
  const b = mk('without evidence', null);
  const dep = mk('dependent', [a]);
  const doneA = engine.finishHopperNode(a, 'done', { result: 'built it', evidence: '  npx tsc --noEmit clean; npm run child-outcome:test 13/13  ' });
  assert.equal(doneA?.done_evidence, 'npx tsc --noEmit clean; npm run child-outcome:test 13/13');
  const doneB = engine.finishHopperNode(b, 'done', { result: 'built it too' });
  assert.equal(doneB?.done_evidence, null);
  const prompt = engine.composeWorkerPrompt(engine.getHopperNode(dep)!, engine.getHopperTree('tree-s2-ev')!);
  assert.match(prompt, /- with evidence: built it\n {2}\(evidence: npx tsc --noEmit clean; npm run child-outcome:test 13\/13\)/);
  assert.match(prompt, /"evidence":"<optional: the command\/check that proved it/);
});
