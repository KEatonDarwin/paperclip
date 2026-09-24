// CLAUDE ACCOUNT REGISTRY + ACTIVE-ACCOUNT SELECTOR (multi-claude, tree-44d2ff4a node #290)
//
// Pure, unit-testable helpers that let JARVIS run overnight work across MORE
// THAN ONE Claude subscription. Each "account" is an isolated `CLAUDE_CONFIG_DIR`
// (its own OAuth token / session / memory — see docs/multi-claude/RECON.md §6),
// logged in ONCE by hand (docs/multi-claude/DESIGN-ADDENDUM.md). This file owns:
//   1. the registry  (`listClaudeAccounts`)  — reads settings-KV `claude_accounts`
//   2. per-account usage reads (`readAccountUsage`)  — one usage file per account
//   3. the selector  (`selectActiveClaudeAccount`)  — which account a new worker runs on
//
// It makes NO model calls, spawns nothing, and writes nothing. Consumers (the
// `claude` adapter's envOverrides in src/agent.ts, and the governor's claude
// gate in src/hopper-governor.ts) wire it in on later nodes.
//
// ─── SELECTION STRATEGY: LEAST-USED, not first-with-headroom ───────────────────
// Kevin bought the 2nd subscription for THROUGHPUT, not just a longer runway
// (DESIGN-ADDENDUM). So among enabled accounts under the 5h ceiling we pick the
// LEAST-used one: two workers dispatching close together land on different
// accounts and run in parallel. The serial "run A to its wall → continue on B"
// swap falls out of the same selector for free (once A is over the ceiling it's
// no longer eligible, so B wins). This resolves the tension the recon flagged
// between the node spec's "first with headroom" phrasing and the addendum —
// least-used satisfies both, and every required test still passes.
//
// SINGLE-ACCOUNT PATH IS BYTE-IDENTICAL to today: with no `claude_accounts`
// setting (or a single enabled account), the default implicit account 'a' maps
// to `~/.claude` (config_dir null) and `/tmp/claude-usage-live.json`, exactly as
// before this feature existed.

import { statSync, readFileSync } from 'node:fs';
import { getSetting, setSetting } from './conversation-db.js';
// ⚡ THROTTLE (§4.1/§4.6): the account MODE is applied at this one chokepoint —
// the single function all five call sites funnel through — and the SAME
// candidate function is used by hopper-governor's Claude lane, so the selector
// and the governor can never disagree about which account a worker lands on.
import { throttleClaudeCandidates } from './throttle.js';

/** A single Claude subscription JARVIS can route work to. */
export interface ClaudeAccount {
  /** Stable short id used in file names + selection ('a' is the default account). */
  key: string;
  /** Human label for the cockpit UI. */
  label: string;
  /** `CLAUDE_CONFIG_DIR` for this account. `null` = the CLI default (`~/.claude`). */
  config_dir: string | null;
  /** Browser session-cookie file the usage poller reads (never committed). */
  cookie_file: string;
  /** This login's Claude org id (each subscription has its own). `null` if unknown. */
  org_id: string | null;
  /** Disabled accounts are never selected and never gate the governor. */
  enabled: boolean;
}

/** Point-in-time usage for one account, mirroring the governor's window shape. */
export interface AccountUsage {
  /** 5-hour-window utilization %, or null if unreadable. */
  five_hour: number | null;
  /** 7-day-window utilization %, or null if unreadable. */
  weekly: number | null;
  /** True when the usage file is missing or older than the staleness threshold. */
  stale: boolean;
  /**
   * Non-null when Claude itself reports this subscription as locked out of a
   * window (the `locked_reason` the usage payload carries on `five_hour` /
   * `seven_day`). A locked account cannot serve a turn no matter what the
   * percentages say, so it is never AUTO-selected (a manual pin still wins —
   * see agent.ts). Null on every healthy account, so the normal path is
   * unchanged.
   */
  locked_reason: string | null;
  /**
   * ⚡ THROTTLE §7.2 (additive): when the 5-hour / 7-day windows reset, straight
   * out of the same payload this function already parses. It was being dropped
   * on the floor; the throttle panel shows a reset countdown beside each
   * account. Null when absent/unreadable. No existing consumer changes.
   */
  five_hour_resets_at: string | null;
  weekly_resets_at: string | null;
}

