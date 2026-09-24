// Sim guard — a sim that isolates its DATABASE is not thereby isolating the MODEL.
//
// Background (2026-09-24 incident): `npm run critic:sim` fanned out into six
// live Opus turns. The sim pointed JARVIS_DB_PATH at a throwaway DB, but
// src/goals.ts postCue() genuinely calls agent.processMessage — so every cue the
// sim triggered woke a real, billed JARVIS turn that answered against fixture
// goals and wrote into a DB the next run deletes. The sim still reported 60/60:
// from inside, a fired cue and a stubbed cue are indistinguishable, so green did
// not mean hermetic. The Night Shift SIM node repeated it the next morning.
//
// Per-sim ESM stub hooks (scripts/*.hooks.mjs) remain the first line of defence,
// but they are opt-in and every new sim has to remember one. This module is the
// second line: a single check at the one chokepoint every model turn passes
// through, so a sim is protected whether or not its author knew to register a
// hook.
//
// The rule: a model turn may only run against the REAL jarvis.db. Any other
// database — or an explicit JARVIS_SIM=1 — means we are in a scratch harness and
// spawning a billed turn is a bug, not a feature.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The one database a real model turn is allowed to run against. */
const LIVE_DB_PATH = path.resolve(path.join(HERE, '..', 'jarvis.db'));

/**
 * True when this process is running against anything other than the live
 * jarvis.db. Deliberately fails CLOSED: an unrecognised database is treated as
 * scratch, because the cost of wrongly blocking a turn (a sim assertion fails
 * loudly) is far below the cost of wrongly allowing one (real tokens burnt on
 * fixture data, cascading cue→turn→cue loops, no trace once the DB is deleted).
 */
export function isScratchEnv(): boolean {
  if (process.env['JARVIS_SIM'] === '1') return true;
  const configured = process.env['JARVIS_DB_PATH'];
  if (!configured) return false; // unset === the default live path
  return path.resolve(configured) !== LIVE_DB_PATH;
}

/** One-line description of why a turn was refused, for logs and thrown errors. */
export function scratchReason(): string {
  if (process.env['JARVIS_SIM'] === '1') return 'JARVIS_SIM=1';
  return `JARVIS_DB_PATH=${process.env['JARVIS_DB_PATH']} (not the live jarvis.db)`;
}

/** Marker class so callers can distinguish a refusal from a real failure. */
export class SimGuardError extends Error {
  constructor(where: string) {
    super(
      `[sim-guard] refused to start a model turn from ${where}: running in a scratch ` +
        `environment (${scratchReason()}). A sim must stub agent.processMessage — see ` +
        `scripts/goals-tree-cue-sim.hooks.mjs for the pattern. Set JARVIS_SIM=0 and point ` +
        `JARVIS_DB_PATH at the live DB only if you genuinely intend to spend tokens.`,
    );
    this.name = 'SimGuardError';
  }
}

let warned = false;

/**
 * Call at the top of any function that would spawn a billed model turn.
 * Returns true when the caller should abort. Logs once per process so a sim
 * that trips it repeatedly stays readable.
 */
export function refuseModelTurnInScratch(where: string): boolean {
  if (!isScratchEnv()) return false;
  if (!warned) {
    warned = true;
    console.error(
      `[sim-guard] BLOCKED a model turn from ${where} — scratch environment (${scratchReason()}). ` +
        `Further blocks this process are silent.`,
    );
  }
  return true;
}
