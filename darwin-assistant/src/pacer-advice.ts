// ⚡ PACER ADVICE — a read-only view of the window-burn pacer's advice file
// (/home/kevin/window-burn/pacer.json, overridable via PACER_JSON). The pacer
// predicts whether an account is on pace to land its usage window at the
// target, behind, or safely ahead with room to flush. This module only reads
// and validates that file; it decides nothing about dispatch itself — callers
// (throttle.ts and friends) turn this advice into actual routing choices.
//
// THE ONE RULE THAT MATTERS: stale or missing data is ALWAYS "no opinion",
// never 'hold'. A pacer that can silently stop dispatch just because its file
// went missing would be worse than no pacer at all.
//
// Zero imports from darwin-assistant/src (only `node:fs`) — load-bearing for
// throttle.ts's one-directional import discipline (see its header comment):
// this keeps the dependency edge one-directional with no risk of a cycle.

import { readFileSync } from 'node:fs';

export type PacerRecommendation = 'release' | 'hold' | 'flush';
export type PacerMode = 'off' | 'advise' | 'enforce';

export interface PacerAdvice {
  recommendation: PacerRecommendation | null;
  target: number | null;
  reserve: number | null;
  behind_pace: boolean;
  headroom_pct: number | null;
  minutes_to_reset: number | null;
  fresh: boolean;
  sentence: string;
}

export const PACER_STALE_MINUTES = 15;
const DEFAULT_PACER_JSON = '/home/kevin/window-burn/pacer.json';

/** Read per call (never cached) so a dial/file change lands on the next tick. */
export function pacerJsonPath(): string {
  return process.env.PACER_JSON?.trim() || DEFAULT_PACER_JSON;
}

export const NO_PACER_ADVICE: PacerAdvice = Object.freeze({
  recommendation: null,
  target: null,
  reserve: null,
  behind_pace: false,
  headroom_pct: null,
  minutes_to_reset: null,
  fresh: false,
  sentence: 'no fresh pacer advice — the pacer has no opinion right now',
});

export function claudePacerKey(accountKey: string): string {
  return `claude_${accountKey}`;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isFresh(ts: unknown, now: number): boolean {
  const t = typeof ts === 'number' ? ts : typeof ts === 'string' && ts.trim() ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return false;
  return now - (t as number) <= PACER_STALE_MINUTES * 60_000;
}

function sentenceFor(a: PacerAdvice, reason: string): string {
  const head = `pacer says ${a.recommendation}`;
  if (reason) return `${head} — ${reason}`;
  const bits: string[] = [];
  if (a.headroom_pct != null) bits.push(`${a.headroom_pct}% headroom`);
  if (a.minutes_to_reset != null) bits.push(`${Math.round(a.minutes_to_reset)}m to reset`);
  if (a.behind_pace) bits.push('behind pace');
  if (a.reserve != null) bits.push(`reserve ${a.reserve}%`);
  return bits.length ? `${head} — ${bits.join(', ')}` : head;
}

function adviceFrom(raw: unknown, now: number): PacerAdvice {
  if (!raw || typeof raw !== 'object') return { ...NO_PACER_ADVICE };
  const e = raw as Record<string, unknown>;
  if (!isFresh(e.ts, now)) return { ...NO_PACER_ADVICE };
  const rec = e.recommendation;
  const recommendation: PacerRecommendation | null =
    rec === 'release' || rec === 'hold' || rec === 'flush' ? rec : null;
  if (recommendation == null) return { ...NO_PACER_ADVICE };
  const reserve = num(e.reserve);
  const advice: PacerAdvice = {
    recommendation,
    target: num(e.target),
    reserve: reserve != null && reserve >= 0 && reserve <= 100 ? reserve : null,
    behind_pace: e.behind_pace === true,
    headroom_pct: num(e.headroom_pct),
    minutes_to_reset: num(e.minutes_to_reset),
    fresh: true,
    sentence: '',
  };
  advice.sentence = sentenceFor(advice, typeof e.reason === 'string' ? e.reason.trim() : '');
  return advice;
}

/** The whole advice map. `{}` on ANY failure — missing file, bad JSON, bad root. */
export function readPacerAdvice(now: number = Date.now()): Record<string, PacerAdvice> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pacerJsonPath(), 'utf8'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, PacerAdvice> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    out[key] = adviceFrom(entry, now);
  }
  return out;
}

export function pacerAdviceFor(
  accountKey: string,
  map?: Record<string, PacerAdvice>,
  now: number = Date.now(),
): PacerAdvice {
  const source = map ?? readPacerAdvice(now);
  return source[claudePacerKey(accountKey)] ?? { ...NO_PACER_ADVICE };
}

export function pacerSaysHold(advice: PacerAdvice): boolean {
  return advice.fresh && advice.recommendation === 'hold';
}

/**
 * THE reserve invariant, in ONE place: a fresh 'flush' may waive the
 * kevin_active hold only while the account's own utilization is still below
 * (100 - reserve). The reserve is Kevin's and the pacer never crosses it; an
 * unusable/absent reserve, an unknown utilization, advise/off mode, or another
 * account that could serve the claim normally all refuse the override.
 */
export function pacerFlushOverride(args: {
  mode: PacerMode;
  advice: PacerAdvice;
  utilizationPct: number | null;
  otherAccountCanServe: boolean;
}): boolean {
  const { mode, advice, utilizationPct, otherAccountCanServe } = args;
  if (mode !== 'enforce') return false;
  if (otherAccountCanServe) return false;
  if (!advice.fresh || advice.recommendation !== 'flush') return false;
  if (advice.reserve == null || utilizationPct == null) return false;
  return utilizationPct < 100 - advice.reserve;
}
