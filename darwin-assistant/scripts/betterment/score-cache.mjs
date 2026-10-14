// Betterment lane — SCORER 2: cache-stable prefix bytes over per-session prompt sequences (higher is better).
//
//   npx tsx scripts/betterment/score-cache.mjs [--corpus <dir>] [--assembler <candidate.mjs>]
//
// For each consecutive pair of assembled prompts (prev, next) in a session: stable = byte length
// (UTF-8) of their common prefix, total = byte length of `next`. stable_ratio = Σstable / Σtotal.
// A session's first turn has no predecessor and contributes nothing; single-turn sessions are
// listed with pairs:0. Prompts come from replay.mjs (same assembler interface as score-memory).
//
// Prints one JSON line: {stable_ratio, stable_bytes, total_bytes, pairs, per_session}
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCorpus, replayCorpus, resolveAssembler, parseCommonArgs, cleanupScratch } from './replay.mjs';

export const DEFAULT_CORPUS = '/home/kevin/jarvis-betterment/corpus';

export function commonPrefixBytes(a, b) {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  const n = Math.min(x.length, y.length);
  let i = 0;
  while (i < n && x[i] === y[i]) i++;
  return i;
}

const ratio = (s, t) => (t > 0 ? Math.round((s / t) * 1e6) / 1e6 : null);

/** sequences: { [sessionKey]: string[] } in turn order. Pure. */
export function scoreCacheSequences(sequences) {
  let stable = 0;
  let total = 0;
  let pairs = 0;
  const perSession = {};
  for (const key of Object.keys(sequences)) {
    const seq = sequences[key];
    let s = 0;
    let t = 0;
    for (let i = 1; i < seq.length; i++) {
      s += commonPrefixBytes(seq[i - 1], seq[i]);
      t += Buffer.byteLength(seq[i], 'utf8');
    }
    const p = Math.max(0, seq.length - 1);
    perSession[key] = { pairs: p, stable_bytes: s, total_bytes: t, ratio: ratio(s, t) };
    stable += s;
    total += t;
    pairs += p;
  }
  return { stable_ratio: ratio(stable, total), stable_bytes: stable, total_bytes: total, pairs, per_session: perSession };
}

export function sequencesFromReplay(replay) {
  return Object.fromEntries(replay.sessions.map((s) => [s.key, s.turns.map((t) => t.prompt)]));
}

export async function scoreCache(corpusDir, assemblerPath) {
  const corpus = readCorpus(corpusDir);
  const assembler = await resolveAssembler(assemblerPath);
  return scoreCacheSequences(sequencesFromReplay(replayCorpus(corpus, assembler)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 0;
  try {
    const args = parseCommonArgs(process.argv.slice(2), { corpus: DEFAULT_CORPUS });
    console.log(JSON.stringify(await scoreCache(args.corpus, args.assembler)));
  } catch (e) {
    console.error(`score-cache: ${e.message}`);
    code = 2;
  }
  cleanupScratch();
  process.exit(code);
}
