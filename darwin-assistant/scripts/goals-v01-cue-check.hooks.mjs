// Node ESM loader hook used by scripts/goals-v01-cue-check.mjs (node #469) AND
// scripts/goals-sim.ts (node #471, CONTRACT §11.3/§11.4). Intercepts ONLY the
// dynamic `import('./agent.js')` that goals.ts's fireGoalReviewCue performs
// (scoped to `context.parentURL === .../dist/goals.js` — goals.ts never
// statically imports agent.js, only this one dynamic call does) and swaps in a
// stub — so the exercise proves the cue is composed + "sent" correctly without
// spawning a real claude CLI turn (NO API KEYS / no real model calls). Scoping
// by parentURL matters for goals-sim.ts specifically: it boots the full
// createApiV1Router() module graph, where OTHER modules (notes.ts,
// dispatch-gate.ts, …) statically import unrelated exports (e.g. runClaude)
// from dist/agent.js — an unscoped stub would break those imports too.
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
    if (parentURL.endsWith('/dist/goals.js')) {
      const result = await nextResolve(specifier, context).catch(() => null);
      if (result && result.url.endsWith('/dist/agent.js')) {
        return { url: STUB, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
