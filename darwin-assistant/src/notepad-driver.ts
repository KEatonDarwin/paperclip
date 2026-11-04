import { getSetting } from './conversation-db.js';
import { laneStopped } from './work-switch.js';
import { todayNotepadDate } from './notepad.js';
import { runNotepadSpeak } from './notepad-speak.js';

// THE PERIODIC CALLER the settle chain was missing.
//
// Every piece of goal #6's brain was built and proven (27 check suites) but
// nothing in the running service ever invoked it: notepad-settle.ts closes
// with "No periodic caller is wired here", #98 deferred it to "the next
// consumer", and no node ever claimed it. Result on 2026-09-26: the whole
// chain was live in dist/ while `notepad_markers` and `notepad_line_state`
// held zero rows -- Kevin typed all day and JARVIS never read a word.
//
// This is that caller, and it is deliberately the dumbest possible one.
// runNotepadSpeak -> runNotepadPass -> checkNotepadSettle already owns ALL
// the "should anything happen right now" judgement:
//
//   - not quiet long enough yet (notepad_settle_seconds) -> returns null
//   - already settled for this exact write -> returns null
//   - nothing survived the deterministic prefilter -> no model call
//
// so a fixed tick cannot cause a double pass, cannot fire per-keystroke, and
// costs one indexed SELECT when the note is idle. That is why this ticks on a
// timer instead of hooking PUT /notepad: the save handler must stay off the
// keystroke path, and "quiet for N seconds" is by definition something only a
// later clock tick can observe.
const DEFAULT_TICK_SECONDS = 60;

function tickSeconds(): number {
  const raw = getSetting('notepad_tick_seconds');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 10 ? n : DEFAULT_TICK_SECONDS;
}

/** Kill switch. `notepad_speak_enabled=0` stops judgement; saves keep working. */
function enabled(): boolean {
  return getSetting('notepad_speak_enabled') !== '0';
}

let running = false;

/**
 * One pass over today's note. Never throws -- a bad model call, a stale
 * settings row or a broken dossier must not take down jarvis.service, and it
 * must not stop the NEXT tick from trying again.
 *
 * `running` is a re-entrancy guard, not an optimisation: a pass that spends
 * two model one-shots can outlive a 60s tick, and two concurrent passes over
 * the same day would race on the same marker rows.
 */
export async function runNotepadTick(): Promise<void> {
  if (running) return;
  if (!enabled()) return;
  // Kevin's stop-all (and the autopilot lane specifically) covers every
  // surface where JARVIS acts on its own judgement -- this is one of them.
  if (laneStopped('autopilot')) return;

  running = true;
  try {
    const day = todayNotepadDate();
    const result = await runNotepadSpeak(day);

    // BE LOUD ABOUT FALLBACKS. A timed-out model call degrades to "nothing
    // landed"/"no moves", which on the outside is indistinguishable from a
    // genuinely quiet day -- that is exactly how this chain sat silent with
    // 20s/30s timeouts and nobody noticed. A fallback is an incident, not a
    // verdict: say so every time.
    const gateFellBack = (result.pass.gate ?? []).some((v) => v.reason === 'fallback');
    if (gateFellBack) {
      console.error(
        `[notepad] ${day}: GATE FELL BACK (model call failed/timed out) -- judged nothing. ` +
          `Raise notepad_gate_timeout_ms if this repeats.`,
      );
    }
    if (result.moves && result.moves.outcome === 'fallback') {
      console.error(
        `[notepad] ${day}: MOVES FELL BACK (model call failed/timed out) -- no markers published. ` +
          `Raise notepad_moves_timeout_ms if this repeats.`,
      );
    }

    if (result.markers.length > 0) {
      console.log(
        `[notepad] ${day}: ${result.markers.length} marker(s) -- ` +
          result.markers.map((m) => `${m.line_id}:${m.kind}`).join(' '),
      );
    } else if (result.pass.worth_reviewing) {
      console.log(`[notepad] ${day}: reviewed, nothing worth saying`);
    }
  } catch (err) {
    console.error('[notepad] tick failed:', err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

export function startNotepadDriver(): void {
  const secs = tickSeconds();
  console.log(`[notepad] driver started · tick ${secs}s · speak ${enabled() ? 'on' : 'OFF'}`);
  setInterval(() => void runNotepadTick(), secs * 1000);
}
