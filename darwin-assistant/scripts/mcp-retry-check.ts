/**
 * Model-free check for the MCP auto-heal helper (src/tools/mcp-retry.ts).
 * Run: npx tsx scripts/mcp-retry-check.ts   (or after build via the .mjs twin)
 *
 * Testing discipline: inject REAL failing/succeeding functions, assert the
 * observable behaviour (attempt count, final class, that backoff actually
 * fired), and include a mutation check that the retry loop cannot silently
 * become a no-op.
 */
import {
  classifyFailure,
  isRetryable,
  withRetry,
  type FailureClass,
} from '../src/tools/mcp-retry.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  ✗ ${label}`);
  }
}

// ---- 1. classifyFailure over REAL error strings this codebase emits ----
const classCases: Array<[string, FailureClass]> = [
  ['tools/call failed: HTTP 503 Service Unavailable', 'transient'],
  ['tools/call failed: HTTP 502 <html>bad gateway</html>', 'transient'],
  ['native MCP call timed out after 60000ms', 'transient'],
  ['fetch failed', 'transient'],
  ['request to https://mcp.thedarwinhub.com failed, reason: ECONNRESET', 'transient'],
  ['SSE response contained no JSON-RPC message', 'transient'],
  ['getaddrinfo EAI_AGAIN mcp.thedarwinhub.com', 'transient'],
  ['tools/call failed: HTTP 429 Too Many Requests', 'rate_limit'],
  ['Claude AI usage limit — overloaded_error', 'rate_limit'],
  ['initialize failed: HTTP 401 Unauthorized', 'auth'],
  ['tools/call failed: HTTP 403 Forbidden', 'auth'],
  ['OAuth token expired', 'auth'],
  ['tools/call error -32602: Unknown operation: frobnicate', 'tool_error'],
  ['permission_denied: tool not in --allowed-tools scope', 'tool_error'],
  ['Invalid argument: key must be a string', 'tool_error'],
  ['something nobody has ever seen before', 'unknown'],
  ['', 'unknown'],
];
for (const [msg, want] of classCases) {
  const got = classifyFailure(msg);
  ok(got === want, `classify "${msg.slice(0, 48)}" → ${got} (want ${want})`);
}
ok(isRetryable('transient') && isRetryable('rate_limit') && isRetryable('auth'), 'transient/rate_limit/auth are retryable');
ok(!isRetryable('tool_error') && !isRetryable('unknown'), 'tool_error/unknown are NOT retryable');

// ---- helper: a fn that fails with `err` for the first `n` calls, then succeeds ----
function flaky(nFailures: number, err: string) {
  let calls = 0;
  const f = async () => {
    calls += 1;
    if (calls <= nFailures) return { ok: false as const, error: err };
    return { ok: true as const, error: undefined, value: 'done' };
  };
  return { f, calls: () => calls };
}
function recordingSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

// ---- 2. succeeds after 2 transient failures ----
{
  const { f, calls } = flaky(2, 'tools/call failed: HTTP 503');
  const { sleep, delays } = recordingSleep();
  const r = await withRetry(f, { retries: 2, baseDelayMs: 100, sleep });
  ok(r.ok === true, 'recovers after 2 transient failures (ok)');
  ok(r.attempts === 3, `made exactly 3 attempts (got ${r.attempts})`);
  ok(calls() === 3, `fn called exactly 3 times (got ${calls()})`);
  ok(delays.length === 2 && delays[0] === 100 && delays[1] === 200, `backoff fired 100,200 (got ${delays.join(',')})`);
}

// ---- 3. a tool_error is NEVER retried ----
{
  const { f, calls } = flaky(99, 'Unknown operation: nope');
  const { sleep, delays } = recordingSleep();
  const r = await withRetry(f, { retries: 5, baseDelayMs: 1, sleep });
  ok(r.ok === false, 'tool_error stays failed');
  ok(r.attempts === 1 && calls() === 1, `tool_error not retried (attempts ${r.attempts}, calls ${calls()})`);
  ok(r.failure_class === 'tool_error', `classed tool_error (got ${r.failure_class})`);
  ok(delays.length === 0, 'no backoff for tool_error');
}

// ---- 4. transient that never recovers exhausts the budget, no more ----
{
  const { f, calls } = flaky(99, 'fetch failed');
  const { sleep } = recordingSleep();
  const r = await withRetry(f, { retries: 2, baseDelayMs: 1, sleep });
  ok(r.ok === false, 'always-failing transient ends failed');
  ok(r.attempts === 3 && calls() === 3, `budget respected: 1 try + 2 retries (attempts ${r.attempts})`);
  ok(r.failure_class === 'transient', `final class transient (got ${r.failure_class})`);
}

// ---- 5. auth gets at most authMaxRetries regardless of the retries budget ----
{
  const { f, calls } = flaky(99, 'HTTP 401 Unauthorized');
  const { sleep } = recordingSleep();
  const r = await withRetry(f, { retries: 5, baseDelayMs: 1, authMaxRetries: 1, sleep });
  ok(r.ok === false, 'always-failing auth ends failed');
  ok(r.attempts === 2 && calls() === 2, `auth capped at 1 retry despite retries=5 (attempts ${r.attempts})`);
  ok(r.failure_class === 'auth', `final class auth (got ${r.failure_class})`);
}

// ---- 6. unknown is not retried ----
{
  const { f, calls } = flaky(99, 'bizarre unseen failure');
  const { sleep } = recordingSleep();
  const r = await withRetry(f, { retries: 3, baseDelayMs: 1, sleep });
  ok(r.attempts === 1 && calls() === 1, `unknown not retried (attempts ${r.attempts})`);
  ok(r.failure_class === 'unknown', `final class unknown (got ${r.failure_class})`);
}

// ---- 7. MUTATION check: a first-try success must not sleep or re-call ----
{
  const { f, calls } = flaky(0, 'n/a');
  const { sleep, delays } = recordingSleep();
  const r = await withRetry(f, { retries: 3, baseDelayMs: 1, sleep });
  ok(r.ok === true && r.attempts === 1 && calls() === 1 && delays.length === 0, 'clean success: 1 call, 0 sleeps');
}

console.log(`\nmcp-retry-check: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
