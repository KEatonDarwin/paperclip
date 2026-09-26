// UNPARK PASS — docs/hopper/PARALLEL-CONTRACT.md §6 (tree-383bb55b node #946).
//
// hopper-git.ts already owns the pure per-condition check (`evaluateUnpark`,
// `parseUnparkCondition`, `UnparkCondition` — shipped by node #945 as the §9
// "one shared surface", filled by this node). This module is the thin BATCH
// layer over it: `evaluateUnparks()` is the "one pass" the CONTRACT calls for.
//
// Deliberately has NO import of goals.ts / night-shift.ts / goals-autopilot.ts:
// night-shift.ts already imports goals-autopilot.ts, which imports goals.ts, so
// this module importing either of the domain modules risks a cycle depending on
// which side wires up first. Instead goals.ts and night-shift.ts each build
// their own `UnparkTarget[]` from their own rows (parked goal_nodes / condition-
// parked night_items) and apply the verdicts with their own domain logic
// (`unparkGoalNode`, `requeue`) — this module only does the pure evaluation.

import { evaluateUnpark, parseUnparkCondition, type UnparkCondition } from './hopper-git.js';

export type { UnparkCondition };
export { parseUnparkCondition, evaluateUnpark };

export interface UnparkTarget<T = unknown> {
  /** Caller-defined reference (a goal node id, a night item id, ...). */
  ref: T;
  condition: UnparkCondition;
}

export interface UnparkVerdict<T = unknown> {
  ref: T;
  condition: UnparkCondition;
  met: boolean;
}

/**
 * The one pass: evaluate every target's condition. Pure — no writes, no model
 * calls, no network (each individual check is already pure per hopper-git.ts's
 * `evaluateUnpark`). Callers apply the effect (unpark / re-queue) themselves for
 * every verdict where `met === true`.
 */
export function evaluateUnparks<T>(targets: UnparkTarget<T>[]): UnparkVerdict<T>[] {
  return targets.map((t) => ({ ref: t.ref, condition: t.condition, met: evaluateUnpark(t.condition) }));
}
