// turn-admission — a global ceiling on CONCURRENT AUTOMATED model turns.
//
// Why this exists (2026-09-23 overnight): the box ran out of memory and took 33
// OOM kills. The obvious suspect was the hopper engine, but it caps itself at
// HOPPER_ENGINE_SLOTS=2 workers and never exceeded it. The real surface was
// JARVIS turns: autopilot cues, goal-chat and node-chat cues, tree-done cues,
// guard cues and a leaking sim each call agent.processMessage directly, and
// NOTHING counted them against each other. Twelve to fourteen claude processes
// at ~250-300MB apiece is simply more than the box had.
//
// So the ceiling belongs here, at the turn, not at the tree. Two rules:
//
//   1. Only AUTOMATED turns are gated. Anything Kevin is waiting on goes
//      straight through — a cap that makes his own chat queue behind a robot is
//      a worse bug than the one it fixes.
//   2. Gated turns WAIT for a slot rather than being dropped. The work is not
//      lost, just paced; a cue that waits 40s is invisible, a cue that vanishes
//      is a silent hole in the night.

import { getSetting } from './conversation-db.js';

/** Correlation-key prefixes minted by the automated producers. */
const AUTOMATED_KEY_PREFIXES = [
  'goal-structure:', 'goal-weighin:', 'goal-guard:', 'goal-tree:', 'autopilot:',
  'dispatch-cue:', 'tree-cue:', 'nightshift:', 'critic:', 'checkin:',
  // NIGHT SHIFT (review node #682): its cues mint `night:<run>:<item>:<n>` —
  // `nightshift:` never matched one, so up to 4 lanes of orchestrator turns ran
  // OUTSIDE the ceiling all night, which is exactly the surface this file exists
  // to cap. Gated turns WAIT for a slot, so nothing is lost.
  'night:',
];

export function isAutomatedTurn(externalId: string, correlationKey?: string): boolean {
  if (externalId.startsWith('cockpit:hopper-node-')) return true; // a spawned worker
  if (!correlationKey) return false;
  return AUTOMATED_KEY_PREFIXES.some((p) => correlationKey.startsWith(p));
}

function cap(): number {
  const raw = getSetting('max_concurrent_auto_turns');
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 4; // 4 × ~300MB leaves headroom
}

const MAX_WAIT_MS = 10 * 60 * 1000;

let active = 0;
const waiters: Array<() => void> = [];

export function activeAutomatedTurns(): number { return active; }

/**
 * Acquire a slot for an automated turn. Resolves true once admitted, or false
 * if it waited past MAX_WAIT_MS (caller should skip rather than pile on).
 * Always pair a true with releaseAutomatedSlot() in a finally.
 */
export async function acquireAutomatedSlot(label: string): Promise<boolean> {
  if (active < cap()) { active += 1; return true; }
  console.log(`[turn-admission] ${label} waiting — ${active}/${cap()} automated turns in flight`);
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const i = waiters.indexOf(admit);
      if (i >= 0) waiters.splice(i, 1);
      console.warn(`[turn-admission] ${label} gave up after ${MAX_WAIT_MS / 60000}m waiting for a slot`);
      resolve(false);
    }, MAX_WAIT_MS);
    function admit() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active += 1;
      resolve(true);
    }
    waiters.push(admit);
  });
}

export function releaseAutomatedSlot(): void {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}
