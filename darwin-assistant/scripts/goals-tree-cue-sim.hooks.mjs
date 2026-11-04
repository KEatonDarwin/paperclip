// Node ESM loader hook used by scripts/goals-sim.ts's v0.3 §14 node-chat
// section (CONTRACT §14.6 tree-done routing). Intercepts ONLY the dynamic
// `import('./agent.js')` that tree-cue.ts's treeCueOnTreeStatus performs
// (scoped to parentURL === .../dist/tree-cue.js — tree-cue.ts never statically
// imports agent.js, only that one dynamic call does) and swaps in a stub, so a
// finished hopper tree "posts" its cue without spawning a real claude CLI turn
// (NO API KEYS / no live model calls anywhere in the sim). Pushes onto the SAME
// globalThis.__goalsCueCalls array as the goals.js / goals-guards.js hooks so
// the sim's cueCalls()/lastCueCall() helpers see tree cues too. The three hook
// conditions are mutually exclusive (different parentURL), so order is moot.
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
    if (parentURL.endsWith('/dist/tree-cue.js')) {
      const result = await nextResolve(specifier, context).catch(() => null);
      if (result && result.url.endsWith('/dist/agent.js')) {
        return { url: STUB, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