/** One account paired with its live usage + whether it's eligible right now. */
export interface AccountUsageEntry {
  account: ClaudeAccount;
  usage: AccountUsage;
  /** enabled AND non-stale AND five_hour known AND under the ceiling. */
  eligible: boolean;
}

export interface AccountSelection {
  /** The account a new worker should run on, or null if none is usable. */
  account: ClaudeAccount | null;
  /** All account keys, in registry order. */
  allNames: string[];
  /** Full per-account breakdown (all accounts, enabled or not), registry order. */
  perAccount: AccountUsageEntry[];
}

const SETTINGS_KEY = 'claude_accounts';

// The default account's org (verified live in RECON §2 from the usage poller).
// Not a secret — a plain org UUID; override for a different primary via env.
const DEFAULT_ORG_ID = process.env.CLAUDE_ORG_ID ?? 'afc417b0-b3d0-4302-b18f-c40cb7394447';

// Usage files live in /tmp (where the pollers write them). Overridable so tests
// never touch the LIVE /tmp/claude-usage-live.json. Production default = /tmp.
const USAGE_DIR = process.env.CLAUDE_USAGE_DIR ?? '/tmp';

// Match the governor's staleness threshold exactly (HOPPER_GOV_STALE_MIN, 10m).
function staleMinutesCeiling(): number {
  const raw = Number(process.env.HOPPER_GOV_STALE_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}

/**
 * The 5h-window ceiling used to decide account eligibility — mirrors the
 * governor's `fiveHourCeiling()` exactly (settings-KV `gov_5h_ceiling`, env
 * `HOPPER_GOV_5H_CEILING`, default 90) so the account selector and the governor
 * agree on when an account is "full". Read fresh (uncached) so a cockpit PATCH
 * takes effect on the next spawn, same as every other governor knob. Kept here
 * (not imported from hopper-governor) to avoid a cross-module dependency — the
 * governor's copy is private.
 */
export function claudeFiveHourCeiling(): number {
  const kv = getSetting('gov_5h_ceiling')?.trim();
  const env = process.env.HOPPER_GOV_5H_CEILING?.trim();
  const raw = kv || env;
  const n = raw != null ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 90;
}

/** The implicit single account used when nothing is configured. */
function defaultAccount(): ClaudeAccount {
  return {
    key: 'a',
    label: 'Claude A',
    config_dir: null, // ~/.claude
    cookie_file: '~/.claude/claude-ai-session-cookie',
    org_id: DEFAULT_ORG_ID,
    enabled: true,
  };
}

/** Coerce one raw settings entry into a fully-populated ClaudeAccount, or null if it has no usable key. */
function normalizeAccount(raw: unknown): ClaudeAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === 'string' ? r.key.trim() : '';
  if (!key) return null;
  const configDir = typeof r.config_dir === 'string' && r.config_dir.trim() ? r.config_dir.trim() : null;
  return {
    key,
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : `Claude ${key.toUpperCase()}`,
    config_dir: configDir,
    cookie_file:
      typeof r.cookie_file === 'string' && r.cookie_file.trim()
        ? r.cookie_file.trim()
        : configDir
          ? `${configDir.replace(/\/$/, '')}/claude-ai-session-cookie`
          : '~/.claude/claude-ai-session-cookie',
    org_id: typeof r.org_id === 'string' && r.org_id.trim() ? r.org_id.trim() : null,
    // Default enabled=true unless explicitly false.
    enabled: r.enabled === false ? false : true,
  };
}

/**
 * The Claude account registry. Reads settings-KV `claude_accounts` (a JSON array).
 * When unset/empty/malformed, returns the single implicit default account 'a'
 * (`~/.claude`) so the single-subscription path is byte-identical to today.
 */
