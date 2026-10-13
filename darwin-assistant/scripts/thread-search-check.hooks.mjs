// ESM loader hook for scripts/thread-search-check.mjs (Find Any Chat).
// Stubs runClaude ONLY for dist/thread-search.js (the model ranker), so the
// check never spawns a claude process. The stub records each prompt and
// "ranks" by returning the first 5 thread_ids from the corpus it was given —
// enough to prove which chats reached the ranker. Every other importer of
// dist/agent.js keeps the real module.
const STUB = 'data:text/javascript,' + encodeURIComponent(`
  export async function runClaude(prompt) {
    globalThis.__rankerPrompts = globalThis.__rankerPrompts || [];
    globalThis.__rankerPrompts.push(prompt);
    const ids = [...prompt.matchAll(/- thread_id: (\\S+)/g)].map((m) => m[1]).slice(0, 5);
    return { text: JSON.stringify(ids.map((id) => ({ thread_id: id, reason: 'stub' }))) };
  }
`);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === './agent.js' && (context.parentURL ?? '').endsWith('/dist/thread-search.js')) {
    return { url: STUB, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
