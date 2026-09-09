import { statSync, readFileSync } from 'node:fs';
import { sqliteDb, getSetting, setSetting } from './conversation-db.js';
import { createNotification } from './notifications.js';

// HOPPER GOVERNOR — the subscription throttle for overnight autonomous runs
// (Kevin, 2026-09-06: "meter the connection and run all night"). Plain code,
// zero model calls, consulted by dispatchTick() before every new claim.
//
// The gates are PROVIDER-AWARE (Kevin, 2026-09-09: "the non-Claude models can
// work in the daytime too"). Claude-routed nodes ride Kevin's own subscription,
// so they keep all four gates below. Nodes routed to another provider (codex,
// auggie, devin) burn a separate plan and only answer to that plan's own
// ceiling — so they keep working while Kevin is at the keyboard. The
// `hopper_daytime_mode` setting is the kill-switch: turn it off and every
// provider falls back to the full Claude gate set.
//
// Claude gates, any one holds NEW dispatches (running workers are never touched):
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
const CODEX_CEILING = num(process.env.HOPPER_GOV_CODEX_CEILING, 90);
const AUGGIE_CEILING = num(process.env.HOPPER_GOV_AUGGIE_CEILING, 90);
const CODEX_USAGE_FILE = process.env.CODEX_USAGE_FILE ?? '/tmp/codex-usage-live.json';
const AUGGIE_USAGE_FILE = process.env.AUGGIE_USAGE_FILE ?? '/tmp/auggie-usage-live.json';
const DAYTIME_SETTING_KEY = 'hopper_daytime_mode';

function num(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export type GovernorProvider = 'claude' | 'codex' | 'auggie' | 'devin';

/** Adapter string (router loadout) → the plan whose meter that work burns. */
export function providerFor(adapter?: string | null): GovernorProvider {
  const a = (adapter ?? '').toLowerCase();
  if (a.includes('codex') || a.includes('openai')) return 'codex';
  if (a.includes('auggie') || a.includes('augment')) return 'auggie';
  if (a.includes('devin')) return 'devin';
  return 'claude';
}

/** Daytime mode = non-Claude providers bypass the Claude gates. On by default. */
export function daytimeMode(): boolean {
  const raw = getSetting(DAYTIME_SETTING_KEY)?.trim().toLowerCase();
  if (!raw) return process.env.HOPPER_GOV_DAYTIME !== '0';
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

export function setDaytimeMode(on: boolean): boolean {
  setSetting(DAYTIME_SETTING_KEY, on ? 'on' : 'off');
  return on;
}

export interface GovernorVerdict {
  allow: boolean;
  reason:
    | 'ok'
    | 'disabled'
    | 'five_hour_ceiling'
    | 'weekly_ceiling'
    | 'usage_stale'
    | 'kevin_active'
    | 'provider_ceiling';
  detail: string;
  provider: GovernorProvider;
  five_hour?: number | null;
  weekly?: number | null;
  provider_usage?: number | null;
  config: {
    enabled: boolean;
    five_hour_ceiling: number;
    weekly_ceiling: number;
    idle_minutes: number;
    stale_minutes: number;
    daytime_mode: boolean;
    codex_ceiling: number;
    auggie_ceiling: number;
  };
}

function config(): GovernorVerdict['config'] {
  return {
    enabled: ENABLED,
    five_hour_ceiling: FIVE_HOUR_CEILING,
    weekly_ceiling: WEEKLY_CEILING,
    idle_minutes: IDLE_MINUTES,
    stale_minutes: STALE_MINUTES,
    daytime_mode: daytimeMode(),
    codex_ceiling: CODEX_CEILING,
    auggie_ceiling: AUGGIE_CEILING,
  };
}

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

/**
 * Kevin-at-the-keyboard probe, exported so the engine can apply the daytime
 * concurrency cap (non-Claude lanes stay open while he works, but narrowed).
 */
export function kevinActive(): boolean {
  if (IDLE_MINUTES <= 0) return false;
  return !!kevinActiveStmt.get(`-${IDLE_MINUTES} minutes`)?.active;
}

export function idleMinutes(): number {
  return IDLE_MINUTES;
}

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

// Non-Claude pollers write a different shape: {windows:[{label, used_percentage}]}.
// We take the worst window — one saturated window means that plan is spent.
function readProviderUsage(file: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      windows?: { used_percentage?: number | null }[] | null;
    };
    const pcts = (parsed.windows ?? [])
      .map((w) => w?.used_percentage)
      .filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
    return pcts.length ? Math.max(...pcts) : null;
  } catch {
    return null;
  }
}

