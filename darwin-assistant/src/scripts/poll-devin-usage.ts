import Database from 'better-sqlite3';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const API_BASE = process.env.DEVIN_API_BASE?.trim() || 'https://api.devin.ai/v3';
const API_KEY = process.env.DEVIN_API_KEY?.trim() || '';
const OUT_FILE = process.env.DEVIN_USAGE_FILE?.trim() || process.env.DEVIN_USAGE_OUT_FILE?.trim() || '/tmp/devin-usage-live.json';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.DEVIN_USAGE_TIMEOUT_MS ?? '10000', 10);
const DEFAULT_WINDOW_DAYS = 30;

type UsageWindowSnapshot = {
  label: string;
  used_percentage: number | null;
  resets_at: number | null;
  value_label?: string | null;
  detail?: string | null;
};

type DevinUsageSnapshot = {
  provider: 'devin';
  status: 'ok' | 'key_needed' | 'error';
  plan: string | null;
  email: string | null;
  updated_at: number;
  source: 'devin-consumption' | 'devin-sessions' | 'key-needed' | 'none';
  windows: UsageWindowSnapshot[];
  used_acus: number | null;
  pool_acus: number | null;
  ceiling_acus: number | null;
  cycle_start: string | null;
  cycle_end: string | null;
  error: string | null;
};

type DevinSelf = {
  org_id?: string | null;
};

type DevinConsumptionResponse = {
  total_acus?: number | string | null;
};

