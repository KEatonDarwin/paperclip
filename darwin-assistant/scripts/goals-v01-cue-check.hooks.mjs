// Node ESM loader hook used ONLY by scripts/goals-v01-cue-check.mjs (node #469,
// CONTRACT §11.3/§11.4 manual exercise). Intercepts the dynamic `import('./agent.js')`
// that goals.ts's fireGoalReviewCue performs and swaps in a stub — so the exercise
// proves the cue is composed + "sent" correctly without spawning a real claude CLI
// turn (NO API KEYS / no real model calls in a throwaway check).
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
    const result = await nextResolve(specifier, context).catch(() => null);
    if (result && result.url.endsWith('/dist/agent.js')) {
      return { url: STUB, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
