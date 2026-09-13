// DEVIN REST v3 CLIENT — dispatch-side. Talks to https://api.devin.ai/v3 on
// Kevin's DEVIN_API_KEY. See docs/devin-jobs/CONTRACT.md section 4 for the
// endpoint contract this mirrors (the contract calls this module
// `src/devin-api.ts`; it lives here as `devin-client.ts` per the dispatch
// task spec — same shape, same job).
//
// Hard rule: NEVER log DEVIN_API_KEY, NEVER echo request headers, NEVER put
// the key or a full prompt body into a thrown error. Sanitized errors carry
// only HTTP status + Devin's own error code/message + the endpoint path.

const DEVIN_API_BASE = (process.env.DEVIN_API_BASE ?? 'https://api.devin.ai/v3').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 20_000;

export class DevinKeyMissing extends Error {
  readonly code = 'devin_key_missing' as const;
  readonly status = 409 as const;
  constructor() {
    super(
      'DEVIN_API_KEY is not configured. Mint one at app.devin.ai -> Settings -> API Keys and add it to darwin-assistant/.env.',
    );
    this.name = 'DevinKeyMissing';
  }
}

export class DevinApiError extends Error {
  readonly code = 'devin_api_error' as const;
  readonly status: number;
  readonly devinCode: string | null;
  constructor(status: number, message: string, devinCode: string | null = null) {
    super(message);
    this.name = 'DevinApiError';
    this.status = status;
    this.devinCode = devinCode;
  }
}

export function hasDevinKey(): boolean {
  return !!process.env.DEVIN_API_KEY?.trim();
}

function requireKey(): string {
  const key = process.env.DEVIN_API_KEY?.trim();
  if (!key) throw new DevinKeyMissing();
  return key;
}

export type DevinMode = 'normal' | 'fast' | 'lite' | 'ultra' | 'fusion';
export const DEVIN_MODES: readonly DevinMode[] = ['normal', 'fast', 'lite', 'ultra', 'fusion'];

export type DevinSessionStatus = 'new' | 'claimed' | 'running' | 'exit' | 'error' | 'suspended' | 'resuming';

export type DevinSessionStatusDetail =
  | 'working'
  | 'waiting_for_user'
  | 'waiting_for_approval'
  | 'finished'
  | 'inactivity'
  | 'user_request'
  | 'usage_limit_exceeded'
  | 'out_of_credits'
  | 'out_of_quota'
  | 'no_quota_allocation'
  | 'payment_declined'
  | 'org_usage_limit_exceeded'
  | 'user_usage_limit_exceeded'
  | 'total_session_limit_exceeded'
  | 'error';

export interface DevinSession {
  session_id: string;
  title?: string | null;
  status: DevinSessionStatus | string;
  status_detail?: DevinSessionStatusDetail | string | null;
  acus_consumed?: number | null;
  url?: string | null;
  structured_output?: unknown;
  tags?: string[] | null;
  devin_mode?: string | null;
  created_at?: string | null;
}

interface DevinSelfResponse {
  org_id?: string;
  [key: string]: unknown;
}

// The default finish-contract schema (CONTRACT.md section 8). Sent whenever a
// caller doesn't supply its own structured_output_schema.
export const DEFAULT_STRUCTURED_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary'],
  properties: {
    outcome: { type: 'string', enum: ['done', 'blocked'] },
    summary: { type: 'string', minLength: 1 },
    branch: { type: ['string', 'null'] },
    commits: { type: ['array', 'null'], items: { type: 'string' } },
    notes: { type: ['array', 'null'], items: { type: 'string' } },
  },
};

let cachedOrgId: string | null = null;

async function devinFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const key = requireKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${DEVIN_API_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new DevinApiError(0, aborted ? `Devin API request timed out: ${path}` : `Devin API request failed: ${path}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-JSON body — leave parsed as null, status code still tells the story
    }
  }

  if (!res.ok) {
    const body = (parsed ?? {}) as { message?: string; error?: string; detail?: string };
    const devinMessage = body.message ?? body.detail ?? body.error ?? null;
    throw new DevinApiError(
      res.status,
      devinMessage ? `Devin API ${res.status} on ${path}: ${devinMessage}` : `Devin API ${res.status} on ${path}`,
      body.error ?? null,
    );
  }

  return parsed as T;
}

/** Discovers org_id from GET /self and caches it in-process. DEVIN_ORG_ID env
 *  always wins if Kevin sets it explicitly. */
export async function discoverOrgId(): Promise<string> {
  const envOrgId = process.env.DEVIN_ORG_ID?.trim();
  if (envOrgId) return envOrgId;
  if (cachedOrgId) return cachedOrgId;
  const self = await devinFetch<DevinSelfResponse>('/self');
  if (!self?.org_id) throw new DevinApiError(502, 'Devin /self response did not include org_id');
  cachedOrgId = self.org_id;
  return cachedOrgId;
}

export interface CreateDevinSessionArgs {
  title: string;
  prompt: string;
  devin_mode?: DevinMode;
  structured_output_schema?: Record<string, unknown>;
  tags?: string[];
  max_acu_limit?: number;
}

export async function createDevinSession(args: CreateDevinSessionArgs): Promise<DevinSession> {
  const orgId = await discoverOrgId();
  const body: Record<string, unknown> = {
    title: args.title,
    prompt: args.prompt,
    devin_mode: args.devin_mode ?? 'lite',
    structured_output_required: true,
    structured_output_schema: args.structured_output_schema ?? DEFAULT_STRUCTURED_OUTPUT_SCHEMA,
    tags: args.tags ?? [],
    resumable: true,
  };
  if (typeof args.max_acu_limit === 'number' && Number.isFinite(args.max_acu_limit) && args.max_acu_limit > 0) {
    body.max_acu_limit = args.max_acu_limit;
  }
  return devinFetch<DevinSession>(`/organizations/${encodeURIComponent(orgId)}/sessions`, { method: 'POST', body });
}

export async function getDevinSession(sessionId: string): Promise<DevinSession> {
  const orgId = await discoverOrgId();
  return devinFetch<DevinSession>(
    `/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function sendDevinMessage(sessionId: string, message: string): Promise<DevinSession> {
  const orgId = await discoverOrgId();
  return devinFetch<DevinSession>(
    `/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
    { method: 'POST', body: { message } },
  );
}
