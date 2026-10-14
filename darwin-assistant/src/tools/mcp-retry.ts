/**
 * MCP call auto-heal — retry + failure classification.
 *
 * Why this exists: an `mcp_call` failure used to surface to JARVIS as an opaque
 * "connector dropped". In practice the server (smarty-pants) is almost always
 * up — the failure is a transient: a cold-start 5xx, a network blip, a brief
 * timeout, or a rate-limit (429). The native client already re-inits a dropped
 * *session* (404/400) but does NOT retry a transient blip; it falls straight
 * through to the expensive CLI bridge, and if that also has a bad moment the
 * whole call dies.
 *
 * This module gives two things, both pure and unit-testable:
 *   1. classifyFailure(msg) — turn a raw error string into a FailureClass, so
 *      callers can say *which* kind of failure it was instead of "dropped".
 *   2. withRetry(fn, opts) — re-run a call that returns {ok,error} while the
 *      failure is retryable, with exponential backoff. Never retries a real
 *      tool error (bad args / unknown operation) — only transient/auth blips.
 */

export type FailureClass =
  | 'transient' // timeout / network / 5xx / overloaded — retry with backoff
  | 'rate_limit' // 429 — retry with backoff (a transient subtype, named for clarity)
  | 'auth' // 401 / 403 / needs auth / expired token — retry once, then surface
  | 'tool_error' // the tool itself rejected the call (bad args, unknown op) — never retry
  | 'unknown'; // unclassified — do NOT auto-retry (don't hammer an unexplained error)

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\bHTTP 429\b/i,
  /\b429\b/,
  /rate.?limit/i,
  /too many requests/i,
  /overloaded/i,
];

const AUTH_PATTERNS: RegExp[] = [
  /\bHTTP 40[13]\b/i,
  /\b40[13]\b/,
  /unauthor/i,
  /forbidden/i,
  /needs? authentication/i,
  /\boauth\b/i,
  /invalid[_ -]?token/i,
  /token expired/i,
  /expired token/i,
];

const TRANSIENT_PATTERNS: RegExp[] = [
  /timed out/i,
  /timeout/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  /EPIPE/i,
  /socket hang up/i,
  /network/i,
  /fetch failed/i,
  /\bHTTP 5\d\d\b/i,
  /\b50[0-9]\b/,
  /\bbad gateway\b/i,
  /\bservice unavailable\b/i,
  /\bgateway timeout\b/i,
  /connection.*(closed|reset|refused)/i,
  /no JSON-RPC message/i, // truncated/empty stream frame — a transport hiccup
];

const TOOL_ERROR_PATTERNS: RegExp[] = [
  /unknown operation/i,
  /invalid (argument|parameter|input)/i,
  /missing required/i,
  /permission_denied/i,
  /not in --allowed-tools/i,
  /validation/i,
];

/** Classify a raw error string into a FailureClass. Order matters: the most
 *  actionable, retry-safe buckets (rate_limit, auth) are checked before the
 *  broad transient net, and real tool errors win over everything so we never
 *  auto-retry a call the server correctly rejected. */
export function classifyFailure(message: string | undefined | null): FailureClass {
  if (!message) return 'unknown';
  const m = String(message);
  if (TOOL_ERROR_PATTERNS.some((re) => re.test(m))) return 'tool_error';
  if (AUTH_PATTERNS.some((re) => re.test(m))) return 'auth';
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(m))) return 'rate_limit';
  if (TRANSIENT_PATTERNS.some((re) => re.test(m))) return 'transient';
  return 'unknown';
}

/** Is this failure class worth another automatic attempt? */
export function isRetryable(cls: FailureClass): boolean {
  return cls === 'transient' || cls === 'rate_limit' || cls === 'auth';
}

/** A short, human-facing phrase for a class — used in the final error string so
 *  the surfaced message names the cause instead of "connector dropped". */
export function describeFailure(cls: FailureClass): string {
  switch (cls) {
    case 'transient':
      return 'transient connector blip';
    case 'rate_limit':
      return 'rate-limited by the provider';
    case 'auth':
      return 'connector auth/token issue';
    case 'tool_error':
      return 'the tool rejected the call';
    default:
      return 'unclassified connector error';
  }
}

export interface RetryResultMeta {
  /** How the FINAL failure was classified (only meaningful when ok=false). */
  failure_class?: FailureClass;
  /** Total attempts made (1 = succeeded or failed first try, no retry). */
  attempts?: number;
}

export interface RetryOpts {
  /** Max RETRIES after the first attempt (so total attempts = retries + 1). */
  retries: number;
  /** Base backoff in ms; attempt n waits baseDelayMs * 2^(n-1). */
  baseDelayMs: number;
  /** Cap on a single backoff wait. */
  maxDelayMs?: number;
  /** An auth-class failure gets at most this many retries regardless of `retries`
   *  (a stale token rarely fixes itself in more than one short wait). Default 1. */
  authMaxRetries?: number;
  /** Injected sleep — tests pass a no-op so they don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected classifier — tests can override; defaults to classifyFailure. */
  classify?: (message: string | undefined) => FailureClass;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` (which resolves to a result carrying {ok, error?}) and retry while
 * the failure is retryable and attempts remain. Returns the last result with
 * `failure_class` and `attempts` attached. Pure w.r.t. everything but `fn` and
 * the injected sleep/classify, so a test drives it with a fake fn + no-op sleep.
 */
export async function withRetry<T extends { ok: boolean; error?: string }>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOpts,
): Promise<T & RetryResultMeta> {
  const classify = opts.classify ?? classifyFailure;
  const sleep = opts.sleep ?? defaultSleep;
  const maxDelay = opts.maxDelayMs ?? 5_000;
  const authMax = opts.authMaxRetries ?? 1;

  let attempt = 0;
  let last: T;
  let authRetries = 0;

  // total attempts = first try + up to `retries` retries
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    last = await fn(attempt);
    if (last.ok) {
      return Object.assign(last, { attempts: attempt });
    }

    const cls = classify(last.error);
    const retriesLeft = attempt <= opts.retries;
    const authBudgetLeft = cls !== 'auth' || authRetries < authMax;

    if (!isRetryable(cls) || !retriesLeft || !authBudgetLeft) {
      return Object.assign(last, { failure_class: cls, attempts: attempt });
    }

    if (cls === 'auth') authRetries += 1;
    const delay = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), maxDelay);
    await sleep(delay);
  }
}
