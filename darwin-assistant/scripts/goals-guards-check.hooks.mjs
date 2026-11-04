// Node ESM loader hook for scripts/goals-guards-check.mjs (CONTRACT §12, node
// #476). Intercepts ONLY the dynamic `import('./agent.js')` that goals-guards.ts
// performs inside fireGuardCue (scoped to parentURL === .../dist/goals-guards.js)
// and swaps in a stub — so a guard health flip "sends" its cue without spawning
// a real claude CLI turn (NO API KEYS / no real model calls). Mirrors
// scripts/goals-v01-cue-check.hooks.mjs, scoped to goals-guards.js.
const STUB = 'data:text/javascript,' + encodeURIComponent(`
  export async function processMessage(text, externalId, correlationKey) {
    globalThis.__guardCueCalls = globalThis.__guardCueCalls || [];
    globalThis.__guardCueCalls.push({ text, externalId, correlationKey });
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
