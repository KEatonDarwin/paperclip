/**
 * AGENT STABLE — the read model and run/enable operations for Kevin's stable of
 * recurring claude-CLI agents (/home/kevin/agent-stable, built by node #1205).
 *
 * Deliberately a THIN layer over the `agent-stable` CLI rather than a second
 * implementation. The CLI already owns registry validation, the `systemctl show`
 * reads for last/next run, drift detection and the run ledger; reimplementing any
 * of that in TypeScript would guarantee the two copies disagree the first time
 * the registry schema moves. So:
 *
 *   - the roll-up comes from `agent-stable status --json`
 *   - run-now shells `sudo -n systemd-run` -> bin/run-agent (the SHARED runner,
 *     so an API-triggered run obeys exactly the same invariants as a timer run:
 *     flock, env scrubbing, post_step, ledger, ntfy)
 *   - enable/disable delegates to `agent-stable enable|disable`, which flips the
 *     registry AND `systemctl --now` in one place
 *
 * The one thing the CLI does NOT give us is the digest/log tail the cockpit shows,
 * so that is read from disk here.
 *
 * NO API KEYS anywhere: the runner scrubs them and we never pass one.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const CLI = '/home/kevin/.local/bin/agent-stable';
const RUNNER = '/home/kevin/agent-stable/bin/run-agent';
const STABLE_ROOT = process.env.AGENT_STABLE_ROOT || '/home/kevin/agent-stable';

/** Max bytes we read off the end of a digest/log file. Keeps a 200MB log safe. */
const TAIL_BYTES = 16_000;
/** Lines of tail handed to the cockpit. */
const TAIL_LINES = 40;

export interface AgentStableRecord {
  key: string;
  title: string;
  schedule: string;
  model: string;
  managed: boolean;
  enabled: boolean;
  enabled_actual: boolean | null;
  last_run_at: string | null;
  last_rc: number | null;
  outcome: string | null;
  next_run_at: string | null;
  last_duration_s: number | null;
  drift: string[];
  healthy: boolean;
  allowed_tools?: string[];
  workdir?: string;
  prompt_file?: string;
  post_step?: string | null;
  digest_file?: string | null;
  outputs_dir?: string | null;
  entry_script?: string | null;
  timeout_seconds?: number;
  ntfy_on_failure?: boolean;
}

export interface AgentTail {
  /** Where the text came from, so the UI can label the expander honestly. */
  source: 'digest' | 'log' | null;
  path: string | null;
  /** True when the file the record points at does not exist yet (never run). */
  missing: boolean;
  lines: string[];
  mtime: string | null;
}

export interface AgentStableAgent extends AgentStableRecord {
  digest: AgentTail;
  log: AgentTail;
  /** Transient run-now unit name, when one is currently active for this key. */
  running_unit: string | null;
}

export interface AgentStablePayload {
  ok: boolean;
  /** Set when the CLI itself could not be reached — the page says so instead of lying. */
  error: string | null;
  root: string;
  agents: AgentStableAgent[];
  counts: { total: number; enabled: number; unhealthy: number; managed: number };
}

export interface CliResult {
  ok: boolean;
  rc: number;
  /** stdout ONLY, never mixed with stderr — `status` exits 1 when something is
   *  unhealthy while still printing perfectly valid JSON on stdout, so mixing
   *  the two makes every unhealthy stable look like a parse failure. */
  stdout: string;
  /** stdout + stderr + message, for humans. */
  output: string;
}

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(ESC + '\\[[0-9;]*m', 'g');

