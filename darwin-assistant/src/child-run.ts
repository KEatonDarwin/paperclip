// Child-process plumbing for model CLI runs (harness spine S2, 2026-10-13 review §3).
//
// Everything runClaude() needs to turn a spawned CLI into an HONEST outcome:
//   - classifyChildOutcome(): the typed (exit code × signal × parse state) matrix.
//     A nonzero exit is no longer "success" just because something hit stdout.
//   - LineSplitter: one incremental, byte-aware line splitter (streaming
//     TextDecoder), so a UTF-8 char split across two chunks decodes intact.
//   - ByteTail: a rolling byte cap for the DIAGNOSTIC tail only.
//   - Output accumulators (claude JSONL / codex JSONL / plain text): each line is
//     JSON-parsed ONCE by the caller and fed here; structural events are kept,
//     noise goes to the capped tail. No unbounded raw-chunk array.
//   - killProcessGroup(): SIGTERM the whole group, await the real 'exit', then
//     SIGKILL the group — grandchildren (MCP servers, shells) get reaped too.
//
// Deliberately free of DB/settings imports so it can be unit-tested hermetically.
import type { ChildProcess } from 'node:child_process';

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ClaudeResult {
  text: string;
  sessionId: string | null;
  usage?: ClaudeUsage;
  model?: string;
  rawOutput?: string;
  // Multi-Claude (tree-44d2ff4a): which Claude account this run was routed to
  // (the `claude_accounts` key, e.g. 'a'/'b'), or null for non-Claude runs / when
  // no account could be resolved. Lets the caller persist session_account and lets
  // the monitor see which subscription the work burned.
  accountKey?: string | null;
}

// ── outcome matrix ────────────────────────────────────────────────────────────

/** What the stdout parser saw: a good final result, an explicit error, or neither. */
export type FinalState = 'ok' | 'error' | 'none';

export type ChildOutcome =
  | { kind: 'success' }
  | { kind: 'success_with_warning'; warning: string }
  | { kind: 'failure'; reason: string };

export interface OutcomeInput {
  code: number | null;
  signal: NodeJS.Signals | null;
  final: FinalState;
  /** Message carried by an explicit error event (final === 'error'). */
  finalError?: string | null;
  /** Structured adapters must emit a final event; plain-text ones can't, so exit 0 decides. */
  requiresFinal: boolean;
  /** Best one-line diagnostic (first stderr line) for failures with no error event. */
  diagnostic?: string | null;
  /** Why a structured adapter's final is missing, when the parser knows more than "absent". */
  noFinalReason?: string | null;
}

/**
 * The typed outcome of a finished CLI child:
 *   killed by signal                → failure (signal named)
 *   explicit error event            → failure (its message)
 *   final result + exit 0           → success
 *   final result + nonzero exit     → success_with_warning (logged, turn not failed)
 *   no final result + nonzero exit  → failure, REGARDLESS of stdout
 *   no final result + exit 0        → failure for structured adapters, success for plain-text ones
 */
export function classifyChildOutcome(i: OutcomeInput): ChildOutcome {
  if (i.signal) return { kind: 'failure', reason: `killed by signal ${i.signal}` };
  if (i.final === 'error') {
    return { kind: 'failure', reason: (i.finalError ?? '').trim() || 'CLI reported an error result' };
  }
  const code = i.code ?? 0;
  if (i.final === 'ok') {
    return code === 0
      ? { kind: 'success' }
      : { kind: 'success_with_warning', warning: `exited with code ${code} after a final result${i.diagnostic ? ` (${i.diagnostic})` : ''}` };
  }
  if (code !== 0) {
    return { kind: 'failure', reason: i.diagnostic?.trim() || i.noFinalReason?.trim() || `exit code ${code}` };
  }
  if (!i.requiresFinal) return { kind: 'success' };
  return { kind: 'failure', reason: i.noFinalReason?.trim() || 'exited 0 without a final result event' };
}

