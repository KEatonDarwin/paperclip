// Node ESM loader hook for scripts/tree-cue-check.mjs (tree-cue, node #473).
// Intercepts ONLY the dynamic `import('./agent.js')` that tree-cue.ts's
// treeCueOnTreeStatus performs (scoped to parentURL === .../dist/tree-cue.js —
// tree-cue.ts never statically imports agent.js, only this one dynamic call
// does) and swaps in a stub that just records what would have been posted. This
// proves the cue is composed + "sent" correctly with NO real claude CLI turn
// (NO API KEYS / no real model calls). Scoping by parentURL keeps other modules'
// static imports of dist/agent.js untouched.
const STUB = 'data:text/javascript,' + encodeURIComponent(`
  export async function processMessage(text, externalId, correlationKey) {
    globalThis.__treeCueCalls = globalThis.__treeCueCalls || [];
    globalThis.__treeCueCalls.push({ text, externalId, correlationKey });
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