/** Run the agent-stable CLI. Never throws — a broken CLI must not 500 the page. */
export function runStableCli(args: string[], timeoutMs = 30_000): CliResult {
  const clean = (v: string | undefined) => (v ?? '').replace(ANSI_RE, '').trim();
  if (!existsSync(CLI)) {
    return { ok: false, rc: -1, stdout: '', output: `${CLI} is not installed` };
  }
  try {
    const out = clean(execFileSync(CLI, args, { encoding: 'utf8', timeout: timeoutMs }));
    return { ok: true, rc: 0, stdout: out, output: out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    // `status` exits 1 for an UNHEALTHY stable — a report, not a crash — so its
    // stdout is preserved verbatim for the caller to parse.
    return {
      ok: false,
      rc: typeof e.status === 'number' ? e.status : -1,
      stdout: clean(e.stdout),
      output: clean(`${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`),
    };
  }
}

/** Read the last TAIL_LINES lines of a file without loading the whole thing. */
function tailFile(path: string | null | undefined, source: 'digest' | 'log'): AgentTail {
  if (!path) return { source: null, path: null, missing: true, lines: [], mtime: null };
  let size = 0, mtime: string | null = null;
  try {
    const st = statSync(path);
    size = st.size;
    mtime = new Date(st.mtimeMs).toISOString();
  } catch {
    return { source, path, missing: true, lines: [], mtime: null };
  }
  // Positional read of the LAST TAIL_BYTES only. A claude --output-format json
  // log is one enormous line; reading the whole file to slice it would pull
  // megabytes into the event loop on every page load.
  let fd: number | null = null;
  try {
    const want = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(want);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, want, Math.max(0, size - want));
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    // A partial first line from mid-character/mid-line slicing is dropped.
    if (size > want && lines.length > 1) lines.shift();
    return { source, path, missing: false, lines: lines.slice(-TAIL_LINES), mtime };
  } catch {
    return { source, path, missing: true, lines: [], mtime };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

/**
 * Newest run log for an agent. Logs live in <workdir>/logs/ per CONTRACT §2
 * (the adopted wrappers already wrote there, so the runner followed them) —
 * NOT in a central runs/<key>/ tree, which is why this globs rather than
 * computing a path from the ledger's `log` field alone.
 */
function newestLog(rec: AgentStableRecord): string | null {
  // The ledger's recorded path is authoritative when it still exists.
  const fromLedger = lastRunLog(rec.key);
  if (fromLedger && existsSync(fromLedger)) return fromLedger;
  const dir = rec.workdir ? join(rec.workdir, 'logs') : null;
  if (!dir || !existsSync(dir)) return null;
  try {
    const best = readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const p = join(dir, f);
        try { return { p, m: statSync(p).mtimeMs }; } catch { return null; }
      })
      .filter((x): x is { p: string; m: number } => x !== null)
      .sort((a, b) => b.m - a.m)[0];
    return best?.p ?? null;
  } catch {
    return null;
  }
}

/** The `log` path the runner recorded for the most recent run, if any. */
function lastRunLog(key: string): string | null {
  const p = join(STABLE_ROOT, 'state', key, 'last.json');
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { log?: string | null };
    return typeof parsed.log === 'string' && parsed.log ? parsed.log : null;
  } catch {
    return null;
  }
}

const RUN_UNIT_PREFIX = 'agent-stable-run-';

