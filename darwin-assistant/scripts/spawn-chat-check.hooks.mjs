// Node ESM loader hook for scripts/spawn-chat-check.mjs (overnight 2026-10-12,
// spawn_chat). Intercepts ONLY the dynamic `import('../agent.js')` that
// dist/tools/spawn-chat-tool.js performs and swaps in a stub that records what
// would have been dispatched — NO real claude turn, NO API keys. getAdapters is
// re-exported from the REAL dist/agent.js so model validation runs against the
// live adapter shelf. processMessage mimics the one side effect the real one
// has before any model work — persisting the incoming text as a 'user' turn —
// so "a turn landed on the origin" is observable; the call args are the proof.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const realAgent = pathToFileURL(path.join(dist, 'agent.js')).href;
const convDb = pathToFileURL(path.join(dist, 'conversation-db.js')).href;

const STUB = 'data:text/javascript,' + encodeURIComponent(`
  import { getConversation, addTurn } from ${JSON.stringify(convDb)};
  export { getAdapters } from ${JSON.stringify(realAgent)};
  export class ConversationBusyError extends Error {}
  export async function processMessage(text, externalId, key) {
    globalThis.__spawnCalls = globalThis.__spawnCalls || [];
    globalThis.__spawnCalls.push({ text, externalId, key });
    const conv = getConversation(externalId);
    if (conv) addTurn(conv.id, 'user', text);
    return 'STUB_OK — no real model call made.';
  }
  export function getInFlightMessageId(convId) {
    return (globalThis.__inFlight && globalThis.__inFlight.has(convId)) ? 'turn:busy' : undefined;
  }
`);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '../agent.js' && (context.parentURL ?? '').endsWith('/dist/tools/spawn-chat-tool.js')) {
    return { url: STUB, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