type DevinSession = {
  acus_consumed?: number | string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type DevinSessionsPage = {
  items?: DevinSession[] | null;
  data?: DevinSession[] | null;
  has_next_page?: boolean | null;
  end_cursor?: string | null;
};

class DevinHttpError extends Error {
  constructor(
    public status: number,
    public path: string,
    message: string,
  ) {
    super(`Devin ${path} returned HTTP ${status}${message ? `: ${message}` : ''}`);
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fmtAcus(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function settingFromDb(key: string): string | null {
  const dbPath = process.env.JARVIS_DB_PATH?.trim() || join(process.cwd(), 'jarvis.db');
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare<[string], { value: string | null }>('SELECT value FROM settings WHERE key = ?').get(key);
    return typeof row?.value === 'string' && row.value.trim() ? row.value.trim() : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // best effort
    }
  }
}

function setting(key: string, envKeys: string[] = []): string | null {
  const fromDb = settingFromDb(key);
  if (fromDb) return fromDb;
  const generatedEnv = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  for (const envKey of [generatedEnv, ...envKeys]) {
    const value = process.env[envKey]?.trim();
    if (value) return value;
  }
  return null;
}

function parsePositiveNumberSetting(key: string, envKeys: string[] = []): number | null {
  const parsed = finiteNumber(setting(key, envKeys));
  return parsed != null && parsed > 0 ? parsed : null;
}

function parseDateSetting(raw: string | null): Date | null {
  if (!raw) return null;
  const stamp = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
  const parsed = new Date(stamp);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function cycleWindow(): { start: Date; end: Date | null; configured: boolean } {
  const start = parseDateSetting(setting('devin_billing_cycle_start', ['DEVIN_BILLING_CYCLE_START']));
  const end = parseDateSetting(setting('devin_billing_cycle_end', ['DEVIN_BILLING_CYCLE_END']));
  if (start) return { start, end, configured: true };
  return {
    start: new Date(Date.now() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000),
    end: null,
    configured: false,
  };
}

async function fetchJson<T>(path: string, query?: Record<string, string>): Promise<T> {
  const url = new URL(`${API_BASE.replace(/\/+$/, '')}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json',
        'User-Agent': 'JARVIS Devin Usage',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 500);
      throw new DevinHttpError(response.status, path, sanitizeErrorText(body));
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeErrorText(text: string): string {
  return text.replace(API_KEY, '[redacted]').replace(/\s+/g, ' ').trim();
}

async function discoverOrgId(): Promise<string> {
  const explicit = process.env.DEVIN_ORG_ID?.trim();
  if (explicit) return explicit;
  const self = await fetchJson<DevinSelf>('/self');
  if (typeof self.org_id === 'string' && self.org_id.trim()) return self.org_id.trim();
  throw new Error('Devin /self did not return org_id');
}

async function fetchConsumption(orgId: string, start: Date, end: Date | null): Promise<number> {
  const body = await fetchJson<DevinConsumptionResponse>(`/organizations/${encodeURIComponent(orgId)}/consumption/daily`, {
    time_after: start.toISOString(),
    time_before: (end ?? new Date()).toISOString(),
  });
  const total = finiteNumber(body.total_acus);
  if (total == null || total < 0) throw new Error('Devin consumption response did not include total_acus');
  return total;
}

function sessionTimestamp(session: DevinSession): number | null {
  const raw = session.created_at ?? session.updated_at ?? null;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function sessionInWindow(session: DevinSession, start: Date, end: Date | null): boolean {
  const ts = sessionTimestamp(session);
  if (ts == null) return true;
  if (ts < start.getTime()) return false;
  if (end && ts > end.getTime()) return false;
  return true;
}

async function fetchSessionSum(orgId: string, start: Date, end: Date | null): Promise<number> {
  let after: string | null = null;
  let total = 0;
  for (let page = 0; page < 25; page += 1) {
    const query: Record<string, string> = { first: '200' };
    if (after) query.after = after;
    const body = await fetchJson<DevinSessionsPage>(`/organizations/${encodeURIComponent(orgId)}/sessions`, query);
    const items = Array.isArray(body.items) ? body.items : Array.isArray(body.data) ? body.data : [];
    for (const session of items) {
      if (!sessionInWindow(session, start, end)) continue;
      const acus = finiteNumber(session.acus_consumed);
      if (acus != null && acus > 0) total += acus;
    }
    if (!body.has_next_page || !body.end_cursor) break;
    after = body.end_cursor;
  }
  return total;
}

function noKeySnapshot(): DevinUsageSnapshot {
  return {
    provider: 'devin',
    status: 'key_needed',
    plan: 'connected',
    email: null,
    updated_at: nowSeconds(),
    source: 'key-needed',
    windows: [
      {
        label: 'ACUs',
        used_percentage: null,
        resets_at: null,
        value_label: 'key needed for usage',
        detail: 'Add DEVIN_API_KEY to darwin-assistant/.env to enable the ACU meter.',
      },
    ],
    used_acus: null,
    pool_acus: null,
    ceiling_acus: null,
    cycle_start: null,
    cycle_end: null,
    error: null,
  };
}

function buildSnapshot(
  usedAcus: number,
  source: DevinUsageSnapshot['source'],
  start: Date,
  end: Date | null,
  configuredCycle: boolean,
): DevinUsageSnapshot {
  const pool = parsePositiveNumberSetting('devin_acu_pool', ['DEVIN_ACU_POOL']);
  const ceiling = parsePositiveNumberSetting('gov_devin_acu_ceiling', ['GOV_DEVIN_ACU_CEILING', 'HOPPER_GOV_DEVIN_ACU_CEILING']) ?? pool;
  const pct = pool ? Math.max(0, Math.min(100, (usedAcus / pool) * 100)) : null;
  const valueLabel = pool
    ? `${fmtAcus(usedAcus)} / ${fmtAcus(pool)} ACUs used`
    : `${fmtAcus(usedAcus)} ACUs used`;
  const detailParts = [
    configuredCycle ? 'Current configured Devin billing cycle.' : `Last ${DEFAULT_WINDOW_DAYS} days; set devin_billing_cycle_start/end for cycle resets.`,
  ];
  if (ceiling != null) detailParts.push(`JARVIS ceiling: ${fmtAcus(ceiling)} ACUs.`);
  if (source === 'devin-sessions') detailParts.push('Consumption endpoint unavailable; summed sessions fallback.');
  return {
    provider: 'devin',
    status: 'ok',
    plan: 'connected',
    email: null,
    updated_at: nowSeconds(),
    source,
    windows: [
      {
        label: 'ACUs',
        used_percentage: pct,
        resets_at: end ? Math.floor(end.getTime() / 1000) : null,
        value_label: valueLabel,
        detail: detailParts.join(' '),
      },
    ],
    used_acus: usedAcus,
    pool_acus: pool,
    ceiling_acus: ceiling,
    cycle_start: configuredCycle ? start.toISOString() : null,
    cycle_end: end ? end.toISOString() : null,
    error: null,
  };
}

function errorSnapshot(error: unknown): DevinUsageSnapshot {
  const message = sanitizeErrorText(error instanceof Error ? error.message : String(error));
  return {
    provider: 'devin',
    status: 'error',
    plan: 'connected',
    email: null,
    updated_at: nowSeconds(),
    source: 'none',
    windows: [
      {
        label: 'ACUs',
        used_percentage: null,
        resets_at: null,
        value_label: 'usage unavailable',
        detail: message,
      },
    ],
    used_acus: null,
    pool_acus: parsePositiveNumberSetting('devin_acu_pool', ['DEVIN_ACU_POOL']),
    ceiling_acus: parsePositiveNumberSetting('gov_devin_acu_ceiling', ['GOV_DEVIN_ACU_CEILING', 'HOPPER_GOV_DEVIN_ACU_CEILING']),
    cycle_start: null,
    cycle_end: null,
    error: message || 'Devin usage unavailable',
  };
}

async function writeSnapshot(snapshot: DevinUsageSnapshot): Promise<void> {
  const tmp = `${OUT_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  await rename(tmp, OUT_FILE);
}

async function main(): Promise<void> {
  if (!API_KEY) {
    await writeSnapshot(noKeySnapshot());
    return;
  }

  const orgId = await discoverOrgId();
  const { start, end, configured } = cycleWindow();
  try {
    const used = await fetchConsumption(orgId, start, end);
    await writeSnapshot(buildSnapshot(used, 'devin-consumption', start, end, configured));
  } catch (error) {
    if (error instanceof DevinHttpError && error.status === 403) {
      const used = await fetchSessionSum(orgId, start, end);
      await writeSnapshot(buildSnapshot(used, 'devin-sessions', start, end, configured));
      return;
    }
    throw error;
  }
}

main().catch(async (error) => {
  await writeSnapshot(errorSnapshot(error)).catch(() => {});
  console.error(`[devin-usage-poll] ${error instanceof Error ? sanitizeErrorText(error.message) : String(error)}`);
  process.exitCode = 1;
});
