// Node ESM loader hook used by scripts/health-sim.ts. Intercepts EVERY
// `./agent.js` import that health-monitor.ts performs — its static
// `import { getActiveRuns } from './agent.js'` (used for the claude-proc-count
// fallback + the workload snapshot's active-runs listing) AND the dynamic
// `import('./agent.js')` postHealthCue does to post a cue — scoped to
// `context.parentURL === .../dist/health-monitor.js` so nothing ELSE that
// imports agent.js is touched, and swaps in a stub that records cues onto
// globalThis.__HEALTH_CUES__ instead of spawning a real turn.
//
// Scoping matters here specifically because health-sim.ts boots the FULL
// createApiV1Router() module graph (unlike health-check.mjs, which only
// imports health-monitor.js + conversation-db.js directly) — and other
// modules reachable from api-v1.js (big-board.js, api-v1.js itself)
// STATICALLY import unrelated real exports (e.g. resolveConversationRuntime,
// isPlanModeMessage) from dist/agent.js. An unscoped stub — like
// health-check.hooks.mjs's, which is fine for health-check.mjs's narrower
// import graph — breaks those imports with "does not provide an export named
// ...". Mirrors the same scoped pattern as scripts/goals-v01-cue-check.hooks.mjs
// / goals-guards-sim-cue / goals-tree-cue-sim / goals-tool-sim-seed.
const STUB = 'data:text/javascript,' + encodeURIComponent(`
  globalThis.__HEALTH_CUES__ = globalThis.__HEALTH_CUES__ ?? [];
  export class ConversationBusyError extends Error {}
  export function getInFlightMessageId() { return undefined; }
  export function getActiveRuns() { return []; }
  export function processMessage(text, externalId, correlationKey) {
    globalThis.__HEALTH_CUES__.push({ text, externalId, correlationKey });
    return Promise.resolve('STUB_OK — no real model call made.');
  }
`);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/agent.js') || specifier === './agent.js') {
    const parentURL = context.parentURL ?? '';
    if (parentURL.endsWith('/dist/health-monitor.js')) {
      const result = await nextResolve(specifier, context).catch(() => null);
      if (result && result.url.endsWith('/dist/agent.js')) {
        return { url: STUB, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
