// GOALS GUARDS — the Overwatch rules API client (CONTRACT §12, GUARDS-RECON.md).
//
// The ONE place guard traffic reaches Overwatch. All auth / degrade / URL logic
// lives here so the rest of the guard code (goals-guards.ts) never sees a raw
// fetch. Every call is best-effort and NEVER throws into a caller — it returns
// { ok: true, … } or { ok: false, status, error }. A missing key/URL is not an
// error the caller must handle specially: `isConfigured()` is false and the
// callers degrade (accept → 503 overwatch_not_connected, poller → no-op).
//
// Env (all optional; Guards degrade cleanly without them — CONTRACT §12.12):
//   OVERWATCH_API_URL  e.g. https://health.thedarwinhub.com  (we append /api/v1/overwatch/rules)
//   OVERWATCH_API_KEY  bearer for the rule API (a MONITORING key — never a model call)
//
// Read straight from process.env on every call (no caching) so the moment
// Kevin drops the key in .env + restarts, guards start writing/reading with no
// code change — and so the sim can point the URL at a fake server per-request.

const RULES_PATH = '/api/v1/overwatch/rules';
const TIMEOUT_MS = 10_000;

export interface OwLastResult {
  status: string | null; // ok | warn | fail | error  (never 'stale' — derived at read time)
  value: number | null;
  summary: string | null;
  at: string | null;
}

export type OwErr = { ok: false; status: number; error: string };
export type OwResult<T> = ({ ok: true } & T) | OwErr;
export type OwVoid = { ok: true } | OwErr;

/** Raw base, e.g. `https://health.thedarwinhub.com` (trailing slash stripped) or null. */
export function overwatchBaseUrl(): string | null {
  const raw = (process.env.OVERWATCH_API_URL ?? '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function apiKey(): string | null {
  const raw = (process.env.OVERWATCH_API_KEY ?? '').trim();
  return raw || null;
}

/** True only when BOTH the base URL and the bearer key are present. */
export function isConfigured(): boolean {
  return overwatchBaseUrl() !== null && apiKey() !== null;
}

/** The Overwatch dashboard link (base + /overwatch), or null when unconfigured. */
export function dashboardUrl(): string | null {
  const base = overwatchBaseUrl();
  return base ? `${base}/overwatch` : null;
}

async function owFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; status: number; json: unknown } | { ok: false; status: number; error: string }> {
  const base = overwatchBaseUrl();
  const key = apiKey();
  if (!base || !key) {
    // 503 semantics: not configured. Callers translate to overwatch_not_connected.
    return { ok: false, status: 503, error: 'Overwatch not configured (OVERWATCH_API_URL/OVERWATCH_API_KEY unset)' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${RULES_PATH}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = { error: text }; }
    }
    if (!res.ok) {
      const err = (json && typeof json === 'object' && 'error' in json)
        ? String((json as { error: unknown }).error)
        : `Overwatch responded ${res.status}`;
      return { ok: false, status: res.status, error: err };
    }
    return { ok: true, status: res.status, json };
  } catch (err) {
    // Network error / timeout / DNS — status 0 = "couldn't reach it" (transient).
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** POST /rules — returns the server-generated key on success (RECON §2). */
export async function createRule(
  payload: Record<string, unknown>,
): Promise<OwResult<{ key: string; dashboard_url: string | null }>> {
  const r = await owFetch('POST', '', payload);
  if (!r.ok) return r;
  const j = r.json as { key?: unknown; dashboard_url?: unknown } | null;
  const key = j && typeof j.key === 'string' ? j.key : '';
  if (!key) return { ok: false, status: 502, error: 'Overwatch create returned no key' };
  const dash = j && typeof j.dashboard_url === 'string' ? j.dashboard_url : dashboardUrl();
  return { ok: true, key, dashboard_url: dash };
}

/** GET /rules/{key} — returns last_result (null when never run). RECON §3. */
export async function getRule(key: string): Promise<OwResult<{ last_result: OwLastResult | null }>> {
  const r = await owFetch('GET', `/${encodeURIComponent(key)}`, undefined);
  if (!r.ok) return r;
  const j = r.json as { last_result?: unknown } | null;
  const lr = j && j.last_result && typeof j.last_result === 'object'
    ? (j.last_result as OwLastResult)
    : null;
  return { ok: true, last_result: lr };
}

/** PATCH /rules/{key} — merge-patch (RECON §4). */
export async function patchRule(key: string, payload: Record<string, unknown>): Promise<OwVoid> {
  const r = await owFetch('PATCH', `/${encodeURIComponent(key)}`, payload);
  if (!r.ok) return r;
  return { ok: true };
}

/** DELETE /rules/{key} — a 404 (already gone) is surfaced as status 404 (callers tolerate it). */
export async function deleteRule(key: string): Promise<OwVoid> {
  const r = await owFetch('DELETE', `/${encodeURIComponent(key)}`, undefined);
  if (!r.ok) return r;
  return { ok: true };
}
