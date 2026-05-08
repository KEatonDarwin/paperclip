import { query } from '../db.js';

const JARVIS_PROJECT_ID = '3e1aab03-f296-4992-b7a9-f6bf74b8f48e';

const QUALIFYING_PROJECTS = new Set([
  JARVIS_PROJECT_ID,
  '6de396ed-01fa-46b8-9e0d-fd01f263bf9d', // SHIM Bug Fixer
  '5bd30de8-723d-493c-ab2e-034077b1d484', // SHIM Feature Implementation
]);

const QUALIFYING_KEYWORDS = [
  'jarvis', 'shim', 'calendar', 'briefing', 'check-in', 'checkin',
  'slack', 'webhook', 'dashboard', 'ui', 'plugin', 'integration',
  'notification', 'schedule', 'reminder', 'assistant',
];

const SKIP_KEYWORDS = [
  'refactor', 'lint', 'ci/cd', 'ci ', 'pipeline', 'benchmark',
  'type error', 'typo',
];

interface WebhookPayload {
  id: string;
  event: string;
  timestamp: string;
  companyId: string;
  data: {
    entityType: string;
    entityId: string;
    actor: { type: string; id: string };
    agentId?: string | null;
    runId?: string | null;
    status?: string;
    identifier?: string;
    title?: string;
    _previous?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

interface QualificationResult {
  qualified: boolean;
  reason: string;
}

async function fetchIssueDetails(issueId: string) {
  const rows = await query<{
    id: string;
    title: string;
    identifier: string;
    project_id: string | null;
    description: string | null;
  }>(
    `SELECT id, title, identifier, project_id, description
     FROM issues WHERE id = $1 LIMIT 1`,
    [issueId],
  );
  return rows[0] ?? null;
}

function qualifyIssue(
  title: string,
  projectId: string | null,
  description: string | null,
): QualificationResult {
  if (projectId && QUALIFYING_PROJECTS.has(projectId)) {
    return { qualified: true, reason: 'project qualifies (JARVIS/SHIM)' };
  }

  const lowerTitle = title.toLowerCase();
  const lowerDesc = (description ?? '').toLowerCase();
  const combined = `${lowerTitle} ${lowerDesc}`;

  for (const kw of SKIP_KEYWORDS) {
    if (lowerTitle.includes(kw)) {
      return { qualified: false, reason: `skip keyword in title: "${kw}"` };
    }
  }

  for (const kw of QUALIFYING_KEYWORDS) {
    if (combined.includes(kw)) {
      return { qualified: true, reason: `keyword match: "${kw}"` };
    }
  }

  // When in doubt, qualify
  return { qualified: true, reason: 'default: qualifying (better to over-nudge)' };
}

function buildCheckinReason(identifier: string, title: string): string {
  return [
    `Graduation check-in: ${identifier} — "${title}" was marked done.`,
    '',
    'Walk Kevin through:',
    '1. Is this feature visible in JARVIS/SHIM/calendar/dashboard? If so, test it.',
    '2. Does anything need to be configured, toggled, or wired up?',
    '3. Are there follow-up tasks or related issues that depend on this?',
    '4. Should this be mentioned in the morning briefing or noted anywhere?',
    '',
    'If the feature is purely internal (agent-only, backend plumbing), a quick acknowledgement is fine.',
  ].join('\n');
}

export async function handlePaperclipWebhook(
  payload: WebhookPayload,
): Promise<{ action: string; detail: string }> {
  const { event, data } = payload;

  if (event !== 'issue.updated') {
    console.log(`[paperclip-webhook] Skipped event: ${event}`);
    return { action: 'skipped', detail: `event type "${event}" not handled` };
  }

  const newStatus = data.status;
  const oldStatus = data._previous?.status as string | undefined;

  if (newStatus !== 'done' || oldStatus === 'done') {
    console.log(
      `[paperclip-webhook] Skipped: status ${oldStatus ?? '?'} → ${newStatus ?? '?'} (not a done transition)`,
    );
    return { action: 'skipped', detail: 'not a done transition' };
  }

  const issueId = data.entityId;
  const issue = await fetchIssueDetails(issueId);

  if (!issue) {
    console.warn(`[paperclip-webhook] Issue ${issueId} not found in DB`);
    return { action: 'skipped', detail: 'issue not found' };
  }

  const qualification = qualifyIssue(issue.title, issue.project_id, issue.description);

  console.log(
    `[paperclip-webhook] ${issue.identifier} "${issue.title}" → done | qualified=${qualification.qualified} (${qualification.reason})`,
  );

  if (!qualification.qualified) {
    return {
      action: 'skipped',
      detail: `${issue.identifier} did not qualify: ${qualification.reason}`,
    };
  }

  // Fire 24h from now
  const fireAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const reason = buildCheckinReason(issue.identifier, issue.title);

  const rows = await query<{ id: string; fire_at: string }>(
    `INSERT INTO jarvis_checkins (fire_at, reason, source_type, source_id)
     VALUES ($1, $2, 'paperclip', $3)
     RETURNING id, fire_at`,
    [fireAt, reason, issue.identifier],
  );

  const checkin = rows[0];
  console.log(
    `[paperclip-webhook] Enqueued graduation check-in ${checkin.id} for ${issue.identifier} at ${checkin.fire_at}`,
  );

  return {
    action: 'enqueued',
    detail: `Graduation check-in ${checkin.id} for ${issue.identifier} fires at ${checkin.fire_at}`,
  };
}
