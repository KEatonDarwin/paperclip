/**
 * System timers — read-only visibility into EVERY systemd timer on the box
 * (tree-0dbc1aa9 node #1679). The /agents page only knew the agent-stable
 * agents; the other ~37 timers were invisible anywhere in the cockpit.
 *
 * MODEL-FREE by construction: it is `systemctl` / `systemd-analyze` parsing plus
 * one directory read of the agent-stable registry. Nothing here ever builds a
 * model call, writes a file, or changes a unit.
 *
 * QUIET BY DEFAULT: every timer carries ONE `abnormal` boolean (plus the
 * `reasons` that set it); the UI leads with that and stays silent when no
 * timer is abnormal. The three reasons, per the spec:
 *   - failed:    the service's last run did not succeed
 *   - never_fired: enabled but never fired AND it should have by now
 *   - overdue:   last fired more than 2x its own interval ago
 *
 * Three sources of truth, each used for what it is exact at:
 *   - `systemctl list-timers --output=json`  -> next / last as epoch microseconds
 *     (`systemctl show` prints those two in LOCAL time with a zone abbreviation,
 *     which --timestamp=utc does not fix for the *USec properties)
 *   - `systemctl show <timers>`              -> state, Description, schedule specs
 *   - `systemctl show <services>`            -> Result / ExecMainStatus of the last run
 *   - `systemd-analyze calendar`             -> the real gap between elapses of an
 *     OnCalendar spec, so "its own interval" is systemd's answer, not a regex's
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const STABLE_ROOT = process.env.AGENT_STABLE_ROOT || '/home/kevin/agent-stable';

/** A run later than this many intervals after the last fire is "overdue". */
export const OVERDUE_FACTOR = 2;
/** Slack added on top, so a 30s timer isn't abnormal for being 61s late. */
export const OVERDUE_SLACK_MS = 120_000;
/** Elapses sampled per calendar spec; 8 covers a full week of a Mon..Fri spec. */
const ANALYZE_ITERATIONS = 8;

const TIMER_PROPS = [
  'Id', 'Description', 'Unit', 'ActiveState', 'SubState', 'UnitFileState',
  'ActiveEnterTimestamp', 'LastTriggerUSec', 'NextElapseUSecRealtime',
  'NextElapseUSecMonotonic', 'TimersCalendar', 'TimersMonotonic', 'Persistent',
].join(',');
const SERVICE_PROPS = [
  'Id', 'ActiveState', 'SubState', 'Result', 'ExecMainStatus',
  'ExecMainStartTimestamp', 'ExecMainExitTimestamp',
].join(',');

export type TimerReason = 'failed' | 'never_fired' | 'overdue';

export interface SystemTimer {
  /** e.g. `hub-error-triage.timer` */
  unit: string;
  /** The service it activates. */
  service: string;
  description: string;
  /** UnitFileState is on (enabled / transient / static ...), i.e. expected to run. */
  enabled: boolean;
  /** Active and has a scheduled next run, or its service is running right now. */
  armed: boolean;
  /** Timer ActiveState/SubState, e.g. `active/waiting`. */
  state: string;
  last_trigger_at: string | null;
  next_run_at: string | null;
  /** Did the service's last run succeed. null = the service has never run. */
  last_run_ok: boolean | null;
  /** systemd Result of the last run, e.g. `success` / `exit-code`. */
  last_result: string | null;
  last_exit_status: number | null;
  service_running: boolean;
  /** The timer's own cadence in ms (null = one-shot or unknown). */
  interval_ms: number | null;
  /** The schedule as systemd reports it (OnCalendar=... / OnUnitActiveSec=...). */
  schedule: string[];
  overdue: boolean;
  /** Minutes/hours late against its own schedule, ms. null when not overdue. */
  overdue_by_ms: number | null;
  /** True when an agent-stable registry entry owns this timer (shown on /agents). */
  agent_stable: boolean;
  agent_key: string | null;
  /** THE boolean the UI leads with. */
  abnormal: boolean;
  reasons: TimerReason[];
}

export interface SystemTimersPayload {
  ok: boolean;
  error: string | null;
  generated_at: string;
  counts: { total: number; abnormal: number; enabled: number; armed: number; agent_stable: number };
  /** Abnormal first (worst first), then by unit name. */
  timers: SystemTimer[];
}

// ── parsers (pure — these are what the fixtures exercise) ───────────────────

