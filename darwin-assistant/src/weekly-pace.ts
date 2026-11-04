// WEEKLY PACE LINE — the metering model for the Ultra plan (2026-11-01).
//
// On Ultra there is no 5-hour window at all (the usage payload carries
// `five_hour: null`). The only real budget is the 7-day window, and the danger
// flips from "burn the 5h bar" to "spend the whole week in two days". So each
// account gets a PACE LINE: where its weekly utilization SHOULD be right now if
// the week were spent evenly,
//
//     pace_line = elapsed fraction of THIS account's 7-day window × 100
//
// and automated work (hopper workers, night-shift items) is allowed only while
// the account is under pace_line + a context-dependent cushion:
//
//     overnight / nobody around ........ pace_line + night cushion   (default +10)
//     weekday 08:00–18:00 CT, or Kevin
//       active in the last idle window . pace_line − day reserve      (default −15)
//
// i.e. at night automation may run a little AHEAD of an even spend (nobody is
// competing for the account), and when Kevin is working it must sit 15 points
// BEHIND the line so the room he needs is already there. The existing hard
// weekly stop (gov_weekly_mode=hard + gov_weekly_ceiling, 90) stays as the
// absolute backstop — this module never loosens it.
//
// Kevin's own interactive turns are NEVER gated by the pace line (only the
// real 100%/lock). The pace line governs unattended dispatch and the A/B split.
//
// Zero imports from the rest of src except conversation-db (settings reads) —
// claude-accounts.ts, throttle.ts and hopper-governor.ts all import this, so it
// must stay a leaf.
//
// Dials (settings-KV, read fresh each call; defaults in parens):
//   gov_pace_mode          enforce | off          (enforce)  off = no pace gating
//   gov_pace_night_cushion 0..50 points           (10)
//   gov_pace_day_reserve   0..50 points           (15)
//   gov_pace_day_start/end hour CT, weekdays      (8 / 18)

import { getSetting } from './conversation-db.js';

export const WEEK_MS = 7 * 24 * 3_600_000;
export const PACE_TZ = 'America/Chicago';

function intSetting(key: string, fallback: number, lo: number, hi: number): number {
  const raw = getSetting(key)?.trim();
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
}

export function paceGateEnabled(): boolean {
  return (getSetting('gov_pace_mode')?.trim().toLowerCase() ?? 'enforce') !== 'off';
}
export function paceNightCushion(): number {
  return intSetting('gov_pace_night_cushion', 10, 0, 50);
}
export function paceDayReserve(): number {
  return intSetting('gov_pace_day_reserve', 15, 0, 50);
}

/** The even-spend line for one weekly window: 0..100, or null when the reset instant is unknown. */
export function paceLineFor(resetsAtIso: string | null, now: number = Date.now()): number | null {
  if (!resetsAtIso) return null;
  const reset = Date.parse(resetsAtIso);
  if (!Number.isFinite(reset)) return null;
  const start = reset - WEEK_MS;
  const frac = (now - start) / WEEK_MS;
  // A stale reset instant (poller lag a hair past the boundary) clamps rather
  // than going negative / past 100.
  return Math.min(100, Math.max(0, frac * 100));
}

/** Weekday 08:00–18:00 America/Chicago (the hours Kevin works). Env-free, DST-correct via Intl. */
export function isWeekdayDaytimeCT(now: number = Date.now()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACE_TZ,
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(now));
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hr = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '', 10);
  if (!Number.isFinite(hr)) return false;
  const start = intSetting('gov_pace_day_start', 8, 0, 23);
  const end = intSetting('gov_pace_day_end', 18, 1, 24);
  const weekday = wd !== 'Sat' && wd !== 'Sun';
  return weekday && hr % 24 >= start && hr % 24 < end;
}

// hopper-governor owns the "Kevin typed something recently" probe (a prepared
// statement over turns). It registers it here at load so this leaf module can
// ask without importing the governor (which imports us).
let kevinActiveProbe: (() => boolean) | null = null;
export function setKevinActiveProbe(fn: () => boolean): void {
  kevinActiveProbe = fn;
}

/**
 * True when the day RESERVE applies (Kevin is around), false for the night
 * cushion. `ignoreKevinActive` = night-shift claims, which never yield to
 * "Kevin just typed" (he drives the night by hand) — they still respect the clock.
 */
export function paceReserveMode(opts?: { ignoreKevinActive?: boolean; now?: number }): boolean {
  const now = opts?.now ?? Date.now();
  if (isWeekdayDaytimeCT(now)) return true;
  if (opts?.ignoreKevinActive) return false;
  try {
    return kevinActiveProbe ? kevinActiveProbe() : false;
  } catch {
    return false;
  }
}

/** The most weekly utilization automation may reach right now (clamped 0..100). */
export function paceAllowed(paceLine: number, reserve: boolean): number {
  const v = reserve ? paceLine - paceDayReserve() : paceLine + paceNightCushion();
  return Math.min(100, Math.max(0, v));
}

export interface PaceVerdict {
  /** true = the pace line permits automated work on this account right now. */
  ok: boolean;
  pace_line: number | null;
  allowed: number | null;
  /** Points under (+) / over (−) the even-spend line. Positive = behind pace = room to burn. */
  behind_pts: number | null;
  reserve: boolean;
}

/** Pure judgement used by every gate. Unknown weekly/reset ⇒ ok (never block on a blind reading — staleness already covers dead meters). */
export function paceVerdict(
  weekly: number | null,
  resetsAtIso: string | null,
  reserve: boolean,
  now: number = Date.now(),
): PaceVerdict {
  const line = paceLineFor(resetsAtIso, now);
  if (weekly == null || line == null) {
    return { ok: true, pace_line: line, allowed: null, behind_pts: null, reserve };
  }
  const allowed = paceAllowed(line, reserve);
  return { ok: weekly <= allowed, pace_line: line, allowed, behind_pts: line - weekly, reserve };
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** One plain-English clause for hold/status text. */
export function paceSentence(key: string, weekly: number | null, v: PaceVerdict): string {
  if (v.pace_line == null || weekly == null || v.allowed == null) return `${key.toUpperCase()}: pace unknown`;
  const ctx = v.reserve
    ? `${paceDayReserve()}-pt reserve for Kevin`
    : `+${paceNightCushion()}-pt overnight cushion`;
  return `${key.toUpperCase()} at ${r1(weekly)}% vs even-spend ${r1(v.pace_line)}% (limit ${r1(v.allowed)}% with ${ctx})`;
}
