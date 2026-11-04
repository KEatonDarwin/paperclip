/**
 * WORK SWITCH — impure operations and the API payload.
 *
 * Kept OUT of src/work-switch.ts on purpose: that module is pure fs + zero deps
 * so it still works when jarvis.db is locked or the service is crash-looping.
 * Everything here may touch the DB, systemd or /proc, so it lives separately.
 *
 * Killing in-flight workers is delegated to the `jarvis-work` CLI so there is
 * exactly ONE implementation of the ancestry-aware "never kill the turn doing
 * the killing" logic.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { sqliteDb } from './conversation-db.js';
import { LANES, workSwitchView, type LaneView } from './work-switch.js';

const WORK_CLI = '/usr/local/bin/jarvis-work';
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(ESC + '\\[[0-9;]*m', 'g');
const NUL_RE = new RegExp(String.fromCharCode(0), 'g');

export interface WorkCliResult { ok: boolean; output: string }

/** Run the operator CLI. Never throws — a failed kill must not 500 the stop. */
export function runWorkCli(args: string[]): WorkCliResult {
  if (!existsSync(WORK_CLI)) return { ok: false, output: WORK_CLI + ' is not installed' };
  try {
    const out = execFileSync(WORK_CLI, args, { encoding: 'utf8', timeout: 60_000 });
    return { ok: true, output: out.replace(ANSI_RE, '').trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const blob = `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`;
    return { ok: false, output: blob.replace(ANSI_RE, '').trim() };
  }
}

const WORKER_BINS = new Set(['claude', 'codex', 'auggie', 'devin']);

/** Model-worker processes currently running inside the jarvis.service cgroup. */
export function inFlightWorkers(): { pid: number; cmd: string }[] {
  const out: { pid: number; cmd: string }[] = [];
  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return out; }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      if (!readFileSync(`/proc/${entry}/cgroup`, 'utf8').includes('jarvis.service')) continue;
      const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(NUL_RE, ' ').trim();
      if (!cmd) continue;
      const exe = (cmd.split(' ')[0] ?? '').split('/').pop() ?? '';
      if (WORKER_BINS.has(exe)) out.push({ pid: Number(entry), cmd: cmd.slice(0, 140) });
    } catch { /* process vanished mid-read — normal */ }
  }
  return out;
}

/** systemd state for the timer behind a timer-lane, for the UI's "next run" line. */
function timerState(unit: string): { active: string; next: string | null } {
  const timer = unit.replace(/\.service$/, '.timer');
  try {
    const raw = execFileSync('systemctl', ['show', timer, '-p', 'ActiveState', '-p', 'NextElapseUSecRealtime'], {
      encoding: 'utf8', timeout: 5_000,
    });
    const get = (k: string) => raw.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1).trim() ?? '';
    const next = get('NextElapseUSecRealtime');
    return { active: get('ActiveState') || 'unknown', next: next && next !== 'n/a' ? next : null };
  } catch {
    return { active: 'unknown', next: null };
  }
}

export interface WorkSwitchPayload {
  state: ReturnType<typeof workSwitchView>['state'];
  lanes: (LaneView & { timer?: { active: string; next: string | null } })[];
  any_stopped: boolean;
  in_flight: {
    workers: number;
    worker_procs: { pid: number; cmd: string }[];
    nodes_running: number;
    nodes_pending: number;
    retry_looping: number;
  };
}

/** Everything the cockpit panel and the persona tool need, in one read. */
export function workSwitchPayload(): WorkSwitchPayload {
  const view = workSwitchView();
  const lanes = view.lanes.map((l) => {
    const def = LANES.find((d) => d.key === l.key);
    return def?.unit ? { ...l, timer: timerState(def.unit) } : { ...l };
  });
  const workers = inFlightWorkers();
  let running = 0, pending = 0, looping = 0;
  try {
    const rows = sqliteDb
      .prepare("SELECT status, attempts FROM hopper_nodes WHERE status IN ('running','pending')")
      .all() as { status: string; attempts: number }[];
    for (const r of rows) {
      if (r.status === 'running') running++; else pending++;
      // attempts >= 3 is the signature of a node re-arming itself (node 861,
      // 2026-09-25) — surface the runaway instead of making Kevin infer it.
      if ((r.attempts ?? 0) >= 3) looping++;
    }
  } catch { /* db locked/absent — the switch still reports */ }
  return {
    state: view.state,
    lanes,
    any_stopped: view.any_stopped,
    in_flight: {
      workers: workers.length,
      worker_procs: workers.slice(0, 10),
      nodes_running: running,
      nodes_pending: pending,
      retry_looping: looping,
    },
  };
}
