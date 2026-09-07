import { statSync, readFileSync } from 'node:fs';
import { sqliteDb } from './conversation-db.js';
import { createNotification } from './notifications.js';

// HOPPER GOVERNOR — the subscription throttle for overnight autonomous runs
// (Kevin, 2026-09-06: "meter the connection and run all night"). Plain code,
// zero model calls, consulted by dispatchTick() before every new claim.
//
// Four gates, any one holds NEW dispatches (running workers are never touched):
//   1. five-hour window ≥ ceiling  → sleeps until the window resets, then the
//      60s safety tick resumes dispatch on its own. This IS the pacing loop.
//   2. weekly window ≥ ceiling     → the hard overnight budget; protects the
//      workweek. One bell notification when first hit.
//   3. usage snapshot stale        → poller dead means we're flying blind;
//      hold + one error notification rather than burn unmetered.
//   4. Kevin recently active       → any non-worker user message inside the
//      idle window pauses dispatch, so trees only burn while he's away.

const ENABLED = process.env.HOPPER_GOV_ENABLED !== '0';
const FIVE_HOUR_CEILING = num(process.env.HOPPER_GOV_5H_CEILING, 90);
const WEEKLY_CEILING = num(process.env.HOPPER_GOV_WEEKLY_CEILING, 40);
const IDLE_MINUTES = num(process.env.HOPPER_GOV_IDLE_MIN, 15);
const STALE_MINUTES = num(process.env.HOPPER_GOV_STALE_MIN, 10);
const USAGE_FILE = process.env.CLAUDE_USAGE_FILE ?? '/tmp/claude-usage-live.json';

