// PAGE COMPANION — BRANCH AWARENESS (tree-b0198a82, node #1586).
//
// The question Kevin actually has on a repo-driven page: **which branch is live
// here right now?** The intake/accounting deploy model is checkout-switching —
// the page he is looking at is whatever branch happens to be checked out on that
// host at that moment, and nothing on the page says which one.
//
// ───────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SEPARATE MODULE, AND A SEPARATE ENDPOINT
//
// A deployment read is a NETWORK read — the deploy API over HTTPS, or the hub
// file reader over MCP. The lookup ("is this page ours?") is a few synchronous
// sqlite queries that must stay instant and must never be able to fail because
// a remote host is slow or down.
//
// So the split is structural, not stylistic:
//   * `lookupPage()` stays SYNCHRONOUS and lives in page-companion.ts, which
//     imports nothing from this file. It cannot await, so it cannot be slowed
//     or broken by anything here. (scripts/page-companion-deploy-check.mjs
//     asserts exactly that, with both sources rigged to hang and to throw.)
//   * the panel calls `GET /page-companion/deployment?registry_id=N` LAZILY,
//     after it has already opened on the lookup's answer. If that call fails,
//     errors or times out, the panel shows no branch line and nothing else
//     changes.
//
// ───────────────────────────────────────────────────────────────────────────────
// TWO READ-ONLY SOURCES, IN THIS ORDER
//
// (a) THE DEPLOY-CONTROL API — `GET <DEPLOY_API_BASE>/api/v1/deploy/environments`
//     (DarwinIntakeSystem docs/deploy-control/CONTRACT.md §8.2). For targets it
//     manages this is the good data: branch, commit, `drift.behind`/`stale`,
//     `doctor.health_http_status`. Used where it exists.
//
//     ⚠️ STATE OF THE WORLD, 2026-10-09: this endpoint is NOT live. The control
//     plane lives on the unmerged DarwinIntakeSystem branch
//     `deploy/control-plane`; both intake hosts answer `405 … Supported
//     methods: POST` for it today (the request falls through to
//     `POST /api/v1/deploy/{identifier}`). That is precisely why (b) exists and
//     why an unavailable source is a first-class, tested path rather than an
//     error — and it is also why every in-scope page is wired to (b).
//
// (b) `.git/HEAD` THROUGH THE HUB FILE READER — the already-live, read-only
//     smarty-pants `approved-roots-file-tool` (`vhosts` root = /var/www/vhosts).
//     Read `<dir>/.git/HEAD`; when it is `ref: refs/heads/<branch>`, read the
//     matching loose ref (falling back to `.git/packed-refs`) for the sha. A
//     detached HEAD holds a raw sha — report the short sha and say so. The ref
//     file's mtime is when that checkout last moved, which is the honest
//     "how stale" for a checkout-switching deploy model.
//
//     This places NOTHING on any server and writes nothing anywhere.
//
// If neither source can answer: `known: false`. Never a guess, and never a
// cached value presented as current (see CACHE_TTL_MS).

import { nativeCall } from './tools/mcp-native.js';

// ─── The target table ─────────────────────────────────────────────────────────

export interface DeployTargetSpec {
  /** The string stored in `page_registry.deploy_target`. */
  key: string;
  /** Short human label, for the report and for debugging. Not shown in the panel. */
  label: string;
  /** Target key in the deploy-control API, when it manages this host. */
  api_target?: string;
  /** Approved-roots coordinates of the checkout, for the `.git/HEAD` fallback. */
  git?: { host: string; root: string; dir: string };
}

function hubVhost(dir: string) {
  return { host: 'hub', root: 'vhosts', dir };
}

/**
 * Every deploy target a registry row may point at.
 *
 * 🔴 The target NAMES here were read off the real config, not guessed:
 * `sandbox-intake` is `config/deploy-targets.php` on DarwinIntakeSystem
 * `deploy/control-plane`, and its domain is **sandbox**.intake.thedarwinhub.com
 * — NOT staging.intake.thedarwinhub.com. They are two different vhosts
 * (`/var/www/vhosts/` has both) on two different branches. The node spec's
 * note that "the staging intake target is sandbox-intake" is wrong on that
 * point; staging intake is not a managed deploy-API target at all, so it reads
 * its own checkout through (b) like the other two.
 *
 * `sandbox-intake` is kept here because it IS a real managed target and it is
 * what exercises source (a) — it carries both an api_target and a git fallback,
 * so it degrades to (b) while the control plane is unmerged. No seeded page
 * currently points at it (Kevin's scope named staging, not sandbox).
 */
