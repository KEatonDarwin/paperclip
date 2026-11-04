// Node ESM loader hook for scripts/mike-radar-chat-check.mjs (node #1342).
//
// Intercepts ONLY the dynamic `import('./agent.js')` that mike-radar-cue.ts's
// fireMikeReportCue performs — scoped to parentURL === .../dist/mike-radar-cue.js,
// which is the single place that import exists (the module never statically
// imports agent.js; that is the whole reason the import is dynamic) — and swaps
// in a stub that records what WOULD have been posted.
//
// This is what makes the cue testable for free: the cue is composed, routed and
// "sent" with NO claude CLI turn and NO API KEYS. Scoping by parentURL leaves
// every other module's static import of dist/agent.js completely untouched,
// including agent.js itself, which this check also loads for real to prove the
// per-turn context block is wired into the prompt prefix.
const STUB = 'data:text/javascript,' + encodeURIComponent(`
  export async function processMessage(text, externalId, correlationKey) {
    globalThis.__mikeCueCalls = globalThis.__mikeCueCalls || [];
    globalThis.__mikeCueCalls.push({ text, externalId, correlationKey });
    return 'STUB_OK — no real model call made.';
  }
  export function getInFlightMessageId() { return globalThis.__mikeInFlight ?? undefined; }
  export class ConversationBusyError extends Error {}
`);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/agent.js') || specifier === './agent.js') {
    const parentURL = context.parentURL ?? '';
    if (parentURL.endsWith('/dist/mike-radar-cue.js')) {
      const result = await nextResolve(specifier, context).catch(() => null);
      if (result && result.url.endsWith('/dist/agent.js')) {
        return { url: STUB, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
