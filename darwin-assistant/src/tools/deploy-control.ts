import type { ToolDef } from './index.js';

// Deploy Control Plane — JARVIS-side client (tree-c38fbe71, node 6).
//
// Talks to the deployment API on DarwinIntakeSystem (docs/deploy-control/CONTRACT.md,
// same repo as intake.thedarwinhub.com) so JARVIS always knows what is deployed on every
// managed target — the three PerClickity sandbox domains plus the pre-existing
// interest-targeting / staging-interest-targeting / hub2-preview targets — and can deploy
// any of them, individually or as a group, without SSH.
//
// Mirrors the shape of intake-deploy.ts (same repo, same MCP-server box) but this is a
// DIFFERENT API on the SAME host: intake-deploy.ts drives the smarty-pants MCP server's
// own git-pull endpoint; this tool drives DarwinIntakeSystem's application-level deploy
// API (CONTRACT.md §8). Do not merge the two — they manage unrelated things.
//
// Reads (status/branches/environments/doctor) are unauthenticated by default on the
// server (CONTRACT §9.3) — DEPLOY_API_KEY is optional for those and only required if
// Kevin later flips DEPLOY_API_REQUIRE_AUTH_READS=true. Writes (deploy/deploy_group) need
// it for the three sandbox targets (require_auth_writes=true) and for the group endpoint
// (always required) — the three legacy targets stay open-write for their existing
// unauthenticated callers (CONTRACT §9, rule 2/table).

function apiBase(): string {
  return (process.env.DEPLOY_API_BASE ?? 'https://intake.thedarwinhub.com').replace(/\/$/, '');
}

function apiKey(): string | undefined {
  return process.env.DEPLOY_API_KEY || undefined;
}

interface DeployApiResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