export const DEPLOY_TARGETS: Readonly<Record<string, DeployTargetSpec>> = {
  'intake-prod': {
    key: 'intake-prod',
    label: 'Intake (prod)',
    git: hubVhost('intake.thedarwinhub.com'),
  },
  'intake-staging': {
    key: 'intake-staging',
    label: 'Intake (staging)',
    git: hubVhost('staging.intake.thedarwinhub.com'),
  },
  accounting: {
    key: 'accounting',
    label: 'Accounting',
    git: hubVhost('accounting.thedarwinhub.com'),
  },
  'sandbox-intake': {
    key: 'sandbox-intake',
    label: 'Intake (sandbox)',
    api_target: 'sandbox-intake',
    git: hubVhost('sandbox.intake.thedarwinhub.com'),
  },
};

export function resolveDeployTarget(key: unknown): DeployTargetSpec | null {
  if (typeof key !== 'string') return null;
  return DEPLOY_TARGETS[key.trim()] ?? null;
}

// ─── The answer shape ─────────────────────────────────────────────────────────

export interface PageDeployment {
  registry_id: number;
  deploy_target: string | null;
  /** false = we have nothing to say. The panel renders NOTHING in that case —
   *  an "unknown" line is noise on every page that simply has no target. */
  known: boolean;
  source: 'deploy_api' | 'git_head' | null;
  branch: string | null;
  /** Short sha (10 chars), or null. */
  commit: string | null;
  detached: boolean;
  /** ISO — when this checkout last moved (git), or when the roll-up was
   *  generated (api). The "how stale" the panel renders as a relative time. */
  as_of: string | null;
  behind: number | null;
  stale: boolean | null;
  dirty: boolean | null;
  health: number | null;
  /** Why there is no answer, when known=false. For logs and debugging only. */
  reason: string | null;
}

function unknown(registryId: number, target: string | null, reason: string): PageDeployment {
  return {
    registry_id: registryId,
    deploy_target: target,
    known: false,
    source: null,
    branch: null,
    commit: null,
    detached: false,
    as_of: null,
    behind: null,
    stale: null,
    dirty: null,
    health: null,
    reason,
  };
}

// ─── Injectable sources (so the tests are hermetic) ───────────────────────────

export interface HubFileRead {
  content: string;
  /** ISO mtime of the file, when the reader gave one. */
  mtime: string | null;
}

/** The two network calls, in one object so a test can replace either. Production
 *  never reassigns these. */
export const deploymentSources = {
  fetchEnvironments: defaultFetchEnvironments,
  readHubFile: defaultReadHubFile,
};

const DEPLOY_API_TIMEOUT_MS = Number(process.env.PAGE_COMPANION_DEPLOY_API_TIMEOUT_MS || 6_000);
const HUB_READ_TIMEOUT_MS = Number(process.env.PAGE_COMPANION_HUB_READ_TIMEOUT_MS || 8_000);
/** Whole-answer budget. A deployment read that takes longer than this is simply
 *  not worth having — the panel is already open and showing the chats. */
const OVERALL_BUDGET_MS = Number(process.env.PAGE_COMPANION_DEPLOY_BUDGET_MS || 9_000);

function deployApiBase(): string {
  return (process.env.DEPLOY_API_BASE ?? 'https://intake.thedarwinhub.com').replace(/\/$/, '');
}

/** Raw `data.targets` from the deploy-control roll-up. Throws on any non-OK
 *  answer — the caller turns that into "source unavailable".
 *
 *  Exported so the check script can exercise THIS implementation (not a
 *  re-creation of it) against a throwaway fixture server. */
export async function defaultFetchEnvironments(): Promise<unknown[]> {
  const url = new URL(`${deployApiBase()}/api/v1/deploy/environments`);
  // fetch=false: we want the currently-checked-out branch, not a fresh
  // `git fetch` on a production host. Drift may be a little stale; the branch
  // name — the thing Kevin is asking about — is exact either way.
  url.searchParams.set('fetch', 'false');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.DEPLOY_API_KEY) headers.Authorization = `Bearer ${process.env.DEPLOY_API_KEY}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(DEPLOY_API_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`deploy environments HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { targets?: unknown } };
  const targets = body?.data?.targets;
  if (!Array.isArray(targets)) throw new Error('deploy environments: no targets array');
  return targets;
}

