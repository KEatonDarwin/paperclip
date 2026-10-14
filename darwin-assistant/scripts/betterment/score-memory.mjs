// Betterment lane — SCORER 1: injected memory tokens over the replay corpus (lower is better).
//
//   npx tsx scripts/betterment/score-memory.mjs [--corpus <dir>] [--assembler <candidate.mjs>]
//
// TOKENS = ceil(chars / 4) per injected memory text — a chars/4 heuristic, not a real tokenizer.
// It is model-free and stable, which is what an optimisation loop needs; absolute numbers are
// approximate, deltas between candidates are what matter.
//
// HARD CONSTRAINT: facts-checklist.json. For every FULL-profile session, each context segment
// (session start, and again after every observed compaction/context reset) must have seen every
// checklist marker in the memory injected during that segment. A candidate that lets a marker drop
// out of what the model can see scores valid:false (INVALID) regardless of tokens.
//
// Prints one JSON line: {score_tokens, valid, per_class_breakdown, turns, violations?}
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCorpus, replayCorpus, resolveAssembler, parseCommonArgs, cleanupScratch } from './replay.mjs';

export const DEFAULT_CORPUS = '/home/kevin/jarvis-betterment/corpus';
export const tokensOf = (text) => Math.ceil((text ? text.length : 0) / 4);

/** Score an already-replayed corpus. Pure. */
export function scoreMemoryReplay(replay, checklist) {
  let total = 0;
  const perClass = {};
  for (const t of replay.turns) {
    const k = t.rec.thread_class;
    perClass[k] ??= { turns: 0, tokens: 0 };
    const tok = tokensOf(t.memory);
    perClass[k].turns++;
    perClass[k].tokens += tok;
    total += tok;
  }
  const violations = [];
  for (const s of replay.sessions) {
    if (s.memory_profile !== 'full') continue;
    let segment = [];
    let segStartSeq = null;
    let lastCompactions = null;
    const close = () => {
      if (!segment.length) return;
      const seen = segment.join('\n');
      const missing = checklist.filter((m) => !seen.includes(m));
      if (missing.length) violations.push({ session: s.key, segment_start_seq: segStartSeq, missing });
    };
    for (const t of s.turns) {
      if (lastCompactions !== null && t.rec.compactions_before !== lastCompactions) { close(); segment = []; segStartSeq = null; }
      lastCompactions = t.rec.compactions_before;
      if (segStartSeq === null) segStartSeq = t.rec.seq;
      segment.push(t.memory ?? '');
    }
    close();
  }
  const out = { score_tokens: total, valid: violations.length === 0, per_class_breakdown: perClass, turns: replay.turns.length };
  if (violations.length) out.violations = violations.slice(0, 20);
  return out;
}

export async function scoreMemory(corpusDir, assemblerPath) {
  const corpus = readCorpus(corpusDir);
  const assembler = await resolveAssembler(assemblerPath);
  return scoreMemoryReplay(replayCorpus(corpus, assembler), corpus.checklist);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 0;
  try {
    const args = parseCommonArgs(process.argv.slice(2), { corpus: DEFAULT_CORPUS });
    console.log(JSON.stringify(await scoreMemory(args.corpus, args.assembler)));
  } catch (e) {
    console.error(`score-memory: ${e.message}`);
    code = 2;
  }
  cleanupScratch();
  process.exit(code);
}