// ── stream hygiene ────────────────────────────────────────────────────────────

/** Incremental line splitter: byte-aware (streaming TextDecoder), CR-tolerant. */
export class LineSplitter {
  private decoder = new TextDecoder('utf-8');
  private pending = '';

  /** Feed a chunk; returns the complete lines it finished (without newline). */
  push(chunk: Uint8Array): string[] {
    this.pending += this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  /** Flush the decoder and return the trailing partial line, if any. */
  end(): string[] {
    this.pending += this.decoder.decode();
    const lines = this.drain();
    if (this.pending) lines.push(this.pending.replace(/\r$/, ''));
    this.pending = '';
    return lines;
  }

  private drain(): string[] {
    if (!this.pending.includes('\n')) return [];
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    return parts.map((l) => l.replace(/\r$/, ''));
  }
}

export const DIAGNOSTIC_TAIL_BYTES = (() => {
  const raw = Number(process.env.JARVIS_CHILD_DIAG_TAIL_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 64 * 1024;
})();

/** Rolling, byte-capped tail of whole lines; oldest lines drop first. */
export class ByteTail {
  private lines: string[] = [];
  private bytes = 0;
  dropped = 0;
  constructor(private readonly cap: number = DIAGNOSTIC_TAIL_BYTES) {}

  push(line: string): void {
    let l = line;
    let n = Buffer.byteLength(l, 'utf8') + 1;
    if (n > this.cap) {
      // One oversized line: keep its tail end only.
      l = Buffer.from(l, 'utf8').subarray(-(this.cap - 1)).toString('utf8');
      n = Buffer.byteLength(l, 'utf8') + 1;
    }
    this.lines.push(l);
    this.bytes += n;
    while (this.bytes > this.cap && this.lines.length > 1) {
      this.bytes -= Buffer.byteLength(this.lines.shift() as string, 'utf8') + 1;
      this.dropped++;
    }
  }

  get size(): number { return this.bytes; }
  toLines(): string[] { return [...this.lines]; }
  toString(): string { return this.lines.join('\n'); }
}

/** Byte-capped text sink for stderr (streamed through its own decoder). */
export class StderrTail {
  private splitter = new LineSplitter();
  private tail: ByteTail;
  constructor(cap: number = DIAGNOSTIC_TAIL_BYTES) { this.tail = new ByteTail(cap); }
  push(chunk: Uint8Array): void { for (const l of this.splitter.push(chunk)) this.tail.push(l); }
  end(): string { for (const l of this.splitter.end()) this.tail.push(l); return this.tail.toString(); }
}

/** Parse a line as a JSON object exactly once; null for non-JSON / non-object lines. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── output accumulators ───────────────────────────────────────────────────────

export interface AccumulatedOutput {
  result: ClaudeResult;
  final: FinalState;
  finalError?: string | null;
  noFinalReason?: string | null;
}

export interface OutputAccumulator {
  /** Structured adapters must produce a final event; see classifyChildOutcome. */
  readonly requiresFinal: boolean;
  /** Feed one line (already split, already parsed once — `event` is null for non-JSON). */
  line(line: string, event: Record<string, unknown> | null): void;
  finish(): AccumulatedOutput;
}

function joinRaw(structural: string[], tail: ByteTail): string {
  if (!tail.size) return structural.join('\n');
  const marker = tail.dropped ? [`[diagnostic tail: ${tail.dropped} older line(s) dropped]`] : [];
  return [...structural, ...marker, ...tail.toLines()].join('\n');
}

/**
 * Claude `--output-format stream-json` (also auggie's JSON blob).
 * Structural events (everything JSON except the per-token `stream_event` deltas)
 * are retained raw for turn-steps; non-JSON noise goes to the capped tail —
 * unless `nonJson: 'all'` (auggie, whose answer may itself be the plain text).
 */
export function createClaudeAccumulator(opts: { requiresFinal?: boolean; nonJson?: 'tail' | 'all'; tailBytes?: number } = {}): OutputAccumulator {
  const requiresFinal = opts.requiresFinal ?? true;
  const keepAllNonJson = opts.nonJson === 'all';
  const texts: string[] = [];
  const structural: string[] = [];
  const tail = new ByteTail(opts.tailBytes);
  let sessionId: string | null = null;
  let usage: ClaudeUsage | undefined;
  let model: string | undefined;
  let finalResult: { text: string; isError: boolean } | null = null;

  return {
    requiresFinal,
    line(line, event) {
      if (!line.trim()) return;
      if (!event) {
        if (keepAllNonJson) structural.push(line); else tail.push(line);
        return;
      }
      // --include-partial-messages: one stream_event per token; turn-steps only
      // reads complete `assistant` messages, so the deltas are never retained.
      if (event.type === 'stream_event') return;
      structural.push(line);
      if (finalResult) return; // the CLI's own result is authoritative; ignore trailing lines

      if (typeof event.session_id === 'string' && event.session_id) sessionId = event.session_id;
      if (typeof event.model === 'string' && event.model) model = event.model;

      if (event.type === 'assistant') {
        const content = (event.message as Record<string, unknown> | null)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
          }
        }
      }

      if (event.type === 'result') {
        const u = event.usage as Record<string, unknown> | undefined;
        if (u) {
          usage = {
            inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
            outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
            cacheReadTokens: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : undefined,
            cacheWriteTokens: typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : undefined,
          };
        }
        const r = typeof event.result === 'string' ? event.result.trim() : '';
        finalResult = { text: r || texts.join('').trim(), isError: event.is_error === true };
      }
    },
    finish() {
      const rawOutput = joinRaw(structural, tail);
      if (finalResult) {
        const result = { text: finalResult.text, sessionId, usage, model, rawOutput };
        return finalResult.isError
          ? { result, final: 'error', finalError: finalResult.text || 'claude reported is_error with no message' }
          : { result, final: 'ok' };
      }
      return {
        result: { text: texts.join('').trim() || rawOutput.trim(), sessionId, usage, model, rawOutput },
        final: 'none',
        noFinalReason: 'no result event in the CLI output',
      };
    },
  };
}