/** One read through the live, read-only approved-roots hub file reader.
 *  Returns null when the file isn't there (a missing loose ref is normal).
 *  Exported for the same reason as defaultFetchEnvironments. */
export async function defaultReadHubFile(host: string, root: string, path: string): Promise<HubFileRead | null> {
  const call = await nativeCall(
    'smarty-pants',
    'approved-roots-file-tool',
    { operation: 'read', host, root, path },
    HUB_READ_TIMEOUT_MS,
  );
  if (!call.ok) throw new Error(call.error || 'approved-roots read failed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.result);
  } catch {
    throw new Error('approved-roots read returned non-JSON');
  }
  const envelope = parsed as { success?: boolean; data?: { content?: unknown; mtime_iso?: unknown } };
  if (!envelope?.success || !envelope.data) return null; // not found / not readable
  const content = envelope.data.content;
  if (typeof content !== 'string') return null;
  return {
    content,
    mtime: typeof envelope.data.mtime_iso === 'string' ? envelope.data.mtime_iso : null,
  };
}

// ─── Source (a): the deploy-control API ───────────────────────────────────────

/** The whole roll-up, cached — one call answers every target, so opening panels
 *  on three different hosts does not make three requests. */
let envCache: { at: number; targets: unknown[] } | null = null;

async function environmentsTargets(): Promise<unknown[]> {
  if (envCache && Date.now() - envCache.at < CACHE_TTL_MS) return envCache.targets;
  const targets = await deploymentSources.fetchEnvironments();
  envCache = { at: Date.now(), targets };
  return targets;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

async function fromDeployApi(registryId: number, spec: DeployTargetSpec): Promise<PageDeployment | null> {
  if (!spec.api_target) return null;
  const targets = await environmentsTargets();
  const raw = targets.map(rec).find((t) => t.key === spec.api_target);
  if (!raw) return null; // this control plane's realm doesn't manage it

  const status = rec(raw.status);
  const drift = rec(raw.drift);
  const doctor = rec(raw.doctor);
  const commitHash = str(rec(status.latest_commit).hash);
  const branch = str(status.branch);
  const detached = bool(drift.detached) === true;
  // Branch AND commit both missing means the inspector couldn't read the
  // checkout — that is an absence of data, not a deployment.
  if (!branch && !commitHash) return null;

  return {
    registry_id: registryId,
    deploy_target: spec.key,
    known: true,
    source: 'deploy_api',
    branch: detached ? null : branch,
    commit: commitHash ? commitHash.slice(0, 10) : null,
    detached,
    as_of: str(drift.fetched_at) ?? str(rec(raw.last_deploy).deployed_at),
    behind: num(drift.behind),
    stale: bool(drift.stale),
    dirty: bool(drift.dirty),
    health: num(doctor.health_http_status),
    reason: null,
  };
}

// ─── Source (b): .git/HEAD through the hub file reader ────────────────────────

/** `ref: refs/heads/<branch>` → the branch; a bare 40-hex sha → detached. */
export function parseGitHead(content: unknown): { branch: string | null; sha: string | null } {
  if (typeof content !== 'string') return { branch: null, sha: null };
  const line = content.trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(line);
  if (ref) return { branch: ref[1].trim(), sha: null };
  if (/^[0-9a-f]{40}$/i.test(line)) return { branch: null, sha: line.toLowerCase() };
  return { branch: null, sha: null };
}

/** Find one branch's sha in a `.git/packed-refs` file. */
export function shaFromPackedRefs(content: unknown, branch: string): string | null {
  if (typeof content !== 'string') return null;
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const m = /^([0-9a-f]{40})\s+(.+)$/i.exec(line.trim());
    if (m && m[2].trim() === `refs/heads/${branch}`) return m[1].toLowerCase();
  }
  return null;
}

