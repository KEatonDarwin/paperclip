import type { ToolDef } from './index.js';
import {
  normalizeThrottlePatch,
  writeThrottleUpdates,
  enforceAdmissionFloor,
  applyThrottlePreset,
  listThrottlePresets,
} from '../throttle.js';
// The COMPOSED status (governor verdicts + account views). A bare
// `throttleStatus()` in throttle.ts takes those as an argument and, with none supplied, reports
// `dispatching: true` and an empty account list no matter how hard the governor
// is holding — which is precisely the question this tool exists to answer
// ("why is nothing running?"). Review node #719.
import { fullThrottleStatus } from '../throttle-status.js';
import { dispatchTick } from '../hopper-engine.js';

// ⚡ THROTTLE (CONTRACT §7.5) — the dials Kevin turns himself.
//
// THE ONE RULE baked into the description below: `set` and `preset` are only
// called when Kevin asked for that change IN WORDS. The throttle is HIS dial, not
// JARVIS's to self-tune — a model that quietly raises its own ceilings is the
// single failure mode this whole feature must not introduce. `status` is free.
export const throttle: ToolDef = {
  name: 'throttle',
  description:
    "Kevin's ⚡ Throttle — the manual dials over the autonomous work rate: total simultaneous workers (hopper_slots), max workers per goal / per tree, which Claude account or provider runs the work (throttle_claude_mode: auto | ordered | split | a | b), and the per-provider stop-loss ceilings. 'status' is a read-only snapshot: the dials, the live running-by-goal/by-tree breakdown, each account's 5h/weekly % and reset countdown, and ONE honest hold reason explaining why nothing is dispatching — call it freely whenever Kevin asks how hard the system is running, why a tree is stalled, or how much subscription is left. 'set' writes dials and 'preset' applies one of the saved presets (turned_up · normal · conserve · overnight). ONLY call 'set' or 'preset' when Kevin asked for that change in words in this conversation — these are HIS dials, never yours to self-tune, and raising your own ceilings is exactly the thing you must not do. Dial changes affect FUTURE claims only; a running worker is never interrupted.",
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['status', 'set', 'preset'], description: 'What to do.' },
      name: { type: 'string', description: 'Preset name for preset: turned_up | normal | conserve | overnight.' },
      hopper_slots: { type: 'number', description: 'Total simultaneous workers, 1–12.' },
      throttle_max_per_goal: { type: 'number', description: 'Max concurrent workers on ONE goal; 0 = unlimited.' },
      throttle_max_per_tree: { type: 'number', description: 'Max concurrent workers on ONE tree; 0 = unlimited.' },
      throttle_claude_mode: {
        type: 'string',
        enum: ['auto', 'ordered', 'split', 'a', 'b'],
        description:
          "auto = least-used (default) · ordered = first with headroom by throttle_claude_order, SPILLS to the next account · split = alternate worker spawns · a / b = focus ONE account and HOLD when it's spent (never spills).",
      },
      throttle_claude_order: { type: 'string', description: "Order for 'ordered' mode, e.g. 'a,b'." },
      throttle_provider_order: { type: 'string', description: "Cross-provider order, e.g. 'claude,codex,auggie'." },
      throttle_provider_fallback: {
        type: 'string',
        enum: ['on', 'off'],
        description: "on = a Claude node whose accounts are all stopped out reroutes to the next metered pool. Default off = hold.",
      },
      gov_5h_ceiling: { type: 'number', description: 'Claude 5-hour stop-loss %, max 98.' },
      gov_weekly_ceiling: { type: 'number', description: 'Claude weekly stop-loss %, max 98.' },
      gov_weekly_mode: { type: 'string', enum: ['soft', 'hard'], description: 'soft = notify and continue; hard = park.' },
      gov_kevin_active_claude_max_5h: { type: 'number', description: 'Run Claude while Kevin is at the keyboard below this 5h %, max 98.' },
      gov_codex_ceiling: { type: 'number', description: 'Codex stop-loss %, max 98.' },
      gov_auggie_ceiling: { type: 'number', description: 'Augment stop-loss %, max 98.' },
      gov_concurrency_cap: { type: 'number', description: 'Non-Claude workers allowed while Kevin is active.' },
    },
    required: ['operation'],
  },
  execute: async (args) => {
    const op = typeof args.operation === 'string' ? args.operation : '';

    if (op === 'status') return fullThrottleStatus();

    if (op === 'preset') {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) return { error: `preset needs a name. Valid: ${Object.keys(listThrottlePresets()).join(', ')}` };
      const result = applyThrottlePreset(name);
      if (!result.ok) return { error: result.error?.message ?? 'preset could not be applied', valid: result.error?.valid };
      void dispatchTick('throttle_preset_applied');
      return { ok: true, preset: result.name, updated: result.updated, clamped: result.clamped, status: fullThrottleStatus() };
    }

    if (op === 'set') {
      const { operation: _op, name: _name, ...dials } = args;
      const patch = normalizeThrottlePatch(dials as Record<string, unknown>);
      if (patch.error) return { error: patch.error.message };
      if (!Object.keys(patch.updates).length) return { error: 'set needs at least one dial' };
      writeThrottleUpdates(patch.updates);
      const admission = enforceAdmissionFloor();
      void dispatchTick('throttle_changed');
      return { ok: true, updated: Object.keys(patch.updates), clamped: patch.clamped, admission_raised: admission, status: fullThrottleStatus() };
    }

    return { error: `unknown operation: ${op || '(none)'}` };
  },
};