/** `systemctl show a b c` -> one property map per unit (blank-line separated). */
export function parseShowBlocks(text: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const block of text.split(/\n\s*\n/)) {
    const props: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const val = line.slice(eq + 1);
      // systemd prints ONE line per spec, so TimersMonotonic/TimersCalendar can
      // repeat (14 timers on this box print both OnUnitActiveUSec and OnBootUSec).
      // Last-wins would discard the real cadence and kill the overdue rule, so
      // accumulate: parseTimersMonotonic/parseTimersCalendar use matchAll and
      // read a newline-joined value unchanged.
      props[key] = key in props ? `${props[key]}\n${val}` : val;
    }
    if (props.Id) out.push(props);
  }
  return out;
}

export interface ListTimerEntry {
  unit: string;
  activates: string;
  /** epoch ms; null = no next run scheduled */
  nextMs: number | null;
  /** epoch ms; null = never fired */
  lastMs: number | null;
}

/** `systemctl list-timers --all --output=json` (epoch microseconds). */
export function parseListTimersJson(text: string): ListTimerEntry[] {
  const raw = JSON.parse(text) as Array<{ unit?: string; activates?: string; next?: number | null; last?: number | null }>;
  if (!Array.isArray(raw)) throw new Error('list-timers json was not an array');
  const ms = (us: number | null | undefined): number | null =>
    typeof us === 'number' && Number.isFinite(us) && us > 0 ? Math.floor(us / 1000) : null;
  return raw
    .filter((r) => typeof r.unit === 'string')
    .map((r) => ({
      unit: r.unit as string,
      activates: r.activates ?? (r.unit as string).replace(/\.timer$/, '.service'),
      nextMs: ms(r.next),
      lastMs: ms(r.last),
    }));
}

const DURATION_UNITS: Array<[RegExp, number]> = [
  [/^(?:us|usec)$/, 0.001],
  [/^(?:ms|msec)$/, 1],
  [/^(?:s|sec|second|seconds)$/, 1000],
  [/^(?:m|min|minute|minutes)$/, 60_000],
  [/^(?:h|hr|hour|hours)$/, 3_600_000],
  [/^(?:d|day|days)$/, 86_400_000],
  [/^(?:w|week|weeks)$/, 604_800_000],
  [/^(?:month|months)$/, 2_629_800_000],
  [/^(?:y|year|years)$/, 31_557_600_000],
];

/** systemd timespan as printed by `show` (`1h 30min`, `4w 2d`, `6.218301s`). */
export function parseTimespanMs(text: string): number | null {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  let total = 0;
  for (const part of parts) {
    const m = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(part);
    if (!m) return null;
    const unit = DURATION_UNITS.find(([re]) => re.test(m[2]!));
    if (!unit) return null;
    total += Number(m[1]) * unit[1];
  }
  return Math.round(total);
}

/** `TimersMonotonic={ OnUnitActiveUSec=5min ; next_elapse=... }` -> [[name, ms]]. */
export function parseTimersMonotonic(value: string | undefined): Array<{ name: string; ms: number | null; raw: string }> {
  const out: Array<{ name: string; ms: number | null; raw: string }> = [];
  for (const m of (value ?? '').matchAll(/\b(On[A-Za-z]+USec)=([^;}]*?)\s*(?:;|\})/g)) {
    const raw = m[2]!.trim();
    out.push({ name: m[1]!.replace(/USec$/, 'Sec'), ms: parseTimespanMs(raw), raw });
  }
  return out;
}

/** `TimersCalendar={ OnCalendar=*-*-* *:00/15:00 ; next_elapse=... }` -> specs. */
export function parseTimersCalendar(value: string | undefined): string[] {
  const out: string[] = [];
  for (const m of (value ?? '').matchAll(/OnCalendar=(.*?)\s*;\s*next_elapse=/g)) out.push(m[1]!.trim());
  return out;
}

/**
 * `systemd-analyze calendar --iterations=N spec...` -> longest gap between two
 * consecutive elapses, per spec, in input order. A spec systemd rejected (or a
 * block count that doesn't line up) yields null for that slot rather than a
 * guess.
 */
export function parseAnalyzeCalendarGaps(text: string, specCount: number): Array<number | null> {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length !== specCount) return Array.from({ length: specCount }, () => null);
  return blocks.map((block) => {
    const elapses: number[] = [];
    for (const line of block.split('\n')) {
      // Lines that carry a UTC instant: "(in UTC): Sun 2026-10-18 12:00:00 UTC", or
      // "Next elapse: ... UTC" when the host zone is UTC (no separate (in UTC) line).
      const m = /(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) UTC\s*$/.exec(line);
      if (m) elapses.push(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
    }
    if (elapses.length < 2) return null;
    let max = 0;
    for (let i = 1; i < elapses.length; i++) max = Math.max(max, elapses[i]! - elapses[i - 1]!);
    return max > 0 ? max : null;
  });
}

// ── classification (pure) ───────────────────────────────────────────────────

