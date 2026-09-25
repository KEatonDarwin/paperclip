import type { ToolDef } from './index.js';
import {
  NightError,
  activeNightRun,
  addNightItem,
  buildNightShiftReport,
  getNightRun,
  latestNightRun,
  listNightEvents,
  listNightItems,
  listNightRuns,
  moveNightItem,
  nightEtaEnd,
  nightOrchestratorLog,
  nightRunSummary,
  nightStatusDigest,
  pauseNightRun,
  planNight,
  resumeNightRun,
  runIdForThread,
  runThreadExt,
  skipNightItem,
  startNightRun,
  stopNightRun,
  type NightRunMode,
  type NightRunStatus,
} from '../night-shift.js';

// NIGHT SHIFT persona tool (CONTRACT §6) — the orchestrator thread's handle on
// the night: read the list, log its own read, and (only when Kevin says so in
// the chat) move/skip/add/pause/resume/stop. It never invents work: every item
// is a goal node the planner already scheduled.

/**
 * SHIFTS v1 §3.1 — which run is this call about?
 *
 * Precedence: an explicit `run_id` → the SHIFT THREAD the call came from
 * (`cockpit:shift-<id>`; a days-old session's chat must answer about its own
 * run, never about whatever is running now) → the active/latest run.
 */
function requireRun(argId?: unknown, externalId?: string): number {
  if (typeof argId === 'number' && Number.isFinite(argId)) return argId;
  if (externalId) {
    const own = runIdForThread(externalId);
    if (own != null) return own;
  }
  const run = activeNightRun() ?? latestNightRun();
  if (!run) throw new NightError(404, 'night_run_not_found', 'there is no night run — plan one first');
  return run.id;
}

/** The §3.4 detail read: the run, its list, its events and its summary. */
function runDetail(runId: number): Record<string, unknown> {
  const run = getNightRun(runId);
  if (!run) throw new NightError(404, 'night_run_not_found', `there is no shift #${runId}`);
  return {
    run, thread_ext: runThreadExt(run), eta_end: nightEtaEnd(runId),
    items: listNightItems(runId), summary: nightRunSummary(runId),
    events: listNightEvents(runId, 200),
  };
}

function errorResult(err: unknown): { error: string; message?: string } {
  if (err instanceof NightError) return { error: err.code, message: err.message };
  return { error: 'night_tool_failed', message: err instanceof Error ? err.message : String(err) };
}