/** Transient run-now units currently active, keyed by agent. */
function activeRunUnits(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const raw = execFileSync(
      'systemctl',
      ['list-units', `${RUN_UNIT_PREFIX}*`, '--all', '--no-legend', '--no-pager', '--plain'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    for (const line of raw.split('\n')) {
      const unit = line.trim().split(/\s+/)[0] ?? '';
      if (!unit.startsWith(RUN_UNIT_PREFIX) || !unit.endsWith('.service')) continue;
      if (!/\b(activating|active|running|start)\b/.test(line)) continue;
      // agent-stable-run-<key>-<ts>.service
      const body = unit.slice(RUN_UNIT_PREFIX.length).replace(/\.service$/, '');
      const key = body.replace(/-\d{8}-\d{6}$/, '');
      if (key) out.set(key, unit);
    }
  } catch { /* systemd unreachable — the page just won't show a live badge */ }
  return out;
}

/** The whole stable, in one read. Never throws. */
export function agentStablePayload(): AgentStablePayload {
  const res = runStableCli(['status', '--json']);
  // rc 1 means "something is unhealthy" and still carries JSON (see runStableCli).
  let records: AgentStableRecord[] = [];
  let error: string | null = null;
  try {
    const parsed = JSON.parse(res.stdout) as { agents?: AgentStableRecord[] };
    records = Array.isArray(parsed.agents) ? parsed.agents : [];
  } catch {
    error = res.output || 'agent-stable status --json returned no parseable JSON';
  }
  const running = activeRunUnits();
  const agents: AgentStableAgent[] = records.map((rec) => ({
    ...rec,
    digest: tailFile(rec.digest_file, 'digest'),
    log: tailFile(newestLog(rec), 'log'),
    running_unit: running.get(rec.key) ?? null,
  }));
  return {
    ok: error === null,
    error,
    root: STABLE_ROOT,
    agents,
    counts: {
      total: agents.length,
      enabled: agents.filter((a) => a.enabled).length,
      unhealthy: agents.filter((a) => !a.healthy).length,
      managed: agents.filter((a) => a.managed).length,
    },
  };
}

export interface RunNowResult {
  ok: boolean;
  unit: string | null;
  detail: string;
}

/**
 * Fire a run NOW as a transient systemd unit.
 *
 * systemd-run (not a bare spawn) on purpose: the run outlives this HTTP request
 * and this process, lands in the journal, and gets the same User/Group/HOME the
 * real timers use. ExecStart is the SHARED runner, so the flock still means only
 * one run of an agent at a time — a run-now that collides with a timer run is
 * recorded as outcome `skipped`/already_running rather than doubling up.
 *
 * No WorkingDirectory property on purpose: run-agent passes cwd=workdir to the
 * model call itself, so the unit starting in / is correct, not a bug.
 */
export function runAgentNow(key: string): RunNowResult {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) {
    return { ok: false, unit: null, detail: `invalid agent key: ${key}` };
  }
  if (!existsSync(join(STABLE_ROOT, 'agents', `${key}.json`))) {
    return { ok: false, unit: null, detail: `no such agent in the registry: ${key}` };
  }
  if (!existsSync(RUNNER)) {
    return { ok: false, unit: null, detail: `${RUNNER} is missing — the shared runner is not installed` };
  }
  const compact = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS (UTC)
  const ts = `${compact.slice(0, 8)}-${compact.slice(8)}`;
  const unit = `${RUN_UNIT_PREFIX}${key}-${ts}`;
  const args = [
    '-n', 'systemd-run',
    `--unit=${unit}`,
    '--collect',
    '--description=agent-stable run-now: ' + key,
    '-p', 'User=kevin',
    '-p', 'Group=kevin',
    '-p', 'Environment=HOME=/home/kevin',
    // NOT Type=oneshot: that makes systemd-run block until the agent finishes,
    // which would hold this HTTP request open for the agent's full runtime.
    // The default (simple) returns as soon as the unit is started. And the cap
    // is RuntimeMaxSec, not TimeoutStartSec=0 — `0` means zero seconds in
    // systemd, which kills the run instantly (`infinity` is the no-limit word).
    // The runner has its own `timeout <timeout_seconds>` around the model call;
    // this is only a backstop against a wedged wrapper.
    '-p', 'RuntimeMaxSec=3600',
    RUNNER, key, '--trigger', 'api',
  ];
  try {
    const out = execFileSync('sudo', args, { encoding: 'utf8', timeout: 20_000 });
    return { ok: true, unit: `${unit}.service`, detail: out.trim() || `started ${unit}.service` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, unit: null, detail: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`.trim() };
  }
}

/**
 * Flip enabled in the registry AND the timer, via the CLI so there is one
 * implementation. The CLI's exit code is systemctl's, which is non-zero for an
 * agent whose timer unit is not installed (every `managed:false` agent adopted
 * without units) — that is reported, not treated as "nothing happened", because
 * the registry flag DID change.
 */
export function setAgentEnabled(key: string, on: boolean): CliResult & { registry_written: boolean } {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) {
    return { ok: false, rc: -1, stdout: '', output: `invalid agent key: ${key}`, registry_written: false };
  }
  const res = runStableCli([on ? 'enable' : 'disable', key], 30_000);
  return { ...res, registry_written: /registry enabled=/.test(res.output) };
}

/**
 * Tail one agent's log or digest on demand (deeper than the roll-up carries).
 *
 * `status <key> --json` returns a BARE record, not the `{agents:[...]}` wrapper
 * the no-key form returns — both shapes are accepted so this does not silently
 * return an empty tail.
 */
export function agentTail(key: string, which: 'log' | 'digest', lines: number): AgentTail {
  const res = runStableCli(['status', key, '--json']);
  let rec: AgentStableRecord | undefined;
  try {
    const parsed = JSON.parse(res.stdout) as AgentStableRecord & { agents?: AgentStableRecord[] };
    rec = Array.isArray(parsed.agents) ? parsed.agents.find((a) => a.key === key) : parsed;
    if (rec && rec.key !== key) rec = undefined;
  } catch { /* fall through to the not-found below */ }
  if (!rec) return { source: null, path: null, missing: true, lines: [], mtime: null };
  const tail = which === 'digest' ? tailFile(rec.digest_file, 'digest') : tailFile(newestLog(rec), 'log');
  const n = Math.max(1, Math.min(500, lines));
  return { ...tail, lines: tail.lines.slice(-n) };
}