/** Codex `exec --json` stream: error/turn.failed events and a missing final message are failures. */
export function createCodexAccumulator(opts: { tailBytes?: number } = {}): OutputAccumulator {
  const messages: string[] = [];
  const structural: string[] = [];
  const tail = new ByteTail(opts.tailBytes);
  let sessionId: string | null = null;
  let usage: ClaudeUsage | undefined;
  let turnCompleted = false;
  let turnFailed: string | null = null;
  let lastError: string | null = null;

  const errorText = (event: Record<string, unknown>): string => {
    const nested = event.error as Record<string, unknown> | string | undefined;
    if (typeof nested === 'string') return nested;
    if (nested && typeof nested.message === 'string') return nested.message;
    if (typeof event.message === 'string') return event.message;
    return JSON.stringify(event).slice(0, 500);
  };

  return {
    requiresFinal: true,
    line(line, event) {
      if (!line.trim()) return;
      if (!event) { tail.push(line); return; }
      const type = event.type;
      if (type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) {
        sessionId = event.thread_id;
        structural.push(line);
        return;
      }
      if (type === 'item.completed') {
        const item = event.item as Record<string, unknown> | undefined;
        if (item && item.type === 'agent_message' && typeof item.text === 'string') {
          messages.push(item.text);
          structural.push(line); // turn-steps reads these back out of rawOutput
          return;
        }
      }
      if (type === 'turn.completed') {
        turnCompleted = true;
        const u = event.usage as Record<string, unknown> | undefined;
        if (u) {
          usage = {
            inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
            outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
            cacheReadTokens: typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : undefined,
          };
        }
        structural.push(line);
        return;
      }
      if (type === 'turn.failed') { turnFailed = errorText(event); structural.push(line); return; }
      if (type === 'error') { lastError = errorText(event); structural.push(line); return; }
      // command_execution / reasoning / file_change … : diagnostic only, capped.
      tail.push(line);
    },
    finish() {
      // Prefer the LAST NON-EMPTY agent_message. Codex sometimes ends a runaway
      // turn with an empty final agent_message — never surface the raw stream as
      // turn text (CODEX RAW-JSONL PERSIST BUG, 2026-09-10, node 61).
      let finalText = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        const t = messages[i]?.trim();
        if (t) { finalText = t; break; }
      }
      const result: ClaudeResult = {
        text: finalText || '[codex worker produced no final message]',
        sessionId,
        usage,
        rawOutput: joinRaw(structural, tail),
      };
      if (turnFailed) return { result, final: 'error', finalError: turnFailed };
      if (turnCompleted && finalText) return { result, final: 'ok' };
      // An `error` event followed by a completed turn is a recovered transient
      // (e.g. a reconnect); with no completed turn it is the failure.
      if (lastError) return { result, final: 'error', finalError: lastError };
      return {
        result,
        final: 'none',
        noFinalReason: turnCompleted ? 'codex completed the turn with no final agent message' : 'codex stream ended without turn.completed',
      };
    },
  };
}