const PROVIDER_METERS: Record<Exclude<GovernorProvider, 'claude'>, { file: string | null; ceiling: number }> = {
  codex: { file: CODEX_USAGE_FILE, ceiling: CODEX_CEILING },
  auggie: { file: AUGGIE_USAGE_FILE, ceiling: AUGGIE_CEILING },
  devin: { file: null, ceiling: 100 },
};

// One-shot notifications per process per condition — the bell is a state-change
// signal, not a 60s drumbeat.
const notified = new Set<string>();
function notifyOnce(key: string, severity: 'info' | 'error', title: string, body: string): void {
  if (notified.has(key)) return;
  notified.add(key);
  createNotification({ severity, title, body, source: 'hopper-engine' });
}

const lastReason = new Map<GovernorProvider, GovernorVerdict['reason']>();

/**
 * Consulted by dispatchTick before claiming each new node — pass the node's
 * adapter so the verdict is metered against the plan that work actually burns.
 * Logs on state change only, per provider.
 */
export function governorCheck(adapter?: string | null): GovernorVerdict {
  const verdict = evaluate(providerFor(adapter));
  if (verdict.reason !== lastReason.get(verdict.provider)) {
    console.log(
      `[hopper-governor] ${verdict.provider}: ${verdict.allow ? 'OPEN' : 'HOLD'} (${verdict.reason}) — ${verdict.detail}`,
    );
    lastReason.set(verdict.provider, verdict.reason);
  }
  return verdict;
}

/** Read-only status for the API — same evaluation, no logging side effects. */
export function governorStatus(adapter?: string | null): GovernorVerdict {
  return evaluate(providerFor(adapter));
}

const ALL_PROVIDERS: GovernorProvider[] = ['claude', 'codex', 'auggie', 'devin'];

/** Per-provider status for the API — which lanes are open right now. */
export function governorStatusAll(): { providers: Record<GovernorProvider, GovernorVerdict> } {
  const providers = {} as Record<GovernorProvider, GovernorVerdict>;
  for (const p of ALL_PROVIDERS) providers[p] = evaluate(p);
  return { providers };
}

function evaluate(provider: GovernorProvider = 'claude'): GovernorVerdict {
  const CONFIG = config();
  if (!ENABLED) {
    return { allow: true, reason: 'disabled', detail: 'governor disabled via HOPPER_GOV_ENABLED=0', provider, config: CONFIG };
  }

  // Daytime lane: another provider's plan, so Kevin's Claude gates don't apply —
  // only that plan's own ceiling does. Kill-switch = hopper_daytime_mode off,
  // which drops these providers back onto the full Claude gate set below.
  if (provider !== 'claude' && CONFIG.daytime_mode) {
    const meter = PROVIDER_METERS[provider];
    const used = meter.file ? readProviderUsage(meter.file) : null;
    if (used != null && used >= meter.ceiling) {
      notifyOnce(
        `provider_ceiling:${provider}`,
        'info',
        `⛽ Hopper governor: ${provider} plan at its ceiling`,
        `${provider} usage ${used}% ≥ ceiling ${meter.ceiling}%. Holding new ${provider} dispatches — raise HOPPER_GOV_${provider.toUpperCase()}_CEILING to keep going.`,
      );
      return {
        allow: false,
        reason: 'provider_ceiling',
        detail: `${provider} usage ${used}% ≥ ${meter.ceiling}%`,
        provider,
        provider_usage: used,
        config: CONFIG,
      };
    }
    return {
      allow: true,
      reason: 'ok',
      detail: `daytime lane — ${provider} usage ${used ?? '?'}% (ceiling ${meter.ceiling}%), clear to dispatch`,
      provider,
      provider_usage: used,
      config: CONFIG,
    };
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
      provider,
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
        provider,
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
      provider,
      five_hour: fiveHour,
      weekly,
      config: CONFIG,
    };
  }

  if (kevinActive()) {
    return {
      allow: false,
      reason: 'kevin_active',
      detail: `Kevin active within the last ${IDLE_MINUTES}m — his subscription, his turn`,
      provider,
      five_hour: fiveHour,
      weekly,
      config: CONFIG,
    };
  }

  return {
    allow: true,
    reason: 'ok',
    detail: `5h ${fiveHour ?? '?'}% / weekly ${weekly ?? '?'}% — clear to dispatch`,
    provider,
    five_hour: fiveHour,
    weekly,
    config: CONFIG,
  };
}
