// ESM loader hook for scripts/thread-search-check.mjs (Find Any Chat).
// Stubs runClaude ONLY for dist/thread-search.js (the model ranker), so the
// check never spawns a claude process. Every other importer of dist/agent.js
// keeps the real module.
//
// The stub is an HONEST ranker: it reads the query out of the prompt and picks
// ONLY the candidate blocks whose own text contains that phrase
// (case-insensitive), best-effort first 5. So a chat whose matching text never
// reaches the prompt is NOT returned — the API checks go red when the ranker
// is blind, instead of passing on "first 5 ids, whatever they say".
const STUB = 'data:text/javascript,' + encodeURIComponent(`
  export async function runClaude(prompt) {
    globalThis.__rankerPrompts = globalThis.__rankerPrompts || [];
    globalThis.__rankerPrompts.push(prompt);
    const q = (prompt.match(/Query:\\n"""\\n([\\s\\S]*?)\\n"""/) || [])[1];
    if (!q) throw new Error('ranker stub: no query in prompt');
    const phrase = q.trim().toLowerCase();
    // Only the corpus — never the instructions that follow it.
    const corpus = prompt.slice(prompt.indexOf('\\n- thread_id: ') + 1, prompt.lastIndexOf('\\n\\nRespond with ONLY'));
    const blocks = corpus.split(/\\n(?=- thread_id: )/).filter((b) => b.startsWith('- thread_id: '));
    const ids = blocks
      .filter((b) => b.toLowerCase().includes(phrase))
      .map((b) => b.match(/^- thread_id: (\\S+)/)[1])
      .slice(0, 5);
    return { text: JSON.stringify(ids.map((id) => ({ thread_id: id, reason: 'stub' }))) };
  }
`);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === './agent.js' && (context.parentURL ?? '').endsWith('/dist/thread-search.js')) {
    return { url: STUB, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
