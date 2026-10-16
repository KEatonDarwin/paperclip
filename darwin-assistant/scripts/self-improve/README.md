# Reflection Lesson Miner — first cut

**Branch:** `feat/reflection-lessons-miner` · overnight 2026-10-15 · NOT deployed, NOT merged.

## The idea (with sources)
Self-improving-agent research is consistent: the cheapest large win is turning a system's own
past-run trajectories into reusable, retrievable lessons fed back into future work.
- Reflexion (verbal post-mortem fed into the next attempt) — foundation.
- ReAP (2025) learns from both successful *and* failed past experiences via self-reflection;
  reports +11pt overall, +29pt on previously-failed tasks.
- IBM trajectory-informed memory (2026): extract actionable learnings from execution
  trajectories, reuse via contextual retrieval.

JARVIS already has ~1,700 hopper nodes. The ones that **retried or blocked** are a free,
high-signal corpus of "what bit us and how we fixed it" that currently evaporates after a run.

## What this first cut does
- `lesson_miner.py` — READ-ONLY over `jarvis.db` (`mode=ro`). Selects lesson-worthy trajectories
  (attempts≥2, blocked, or failure-flavoured result text), distills each into a compact
  `{situation, pitfall, guidance, tags}` lesson, de-dupes by fingerprint into a **separate**
  `lessons.db`, and retrieves top-k by keyword/tag overlap.
- The distiller is **injectable**. Default = a deterministic model-free stub (used by tests and
  good enough to prove the pipeline). `--use-claude` opts into a real distiller that shells to
  the local `claude` CLI on account B (NO API KEYS, haiku).
- `test_lesson_miner.py` — 6 model-free tests on a fixture DB (selection precision, read-only
  enforcement, dedupe on fingerprint collision, retrieval ranking). `python3 -I test_lesson_miner.py`.

## Try it
```
python3 -I lesson_miner.py --scan                 # list candidate trajectories (read-only)
python3 -I lesson_miner.py                         # mine with the model-free stub -> lessons.db
python3 -I lesson_miner.py --retrieve "governor ceiling"   # retrieve lessons for a task
```

## Honest limits / next rungs (NOT done here)
1. **Selection precision:** the `failure-flavoured` matcher over-selects (a REVIEW node that
   merely discusses "fail"/"caught" trips it — the live scan returned ~500). The high-precision
   signals are attempts≥2 and blocked; tighten the keyword branch before trusting volume.
2. **Injection:** nothing yet injects retrieved lessons into `worker-core.md` / spawn briefs.
   The next rung is a `<relevant_lessons>` block built from `retrieve(task_title)` at dispatch.
3. **Retrieval:** keyword overlap now; embeddings later.
4. **Distillation quality:** the stub is deterministic, not smart. Real value needs `--use-claude`
   on B, run nightly (timer), model-free selection first so the model only sees pre-filtered rows.
5. Integration target is the TS engine; this standalone python is the proving ground (same
   pattern as alpha-trainer).