export function listClaudeAccounts(): ClaudeAccount[] {
  const rawSetting = getSetting(SETTINGS_KEY);
  if (!rawSetting || !rawSetting.trim()) return [defaultAccount()];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawSetting);
  } catch {
    return [defaultAccount()];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return [defaultAccount()];
  const seen = new Set<string>();
  const accounts: ClaudeAccount[] = [];
  for (const entry of parsed) {
    const acct = normalizeAccount(entry);
    if (!acct || seen.has(acct.key)) continue; // drop dupes; first key wins
    seen.add(acct.key);
    accounts.push(acct);
  }
  return accounts.length > 0 ? accounts : [defaultAccount()];
}

/** Fields the setup script / cockpit may set when registering an account. Omitted fields keep their prior value (or a sane default when the account is new). */
export interface ClaudeAccountInput {
  key: string;
  label?: string;
  /** `undefined` = leave as-is; `null` or `''` = explicit CLI default (`~/.claude`). */
  config_dir?: string | null;
  cookie_file?: string;
  /** `undefined` = leave as-is; `null` or `''` = unknown. */
  org_id?: string | null;
  enabled?: boolean;
}

/**
 * Create-or-update one account in the `claude_accounts` registry (settings-KV).
 * Starts from `listClaudeAccounts()` — which already synthesizes the implicit
 * default account 'a' when nothing is stored yet — so seeding a NEW account
 * (e.g. 'b') for the first time never silently drops 'a'. Returns the full
 * registry after the write. Idempotent: calling it again with the same input
 * re-applies the same fields (safe to re-run the setup script).
 */
