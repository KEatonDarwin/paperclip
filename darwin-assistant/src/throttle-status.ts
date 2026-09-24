// ⚡ THROTTLE — the composed status payload (CONTRACT §7.3 / §7.4).
//
// WHY THIS FILE EXISTS (review node #719). `throttleStatus()` in throttle.ts
// takes its governor verdicts and account views as an ARGUMENT, because
// throttle.ts cannot import `governorStatusAll` or `selectActiveClaudeAccount`
// — hopper-governor.ts and claude-accounts.ts both import IT (§7.1's
// one-directional import rule). Called with NO argument it still returns a
// well-formed payload, but `providers` is `{}` and `accounts` is `[]`, and
// `deriveHold()` walks the ready leaves seeing no governor verdict at all — so
// it reports `dispatching: true, reason: 'ok'` no matter how hard the governor
// is holding.
//
// That is fine for a unit test and WRONG for a user-facing surface. The route
// composed the inputs inline; the `throttle` persona tool did not, so
// `mcp__jarvis__throttle status` — the exact call JARVIS makes when Kevin asks
// "why is nothing running?" — answered "Dispatching" with an empty account list
// while the Claude lane was shut. One composition, used by both, is the fix.
//
// Import direction stays clean: this module imports throttle / hopper-governor /
// claude-accounts; none of them import this one.

import {
  throttleStatus,
  overrideFor,
  readStopLoss,
  runningWorkerAdapters,
  type ThrottleStatus,
  type ThrottleAccountView,
  type ThrottleProviderView,
} from './throttle.js';
import { governorStatusAll, kevinActive, concurrencyCap, providerFor, type GovernorProvider } from './hopper-governor.js';
import { claudeFiveHourCeiling, selectActiveClaudeAccount } from './claude-accounts.js';

export interface ComposedThrottleInputs {
  providers: Partial<Record<GovernorProvider, ThrottleProviderView>>;
  accounts: ThrottleAccountView[];
  daytime: { active: boolean; cap: number; nonClaudeRunning: number };
}

/**
 * Read-only and side-effect free (§7.3): no `enforceAdmissionFloor`, and
 * `selectActiveClaudeAccount` is called WITHOUT `forSpawn`, so the split cursor
 * is never advanced by a status read (AC-16).
 */
export function composeThrottleInputs(): ComposedThrottleInputs {
  const all = governorStatusAll();
  const stopLoss = readStopLoss();
  const ceilingFor: Record<GovernorProvider, number | null> = {
    claude: stopLoss.gov_5h_ceiling,
    codex: stopLoss.gov_codex_ceiling,
    auggie: stopLoss.gov_auggie_ceiling,
    devin: null,
  };
  const providers: Partial<Record<GovernorProvider, ThrottleProviderView>> = {};
  for (const [name, v] of Object.entries(all) as [GovernorProvider, (typeof all)[GovernorProvider]][]) {
    providers[name] = {
      allow: v.allow,
      reason: v.reason,
      detail: v.detail,
      usage: name === 'claude' ? (v.five_hour ?? null) : (v.provider_usage ?? null),
      ceiling: ceilingFor[name],
      override: overrideFor(name),
    };
  }

  const ceiling = claudeFiveHourCeiling();
  const selection = selectActiveClaudeAccount(ceiling);
  const accounts: ThrottleAccountView[] = selection.perAccount.map(({ account, usage, eligible }) => ({
    key: account.key,
    label: account.label,
    enabled: account.enabled,
    five_hour: usage.five_hour,
    weekly: usage.weekly,
    stale: usage.stale,
    locked_reason: usage.locked_reason,
    eligible,
    active: selection.account?.key === account.key,
    five_hour_resets_at: usage.five_hour_resets_at,
    weekly_resets_at: usage.weekly_resets_at,
    five_hour_ceiling: ceiling,
  }));

  // The non-Claude daytime cap, so the hold line can name it honestly.
  const active = kevinActive();
  const nonClaudeRunning = active
    ? runningWorkerAdapters().filter((a) => providerFor(a ?? 'claude') !== 'claude').length
    : 0;
  return { providers, accounts, daytime: { active, cap: concurrencyCap(), nonClaudeRunning } };
}

/** The complete, honest `GET /throttle` payload. Use this, never a bare
 *  `throttleStatus()`, for anything Kevin or JARVIS reads. */
export function fullThrottleStatus(): ThrottleStatus {
  return throttleStatus(composeThrottleInputs());
}
