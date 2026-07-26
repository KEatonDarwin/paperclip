import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CODEX_BIN = process.env.CODEX_BIN?.trim() || 'codex';
const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
const OUT_FILE = process.env.CODEX_USAGE_OUT_FILE?.trim() || '/tmp/codex-usage-live.json';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CODEX_USAGE_TIMEOUT_MS ?? '10000', 10);

type UsageWindowSnapshot = {
  label: string;
  used_percentage: number | null;
  resets_at: number | null;
  value_label?: string | null;
  detail?: string | null;
};

type CodexUsageSnapshot = {
  provider: 'openai_codex';
  updated_at: number;
  source: 'codex-app-server' | 'codex-wham' | 'none';
  windows: UsageWindowSnapshot[];
  plan: string | null;
  email: string | null;
  error?: string;
};

type RpcMessage = {
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

type PendingRpcRequest = {
  resolve: (message: RpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type CodexRpcWindow = {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
};

type CodexRpcCredits = {
  hasCredits?: boolean | null;
  unlimited?: boolean | null;
  balance?: string | number | null;
};

type CodexRpcLimit = {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRpcWindow | null;
  secondary?: CodexRpcWindow | null;
  credits?: CodexRpcCredits | null;
  planType?: string | null;
};

type CodexRpcRateLimitsResult = {
  rateLimits?: CodexRpcLimit | null;
  rateLimitsByLimitId?: Record<string, CodexRpcLimit> | null;
};

type CodexRpcAccountResult = {
  account?: {
    email?: string | null;
    planType?: string | null;
  } | null;
};

type WhamWindow = {
  used_percent?: number | null;
  limit_window_seconds?: number | null;
  reset_at?: string | number | null;
  reset_after_seconds?: number | null;
};

type WhamCredits = {
  has_credits?: boolean | null;
  unlimited?: boolean | null;
  balance?: string | number | null;
};

type WhamUsageResponse = {
  plan_type?: string | null;
  rate_limit?: {
    primary_window?: WhamWindow | null;
    secondary_window?: WhamWindow | null;
  } | null;
  credits?: WhamCredits | null;
};

type CodexAuthInfo = {
  accessToken: string;
  accountId: string | null;
  idToken: string | null;
};

class CodexRpcClient {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = '';
  private stderr = '';
  private pending = new Map<number, PendingRpcRequest>();

  constructor() {
    this.proc = spawn(CODEX_BIN, ['-s', 'read-only', '-a', 'untrusted', 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME },
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.proc.on('error', (error) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
    });
    this.proc.on('exit', (code) => {
      const message = this.stderr.trim() || `codex app-server exited with code ${code ?? 'unknown'}`;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(message));
      }
      this.pending.clear();
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;

      let parsed: RpcMessage;
      try {
        parsed = JSON.parse(line) as RpcMessage;
      } catch {
        continue;
      }

      const id = typeof parsed.id === 'number' ? parsed.id : null;
      if (id == null) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);

      if (parsed.error) {
        pending.reject(new Error(formatRpcError(parsed.error)));
      } else {
        pending.resolve(parsed);
      }
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<RpcMessage> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server timed out on ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(payload);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.proc.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  shutdown(): void {
    if (!this.proc.killed) this.proc.kill('SIGTERM');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatRpcError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return JSON.stringify(error);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePercent(value: unknown): number | null {
  const raw = finiteNumber(value);
  if (raw == null) return null;
  const pct = raw < 1 ? raw * 100 : raw;
  return Math.max(0, Math.min(100, pct));
}

function windowLabelFromMinutes(minutes: number | null | undefined, fallback: string): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return days === 7 ? '7-day' : `${days}-day`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 5 ? '5-hour' : `${hours}-hour`;
  }
  return `${minutes}-minute`;
}

function windowLabelFromSeconds(seconds: number | null | undefined, fallback: string): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return fallback;
  return windowLabelFromMinutes(Math.round(seconds / 60), fallback);
}

function resetAtToSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }
  return null;
}

function valueLabelForCredits(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return value.trim();
    return `$${parsed.toFixed(2)} remaining`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `$${value.toFixed(2)} remaining`;
  }
  return null;
}

function buildRpcWindow(label: string, window: CodexRpcWindow | null | undefined): UsageWindowSnapshot | null {
  if (!window) return null;
  const usedPercentage = normalizePercent(window.usedPercent);
  if (usedPercentage == null && window.resetsAt == null) return null;
  return {
    label,
    used_percentage: usedPercentage,
    resets_at: resetAtToSeconds(window.resetsAt),
  };
}

function buildWhamWindow(label: string, window: WhamWindow | null | undefined): UsageWindowSnapshot | null {
  if (!window) return null;
  const usedPercentage = normalizePercent(window.used_percent);
  if (usedPercentage == null && window.reset_at == null) return null;
  return {
    label,
    used_percentage: usedPercentage,
    resets_at: resetAtToSeconds(window.reset_at),
  };
}

function maybeAddCredits(windows: UsageWindowSnapshot[], credits: CodexRpcCredits | WhamCredits | null | undefined): void {
  if (!credits || credits.unlimited === true) return;
  const balance = credits.balance;
  const hasCredits =
    ('hasCredits' in credits && credits.hasCredits === true) ||
    ('has_credits' in credits && credits.has_credits === true);
  if (!hasCredits && balance == null) return;
  windows.push({
    label: 'Credits',
    used_percentage: null,
    resets_at: null,
    value_label: valueLabelForCredits(balance) ?? 'N/A',
  });
}