export function upsertClaudeAccount(input: ClaudeAccountInput): ClaudeAccount[] {
  const key = input.key?.trim();
  if (!key) throw new Error('claude account key is required');
  const base = listClaudeAccounts();
  const idx = base.findIndex((a) => a.key === key);
  const prior = idx >= 0 ? base[idx] : null;

  const configDir =
    input.config_dir !== undefined ? (input.config_dir?.trim() || null) : (prior?.config_dir ?? null);
  const merged: ClaudeAccount = {
    key,
    label: input.label?.trim() || prior?.label || `Claude ${key.toUpperCase()}`,
    config_dir: configDir,
    cookie_file:
      input.cookie_file?.trim() ||
      prior?.cookie_file ||
      (configDir ? `${configDir.replace(/\/$/, '')}/claude-ai-session-cookie` : '~/.claude/claude-ai-session-cookie'),
    org_id: input.org_id !== undefined ? (input.org_id?.trim() || null) : (prior?.org_id ?? null),
    enabled: input.enabled !== undefined ? input.enabled : (prior?.enabled ?? true),
  };

  const next = idx >= 0 ? base.map((a, i) => (i === idx ? merged : a)) : [...base, merged];
  setSetting(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/** The usage file for an account: 'a' keeps the legacy path; others get a per-key file. */
export function usageFilePath(key: string): string {
  const base = USAGE_DIR.replace(/\/$/, '');
  return key === 'a' ? `${base}/claude-usage-live.json` : `${base}/claude-usage-${key}-live.json`;
}

interface UsageWindow {
  utilization?: number | null;
  /** Claude's own lockout marker for this window; null/absent when healthy. */
  locked_reason?: string | null;
  /** ISO 8601 instant this window rolls over (throttle §7.2). */
  resets_at?: string | null;
}

/**
 * Reads one account's usage snapshot. Account 'a' → /tmp/claude-usage-live.json
 * (unchanged); every other key → /tmp/claude-usage-<key>-live.json. Returns
 * stale=true when the file is missing or older than the staleness threshold.
 */
export function readAccountUsage(key: string): AccountUsage {
  const file = usageFilePath(key);
  try {
    const ageMinutes = (Date.now() - statSync(file).mtimeMs) / 60_000;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      five_hour?: UsageWindow | null;
      seven_day?: UsageWindow | null;
    };
    // A lock on EITHER window means the account can't serve right now.
    const locked =
      (typeof parsed.five_hour?.locked_reason === 'string' && parsed.five_hour.locked_reason.trim()
        ? parsed.five_hour.locked_reason.trim()
        : null) ??
      (typeof parsed.seven_day?.locked_reason === 'string' && parsed.seven_day.locked_reason.trim()
        ? parsed.seven_day.locked_reason.trim()
        : null);
    const iso = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return {
      five_hour: parsed.five_hour?.utilization ?? null,
      weekly: parsed.seven_day?.utilization ?? null,
      stale: ageMinutes > staleMinutesCeiling(),
      locked_reason: locked,
      five_hour_resets_at: iso(parsed.five_hour?.resets_at),
      weekly_resets_at: iso(parsed.seven_day?.resets_at),
    };
  } catch {
    return {
      five_hour: null,
      weekly: null,
      stale: true,
      locked_reason: null,
      five_hour_resets_at: null,
      weekly_resets_at: null,
    };
  }
}

/** Options for {@link selectActiveClaudeAccount}. */
export interface SelectAccountOptions {
  /**
   * Account key to leave out of selection entirely — used by the rate-limit
   * rescue (node #294) to pick the "next account that has headroom" after the
   * account a turn just ran on hit its wall. The excluded account is treated as
   * ineligible AND dropped from the fallback pool, so it can never be re-picked.
   * `null`/omitted = no exclusion → byte-identical to the single-arg call.
   */
  exclude?: string | null;
  /**
   * ⚡ THROTTLE §4.4: true only when this selection is about to launch a real
   * hopper WORKER. It selects `split` mode's strict-alternation ranking; every
   * other mode ignores it. Kevin's own interactive turns leave it false and rank
   * least-used under `split`, because alternating his chat turns would drop
   * native `--resume` sessions (session ids are per-account) for no benefit.
   */
  forSpawn?: boolean;
}

/**
 * Picks the account a new Claude worker should run on.
 *
 * Primary: among ENABLED, non-stale accounts whose 5h utilization is known and
 * below `ceiling`, choose the LEAST-used one (lowest five_hour). Ties resolve to
 * registry order, so selection is deterministic. This spreads concurrent workers
 * across accounts (parallel throughput) and also handles the serial swap: once
 * an account crosses the ceiling it stops being eligible and the other wins.
 *
 * `opts.exclude` removes one account key from consideration (the just-failed
 * account, for the mid-flight rate-limit rescue). It never appears eligible and
 * is never the fallback pick — so the rescue always lands on a DIFFERENT
 * subscription. When only the excluded account exists, `account` comes back
 * null (all exhausted → caller finishes/holds as today).
 *
 * Fallback ("so we still try"): if no account is eligible, return the enabled
 * (non-excluded) account with the lowest KNOWN five_hour; if none are readable,
 * the first enabled (non-excluded) account. Returns account=null only when every
 * account is disabled/excluded.
 */
/**
 * A weekly window is "spent" at 100% utilization. Unknown (null) is NOT treated
 * as spent — a missing weekly number must never take an otherwise-healthy
 * account out of rotation (the 5h + staleness gates already cover unreadable
 * usage), which keeps every pre-existing single-account path byte-identical.
 */
function isWeeklySpent(weekly: number | null): boolean {
  return weekly != null && weekly >= 100;
}

/** Inputs for {@link isAccountEligible}. */
export interface AccountEligibilityOptions {
  /** The 5h ceiling to compare against (`claudeFiveHourCeiling()` normally). */
  ceiling: number;
  /** Key to treat as ineligible (the rate-limit rescue's just-failed account). */
  exclude?: string | null;
  /**
   * Extra gate for the governor's HARD weekly mode: an account whose own weekly
   * window is at/above this ceiling is ineligible. `null`/omitted = soft mode
   * (weekly never blocks below 100), which is the selector's own behaviour and
   * the default.
   */
  weeklyCeiling?: number | null;
}

/**
 * THE one definition of "can this account serve a turn right now".
 *
 * Extracted (2026-09-24, throttle §4.6) because there were TWO: this file's
 * selector and hopper-governor's `withHeadroom`. They differed — the governor
 * lacked the weekly-spent and locked gates — so the governor could report OPEN
 * on an account the selector already considered unusable. That is precisely the
 * "a worker spawns onto an account that cannot serve it" failure the throttle's
 * account modes would otherwise amplify. Same predicate, both sides, one place.
 */
export function isAccountEligible(
  account: ClaudeAccount,
  usage: AccountUsage,
  opts: AccountEligibilityOptions,
): boolean {
  if (opts.exclude && account.key === opts.exclude) return false;
  if (!account.enabled) return false;
  if (usage.stale) return false;
  if (usage.five_hour == null || usage.five_hour >= opts.ceiling) return false;
  if (isWeeklySpent(usage.weekly)) return false;
  if (usage.locked_reason != null) return false;
  if (opts.weeklyCeiling != null && usage.weekly != null && usage.weekly >= opts.weeklyCeiling) return false;
  return true;
}

/** Look one account up in the registry by key. Null when it isn't registered. */
export function findClaudeAccount(key: string | null | undefined): ClaudeAccount | null {
  if (!key || !key.trim()) return null;
  const k = key.trim();
  return listClaudeAccounts().find((a) => a.key === k) ?? null;
}

export function selectActiveClaudeAccount(ceiling: number, opts?: SelectAccountOptions): AccountSelection {
  const excludeKey = opts?.exclude ?? null;
  const accounts = listClaudeAccounts();
  // WEEKLY GATE (tree-b32ef869 item 7 — long-standing bug, live on 2026-09-24):
  // the selector only ever looked at the 5h window, so an account whose WEEKLY
  // window was spent (100%) still read as eligible and kept winning the
  // least-used pick, sending every turn at an account that could not serve. A
  // spent weekly window, or a lock Claude reports directly, makes an account
  // ineligible for AUTO selection. An explicit per-thread pin still routes there
  // (agent.ts) — that is Kevin's call to make, not the selector's. The predicate
  // now lives in isAccountEligible() so the governor applies the same one.
  const perAccount: AccountUsageEntry[] = accounts.map((account) => {
    const usage = readAccountUsage(account.key);
    return { account, usage, eligible: isAccountEligible(account, usage, { ceiling, exclude: excludeKey }) };
  });

  // ⚡ THROTTLE §4.2 — filter then rank. `exclude` is applied BEFORE the mode
  // filter (it is baked into `eligible` above and re-applied to the fallback
  // pools below), so a mid-flight rate-limit rescue always leaves the account
  // that just hit the wall even under a focus mode naming it. At the default
  // mode `auto` the filter is the identity function and the ranking is
  // least-used, i.e. byte-identical to before the throttle existed.
  const plan = throttleClaudeCandidates(perAccount, { forSpawn: opts?.forSpawn === true });

  const pickLowest = (pool: AccountUsageEntry[]): ClaudeAccount | null => {
    let best: AccountUsageEntry | null = null;
    for (const e of pool) {
      if (e.usage.five_hour == null) continue;
      if (best == null || (e.usage.five_hour as number) < (best.usage.five_hour as number)) {
        best = e; // strict < keeps the earlier (registry-order) entry on ties
      }
    }
    return best?.account ?? null;
  };

  let account = plan.rank(plan.eligible);

  // §4.3 — FOCUS MODE HOLDS. 'a'/'b' are focus modes: Kevin picks "A only"
  // precisely to keep the other subscription untouched. Silently spilling onto B
  // would defeat the only reason to choose a focus mode, and it errs in the
  // irreversible direction (a hold is undone with one click; a spent weekly
  // window is not). He already has a first-class "A first, then B" — that is
  // `ordered`, which does spill. So: no eligible focused account ⇒ null, and no
  // fallback, rather than reaching for the other subscription.
  if (plan.focusKey) {
    return { account, allNames: accounts.map((a) => a.key), perAccount };
  }

  if (account == null) {
    // Fallback: every eligible slot is exhausted/stale. Still hand back something
    // to try — prefer an enabled account with a readable number, else the first
    // enabled account, else nothing (all disabled). The excluded key is dropped
    // from both fallback pools so a rescue never returns to the account that
    // just hit the wall.
    const enabledReadable = plan.narrow(perAccount).filter(
      (e) => e.account.enabled && e.account.key !== excludeKey && e.usage.five_hour != null,
    );
    // Prefer a fallback that isn't weekly-spent/locked — those genuinely cannot
    // serve, so reaching for one is strictly worse than reaching for an account
    // that is merely over its 5h ceiling (which resets in hours, not days). If
    // every fallback is spent we still hand one back rather than nothing, so the
    // "always try something" contract is unchanged.
    const servable = enabledReadable.filter((e) => !isWeeklySpent(e.usage.weekly) && e.usage.locked_reason == null);
    account =
      pickLowest(servable) ??
      pickLowest(enabledReadable) ??
      plan.narrow(perAccount).find((e) => e.account.enabled && e.account.key !== excludeKey)?.account ??
      null;
  }

  return { account, allNames: accounts.map((a) => a.key), perAccount };
}

// ─── PER-TURN ACCOUNT DECISION (tree-b32ef869) ────────────────────────────────
// The whole "which account does THIS turn run on, and do we have to drop the
// native session to get there" decision, as one pure function so it can be unit
// tested without spawning a CLI. src/agent.ts's runConversationTurn is the only
// caller; it previously carried this logic inline.

/** What {@link decideClaudeAccountForTurn} needs to know about the thread. */
export interface ClaudeAccountTurnInput {
  /** `conversations.pinned_claude_account` — Kevin's explicit pick, or null for Auto. */
  pinnedKey: string | null;
  /** The thread's live `claude --resume` id, or null when there is no session yet. */
  sessionId: string | null;
  /**
   * `conversations.session_account`, already coalesced by the caller for legacy
   * threads (null session_account + a live session ⇒ 'a', the pre-multi-claude
   * default). Null = unknown/non-claude ⇒ no forced session drop.
   */
  storedAccount: string | null;
  /** The live least-used selection for this moment. */
  selection: AccountSelection;
}

export interface ClaudeAccountTurnDecision {
  /** The account to run on (null only when nothing is usable at all). */
  account: ClaudeAccount | null;
  /** True when the caller must null out its session id and start fresh. */
  dropSession: boolean;
  /** 'pin' when an explicit per-thread pin decided it, else 'auto'. */
  source: 'pin' | 'auto';
  /** Why a present pin was ignored (null when there was no pin, or it applied). */
  pinIgnoredReason: 'unknown_account' | 'disabled' | null;
}

/**
 * Resolve the Claude account for one turn.
 *
 * Precedence: an explicit per-thread PIN > session stickiness > least-used.
 *
 * A pin wins even when the pinned account is over its 5h ceiling — the ceiling
 * paces unattended workers, and a pin is a human instruction on a human turn
 * (hopper workers stay gated by the governor, which this never touches). A pin
 * also outranks session stickiness, since otherwise a thread with a live
 * session could never be moved to the other subscription; moving means dropping
 * the session, because `claude --resume` ids live inside one account's
 * CLAUDE_CONFIG_DIR.
 *
 * A pin naming an account that is no longer registered, or is disabled, is
 * IGNORED (reported via `pinIgnoredReason`) and the normal selection applies —
 * a stale pin must never hard-fail a turn.
 *
 * With `pinnedKey: null` this is byte-identical to the pre-pin behavior.
 */
export function decideClaudeAccountForTurn(input: ClaudeAccountTurnInput): ClaudeAccountTurnDecision {
  const { sessionId, storedAccount, selection } = input;
  let account = selection.account;
  let source: 'pin' | 'auto' = 'auto';
  let pinIgnoredReason: ClaudeAccountTurnDecision['pinIgnoredReason'] = null;

  const pinnedKey = input.pinnedKey?.trim() || null;
  if (pinnedKey) {
    const pinned = findClaudeAccount(pinnedKey);
    if (!pinned) pinIgnoredReason = 'unknown_account';
    else if (!pinned.enabled) pinIgnoredReason = 'disabled';
    else {
      account = pinned;
      source = 'pin';
    }
  }

  let dropSession = false;
  if (sessionId && storedAccount && account && storedAccount !== account.key) {
    // STICKINESS: a live session stays on the account it was created under for
    // as long as that account is still eligible — unless a pin says otherwise.
    const stored = selection.perAccount.find((e) => e.account.key === storedAccount);
    if (stored?.eligible && source !== 'pin') {
      account = stored.account;
    } else {
      dropSession = true;
    }
  }

  return { account, dropSession, source, pinIgnoredReason };
}
