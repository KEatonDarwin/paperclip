import { statSync, readFileSync } from 'node:fs';
import { sqliteDb, getSetting } from './conversation-db.js';
import { createNotification } from './notifications.js';

// HOPPER GOVERNOR v2 — the subscription throttle for overnight autonomous runs
// (Kevin, 2026-09-06: "meter the connection and run all night"; upgraded
// 2026-09-12/13 per docs/hopper/GOVERNOR-V2-CONTRACT.md). Plain code, zero
// model calls, consulted by dispatchTick() before every new claim.
//
// The gates are PROVIDER-AWARE (Kevin, 2026-09-09: "the non-Claude models can
// work in the daytime too"). Claude-routed nodes ride Kevin's own subscription
// and answer to all four Claude gates below. Nodes routed to another provider
// (codex, auggie, devin) burn a separate plan and only answer to that plan's
// own ceiling — they run even while Kevin is at the keyboard.
//
// Claude gates, any one holds NEW dispatches (running workers are never touched):
//   1. usage snapshot stale        → poller dead means we're flying blind;
//      hold + one error notification rather than burn unmetered.
//   2. weekly window ≥ ceiling     → the hard overnight budget; protects the
//      workweek. One bell notification when first hit. soft/hard mode.
//   3. five-hour window ≥ ceiling  → sleeps until the window resets, then the
//      60s safety tick resumes dispatch on its own. This IS the pacing loop.
//   4. Kevin recently active       → any non-worker user message inside the
//      idle window pauses dispatch UNLESS Claude's 5h utilization is below
//      `gov_kevin_active_claude_max_5h` (2026-09-11: "it's OK to use Claude
//      while I'm here" below half the window burned).
//
// All numeric/enum knobs are read from settings-KV via getGovernorSetting(),
// UNCACHED, with an env-var fallback — so the cockpit settings panel takes
// effect on the very next governor check, no restart. See the contract doc
// for the full settings schema and acceptance checks.

const ENABLED = process.env.HOPPER_GOV_ENABLED !== '0';
const IDLE_MINUTES = num(process.env.HOPPER_GOV_IDLE_MIN, 15);
const STALE_MINUTES = num(process.env.HOPPER_GOV_STALE_MIN, 10);
const USAGE_FILE = process.env.CLAUDE_USAGE_FILE ?? '/tmp/claude-usage-live.json';
const CODEX_USAGE_FILE = process.env.CODEX_USAGE_FILE ?? '/tmp/codex-usage-live.json';
const AUGGIE_USAGE_FILE = process.env.AUGGIE_USAGE_FILE ?? '/tmp/auggie-usage-live.json';
// Mirrors hopper-engine's WORKER_ADAPTER default so a null/unset node adapter
// classifies the same way here as it spawns there.
const WORKER_DEFAULT_ADAPTER = process.env.HOPPER_WORKER_ADAPTER ?? 'claude';