function num(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface GovernorVerdict {
  allow: boolean;
  reason: 'ok' | 'disabled' | 'five_hour_ceiling' | 'weekly_ceiling' | 'usage_stale' | 'kevin_active';
  detail: string;
  five_hour?: number | null;
  weekly?: number | null;
  config: {
    enabled: boolean;
    five_hour_ceiling: number;
    weekly_ceiling: number;
    idle_minutes: number;
    stale_minutes: number;
  };
}

const CONFIG: GovernorVerdict['config'] = {
  enabled: ENABLED,
  five_hour_ceiling: FIVE_HOUR_CEILING,
  weekly_ceiling: WEEKLY_CEILING,
  idle_minutes: IDLE_MINUTES,
  stale_minutes: STALE_MINUTES,
};

// Kevin-activity probe: any user-authored turn in a NON-hopper-worker thread
// inside the idle window. Worker threads (cockpit:hopper-node-*) are excluded —
// their seed prompts are user-role rows but are engine-authored, not Kevin.
const kevinActiveStmt = sqliteDb.prepare<[string], { active: number }>(`
  SELECT EXISTS(
    SELECT 1 FROM turns t
    JOIN conversations c ON c.id = t.conversation_id
    WHERE t.role = 'user'
      AND c.external_id NOT LIKE 'cockpit:hopper-node-%'
      AND t.created_at >= datetime('now', ?)
  ) AS active
`);

interface UsageWindow {
  utilization?: number | null;
}

function readUsage(): { fiveHour: number | null; weekly: number | null; staleMinutes: number | null } {
  try {
    const ageMs = Date.now() - statSync(USAGE_FILE).mtimeMs;
    const parsed = JSON.parse(readFileSync(USAGE_FILE, 'utf8')) as {
      five_hour?: UsageWindow | null;
      seven_day?: UsageWindow | null;
    };
    return {
      fiveHour: parsed.five_hour?.utilization ?? null,
      weekly: parsed.seven_day?.utilization ?? null,
      staleMinutes: ageMs / 60_000,
    };
  } catch {
    return { fiveHour: null, weekly: null, staleMinutes: null };
  }
}

// One-shot notifications per process per condition — the bell is a state-change
// signal, not a 60s drumbeat.
const notified = new Set<string>();
function notifyOnce(key: string, severity: 'info' | 'error', title: string, body: string): void {
  if (notified.has(key)) return;
  notified.add(key);
  createNotification({ severity, title, body, source: 'hopper-engine' });
}

let lastReason: GovernorVerdict['reason'] | null = null;

/** Consulted by dispatchTick before claiming new nodes. Logs on state change only. */
export function governorCheck(): GovernorVerdict {
  const verdict = evaluate();
  if (verdict.reason !== lastReason) {
    console.log(`[hopper-governor] ${verdict.allow ? 'OPEN' : 'HOLD'} (${verdict.reason}) — ${verdict.detail}`);
    lastReason = verdict.reason;
  }
  return verdict;
}

/** Read-only status for the API — same evaluation, no logging side effects. */
export function governorStatus(): GovernorVerdict {
  return evaluate();
}

function evaluate(): GovernorVerdict {
  if (!ENABLED) {
    return { allow: true, reason: 'disabled', detail: 'governor disabled via HOPPER_GOV_ENABLED=0', config: CONFIG };
  }

  const { fiveHour, weekly, staleMinutes } = readUsage();

  if (staleMinutes == null || staleMinutes > STALE_MINUTES) {
    notifyOnce(
      'stale',
      'error',
      '🛑 Hopper governor: usage meter is dark',
      `${USAGE_FILE} is ${staleMinutes == null ? 'missing/unreadable' : `${Math.round(staleMinutes)}m old`} (limit ${STALE_MINUTES}m). Holding all new dispatches rather than burn unmetered — check claude-usage-poll.timer.`,
    );
    return {
      allow: false,
      reason: 'usage_stale',
      detail: `usage snapshot ${staleMinutes == null ? 'unreadable' : `${Math.round(staleMinutes)}m stale`}`,
      five_hour: fiveHour,
      weekly,
      config: CONFIG,
    };
  }

  if (weekly != null && weekly >= WEEKLY_CEILING) {
    // Kevin 2026-09-07: never hard-stop for overages when work matters — soft
    // mode keeps dispatching past the weekly ceiling but rings the bell once so
    // he knows we're into protected (possibly paid extra-usage) territory.
    const soft = process.env.HOPPER_GOV_WEEKLY_MODE === 'soft';
    notifyOnce(
      'weekly',
      'info',
      `⛽ Hopper governor: weekly budget reached${soft ? ' (soft — continuing)' : ''}`,
      `Weekly window at ${weekly}% ≥ ceiling ${WEEKLY_CEILING}%. ${soft ? 'HOPPER_GOV_WEEKLY_MODE=soft, so dispatch continues — this may burn extra-usage credits.' : 'Overnight dispatch is parked to protect the workweek — raise HOPPER_GOV_WEEKLY_CEILING or set HOPPER_GOV_WEEKLY_MODE=soft to keep going.'}`,
    );
    if (!soft) {
      return {
        allow: false,
        reason: 'weekly_ceiling',
        detail: `weekly ${weekly}% ≥ ${WEEKLY_CEILING}%`,
        five_hour: fiveHour,
        weekly,
        config: CONFIG,
      };
    }
  }

  if (fiveHour != null && fiveHour >= FIVE_HOUR_CEILING) {
    return {
      allow: false,
      reason: 'five_hour_ceiling',
      detail: `5h window ${fiveHour}% ≥ ${FIVE_HOUR_CEILING}% — sleeping until the window resets`,
      five_hour: fiveHour,
      weekly,
      config: CONFIG,
    };
  }

  if (IDLE_MINUTES > 0 && kevinActiveStmt.get(`-${IDLE_MINUTES} minutes`)?.active) {
    return {
      allow: false,
      reason: 'kevin_active',
      detail: `Kevin active within the last ${IDLE_MINUTES}m — his subscription, his turn`,
      five_hour: fiveHour,
      weekly,
      config: CONFIG,
    };
  }

  return {
    allow: true,
    reason: 'ok',
    detail: `5h ${fiveHour ?? '?'}% / weekly ${weekly ?? '?'}% — clear to dispatch`,
    five_hour: fiveHour,
    weekly,
    config: CONFIG,
  };
}