const ENABLED_FILE_STATES = new Set(['enabled', 'enabled-runtime', 'transient', 'static', 'generated', 'alias']);

export interface ClassifyInput {
  timer: Record<string, string>;
  service: Record<string, string> | undefined;
  list: ListTimerEntry | undefined;
  /** Gap per OnCalendar spec, keyed by spec text. */
  calendarGapMs: ReadonlyMap<string, number | null>;
  agentKeys: ReadonlySet<string>;
  now: number;
}

/** Cadence = the shortest repeating schedule the timer has (null = one-shot). */
function intervalOf(timer: Record<string, string>, calendarGapMs: ReadonlyMap<string, number | null>): number | null {
  const gaps: number[] = [];
  for (const spec of parseTimersCalendar(timer.TimersCalendar)) {
    const g = calendarGapMs.get(spec);
    if (typeof g === 'number') gaps.push(g);
  }
  for (const m of parseTimersMonotonic(timer.TimersMonotonic)) {
    // Only the "again after the last run" forms repeat; OnBoot/OnActive/OnStartup fire once.
    if ((m.name === 'OnUnitActiveSec' || m.name === 'OnUnitInactiveSec') && m.ms) gaps.push(m.ms);
  }
  return gaps.length ? Math.min(...gaps) : null;
}

export function classifyTimer(input: ClassifyInput): SystemTimer {
  const { timer, service, list, now } = input;
  const unit = timer.Id!;
  const serviceName = timer.Unit || list?.activates || unit.replace(/\.timer$/, '.service');
  const enabled = ENABLED_FILE_STATES.has(timer.UnitFileState ?? '');
  const timerActive = timer.ActiveState === 'active';
  const serviceRunning = service?.ActiveState === 'active' || service?.ActiveState === 'activating';
  const nextMs = list?.nextMs ?? null;
  const lastMs = list?.lastMs ?? null;
  const armed = timerActive && (nextMs !== null || serviceRunning);

  const result = service?.Result ?? null;
  const exitRaw = service?.ExecMainStatus;
  const exitStatus = exitRaw !== undefined && exitRaw !== '' && Number.isFinite(Number(exitRaw)) ? Number(exitRaw) : null;
  const ranBefore = Boolean(service?.ExecMainStartTimestamp) || lastMs !== null;
  // A run that is still going has no verdict yet; judge on the previous Result,
  // which systemd keeps until the new run ends.
  const lastRunOk: boolean | null = !service || !ranBefore
    ? null
    : result === 'success' && (exitStatus === null || exitStatus === 0) && service.ActiveState !== 'failed';

  const intervalMs = intervalOf(timer, input.calendarGapMs);
  const reasons: TimerReason[] = [];

  if (enabled && lastRunOk === false) reasons.push('failed');

  if (enabled && lastMs === null && !serviceRunning) {
    // Never fired. That's only wrong if it should have: not armed at all, or
    // armed with a next run that has already slipped past (a fresh yearly timer
    // legitimately waiting for its first fire is NOT abnormal).
    const shouldHaveFired = !armed || (nextMs !== null && now > nextMs + OVERDUE_SLACK_MS);
    if (shouldHaveFired) reasons.push('never_fired');
  }

  let overdueBy: number | null = null;
  if (enabled && lastMs !== null && intervalMs !== null && !serviceRunning) {
    const allowed = intervalMs * OVERDUE_FACTOR + OVERDUE_SLACK_MS;
    const age = now - lastMs;
    if (age > allowed) {
      overdueBy = age - intervalMs;
      reasons.push('overdue');
    }
  }

  const key = unit.replace(/\.timer$/, '');
  const agentStable = input.agentKeys.has(key);
  const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
  return {
    unit,
    service: serviceName,
    description: timer.Description ?? '',
    enabled,
    armed,
    state: `${timer.ActiveState ?? '?'}/${timer.SubState ?? '?'}`,
    last_trigger_at: iso(lastMs),
    next_run_at: iso(nextMs),
    last_run_ok: lastRunOk,
    last_result: result,
    last_exit_status: exitStatus,
    service_running: serviceRunning,
    interval_ms: intervalMs,
    schedule: [
      ...parseTimersCalendar(timer.TimersCalendar).map((s) => `OnCalendar=${s}`),
      ...parseTimersMonotonic(timer.TimersMonotonic).map((m) => `${m.name}=${m.raw}`),
    ],
    overdue: overdueBy !== null,
    overdue_by_ms: overdueBy,
    agent_stable: agentStable,
    agent_key: agentStable ? key : null,
    abnormal: reasons.length > 0,
    reasons,
  };
}