function num(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// -- Settings-KV knobs (uncached, env-fallback) ------------------------------
// getSetting() is a direct prepared SELECT (conversation-db.ts) — no caching
// layer to invalidate, so a cockpit PATCH takes effect on the next call.

/** name may be bare ("5h_ceiling") or already prefixed ("gov_5h_ceiling"). */
function getGovernorSetting(name: string, legacyEnvKeys: string[] = []): string | null {
  const key = name.startsWith('gov_') ? name : `gov_${name}`;
  const kv = getSetting(key)?.trim();
  if (kv) return kv;
  const envKey = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const primary = process.env[envKey]?.trim();
  if (primary) return primary;
  for (const legacy of legacyEnvKeys) {
    const v = process.env[legacy]?.trim();
    if (v) return v;
  }
  return null;
}

function numSetting(name: string, fallback: number, legacyEnvKeys: string[] = []): number {
  const raw = getGovernorSetting(name, legacyEnvKeys);
  const n = raw != null ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function weeklyModeSetting(): 'soft' | 'hard' {
  const raw = getGovernorSetting('weekly_mode', ['HOPPER_GOV_WEEKLY_MODE'])?.toLowerCase();
  return raw === 'hard' ? 'hard' : 'soft';
}

export type GovernorOverride = 'auto' | 'on' | 'off';

function overrideSetting(provider: GovernorProvider): GovernorOverride {
  const raw = getGovernorSetting(`override_${provider}`)?.toLowerCase();
  return raw === 'on' || raw === 'off' ? raw : 'auto';
}

// Defaults per docs/hopper/GOVERNOR-V2-CONTRACT.md §Settings-KV Schema.
function kevinActiveClaudeMax5h(): number {
  return numSetting('kevin_active_claude_max_5h', 50);
}
function fiveHourCeiling(): number {
  return numSetting('5h_ceiling', 90, ['HOPPER_GOV_5H_CEILING']);
}
function weeklyCeiling(): number {
  // Default dropped 40 -> 30 per Kevin's 2026-09-12 plan-upgrade instruction.
  return numSetting('weekly_ceiling', 30, ['HOPPER_GOV_WEEKLY_CEILING']);
}
function codexCeiling(): number {
  return numSetting('codex_ceiling', 90, ['HOPPER_GOV_CODEX_CEILING']);
}
function auggieCeiling(): number {
  // Stops new Auggie claims at/above 85% burned — Augment was ~80% tonight.
  return numSetting('auggie_ceiling', 85, ['HOPPER_GOV_AUGGIE_CEILING']);
}
/** Exported so dispatchTick can apply the active-window non-Claude cap without
 *  round-tripping through a full governorCheck() evaluation + its logging. */
export function concurrencyCap(): number {
  return numSetting('concurrency_cap', 2, ['HOPPER_DAYTIME_MAX_WORKERS']);
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

export interface GovernorConfig {
  enabled: boolean;
  five_hour_ceiling: number;
  weekly_ceiling: number;
  weekly_mode: 'soft' | 'hard';
  idle_minutes: number;
  stale_minutes: number;
  kevin_active_claude_max_5h: number;
  codex_ceiling: number;
  auggie_ceiling: number;
  concurrency_cap: number;
}

export interface GovernorVerdict {
  allow: boolean;
  reason:
    | 'ok'
    | 'disabled'
    | 'override_on'
    | 'override_off'
    | 'five_hour_ceiling'
    | 'weekly_ceiling'
    | 'usage_stale'
    | 'kevin_active'
    | 'provider_ceiling';
  detail: string;
  provider: GovernorProvider;
  override: GovernorOverride;
  five_hour?: number | null;
  weekly?: number | null;
  provider_usage?: number | null;
  config: GovernorConfig;
}

function currentConfig(): GovernorConfig {
  return {
    enabled: ENABLED,
    five_hour_ceiling: fiveHourCeiling(),
    weekly_ceiling: weeklyCeiling(),
    weekly_mode: weeklyModeSetting(),
    idle_minutes: IDLE_MINUTES,
    stale_minutes: STALE_MINUTES,
    kevin_active_claude_max_5h: kevinActiveClaudeMax5h(),
    codex_ceiling: codexCeiling(),
    auggie_ceiling: auggieCeiling(),
    concurrency_cap: concurrencyCap(),
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

/** Kevin-at-the-keyboard probe, exported so dispatchTick can apply the
 *  active-window non-Claude concurrency cap. */
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
// Also surfaces file age so a dead poller (timer stopped, CLI broken) reads as
// "stale" instead of silently freezing at its last-known (possibly low) value
// forever — the same protection readUsage() already gives the Claude gate.
function readProviderUsage(file: string): { used: number | null; staleMinutes: number | null } {
  try {
    const ageMs = Date.now() - statSync(file).mtimeMs;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      windows?: { used_percentage?: number | null }[] | null;
    };
    const pcts = (parsed.windows ?? [])
      .map((w) => w?.used_percentage)
      .filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
    return { used: pcts.length ? Math.max(...pcts) : null, staleMinutes: ageMs / 60_000 };
  } catch {
    return { used: null, staleMinutes: null };
  }
}

interface ProviderMeter {
  file: string | null;
  ceiling: () => number;
}

function providerMeters(): Record<Exclude<GovernorProvider, 'claude'>, ProviderMeter> {
  return {
    codex: { file: CODEX_USAGE_FILE, ceiling: codexCeiling },
    auggie: { file: AUGGIE_USAGE_FILE, ceiling: auggieCeiling },
    devin: { file: null, ceiling: () => 100 },
  };
}

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
  const verdict = evaluate(providerFor(adapter ?? WORKER_DEFAULT_ADAPTER));
  if (verdict.reason !== lastReason.get(verdict.provider)) {
    console.log(
      `[hopper-governor] ${verdict.provider}: ${verdict.allow ? 'OPEN' : 'HOLD'} (${verdict.reason}) — ${verdict.detail}`,
    );
    lastReason.set(verdict.provider, verdict.reason);
  }
  return verdict;
}

/**
 * Read-only status for the API — same evaluation, no logging side effects.
 * Defaults to claude semantics (back-compat top-level verdict); pass an
 * adapter string to check a specific lane.
 */
export function governorStatus(adapter?: string | null): GovernorVerdict {
  return evaluate(providerFor(adapter ?? 'claude'));
}

const ALL_PROVIDERS: GovernorProvider[] = ['claude', 'codex', 'auggie', 'devin'];

/** Per-provider status for the API — which lanes are open right now and why. */
export function governorStatusAll(): Record<GovernorProvider, GovernorVerdict> {
  const out = {} as Record<GovernorProvider, GovernorVerdict>;
  for (const p of ALL_PROVIDERS) out[p] = evaluate(p);
  return out;
}

function evaluate(provider: GovernorProvider): GovernorVerdict {
  const CONFIG = currentConfig();
  const override = overrideSetting(provider);

  if (override === 'on') {
    return {
      allow: true,
      reason: 'override_on',
      detail: `gov_override_${provider}=on — manual override allows new ${provider} dispatches`,
      provider,
      override,
      config: CONFIG,
    };
  }

  if (override === 'off') {
    return {
      allow: false,
      reason: 'override_off',
      detail: `gov_override_${provider}=off — manual override holds new ${provider} dispatches`,
      provider,
      override,
      config: CONFIG,
    };
  }

  if (!ENABLED) {
    return { allow: true, reason: 'disabled', detail: 'governor disabled via HOPPER_GOV_ENABLED=0', provider, override, config: CONFIG };
  }

  if (provider !== 'claude') {
    const meter = providerMeters()[provider];
    const ceiling = meter.ceiling();
    const { used, staleMinutes } = meter.file ? readProviderUsage(meter.file) : { used: null, staleMinutes: null };
    // A configured meter that's gone missing or stale (poller died) must HOLD,
    // not silently allow — an unmetered pool is exactly the failure mode the
    // ceiling exists to prevent. Providers with no meter (devin) have no file
    // to go stale, so they keep their always-open behavior until a meter ships.
    if (meter.file && (staleMinutes == null || staleMinutes > STALE_MINUTES)) {
      notifyOnce(
        `provider_stale:${provider}`,
        'error',
        `⛽ Hopper governor: ${provider} usage meter is stale`,
        `${provider} usage snapshot ${staleMinutes == null ? 'unreadable' : `${Math.round(staleMinutes)}m stale`} — holding new ${provider} dispatches until the poller catches up.`,
      );
      return {
        allow: false,
        reason: 'usage_stale',
        detail: `${provider} usage snapshot ${staleMinutes == null ? 'unreadable' : `${Math.round(staleMinutes)}m stale`}`,
        provider,
        override,
        provider_usage: used,
        config: CONFIG,
      };
    }
    if (used != null && used >= ceiling) {
      notifyOnce(
        `provider_ceiling:${provider}`,
        'info',
        `⛽ Hopper governor: ${provider} plan at its ceiling`,
        `${provider} usage ${used}% ≥ ceiling ${ceiling}%. Holding new ${provider} dispatches — raise gov_${provider}_ceiling to keep going.`,
      );
      return {
        allow: false,
        reason: 'provider_ceiling',
        detail: `${provider} usage ${used}% ≥ ${ceiling}%`,
        provider,
        override,
        provider_usage: used,
        config: CONFIG,
      };
    }
    return {
      allow: true,
      reason: 'ok',
      detail: `${provider} usage ${used ?? '?'}% (ceiling ${ceiling}%), clear to dispatch — Claude ceilings do not apply`,
      provider,
      override,
      provider_usage: used,
      config: CONFIG,
    };
  }

  // -- Claude lane --
  const { fiveHour, weekly, staleMinutes } = readUsage();
  const FIVE_HOUR_CEILING = CONFIG.five_hour_ceiling;
  const WEEKLY_CEILING = CONFIG.weekly_ceiling;

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
      override,
      five_hour: fiveHour,
      weekly,
      config: CONFIG,
    };
  }

  // Weekly ceiling runs BEFORE the Kevin-active exception (contract: weekly
  // is the hard overnight/workweek budget and isn't waived by the 5h waiver).
  if (weekly != null && weekly >= WEEKLY_CEILING) {
    const soft = CONFIG.weekly_mode === 'soft';
    notifyOnce(
      'weekly',
      'info',
      `⛽ Hopper governor: weekly budget reached${soft ? ' (soft — continuing)' : ''}`,
      `Weekly window at ${weekly}% ≥ ceiling ${WEEKLY_CEILING}%. ${soft ? 'gov_weekly_mode=soft, so dispatch continues — this may burn extra-usage credits.' : 'Overnight dispatch is parked to protect the workweek — raise gov_weekly_ceiling or set gov_weekly_mode=soft to keep going.'}`,
    );
    if (!soft) {
      return {
        allow: false,
        reason: 'weekly_ceiling',
        detail: `weekly ${weekly}% ≥ ${WEEKLY_CEILING}%`,
        provider,
        override,
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
      override,
      five_hour: fiveHour,
      weekly,
      config: CONFIG,
    };
  }

  if (kevinActive()) {
    // 2026-09-11: "it's OK to use Claude while I'm here" below half the 5h
    // window burned. Unknown utilization never grants the waiver — it holds
    // exactly like an at/above-threshold reading would.
    const maxActive = CONFIG.kevin_active_claude_max_5h;
    const waived = fiveHour != null && fiveHour < maxActive;
    if (!waived) {
      return {
        allow: false,
        reason: 'kevin_active',
        detail: waived === false && fiveHour == null
          ? `Kevin active within the last ${IDLE_MINUTES}m and 5h utilization is unknown — never waive on an unknown reading`
          : `Kevin active within the last ${IDLE_MINUTES}m and 5h ${fiveHour}% ≥ waiver threshold ${maxActive}% — his subscription, his turn`,
        provider,
        override,
        five_hour: fiveHour,
        weekly,
        config: CONFIG,
      };
    }
  }

  return {
    allow: true,
    reason: 'ok',
    detail: `5h ${fiveHour ?? '?'}% / weekly ${weekly ?? '?'}% — clear to dispatch`,
    provider,
    override,
    five_hour: fiveHour,
    weekly,
    config: CONFIG,
  };
}