export const nightShift: ToolDef = {
  name: 'night_shift',
  description:
    "Drive Kevin's SHIFTS — a shift is ONE session of work (one ordered list, one orchestrator chat, one row in the Sessions table); a Night Shift is just the overnight flavour, and a focused daytime push is the same machinery. " +
    "`status` (the run, the next ~12 rows, lanes, hold, budget) is the read you want before answering anything about the night. " +
    '`log {text}` after every cue turn: one sentence on what you decided and why — the morning report is built from those lines. ' +
    '`plan` / `start` / `pause` / `resume` / `stop` / `move` / `skip` / `add` change the night itself — call them ONLY when Kevin asked for that in words in this thread, never on your own initiative ' +
    '(the sole exception is the PLAN-READY turn, where you may `log` a one-line verdict and make at most 3 `move`s with reasons). ' +
    'A `move` LOCKS that item at its new position. `skip` only works on a queued item. `add {goal_id, node_id}` schedules an existing goal node — it never creates work. ' +
    '`runs` lists every session newest-first (label, brief, goals, duration, done/failed, status) and `run {run_id}` opens one with its per-goal and per-node minutes — that is how you answer "how long did you work on X two days ago". ' +
    'Inside a `cockpit:shift-<id>` chat every op defaults to THAT session, even a finished one, so an old shift chat always answers about its own run; a finished session is read-only (move/skip/add return `night_run_ended`). ' +
    '`plan` takes `brief` (Kevin\'s instruction for the shift, verbatim — it is injected into the orchestrator every turn), `label` (a short name) and `config` ({lanes, per_goal_parallel, build_model, verify_model}). ' +
    '`report` builds the report markdown on demand.',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['status', 'runs', 'run', 'plan', 'start', 'pause', 'resume', 'stop', 'move', 'skip', 'add', 'log', 'report'],
        description: 'What to do.',
      },
      run_id: { type: 'number', description: 'Target run id. Omit to act on the active run.' },
      mode: { type: 'string', enum: ['until_stop', 'until_budget'], description: 'For plan: how the night ends. Default until_stop.' },
      lanes: { type: 'number', description: 'For plan: 1–4 concurrent lanes (default 3).' },
      brief: { type: 'string', description: "For plan: Kevin's instruction for this shift, VERBATIM (≤2000 chars). It is injected into the orchestrator thread every turn and shown on the board." },
      label: { type: 'string', description: 'For plan: a short name for the session (≤80 chars), e.g. "goal 6 push".' },
      config: { type: 'object', description: 'For plan: {lanes, per_goal_parallel, build_model, light_model, verify_model, max_depth, max_attempts}. Frontier models are rejected.' },
      limit: { type: 'number', description: 'For runs: how many sessions to return (default 20, max 500).' },
      status: { type: 'string', enum: ['planned', 'running', 'paused', 'stopped', 'complete'], description: 'For runs: filter by status.' },
      goal_ids: { type: 'array', items: { type: 'number' }, description: 'For plan: limit the night to these goals. Omit for every live goal.' },
      item_id: { type: 'number', description: 'Target item id. Required for move and skip.' },
      position: { type: 'number', description: 'For move: the new 1-based position (clamped). The item locks there.' },
      goal_id: { type: 'number', description: 'For add: the goal the node belongs to.' },
      node_id: { type: 'number', description: 'For add: the goal node to schedule.' },
      after_item_id: { type: 'number', description: 'For add: insert right after this item (default: the end of the list).' },
      text: { type: 'string', description: 'For log: one sentence — what you decided and why.' },
    },
    required: ['operation'],
  },
  execute: async (args, context) => {
    const op = String(args.operation ?? '');
    const ext = context?.externalId;
    try {
      switch (op) {
        case 'status': {
          // §3.1 — inside a shift chat, `status` is THAT shift's status.
          const own = ext ? runIdForThread(ext) : null;
          if (own != null) {
            const active = activeNightRun();
            if (active?.id !== own) return runDetail(own);
          }
          return nightStatusDigest();
        }
        case 'runs':
          return {
            runs: listNightRuns({
              limit: args.limit === undefined ? 20 : Number(args.limit),
              status: typeof args.status === 'string' ? (args.status as NightRunStatus) : null,
            }),
          };
        case 'run':
          return runDetail(requireRun(args.run_id, ext));
        case 'plan': {
          // `config` is the full object; `lanes` stays as the shorthand it has
          // always been and is merged over it.
          const base = (args.config && typeof args.config === 'object') ? { ...(args.config as Record<string, unknown>) } : {};
          if (args.lanes !== undefined) base.lanes = Number(args.lanes);
          const plan = planNight({
            mode: args.mode as NightRunMode | undefined,
            goal_ids: Array.isArray(args.goal_ids) ? (args.goal_ids as number[]).map(Number) : undefined,
            config: Object.keys(base).length ? base : undefined,
            brief: typeof args.brief === 'string' ? args.brief : undefined,
            label: typeof args.label === 'string' ? args.label : undefined,
            actor: 'jarvis',
          });
          return {
            run: plan.run, eta_end: plan.eta_end, items: plan.items.slice(0, 12),
            item_count: plan.items.length, warnings: plan.warnings,
            thread_ext: runThreadExt(plan.run),
          };
        }
        case 'start':
          return { run: startNightRun(requireRun(args.run_id, ext), 'jarvis') };
        case 'pause':
          return { run: pauseNightRun(requireRun(args.run_id, ext), 'jarvis') };
        case 'resume':
          return { run: resumeNightRun(requireRun(args.run_id, ext), 'jarvis') };
        case 'stop':
          return { run: stopNightRun(requireRun(args.run_id, ext), 'kevin', 'jarvis') };
        case 'move': {
          if (args.item_id === undefined || args.position === undefined) return { error: 'item_id and position are required' };
          const items = moveNightItem(requireRun(args.run_id, ext), Number(args.item_id), Number(args.position), 'jarvis');
          return { items: items.slice(0, 12), item_count: items.length };
        }
        case 'skip':
          if (args.item_id === undefined) return { error: 'item_id is required' };
          return { item: skipNightItem(requireRun(args.run_id, ext), Number(args.item_id), 'jarvis') };
        case 'add': {
          if (args.goal_id === undefined || args.node_id === undefined) return { error: 'goal_id and node_id are required' };
          return {
            item: addNightItem(requireRun(args.run_id, ext), Number(args.goal_id), Number(args.node_id),
              args.after_item_id === undefined ? null : Number(args.after_item_id), 'jarvis'),
          };
        }
        case 'log': {
          const text = typeof args.text === 'string' ? args.text.trim() : '';
          if (!text) return { error: 'text is required' };
          // The PLAN-READY read is recorded as plan_review so the report can
          // separate "what I thought of the plan" from the night's own log.
          // §3.1 — a shift chat logs against ITS OWN run, even a finished one.
          const runId = requireRun(args.run_id, ext);
          const run = getNightRun(runId);
          const kind = run?.status === 'planned' ? 'plan_review' : 'orchestrator_log';
          return { logged: nightOrchestratorLog(text, kind, runId), kind };
        }
        case 'report': {
          const runId = requireRun(args.run_id, ext);
          const report = buildNightShiftReport(runId);
          nightOrchestratorLog(`night report built → ${report.path ?? '(not written)'}`, 'orchestrator_log', runId);
          return { markdown: report.markdown, path: report.path, written: report.written };
        }
        default:
          return { error: `unknown operation: ${op || '(none)'}` };
      }
    } catch (err) {
      return errorResult(err);
    }
  },
};