async function callDeployApi(
  method: string,
  path: string,
  opts: { query?: Record<string, string | boolean | undefined>; body?: unknown; timeoutMs?: number } = {},
): Promise<DeployApiResponse> {
  const url = new URL(`${apiBase()}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = apiKey();
  if (key) headers['Authorization'] = `Bearer ${key}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `deploy_control: request to ${path} timed out after ${opts.timeoutMs ?? 20_000}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function hasData(body: unknown): body is { success?: boolean; data: Record<string, unknown> } {
  return !!body && typeof body === 'object' && 'data' in (body as Record<string, unknown>);
}

function extractError(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)) {
    return String((body as { error?: unknown }).error);
  }
  if (typeof body === 'string' && body.trim()) {
    // Likely an HTML error page (404/405/500 from the web server, not the app) — strip
    // tags and trim so the model doesn't have to wade through a full page.
    const stripped = body
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return stripped.slice(0, 200) || `HTTP ${status}`;
  }
  return `HTTP ${status}`;
}

function requireOk(res: DeployApiResponse, context: string): Record<string, unknown> {
  if (!res.ok || !hasData(res.body)) {
    throw new Error(`deploy_control: ${context} failed (${res.status}): ${extractError(res.status, res.body)}`);
  }
  return res.body.data;
}

// ---------------------------------------------------------------------------
// Trimming — the server payloads (especially environments/doctor/deploy
// output) are deep and repetitive; compact them into something readable in
// chat rather than passing the raw dump straight through.
// ---------------------------------------------------------------------------

interface TrimmedTarget {
  key: string;
  name: string;
  domain: string;
  env: string;
  group: string | null;
  legacy: boolean;
  branch: string | null;
  review_branch: boolean;
  commit: string | null;
  stale: boolean | null;
  behind: number | null;
  dirty: boolean;
  ready: boolean | null;
  health: number | null;
  problems: string[];
  last_deploy: { at: string | null; ok: boolean } | null;
  notes?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function trimTarget(raw: unknown): TrimmedTarget {
  const t = asRecord(raw);
  const status = asRecord(t.status);
  const drift = asRecord(t.drift);
  const doctor = asRecord(t.doctor);
  const lastDeployRaw = asRecord(t.last_deploy);
  const latestCommit = asRecord(status.latest_commit);
  const problems = Array.isArray(doctor.problems) ? doctor.problems.map(String) : [];

  return {
    key: String(t.key ?? ''),
    name: String(t.name ?? t.key ?? ''),
    domain: String(t.domain ?? ''),
    env: String(t.env ?? ''),
    group: typeof t.group === 'string' ? t.group : null,
    legacy: !!t.legacy,
    branch: typeof status.branch === 'string' ? status.branch : null,
    review_branch: !!status.is_review_branch,
    commit: latestCommit.hash ? String(latestCommit.hash).slice(0, 10) : null,
    stale: typeof drift.stale === 'boolean' ? drift.stale : null,
    behind: typeof drift.behind === 'number' ? drift.behind : null,
    dirty: !!drift.dirty,
    ready: typeof doctor.ready === 'boolean' ? doctor.ready : null,
    health: typeof doctor.health_http_status === 'number' ? doctor.health_http_status : null,
    problems,
    last_deploy: t.last_deploy
      ? { at: (lastDeployRaw.deployed_at as string) ?? null, ok: !!lastDeployRaw.success }
      : null,
    ...(typeof t.notes === 'string' && t.notes ? { notes: t.notes } : {}),
  };
}

function targetLine(t: TrimmedTarget): string {
  if (t.problems.length && !t.branch) {
    return `  ${t.key.padEnd(26)} NOT SET UP — ${t.problems.join('; ')}`;
  }
  const branchPart = t.branch ? `${t.branch}${t.commit ? `@${t.commit}` : ''}` : 'unknown';
  const bits: string[] = [branchPart];
  if (t.ready === false) bits.push('NOT READY');
  if (t.stale === true) bits.push(`stale (${t.behind ?? '?'} behind)`);
  else if (t.stale === false) bits.push('fresh');
  if (t.dirty) bits.push('dirty');
  if (t.health !== null && t.health !== 200) bits.push(`health=${t.health}`);
  let line = `  ${t.key.padEnd(26)} ${bits.join('  ')}`;
  if (t.problems.length) line += `\n    ! ${t.problems.join('; ')}`;
  return line;
}

interface GroupInfo {
  key: string;
  name: string;
  order: string[];
  stale_count: number;
  not_ready_count: number;
}

function buildEnvironmentsSummary(
  controlPlane: { env: string; manages: string[]; host: string },
  groups: Record<string, GroupInfo>,
  targets: TrimmedTarget[],
): string {
  const lines: string[] = [
    `Deploy Control — realm ${controlPlane.env} (manages: ${controlPlane.manages.join(', ') || 'none'}) — ${controlPlane.host}`,
  ];
  let currentGroup: string | null | undefined;
  for (const t of targets) {
    if (t.group !== currentGroup) {
      currentGroup = t.group;
      lines.push('');
      lines.push(t.group ? `${groups[t.group]?.name ?? t.group}:` : 'Ungrouped:');
    }
    lines.push(targetLine(t));
  }
  return lines.join('\n');
}

function tailLines(output: unknown, n = 12): string[] {
  if (!Array.isArray(output)) return [];
  return output.slice(-n).map((o) => {
    const r = asRecord(o);
    return `[${r.timestamp ?? ''}] ${r.type ?? ''}: ${r.message ?? ''}`;
  });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function opEnvironments(args: Record<string, unknown>) {
  const query: Record<string, string | boolean | undefined> = {
    env: typeof args.env === 'string' ? args.env : undefined,
    group: typeof args.group === 'string' ? args.group : undefined,
    fetch: typeof args.fetch === 'boolean' ? args.fetch : undefined,
  };
  const res = await callDeployApi('GET', '/api/v1/deploy/environments', { query, timeoutMs: 30_000 });
  const data = requireOk(res, 'environments');

  const controlPlaneRaw = asRecord(data.control_plane);
  const controlPlane = {
    env: String(controlPlaneRaw.env ?? 'unknown'),
    manages: Array.isArray(controlPlaneRaw.manages) ? controlPlaneRaw.manages.map(String) : [],
    host: String(controlPlaneRaw.host ?? ''),
    generated_at: (controlPlaneRaw.generated_at as string) ?? null,
  };

  const groupsRaw = asRecord(data.groups);
  const groups: Record<string, GroupInfo> = {};
  for (const [gk, gv] of Object.entries(groupsRaw)) {
    const g = asRecord(gv);
    groups[gk] = {
      key: String(g.key ?? gk),
      name: String(g.name ?? gk),
      order: Array.isArray(g.order) ? g.order.map(String) : [],
      stale_count: typeof g.stale_count === 'number' ? g.stale_count : 0,
      not_ready_count: typeof g.not_ready_count === 'number' ? g.not_ready_count : 0,
    };
  }

  const targets = (Array.isArray(data.targets) ? data.targets : []).map(trimTarget);
  const summary = buildEnvironmentsSummary(controlPlane, groups, targets);

  return { control_plane: controlPlane, groups, targets, summary };
}

async function opStatus(args: Record<string, unknown>) {
  const target = String(args.target ?? '').trim();
  if (!target) throw new Error('deploy_control: status requires a target');

  const res = await callDeployApi('GET', `/api/v1/deploy/${encodeURIComponent(target)}/status`, {
    timeoutMs: 15_000,
  });
  const data = requireOk(res, `status '${target}'`);
  const latestCommit = asRecord(data.latest_commit);
  const commit = data.latest_commit
    ? {
        hash: latestCommit.hash ? String(latestCommit.hash).slice(0, 10) : null,
        author: (latestCommit.author as string) ?? null,
        date: (latestCommit.date as string) ?? null,
        message: latestCommit.message ? String(latestCommit.message).slice(0, 140) : null,
      }
    : null;

  const out = {
    target,
    branch: (data.branch as string) ?? null,
    main_branch: (data.main_branch as string) ?? null,
    review_branch: !!data.is_review_branch,
    commit,
    diff_summary: data.diff_summary ? String(data.diff_summary).slice(0, 400) : null,
  };
  const summary = `${target}: ${out.branch ?? 'unknown'}${commit?.hash ? ` @ ${commit.hash}` : ''} (${out.review_branch ? 'review branch' : 'main'})`;
  return { ...out, summary };
}

async function opBranches(args: Record<string, unknown>) {
  const target = String(args.target ?? '').trim();
  if (!target) throw new Error('deploy_control: branches requires a target');
  const prefix = typeof args.prefix === 'string' && args.prefix.trim() ? args.prefix.trim() : null;

  const res = await callDeployApi('GET', `/api/v1/deploy/${encodeURIComponent(target)}/branches`, {
    query: { prefix: prefix ?? undefined },
    timeoutMs: 15_000,
  });
  const data = requireOk(res, `branches '${target}'`);
  // listRemoteBranches() returns objects: { name, sha, author_date }, newest first.
  const branches = (Array.isArray(data.branches) ? data.branches : []).map((b) => {
    const r = asRecord(b);
    return {
      name: String(r.name ?? ''),
      sha: r.sha ? String(r.sha).slice(0, 10) : null,
      author_date: (r.author_date as string) ?? null,
    };
  });
  const names = branches.map((b) => b.name);
  const shown = names.slice(0, 10).join(', ') + (names.length > 10 ? ', …' : '');
  const summary = `${target}${prefix ? ` (prefix ${prefix})` : ''}: ${branches.length} branch(es)${branches.length ? ` — ${shown}` : ''}`;
  return { target, prefix, branches, summary };
}

function trimDeployResult(target: string, body: { success?: boolean; data: Record<string, unknown> }) {
  const d = body.data;
  const success = !!body.success;
  const out = {
    target,
    success,
    branch: (d.branch as string) ?? null,
    duration_seconds: (d.duration_seconds as number) ?? null,
    output_tail: tailLines(d.output),
  };
  const header = `${success ? '✅' : '❌'} deploy ${target} @ ${out.branch ?? '?'} — ${success ? 'succeeded' : 'FAILED'} in ${out.duration_seconds ?? '?'}s`;
  const summary = success ? header : `${header}\n${out.output_tail.join('\n')}`;
  return { ...out, summary };
}

async function opDeploy(args: Record<string, unknown>) {
  const target = String(args.target ?? '').trim();
  if (!target) throw new Error('deploy_control: deploy requires a target');
  const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined;
  const repo = typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : undefined;

  const res = await callDeployApi('POST', `/api/v1/deploy/${encodeURIComponent(target)}`, {
    body: { branch, repo },
    // Deploys can run composer install (up to 900s) + npm ci/build (up to 600s each) per
    // CONTRACT.md §3/§8.4 — give this real headroom, not the 20s default.
    timeoutMs: 20 * 60_000,
  });
  if (!hasData(res.body)) {
    throw new Error(`deploy_control: deploy '${target}' failed (${res.status}): ${extractError(res.status, res.body)}`);
  }
  return trimDeployResult(target, res.body as { success?: boolean; data: Record<string, unknown> });
}

function trimGroupResult(group: string, body: { success?: boolean; data: Record<string, unknown> }) {
  const d = body.data;
  const success = !!body.success;
  const resultsRaw = Array.isArray(d.results) ? d.results : [];
  const results = resultsRaw.map((r) => {
    const rr = asRecord(r);
    return {
      key: String(rr.key ?? ''),
      name: String(rr.name ?? rr.key ?? ''),
      attempted: !!rr.attempted,
      success: typeof rr.success === 'boolean' ? rr.success : null,
      branch: (rr.branch as string) ?? null,
      duration_seconds: (rr.duration_seconds as number) ?? null,
      skipped_reason: (rr.skipped_reason as string) ?? null,
      output_tail: tailLines(rr.output),
    };
  });

  const header = `${success ? '✅' : '❌'} group ${group} — attempted ${d.attempted ?? 0}, succeeded ${d.succeeded ?? 0}, failed ${d.failed ?? 0}, skipped ${d.skipped ?? 0} (${d.duration_seconds ?? '?'}s)`;
  const rows = results.map((r) => {
    const status = !r.attempted ? `skipped (${r.skipped_reason})` : r.success ? 'ok' : 'FAILED';
    return `  ${r.key}: ${status}${r.branch ? ` @ ${r.branch}` : ''}`;
  });
  const failTails = results
    .filter((r) => r.attempted && !r.success)
    .map((r) => `--- ${r.key} ---\n${r.output_tail.join('\n')}`);
  const summary = [header, ...rows, ...failTails].join('\n');

  return {
    group,
    success,
    attempted: (d.attempted as number) ?? 0,
    succeeded: (d.succeeded as number) ?? 0,
    failed: (d.failed as number) ?? 0,
    skipped: (d.skipped as number) ?? 0,
    duration_seconds: (d.duration_seconds as number) ?? null,
    results,
    summary,
  };
}

async function opDeployGroup(args: Record<string, unknown>) {
  const group = String(args.group ?? '').trim();
  if (!group) throw new Error('deploy_control: deploy_group requires a group');
  const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined;
  const branches =
    args.branches && typeof args.branches === 'object' ? (args.branches as Record<string, string>) : undefined;
  const continueOnFailure = typeof args.continue_on_failure === 'boolean' ? args.continue_on_failure : undefined;

  const res = await callDeployApi('POST', `/api/v1/deploy/groups/${encodeURIComponent(group)}`, {
    body: { branch, branches, continue_on_failure: continueOnFailure },
    // Sequential multi-target build — worst case ~3x a single deploy's worst case.
    timeoutMs: 40 * 60_000,
  });
  if (!hasData(res.body)) {
    throw new Error(`deploy_control: deploy_group '${group}' failed (${res.status}): ${extractError(res.status, res.body)}`);
  }
  return trimGroupResult(group, res.body as { success?: boolean; data: Record<string, unknown> });
}

async function opDoctor(args: Record<string, unknown>) {
  const targetFilter = typeof args.target === 'string' && args.target.trim() ? args.target.trim() : null;
  const query: Record<string, string | boolean | undefined> = {
    env: typeof args.env === 'string' ? args.env : undefined,
    group: typeof args.group === 'string' ? args.group : undefined,
    fetch: typeof args.fetch === 'boolean' ? args.fetch : undefined,
  };
  const res = await callDeployApi('GET', '/api/v1/deploy/environments', { query, timeoutMs: 30_000 });
  const data = requireOk(res, 'doctor (via environments)');

  const targetsRaw = (Array.isArray(data.targets) ? data.targets : []).map(asRecord);
  const filtered = targetFilter ? targetsRaw.filter((t) => t.key === targetFilter) : targetsRaw;
  if (targetFilter && filtered.length === 0) {
    throw new Error(
      `deploy_control: doctor found no managed target named '${targetFilter}' (it may not exist, or this control plane's realm doesn't manage it)`,
    );
  }

  const rows = filtered.map((t) => {
    const doctor = asRecord(t.doctor);
    return {
      key: String(t.key ?? ''),
      name: String(t.name ?? t.key ?? ''),
      domain: String(t.domain ?? ''),
      env: String(t.env ?? ''),
      ready: typeof doctor.ready === 'boolean' ? doctor.ready : null,
      path_exists: typeof doctor.path_exists === 'boolean' ? doctor.path_exists : null,
      is_git_repo: typeof doctor.is_git_repo === 'boolean' ? doctor.is_git_repo : null,
      origin_matches_expected:
        typeof doctor.origin_matches_expected === 'boolean' ? doctor.origin_matches_expected : null,
      writable_by_web_user: typeof doctor.writable_by_web_user === 'boolean' ? doctor.writable_by_web_user : null,
      docroot_exists: typeof doctor.docroot_exists === 'boolean' ? doctor.docroot_exists : null,
      health_http_status: typeof doctor.health_http_status === 'number' ? doctor.health_http_status : null,
      health_error: (doctor.health_error as string) ?? null,
      problems: Array.isArray(doctor.problems) ? doctor.problems.map(String) : [],
    };
  });

  const lines = rows.map((r) => {
    const status = r.ready === true ? 'ready' : r.ready === false ? 'NOT READY' : 'unknown';
    const line = `  ${r.key.padEnd(26)} ${status}${r.health_http_status ? ` health=${r.health_http_status}` : ''}`;
    return r.problems.length ? `${line}\n    ! ${r.problems.join('; ')}` : line;
  });
  const summary = [`Doctor — ${rows.length} target(s) checked:`, ...lines].join('\n');

  return { targets: rows, summary };
}

// ---------------------------------------------------------------------------

const OPERATIONS = ['environments', 'status', 'branches', 'deploy', 'deploy_group', 'doctor'] as const;

export const deployControl: ToolDef = {
  name: 'deploy_control',
  description:
    'Know what is deployed everywhere and deploy it — the control plane for every managed target: ' +
    "the three PerClickity sandbox domains (sandbox-perclickity-ui, sandbox-track-engine, sandbox-intake, " +
    "grouped as 'sandbox-perclickity') plus the pre-existing interest-targeting / staging-interest-targeting / " +
    "hub2-preview targets. Backed by DarwinIntakeSystem's deploy API on intake.thedarwinhub.com " +
    "(docs/deploy-control/CONTRACT.md). " +
    "ALWAYS call 'environments' (or 'doctor' for setup/readiness specifically) before answering any " +
    "\"what's on sandbox\" / \"is X deployed\" / \"which branch is Y running\" question — never guess or " +
    "recall from memory, branches and drift change constantly. " +
    "'environments' — the full live roll-up: branch/commit/staleness/health per target, grouped. " +
    "'status'/'branches' — single-target detail (safe, read-only, unauthenticated). " +
    "'doctor' — setup readiness per target (path exists, right repo, writable, docroot, health) — the answer " +
    "to \"is this target actually set up right\". " +
    "'deploy' and 'deploy_group' are REAL MUTATIONS — they check out a branch and rebuild a live checkout. " +
    "After calling either, confirm the exact target(s) and branch in your reply so Kevin can see what actually " +
    "ran. NEVER deploy interest-targeting, staging-interest-targeting, or hub2-preview (the prod-realm targets) " +
    "unless Kevin has said so explicitly in this conversation — the three sandbox-* targets are fair game on his " +
    "standing instruction and don't need to be re-confirmed each time. A deploy can take several minutes " +
    "(composer/npm installs) — that's normal, not a hang.",
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [...OPERATIONS],
        description: 'Which deploy-control operation to run.',
      },
      target: {
        type: 'string',
        description:
          "Target identifier: sandbox-perclickity-ui | sandbox-track-engine | sandbox-intake | " +
          "interest-targeting | staging-interest-targeting | hub2-preview. Required for status/branches/deploy; " +
          "optional single-target filter for doctor.",
      },
      group: {
        type: 'string',
        description: "Group identifier (currently only 'sandbox-perclickity'). Required for deploy_group; " +
          'optional filter for environments/doctor.',
      },
      env: {
        type: 'string',
        enum: ['prod', 'sandbox'],
        description: 'Optional env filter for environments/doctor.',
      },
      branch: {
        type: 'string',
        description:
          'Branch to deploy. For deploy: this target\'s branch (omit to redeploy its currently-checked-out ' +
          'review branch, or main). For deploy_group: applied to every target in the group unless overridden ' +
          'per-target in branches.',
      },
      branches: {
        type: 'object',
        description:
          'For deploy_group: per-target branch overrides, e.g. {"sandbox-track-engine": "perclickity/settings-2"}.',
      },
      prefix: {
        type: 'string',
        description: 'Optional branch-name prefix filter for the branches operation.',
      },
      repo: {
        type: 'string',
        description: 'Optional source-repo key override for multi-source targets (e.g. hub2-preview).',
      },
      continue_on_failure: {
        type: 'boolean',
        description:
          'For deploy_group: keep deploying remaining targets after one fails. Default false (recommended — ' +
          'a group deploy that continues after the engine fails produces a UI built against a stale backend).',
      },
      fetch: {
        type: 'boolean',
        description:
          'For environments/doctor: whether to git fetch before computing drift (default true; false is ' +
          'faster but drift may be stale).',
      },
    },
    required: ['operation'],
  },
  execute: async (args) => {
    const operation = String(args.operation ?? '');
    switch (operation) {
      case 'environments':
        return opEnvironments(args);
      case 'status':
        return opStatus(args);
      case 'branches':
        return opBranches(args);
      case 'deploy':
        return opDeploy(args);
      case 'deploy_group':
        return opDeployGroup(args);
      case 'doctor':
        return opDoctor(args);
      default:
        throw new Error(`deploy_control: unknown operation '${operation}' (expected one of ${OPERATIONS.join(', ')})`);
    }
  },
};
