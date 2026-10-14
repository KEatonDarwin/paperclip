# Betterment replay scorers: baseline

These are the numbers any future improvement-loop candidate has to beat. They are the CURRENT live
behaviour (`src/prompt.ts` + `src/token-diet.ts` + `src/agent.ts` at this branch's base), replayed
with no model, offline, over a fixed corpus.

## The corpus

- Built 2026-10-14 from a `/tmp` copy of the live `jarvis.db` (taken with sqlite `.backup`, opened readonly):
  `npx tsx scripts/betterment/build-corpus.mjs --db /tmp/betterment-jarvis-copy.db`
- Location: `/home/kevin/jarvis-betterment/corpus/` (`corpus.jsonl`, `meta.json`, `memory-snapshot.md`,
  `worker-core-snapshot.md`, `facts-checklist.json`).
- Anchor `2026-10-14 10:26:04` UTC, 14-day window. **200 turns, 83 sessions**: interactive 90 turns / 11
  sessions, worker 50 / 50, goal 40 / 4, other (check-ins and shifts) 20 / 18. `corpus.jsonl` is 305,009 bytes.
- Memory snapshot: 99,214 bytes. Worker core: 3,736 bytes. Checklist: 25 markers (5 section headings and 20 literals).
- No memory settings are set in the live db (`memory_dedupe`, `memory_full_every_turns`,
  `claude_autocompact_tokens` are all unset), so the defaults apply: dedupe on, a full resend every 25 turns.

## Scorer 1: injected memory tokens (`score-memory.mjs`, lower is better)

```
{"score_tokens":1704673,"valid":true,"per_class_breakdown":{"interactive":{"turns":90,"tokens":985829},"worker":{"turns":50,"tokens":47400},"goal":{"turns":40,"tokens":228901},"other":{"turns":20,"tokens":442543}},"turns":200}
```

**Baseline: 1,704,673 tokens (chars/4), valid.** How the 200 replayed turns break down:
- interactive: 9 initial, 31 full resume, 50 "unchanged"
- goal: 3 initial, 8 full resume, 29 unchanged
- other: 17 initial, 1 full, 2 unchanged
- worker: 50 initial, all on the worker core

The full memory still dominates. Each send is about 25k tokens, and it goes out on every new session,
on the first resume of a session, and after every observed compaction.

## Scorer 2: cache-stable prefix (`score-cache.mjs`, higher is better)

```
{"stable_ratio":0.091556,"stable_bytes":322082,"total_bytes":3517886,"pairs":117, ...per_session}
```

**Baseline: stable_ratio 0.091556** over 117 consecutive-turn pairs.

## Determinism and safety evidence

- Both scorers were run twice on the real corpus and `cmp` found the outputs byte-identical. Each run takes about 1s.
- Secret grep on `corpus.jsonl` with `AKIA|Bearer [A-Za-z0-9]|eyJ[A-Za-z0-9_-]{8}|PRIVATE KEY` → **1 hit, a
  false positive.** It is the prose phrase "an AWS AKIA key" inside a review-node spec, and no key follows it.
  The key-shaped form `AKIA[A-Z0-9]{16}|Bearer [A-Za-z0-9]|eyJ…|PRIVATE KEY` → **0**. The other corpus files → 0.
- Tests: `npx tsx --test scripts/betterment/scorers.test.mjs` → 5/5 pass.

## Caveats a loop should know

- Sessions are inferred, because jarvis.db keeps only the current `claude_session_id`. One conversation
  counts as one session. A "compaction" is a model call whose total context is under 50% of the previous
  call's, when that previous call was at least 60k tokens. The replay writes that count into a fake CLI
  session file, which is what `token-diet.ts` reads.
- A conversation is capped at its last 20 in-window turns. Its replay starts with no dedupe baseline, so
  the first resumed turn in a slice sends the full memory.
- Prompts are the memory-assembly part only. The per-turn context prefix (thread line, autonomy dial,
  goal and shift blocks) is not replayed. The user input is the scrubbed excerpt of at most 2,000 chars.
  `new Date()` is frozen to each turn's `created_at`, so the minute-resolution "Current Time" in the
  system prompt is faithfully part of the prefix.
- Rebuilding the corpus from a newer db copy changes it. Compare candidates only against a baseline
  scored on the same corpus.
