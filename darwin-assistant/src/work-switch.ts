/**
 * WORK SWITCH — the stop-all / per-lane kill switch for autonomous work.
 *
 * WHY THIS EXISTS (Kevin, 2026-09-25): a stuck review node re-dispatched itself
 * over and over and he had to keep killing it by hand, with no single way to
 * stop everything. He asked for a real stop — "stopping it all and disabling
 * the services that would restart them" — NOT a dial dance (slots to 0, ceilings
 * to 1, overrides off). So this switch mutates NOTHING else: it is one flag file
 * plus per-lane gates. Flip it off and every dial is exactly where he left it.
 *
 * DESIGN RULES (deliberate, don't loosen):
 *  1. NO database dependency. The switch must be readable and writable when
 *     jarvis.service is crash-looping or jarvis.db is locked — those are exactly
 *     the moments Kevin needs it. Pure fs, no imports from conversation-db.
 *  2. PERSISTENT across reboot (/var/lib/jarvis, not /tmp). The 2026-09-25 crash
 *     loop survived a full reboot; a stop that evaporates at boot is not a stop.
 *  3. TWO enforcement layers per lane so neither alone is a single point of
 *     failure: in-process lanes are checked at the top of their dispatch tick;
 *     timer lanes are gated by `ExecCondition=` on the systemd unit (the service
 *     skips cleanly, and flipping the lane needs no sudo).
 *  4. Corrupt file = treat as ALL STOPPED (fail safe). A missing file = defaults
 *     (running), because a never-written switch must not silently halt the shop.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const WORK_SWITCH_PATH = process.env['JARVIS_WORK_SWITCH_PATH'] ?? '/var/lib/jarvis/work-switch.json';

export type LaneKind = 'process' | 'timer';

export interface LaneDef {
  /** Stable id used in the file, the API, the CLI and the ExecCondition gate. */
  key: string;
  /** Kevin-facing label. */
  label: string;
  /** What turning this off actually stops. */
  what: string;
  kind: LaneKind;
  /** For timer lanes: the systemd unit the ExecCondition guards. */
  unit?: string;
}

/**
 * The lanes. Anything that can BIRTH autonomous work belongs here.
 * Deliberately NOT lanes: the usage pollers (claude/codex/augment), the cockpit
 * healthcheck and db retention — they are meters and housekeeping, they never
 * start a worker, and killing them just blinds us while we are trying to debug.
 */
export const LANES: LaneDef[] = [
  { key: 'hopper',    label: 'Hopper dispatch',   what: 'spawning new tree/goal workers',              kind: 'process' },
  { key: 'night',     label: 'Shifts / Night',    what: 'the shift driver cueing the orchestrator',    kind: 'process' },
  { key: 'autopilot', label: 'Goals autopilot',   what: 'per-goal autopilot drivers',                  kind: 'process' },
  { key: 'shepherd',  label: 'Check-ins',         what: 'scheduled check-ins + the shepherd sweep',    kind: 'process' },
  { key: 'watchdog',  label: 'Watchdog',          what: 'dead-turn resume + stalled-job recovery',     kind: 'timer', unit: 'jarvis-watchdog.service' },
  { key: 'spawn_reconcile', label: 'Spawn reconciler', what: 'reconciling/reviving spawned workers',   kind: 'timer', unit: 'jarvis-spawn-reconcile.service' },
  { key: 'intel',     label: 'Intel Desk',        what: 'the daily intel pull',                        kind: 'timer', unit: 'intel-pull.service' },
  { key: 'bi',        label: 'BI sweep',          what: 'the overnight BI sweep',                      kind: 'timer', unit: 'bi-overnight-sweep.service' },
  { key: 'suppression', label: 'Suppression monitor', what: 'the suppression adherence checks',        kind: 'timer', unit: 'suppression-monitor.service' },
  { key: 'kpi',       label: 'Darwin KPI run',    what: 'the scheduled KPI run',                       kind: 'timer', unit: 'darwin-kpi-run.service' },
];

export const LANE_KEYS = LANES.map((l) => l.key);
export function laneDef(key: string): LaneDef | null { return LANES.find((l) => l.key === key) ?? null; }

export interface SwitchEvent {
  at: string;
  by: string;
  op: 'stop_all' | 'resume_all' | 'lane_off' | 'lane_on';
  lane?: string;
  reason?: string;
}

export interface WorkSwitchState {
  version: 1;
  all_stopped: boolean;
  all_stopped_at: string | null;
  all_stopped_by: string | null;
  all_stopped_reason: string | null;
  /** lane key -> enabled. true/missing = enabled. */
  lanes: Record<string, boolean>;
  events: SwitchEvent[];
  /** Set when the file could not be parsed — we then fail SAFE (all stopped). */
  corrupt?: boolean;
}

function defaults(): WorkSwitchState {
  const lanes: Record<string, boolean> = {};
  for (const l of LANES) lanes[l.key] = true;
  return {
    version: 1,
    all_stopped: false,
    all_stopped_at: null,
    all_stopped_by: null,
    all_stopped_reason: null,
    lanes,
    events: [],
  };
}

/** Everything stopped, because we could not trust what we read. */
function failSafe(): WorkSwitchState {
  const s = defaults();
  s.all_stopped = true;
  s.all_stopped_reason = 'work-switch.json is unreadable/corrupt — failing safe (all work stopped)';
  s.corrupt = true;
  return s;
}