/** Abnormal first (more reasons, then more overdue, first), then by unit. */
export function sortTimers(timers: SystemTimer[]): SystemTimer[] {
  return [...timers].sort((a, b) =>
    Number(b.abnormal) - Number(a.abnormal)
    || b.reasons.length - a.reasons.length
    || (b.overdue_by_ms ?? 0) - (a.overdue_by_ms ?? 0)
    || a.unit.localeCompare(b.unit));
}

/** Pure assembly from the four captured outputs — the testable core. */
export function buildSystemTimers(args: {
  listTimersJson: string;
  timersShow: string;
  servicesShow: string;
  /** spec -> gap (ms). Built from parseAnalyzeCalendarGaps. */
  calendarGapMs: ReadonlyMap<string, number | null>;
  agentKeys: ReadonlySet<string>;
  now: number;
}): SystemTimer[] {
  const lists = new Map(parseListTimersJson(args.listTimersJson).map((l) => [l.unit, l]));
  const services = new Map(parseShowBlocks(args.servicesShow).map((s) => [s.Id!, s]));
  const rows = parseShowBlocks(args.timersShow).map((timer) =>
    classifyTimer({
      timer,
      service: services.get(timer.Unit ?? ''),
      list: lists.get(timer.Id!),
      calendarGapMs: args.calendarGapMs,
      agentKeys: args.agentKeys,
      now: args.now,
    }));
  return sortTimers(rows);
}

// ── live collection (the only impure part) ──────────────────────────────────

export type RunCmd = (cmd: string, args: string[]) => string;

const defaultRun: RunCmd = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });

/** Calendar specs don't change under a running process; analyze each once. */
const gapCache = new Map<string, number | null>();

/** keys of /home/kevin/agent-stable/agents/*.json (a plain directory read). */
export function readAgentStableKeys(root = STABLE_ROOT): Set<string> {
  const dir = join(root, 'agents');
  const keys = new Set<string>();
  if (!existsSync(dir)) return keys;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { key?: string };
      keys.add(typeof rec.key === 'string' && rec.key ? rec.key : f.replace(/\.json$/, ''));
    } catch { /* an unreadable registry file just isn't tagged */ }
  }
  return keys;
}

/** Every systemd timer on the box. Never throws — failure comes back in `error`. */
export function systemTimersPayload(opts: { run?: RunCmd; now?: number; agentKeys?: Set<string> } = {}): SystemTimersPayload {
  const run = opts.run ?? defaultRun;
  const now = opts.now ?? Date.now();
  const empty = (error: string): SystemTimersPayload => ({
    ok: false,
    error,
    generated_at: new Date(now).toISOString(),
    counts: { total: 0, abnormal: 0, enabled: 0, armed: 0, agent_stable: 0 },
    timers: [],
  });
  try {
    const listTimersJson = run('systemctl', ['list-timers', '--all', '--no-pager', '--output=json']);
    const units = parseListTimersJson(listTimersJson).map((l) => l.unit);
    if (units.length === 0) return empty('systemctl list-timers returned no timers');
    const timersShow = run('systemctl', ['show', '--timestamp=utc', '-p', TIMER_PROPS, ...units]);
    const serviceNames = [...new Set(parseShowBlocks(timersShow).map((t) => t.Unit).filter((u): u is string => Boolean(u)))];
    const servicesShow = serviceNames.length
      ? run('systemctl', ['show', '--timestamp=utc', '-p', SERVICE_PROPS, ...serviceNames])
      : '';

    const specs = new Set<string>();
    for (const t of parseShowBlocks(timersShow)) for (const s of parseTimersCalendar(t.TimersCalendar)) specs.add(s);
    const fresh = [...specs].filter((s) => !gapCache.has(s));
    if (fresh.length) {
      let gaps: Array<number | null>;
      try {
        gaps = parseAnalyzeCalendarGaps(
          run('systemd-analyze', ['calendar', `--iterations=${ANALYZE_ITERATIONS}`, ...fresh]), fresh.length);
      } catch {
        gaps = fresh.map(() => null); // interval unknown -> overdue simply isn't judged for these
      }
      fresh.forEach((s, i) => gapCache.set(s, gaps[i] ?? null));
    }

    const timers = buildSystemTimers({
      listTimersJson,
      timersShow,
      servicesShow,
      calendarGapMs: gapCache,
      agentKeys: opts.agentKeys ?? readAgentStableKeys(),
      now,
    });
    return {
      ok: true,
      error: null,
      generated_at: new Date(now).toISOString(),
      counts: {
        total: timers.length,
        abnormal: timers.filter((t) => t.abnormal).length,
        enabled: timers.filter((t) => t.enabled).length,
        armed: timers.filter((t) => t.armed).length,
        agent_stable: timers.filter((t) => t.agent_stable).length,
      },
      timers,
    };
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
  }
}
