import type { ToolDef } from './index.js';
import {
  NightError,
  activeNightRun,
  addNightItem,
  buildNightShiftReport,
  latestNightRun,

  moveNightItem,
  nightOrchestratorLog,
  nightStatusDigest,
  pauseNightRun,
  planNight,
  resumeNightRun,
  skipNightItem,
  startNightRun,
  stopNightRun,
  type NightRunMode,
} from '../night-shift.js';

// NIGHT SHIFT persona tool (CONTRACT §6) — the orchestrator thread's handle on
// the night: read the list, log its own read, and (only when Kevin says so in
// the chat) move/skip/add/pause/resume/stop. It never invents work: every item
// is a goal node the planner already scheduled.

function requireRun(argId?: unknown): number {
  if (typeof argId === 'number' && Number.isFinite(argId)) return argId;
  const run = activeNightRun() ?? latestNightRun();
  if (!run) throw new NightError(404, 'night_run_not_found', 'there is no night run — plan one first');
  return run.id;
}

function errorResult(err: unknown): { error: string; message?: string } {
  if (err instanceof NightError) return { error: err.code, message: err.message };
  return { error: 'night_tool_failed', message: err instanceof Error ? err.message : String(err) };
}

export const nightShift: ToolDef = {
  name: 'night_shift',
  description:
    "Drive Kevin's Night Shift — the ONE frozen, ordered list that runs every goal overnight through N lanes out of this thread. " +
    "`status` (the run, the next ~12 rows, lanes, hold, budget) is the read you want before answering anything about the night. " +
    '`log {text}` after every cue turn: one sentence on what you decided and why — the morning report is built from those lines. ' +
    '`plan` / `start` / `pause` / `resume` / `stop` / `move` / `skip` / `add` change the night itself — call them ONLY when Kevin asked for that in words in this thread, never on your own initiative ' +
    '(the sole exception is the PLAN-READY turn, where you may `log` a one-line verdict and make at most 3 `move`s with reasons). ' +
    'A `move` LOCKS that item at its new position. `skip` only works on a queued item. `add {goal_id, node_id}` schedules an existing goal node — it never creates work. ' +
    '`report` builds the night report markdown on demand.',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['status', 'plan', 'start', 'pause', 'resume', 'stop', 'move', 'skip', 'add', 'log', 'report'],
        description: 'What to do.',
      },
      run_id: { type: 'number', description: 'Target run id. Omit to act on the active run.' },
      mode: { type: 'string', enum: ['until_stop', 'until_budget'], description: 'For plan: how the night ends. Default until_stop.' },
      lanes: { type: 'number', description: 'For plan: 1–4 concurrent lanes (default 3).' },
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
  execute: async (args) => {
    const op = String(args.operation ?? '');
    try {
      switch (op) {
        case 'status':
          return nightStatusDigest();
        case 'plan': {
          const config = args.lanes !== undefined ? { lanes: Number(args.lanes) } : undefined;
          const plan = planNight({
            mode: args.mode as NightRunMode | undefined,
            goal_ids: Array.isArray(args.goal_ids) ? (args.goal_ids as number[]).map(Number) : undefined,
            config,
            actor: 'jarvis',
          });
          return { run: plan.run, eta_end: plan.eta_end, items: plan.items.slice(0, 12), item_count: plan.items.length };
        }
        case 'start':
          return { run: startNightRun(requireRun(args.run_id), 'jarvis') };
        case 'pause':
          return { run: pauseNightRun(requireRun(args.run_id), 'jarvis') };
        case 'resume':
          return { run: resumeNightRun(requireRun(args.run_id), 'jarvis') };
        case 'stop':
          return { run: stopNightRun(requireRun(args.run_id), 'kevin', 'jarvis') };
        case 'move': {
          if (args.item_id === undefined || args.position === undefined) return { error: 'item_id and position are required' };
          const items = moveNightItem(requireRun(args.run_id), Number(args.item_id), Number(args.position), 'jarvis');
          return { items: items.slice(0, 12), item_count: items.length };
        }
        case 'skip':
          if (args.item_id === undefined) return { error: 'item_id is required' };
          return { item: skipNightItem(requireRun(args.run_id), Number(args.item_id), 'jarvis') };
        case 'add': {
          if (args.goal_id === undefined || args.node_id === undefined) return { error: 'goal_id and node_id are required' };
          return {
            item: addNightItem(requireRun(args.run_id), Number(args.goal_id), Number(args.node_id),
              args.after_item_id === undefined ? null : Number(args.after_item_id), 'jarvis'),
          };
        }
        case 'log': {
          const text = typeof args.text === 'string' ? args.text.trim() : '';
          if (!text) return { error: 'text is required' };
          // The PLAN-READY read is recorded as plan_review so the report can
          // separate "what I thought of the plan" from the night's own log.
          const run = activeNightRun();
          const kind = run?.status === 'planned' ? 'plan_review' : 'orchestrator_log';
          return { logged: nightOrchestratorLog(text, kind), kind };
        }
        case 'report': {
          const runId = requireRun(args.run_id);
          const report = buildNightShiftReport(runId);
          nightOrchestratorLog(`night report built → ${report.path ?? '(not written)'}`);
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