/**
 * Plain-text adapters (devin --print): the whole stdout IS the answer, so it is
 * retained in full; there is no final event, so the exit code alone decides.
 */
export function createTextAccumulator(parse: (stdout: string) => ClaudeResult): OutputAccumulator {
  const lines: string[] = [];
  return {
    requiresFinal: false,
    line(line) { lines.push(line); },
    finish() { return { result: parse(lines.join('\n')), final: 'none', noFinalReason: null }; },
  };
}

/** Whole-string convenience: feed `stdout` through an accumulator (one parse per line). */
export function accumulateString(acc: OutputAccumulator, stdout: string): AccumulatedOutput {
  for (const line of stdout.split('\n')) {
    const l = line.replace(/\r$/, '');
    acc.line(l, parseJsonLine(l));
  }
  return acc.finish();
}

// ── process-group lifecycle ───────────────────────────────────────────────────

export const CHILD_KILL_GRACE_MS = (() => {
  const raw = Number(process.env.JARVIS_CHILD_KILL_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
})();

/** True once the direct child has actually exited (not merely been signalled). */
export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid) {
    try { process.kill(-pid, sig); return; } catch { /* not a group leader / already gone */ }
  }
  try { child.kill(sig); } catch { /* already gone */ }
}

/**
 * Kill a child spawned with `detached: true` (its own process group):
 * SIGTERM the group, await the child's real 'exit' (not `child.killed`, which only
 * means a signal was SENT), and SIGKILL the group if the child — or any
 * grandchild still in the group — is alive when the grace period ends.
 */
export function killProcessGroup(child: ChildProcess, graceMs: number = CHILD_KILL_GRACE_MS): Promise<void> {
  const pid = child.pid;
  if (!pid) return Promise.resolve();
  signalGroup(child, 'SIGTERM');
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + graceMs;
    let poll: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (poll) clearTimeout(poll);
      child.removeListener('exit', onExit);
      resolve();
    };
    const check = () => {
      if (hasExited(child) && !groupAlive(pid)) return finish();
      if (Date.now() >= deadline) {
        signalGroup(child, 'SIGKILL');
        return finish();
      }
      // Not unref'd: bounded by graceMs, and a shutdown must not exit before the SIGKILL.
      poll = setTimeout(check, 50);
    };
    const onExit = () => check();
    child.on('exit', onExit);
    check();
  });
}

/** stdin 'error' handler: a child that exits before draining its prompt raises EPIPE — tolerate it. */
export function tolerateStdinErrors(child: ChildProcess, label: string): void {
  child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED' || err.code === 'ECONNRESET') return;
    console.warn(`[agent] ${label}: stdin error ignored: ${err.message}`);
  });
}
