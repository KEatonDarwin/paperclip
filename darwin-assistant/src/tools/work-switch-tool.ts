import type { ToolDef } from './index.js';
import { LANE_KEYS, laneDef, resetAllLanes, resumeAll, setLane, stopAll } from '../work-switch.js';
import { runWorkCli, workSwitchPayload } from '../work-switch-ops.js';
import { dispatchTick } from '../hopper-engine.js';

// 🛑 WORK SWITCH — the stop-all / per-lane kill switch.
//
// THE ONE RULE in the description: stop_all / lane_off are only called when Kevin
// asked in words. This is HIS switch. But unlike the throttle, JARVIS *may* read
// it freely and *should* read it before claiming anything is or isn't running —
// "why did nothing happen overnight" is answered here first.
//
// `kill` defaults FALSE deliberately. A kill from a chat turn would also end the
// claude process serving that very turn (the workers are its siblings under
// jarvis.service), so Kevin's reply would never land. The cockpit button and the
// `jarvis-work` CLI are the safe places to kill.
export const workSwitch: ToolDef = {
  name: 'work_switch',
  description:
    "Kevin's 🛑 STOP-ALL switch and the per-lane on/off toggles for autonomous work. This is the answer to \"stop everything right now\" and to \"why is nothing running?\". It deliberately changes NO other setting — no worker slots, no ceilings, no provider overrides — so a stop is instant and fully reversible and every dial stays where he left it. Lanes: hopper (spawning new tree/goal workers) · night (the Shifts driver) · autopilot (per-goal autopilot) · shepherd (check-ins) · watchdog (dead-turn resume — this is what keeps reviving a finished worker) · spawn_reconcile · intel · bi · suppression · kpi. 'status' is read-only and free to call any time: it reports whether work is stopped, every lane, in-flight model workers, running/pending hopper nodes and a count of nodes that are retry-looping (attempts>=3 — the signature of a node re-arming itself). ONLY call stop_all / resume_all / lane_off / lane_on / reset_all_lanes / kill_workers when Kevin asked for that in words in this conversation — never flip his switch on your own initiative. NOTE on kill: leave `kill` false when acting from a chat, because killing in-flight workers also ends the model process serving this very turn; tell Kevin to use the cockpit STOP button or `jarvis-work stop --kill` when he wants in-flight work ended immediately.",
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['status', 'stop_all', 'resume_all', 'reset_all_lanes', 'lane_off', 'lane_on', 'kill_workers'],
        description:
          "What to do. 'status' = read-only snapshot. 'stop_all' = hold every lane now. 'resume_all' = release the global stop (per-lane off flags are PRESERVED). 'reset_all_lanes' = the full green light (clears the global stop AND turns every lane back on). 'lane_off'/'lane_on' = one or more individual lanes. 'kill_workers' = end in-flight model workers without touching the switch.",
      },
      lanes: {
        type: 'array',
        items: { type: 'string' },
        description: `Lane keys for lane_off / lane_on. Known: ${LANE_KEYS.join(', ')}.`,
      },
      lane: { type: 'string', description: 'Single lane shorthand for lane_off / lane_on.' },
      reason: { type: 'string', description: "Why — shown on the switch, in its history, and in the cockpit banner. Worth setting so future-you knows why work is off." },
      kill: { type: 'boolean', description: 'For stop_all: also end in-flight model workers. Default false. Leave false from a chat turn (it would kill this turn).' },
    },
    required: ['operation'],
  },
  async execute(args) {
    const op = String(args['operation'] ?? '');
    const reason = typeof args['reason'] === 'string' && args['reason'].trim() ? args['reason'].trim() : undefined;
    const lanes: string[] = Array.isArray(args['lanes'])
      ? (args['lanes'] as unknown[]).filter((l): l is string => typeof l === 'string')
      : typeof args['lane'] === 'string' ? [args['lane'] as string] : [];

    const snapshot = () => {
      const p = workSwitchPayload();
      return {
        all_stopped: p.state.all_stopped,
        stopped_since: p.state.all_stopped_at,
        stopped_by: p.state.all_stopped_by,
        stopped_reason: p.state.all_stopped_reason,
        lanes: p.lanes.map((l) => ({ lane: l.key, label: l.label, running: !l.stopped, hold: l.hold_reason, stops: l.what })),
        in_flight: p.in_flight,
        recent: p.state.events.slice(-6),
      };
    };

    switch (op) {
      case 'status':
        return snapshot();
      case 'stop_all': {
        stopAll('jarvis', reason);
        const killed = args['kill'] === true ? runWorkCli(['kill-workers']) : null;
        return { ok: true, stopped: true, killed, ...snapshot() };
      }
      case 'resume_all':
        resumeAll('jarvis', reason);
        void dispatchTick('work_switch_resumed');
        return { ok: true, ...snapshot() };
      case 'reset_all_lanes':
        resetAllLanes('jarvis', reason);
        void dispatchTick('work_switch_reset');
        return { ok: true, ...snapshot() };
      case 'lane_off':
      case 'lane_on': {
        if (!lanes.length) return { error: `lane or lanes[] is required. Known lanes: ${LANE_KEYS.join(', ')}` };
        const unknown = lanes.filter((l) => !laneDef(l));
        if (unknown.length) return { error: `unknown lane(s): ${unknown.join(', ')} — known: ${LANE_KEYS.join(', ')}` };
        for (const l of lanes) setLane(l, op === 'lane_on', 'jarvis', reason);
        if (op === 'lane_on') void dispatchTick('work_switch_lane_on');
        return { ok: true, changed: lanes, ...snapshot() };
      }
      case 'kill_workers':
        return { ok: true, killed: runWorkCli(['kill-workers']), ...snapshot() };
      default:
        return { error: 'operation must be one of: status, stop_all, resume_all, reset_all_lanes, lane_off, lane_on, kill_workers' };
    }
  },
};
