// Node ESM loader hook for scripts/goals-autopilot-check.mjs (node #538,
// CONTRACT §15). Same shape as goals-v01-cue-check.hooks.mjs, but scoped to
// BOTH dynamic `import('./agent.js')` call sites the autopilot path can reach:
//   - dist/goals.js        (postCue — §11.3 seam, reused by autopilot cues)
//   - dist/goals-autopilot.js (chatBusy's getInFlightMessageId probe)
// so the smoke can never spawn a real claude CLI turn (NO API KEYS). Scoping
// by parentURL matters: other modules statically import real exports
// (runClaude, …) from dist/agent.js and must keep the real module.
const STUB = 'data:text/javascript,' + encodeURIComponent(`
  export async function processMessage(text, externalId, correlationKey) {
    globalThis.__goalsCueCalls = globalThis.__goalsCueCalls || [];
    globalThis.__goalsCueCalls.push({ text, externalId, correlationKey });
    return 'STUB_OK — no real model call made.';
  }
  export function getInFlightMessageId() { return null; }
  export class ConversationBusyError extends Error {}
`);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/agent.js') || specifier === './agent.js') {
    const parentURL = context.parentURL ?? '';
    if (parentURL.endsWith('/dist/goals.js') || parentURL.endsWith('/dist/goals-autopilot.js')) {
      const result = await nextResolve(specifier, context).catch(() => null);
      if (result && result.url.endsWith('/dist/agent.js')) {
        return { url: STUB, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
