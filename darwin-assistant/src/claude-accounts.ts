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
import { getSetting } from './conversation-db.js';

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

/** The usage file for an account: 'a' keeps the legacy path; others get a per-key file. */
export function usageFilePath(key: string): string {
  const base = USAGE_DIR.replace(/\/$/, '');
  return key === 'a' ? `${base}/claude-usage-live.json` : `${base}/claude-usage-${key}-live.json`;
}

interface UsageWindow {
  utilization?: number | null;
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
    return {
      five_hour: parsed.five_hour?.utilization ?? null,
      weekly: parsed.seven_day?.utilization ?? null,
      stale: ageMinutes > staleMinutesCeiling(),
    };
  } catch {
    return { five_hour: null, weekly: null, stale: true };
  }
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
 * Fallback ("so we still try"): if no account is eligible, return the enabled
 * account with the lowest KNOWN five_hour; if none are readable, the first
 * enabled account. Returns account=null only when every account is disabled.
 */
export function selectActiveClaudeAccount(ceiling: number): AccountSelection {
  const accounts = listClaudeAccounts();
  const perAccount: AccountUsageEntry[] = accounts.map((account) => {
    const usage = readAccountUsage(account.key);
    const eligible =
      account.enabled && !usage.stale && usage.five_hour != null && usage.five_hour < ceiling;
    return { account, usage, eligible };
  });

  const pickLowest = (pool: AccountUsageEntry[]): ClaudeAccount | null => {
    let best: AccountUsageEntry | null = null;
    for (const e of pool) {
      if (best == null || (e.usage.five_hour as number) < (best.usage.five_hour as number)) {
        best = e; // strict < keeps the earlier (registry-order) entry on ties
      }
    }
    return best?.account ?? null;
  };

  let account = pickLowest(perAccount.filter((e) => e.eligible));

  if (account == null) {
    // Fallback: every eligible slot is exhausted/stale. Still hand back something
    // to try — prefer an enabled account with a readable number, else the first
    // enabled account, else nothing (all disabled).
    const enabledReadable = perAccount.filter(
      (e) => e.account.enabled && e.usage.five_hour != null,
    );
    account = pickLowest(enabledReadable) ?? accounts.find((a) => a.enabled) ?? null;
  }

  return { account, allNames: accounts.map((a) => a.key), perAccount };
}
