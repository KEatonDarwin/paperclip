// Node ESM loader hook used by scripts/goals-sim.ts's guard-lifecycle section
// (CONTRACT §12, node #478). Intercepts ONLY the dynamic `import('./agent.js')`
// that goals-guards.ts's fireGuardCue performs (scoped to parentURL ===
// .../dist/goals-guards.js — goals-guards.ts never statically imports agent.js,
// only this one dynamic call does) and swaps in a stub — so a guard health
// flip "sends" its cue without spawning a real claude CLI turn (NO API KEYS /
// no live model calls anywhere in the sim). Mirrors
// scripts/goals-guards-check.hooks.mjs, but pushes onto the SAME
// globalThis.__goalsCueCalls array that scripts/goals-v01-cue-check.hooks.mjs
// (scoped to dist/goals.js) already uses, so goals-sim.ts's existing
// cueCalls()/cueCallCount()/waitForCueCalls() helpers see both goal-review
// cues and guard cues with no new plumbing. Registered alongside that hook —
// the two conditions are mutually exclusive (different parentURL), so
// registration order doesn't matter.
const STUB = 'data:text/javascript,' + encodeURIComponent(`
  export async function processMessage(text, externalId, correlationKey) {
    globalThis.__goalsCueCalls = globalThis.__goalsCueCalls || [];
    globalThis.__goalsCueCalls.push({ text, externalId, correlationKey });
    return 'STUB_OK — no real model call made.';
  }
  export function getInFlightMessageId() { return undefined; }
  export class ConversationBusyError extends Error {}
`);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/agent.js') || specifier === './agent.js') {
    const parentURL = context.parentURL ?? '';
    if (parentURL.endsWith('/dist/goals-guards.js')) {
      const result = await nextResolve(specifier, context).catch(() => null);
      if (result && result.url.endsWith('/dist/agent.js')) {
        return { url: STUB, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