export function readWorkSwitch(): WorkSwitchState {
  if (!existsSync(WORK_SWITCH_PATH)) return defaults();
  let raw: string;
  try {
    raw = readFileSync(WORK_SWITCH_PATH, 'utf8');
  } catch {
    return failSafe();
  }
  if (!raw.trim()) return failSafe();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failSafe();
  }
  if (!parsed || typeof parsed !== 'object') return failSafe();
  const p = parsed as Partial<WorkSwitchState>;
  const state = defaults();
  state.all_stopped = p.all_stopped === true;
  state.all_stopped_at = typeof p.all_stopped_at === 'string' ? p.all_stopped_at : null;
  state.all_stopped_by = typeof p.all_stopped_by === 'string' ? p.all_stopped_by : null;
  state.all_stopped_reason = typeof p.all_stopped_reason === 'string' ? p.all_stopped_reason : null;
  if (p.lanes && typeof p.lanes === 'object') {
    // Unknown keys are ignored; known keys default to enabled unless explicitly false.
    for (const l of LANES) {
      const v = (p.lanes as Record<string, unknown>)[l.key];
      state.lanes[l.key] = v === false ? false : true;
    }
  }
  state.events = Array.isArray(p.events)
    ? (p.events.filter((e) => e && typeof e === 'object') as SwitchEvent[]).slice(-50)
    : [];
  return state;
}

function write(state: WorkSwitchState): void {
  mkdirSync(dirname(WORK_SWITCH_PATH), { recursive: true });
  const body = JSON.stringify({ ...state, corrupt: undefined }, null, 2) + '\n';
  // Atomic: a half-written switch would read as corrupt and fail-safe the shop.
  const tmp = `${WORK_SWITCH_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, WORK_SWITCH_PATH);
  cache = { at: Date.now(), state };
}

function record(state: WorkSwitchState, ev: SwitchEvent): void {
  state.events = [...state.events, ev].slice(-50);
}

// --- read path (hot: called from every dispatch tick) ------------------------
// A tiny file, but dispatchTick can fire on every worker finish, so memoize
// briefly. 1s is far tighter than any tick interval, so a flip still lands
// within one tick of Kevin pressing the button.
let cache: { at: number; state: WorkSwitchState } | null = null;
const CACHE_MS = 1000;

export function workSwitch(): WorkSwitchState {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.state;
  const state = readWorkSwitch();
  cache = { at: now, state };
  return state;
}

/** Drop the memo — used by writers in other processes' tests and by the CLI. */
export function invalidateWorkSwitchCache(): void { cache = null; }

/**
 * THE GUARD. `true` means: do not start new work on this lane.
 * Call this at the TOP of a dispatch tick, before any side effect.
 */
export function laneStopped(lane: string): boolean {
  const s = workSwitch();
  if (s.all_stopped) return true;
  return s.lanes[lane] === false;
}

/** Inverse, for readability at call sites. */
export function laneRunning(lane: string): boolean { return !laneStopped(lane); }

/** One-line reason a lane is held, or null when it is running. */
export function laneHoldReason(lane: string): string | null {
  const s = workSwitch();
  if (s.all_stopped) {
    const why = s.all_stopped_reason ? `: ${s.all_stopped_reason}` : '';
    return `ALL WORK STOPPED${why}`;
  }
  if (s.lanes[lane] === false) return `lane "${lane}" is switched off`;
  return null;
}

// --- write path --------------------------------------------------------------

export function stopAll(by: string, reason?: string): WorkSwitchState {
  const s = readWorkSwitch();
  s.all_stopped = true;
  s.all_stopped_at = new Date().toISOString();
  s.all_stopped_by = by;
  s.all_stopped_reason = reason ?? null;
  s.corrupt = undefined;
  record(s, { at: s.all_stopped_at, by, op: 'stop_all', reason });
  write(s);
  return s;
}

export function resumeAll(by: string, reason?: string): WorkSwitchState {
  const s = readWorkSwitch();
  s.all_stopped = false;
  s.all_stopped_at = null;
  s.all_stopped_by = null;
  s.all_stopped_reason = null;
  s.corrupt = undefined;
  record(s, { at: new Date().toISOString(), by, op: 'resume_all', reason });
  write(s);
  return s;
}

export function setLane(lane: string, on: boolean, by: string, reason?: string): WorkSwitchState {
  if (!laneDef(lane)) throw new Error(`unknown lane "${lane}" (known: ${LANE_KEYS.join(', ')})`);
  const s = readWorkSwitch();
  s.lanes[lane] = on;
  s.corrupt = undefined;
  record(s, { at: new Date().toISOString(), by, op: on ? 'lane_on' : 'lane_off', lane, reason });
  write(s);
  return s;
}

/** Turn every lane back on AND clear all_stopped — the full "green light". */
export function resetAllLanes(by: string, reason?: string): WorkSwitchState {
  const s = readWorkSwitch();
  for (const l of LANES) s.lanes[l.key] = true;
  s.all_stopped = false;
  s.all_stopped_at = null;
  s.all_stopped_by = null;
  s.all_stopped_reason = null;
  s.corrupt = undefined;
  record(s, { at: new Date().toISOString(), by, op: 'resume_all', reason: reason ?? 'all lanes reset on' });
  write(s);
  return s;
}

/** Shape for the API/UI: state + per-lane derived status. */
export interface LaneView extends LaneDef { enabled: boolean; stopped: boolean; hold_reason: string | null }

export function workSwitchView(): { state: WorkSwitchState; lanes: LaneView[]; any_stopped: boolean } {
  const state = readWorkSwitch();
  const lanes: LaneView[] = LANES.map((l) => {
    const enabled = state.lanes[l.key] !== false;
    const stopped = state.all_stopped || !enabled;
    let hold: string | null = null;
    if (state.all_stopped) hold = 'ALL WORK STOPPED';
    else if (!enabled) hold = 'lane switched off';
    return { ...l, enabled, stopped, hold_reason: hold };
  });
  return { state, lanes, any_stopped: state.all_stopped || lanes.some((l) => l.stopped) };
}