async function fromGitHead(registryId: number, spec: DeployTargetSpec): Promise<PageDeployment | null> {
  const git = spec.git;
  if (!git) return null;
  const read = (p: string) => deploymentSources.readHubFile(git.host, git.root, `${git.dir}/${p}`);

  const head = await read('.git/HEAD');
  if (!head) return null;
  const { branch, sha: detachedSha } = parseGitHead(head.content);

  if (!branch) {
    if (!detachedSha) return null; // unreadable HEAD — say nothing rather than guess
    return {
      registry_id: registryId,
      deploy_target: spec.key,
      known: true,
      source: 'git_head',
      branch: null,
      commit: detachedSha.slice(0, 10),
      detached: true,
      as_of: head.mtime,
      behind: null,
      stale: null,
      dirty: null,
      health: null,
      reason: null,
    };
  }

  // The loose ref is the common case; packed-refs covers a repo that has been
  // gc'd, which would otherwise read as a permanent "unknown".
  const loose = await read(`.git/refs/heads/${branch}`);
  let sha = loose ? parseGitHead(loose.content).sha ?? looseSha(loose.content) : null;
  let asOf = loose?.mtime ?? head.mtime;
  if (!sha) {
    const packed = await read('.git/packed-refs');
    sha = packed ? shaFromPackedRefs(packed.content, branch) : null;
    if (sha) asOf = packed?.mtime ?? head.mtime;
  }

  return {
    registry_id: registryId,
    deploy_target: spec.key,
    known: true,
    source: 'git_head',
    branch,
    commit: sha ? sha.slice(0, 10) : null,
    detached: false,
    as_of: asOf,
    behind: null, // no upstream comparison without fetching — never faked
    stale: null,
    dirty: null,
    health: null,
    reason: null,
  };
}

function looseSha(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const line = content.trim();
  return /^[0-9a-f]{40}$/i.test(line) ? line.toLowerCase() : null;
}

// ─── The public read, cached ──────────────────────────────────────────────────

/** Per-target TTL. Short enough that a branch switch shows up on the next
 *  panel open, long enough that reopening a panel cannot hammer the deploy API
 *  or the hub. Unknown answers are cached too — a source that is down must not
 *  be retried on every click. */
export const CACHE_TTL_MS = Number(process.env.PAGE_COMPANION_DEPLOY_TTL_MS || 60_000);

/** target key -> the resolved deployment (registry_id is re-stamped per caller). */
const cache = new Map<string, { at: number; value: PageDeployment }>();
/** In-flight reads, so three panels opening at once make one request. */
const inflight = new Map<string, Promise<PageDeployment>>();

export function clearDeploymentCache(): void {
  cache.clear();
  inflight.clear();
  envCache = null;
}

async function resolveForTarget(spec: DeployTargetSpec): Promise<PageDeployment> {
  // registry_id 0 here; stamped with the real one by getPageDeployment, so one
  // cache entry serves every page on that target.
  const errors: string[] = [];
  for (const [name, source] of [
    ['deploy_api', fromDeployApi],
    ['git_head', fromGitHead],
  ] as const) {
    try {
      const got = await source(0, spec);
      if (got) return got;
      errors.push(`${name}: no answer`);
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return unknown(0, spec.key, errors.join('; ') || 'no source answered');
}

/**
 * What is deployed on the host serving this registry row — or `known:false`.
 *
 * Never throws for a data reason: a missing target, an unknown target key, a
 * dead deploy API, an unreachable hub and a read that blows the budget all come
 * back as `known:false`. The only throw is a programmer error.
 */
export async function getPageDeployment(
  registryId: number,
  deployTarget: string | null,
): Promise<PageDeployment> {
  if (!deployTarget) return unknown(registryId, null, 'page has no deploy target');
  const spec = resolveDeployTarget(deployTarget);
  if (!spec) return unknown(registryId, deployTarget, `unknown deploy target '${deployTarget}'`);

  const hit = cache.get(spec.key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, registry_id: registryId };

  let pending = inflight.get(spec.key);
  if (!pending) {
    pending = resolveForTarget(spec)
      .then((value) => {
        cache.set(spec.key, { at: Date.now(), value });
        return value;
      })
      .catch((err) => unknown(0, spec.key, err instanceof Error ? err.message : String(err)))
      .finally(() => inflight.delete(spec.key));
    inflight.set(spec.key, pending);
  }

  // The budget is on OUR wait, not on the underlying read: a slow read keeps
  // going and populates the cache for the next panel open, it just doesn't hold
  // this response open.
  // NOT unref'd: if the underlying read hangs, this timer is the only thing
  // keeping the event loop alive, and an unref'd one lets the process (or the
  // request) fall through without ever answering.
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<PageDeployment>((resolve) => {
    timer = setTimeout(
      () => resolve(unknown(0, spec.key, `deployment read exceeded ${OVERALL_BUDGET_MS}ms`)),
      OVERALL_BUDGET_MS,
    );
  });
  try {
    const value = await Promise.race([pending, budget]);
    return { ...value, registry_id: registryId };
  } finally {
    clearTimeout(timer);
  }
}