function buildSnapshotFromRpc(limits: CodexRpcRateLimitsResult, account: CodexRpcAccountResult | null): CodexUsageSnapshot {
  const windows: UsageWindowSnapshot[] = [];
  const rootLimit = limits.rateLimits ?? null;
  const limitsById = limits.rateLimitsByLimitId ?? {};
  const orderedIds = ['codex', ...Object.keys(limitsById).filter((id) => id !== 'codex')];
  const allLimits = new Map<string, CodexRpcLimit>();
  if (rootLimit?.limitId) allLimits.set(rootLimit.limitId, rootLimit);
  if (rootLimit && !rootLimit.limitId) allLimits.set('codex', rootLimit);
  for (const [id, limit] of Object.entries(limitsById)) allLimits.set(id, limit);

  for (const limitId of orderedIds) {
    const limit = allLimits.get(limitId);
    if (!limit) continue;
    const prefix = limitId === 'codex' ? '' : `${limit.limitName ?? limitId} - `;
    const primaryLabel = `${prefix}${windowLabelFromMinutes(limit.primary?.windowDurationMins, '5-hour')}`;
    const secondaryLabel = `${prefix}${windowLabelFromMinutes(limit.secondary?.windowDurationMins, '7-day')}`;
    const primary = buildRpcWindow(primaryLabel, limit.primary);
    const secondary = buildRpcWindow(secondaryLabel, limit.secondary);
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
    if (limitId === 'codex') maybeAddCredits(windows, limit.credits);
  }

  return {
    provider: 'openai_codex',
    source: 'codex-app-server',
    updated_at: Math.floor(Date.now() / 1000),
    windows,
    plan: account?.account?.planType ?? rootLimit?.planType ?? null,
    email: account?.account?.email ?? null,
  };
}

async function fetchFromCodexRpc(): Promise<CodexUsageSnapshot> {
  const client = new CodexRpcClient();
  try {
    await client.request('initialize', {
      clientInfo: { name: 'jarvis-provider-usage', version: '0.0.0' },
    });
    client.notify('initialized', {});
    const limitsMessage = await client.request('account/rateLimits/read');
    const accountMessage = await client.request('account/read').catch(() => ({ result: null }));
    return buildSnapshotFromRpc(
      isRecord(limitsMessage.result) ? (limitsMessage.result as CodexRpcRateLimitsResult) : {},
      isRecord(accountMessage.result) ? (accountMessage.result as CodexRpcAccountResult) : null,
    );
  } finally {
    client.shutdown();
  }
}

function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const [, payload] = token.split('.');
  if (!payload) return null;
  let normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  if (remainder) normalized += '='.repeat(4 - remainder);
  try {
    const parsed = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function emailFromToken(idToken: string | null): string | null {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return null;
  if (typeof payload.email === 'string') return payload.email;
  const profile = payload['https://api.openai.com/profile'];
  if (isRecord(profile) && typeof profile.email === 'string') return profile.email;
  return null;
}

async function readCodexAuth(): Promise<CodexAuthInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(join(CODEX_HOME, 'auth.json'), 'utf8')) as unknown;
    if (!isRecord(parsed)) return null;
    const tokens = isRecord(parsed.tokens) ? parsed.tokens : {};
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : null;
    if (!accessToken) return null;
    return {
      accessToken,
      accountId: typeof tokens.account_id === 'string' ? tokens.account_id : null,
      idToken: typeof tokens.id_token === 'string' ? tokens.id_token : null,
    };
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromWham(): Promise<CodexUsageSnapshot> {
  const auth = await readCodexAuth();
  if (!auth) throw new Error('no local Codex ChatGPT login found');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'JARVIS Provider Usage',
  };
  if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;

  const response = await fetchWithTimeout('https://chatgpt.com/backend-api/wham/usage', {
    method: 'GET',
    headers,
  });
  if (!response.ok) throw new Error(`chatgpt wham usage returned HTTP ${response.status}`);
  const body = (await response.json()) as WhamUsageResponse;
  const windows: UsageWindowSnapshot[] = [];
  const primary = body.rate_limit?.primary_window ?? null;
  const secondary = body.rate_limit?.secondary_window ?? null;
  const primaryWindow = buildWhamWindow(
    windowLabelFromSeconds(primary?.limit_window_seconds, '5-hour'),
    primary,
  );
  const secondaryWindow = buildWhamWindow(
    windowLabelFromSeconds(secondary?.limit_window_seconds, '7-day'),
    secondary,
  );
  if (primaryWindow) windows.push(primaryWindow);
  if (secondaryWindow) windows.push(secondaryWindow);
  maybeAddCredits(windows, body.credits);

  return {
    provider: 'openai_codex',
    source: 'codex-wham',
    updated_at: Math.floor(Date.now() / 1000),
    windows,
    plan: body.plan_type ?? null,
    email: emailFromToken(auth.idToken),
  };
}

function errorSnapshot(errors: string[]): CodexUsageSnapshot {
  return {
    provider: 'openai_codex',
    source: 'none',
    updated_at: Math.floor(Date.now() / 1000),
    windows: [],
    plan: null,
    email: null,
    error: errors.join('; ') || 'Codex usage unavailable',
  };
}

async function writeSnapshot(snapshot: CodexUsageSnapshot): Promise<void> {
  const tmp = `${OUT_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  await rename(tmp, OUT_FILE);
}

async function main(): Promise<void> {
  const errors: string[] = [];
  for (const fetcher of [fetchFromCodexRpc, fetchFromWham]) {
    try {
      const snapshot = await fetcher();
      await writeSnapshot(snapshot);
      return;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  await writeSnapshot(errorSnapshot(errors));
  throw new Error(errors.join('; '));
}

main().catch((error) => {
  console.error(`[codex-usage-poll] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
