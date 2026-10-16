# Independent Verifier + bounded recovery loop — first cut

**Branch:** `feat/independent-verifier` · overnight 2026-10-15 · NOT deployed, NOT merged.

## The idea (with sources)
Reliability research is blunt on two points:
1. A generator that checks its **own** output verifies worse than an **independent observer**;
   naive self-critique with no fresh signal can make things worse (Huang et al. on
   self-correction limits; "Where Does Agent Reliability Come From?" 2026 ablation — an
   independent observer beats a self-grading generator; "the self-correction loop that shared
   its verifier's blind spot"). A self-healing orchestrator with observe/compare/correct hit
   98.8% vs 94.5% retry-only on a fault-injection benchmark.
2. Retry loops burn budget through four recurring bugs: no bounded policy, no dedup of identical
   calls, a convergence check the model grades itself, and no staleness check.

Today a JARVIS worker self-reports `VERDICT: PASS` from **inside the same context** that made the
work — exactly the anti-pattern. (The sprint-lane referee is the one place an independent judge
already exists; this generalizes that to every node finish, cheaply.)

## What this first cut does
- `independent_verifier.py`
  - `Artifacts` — the ONLY thing the observer sees: spec, the worker's factual claim, the diff,
    and evidence. Deliberately **excludes the worker's reasoning** so the observer forms its own view.
  - `heuristic_observer` — model-free floor that catches the common hollow PASS (claim with no
    diff/evidence; "PASS but I left a stub"; evidence that contains a traceback/AssertionError).
    Returns INCONCLUSIVE (not PASS) when nothing proves success.
  - `claude_cli_observer` — opt-in production observer: a FRESH adversarial reviewer via the
    local `claude` CLI on account B (NO API KEYS). Injectable, so it never runs in tests.
  - `VerifyLoop` — the four fixes: **bounded** (≤max_attempts), **dedup** (identical artifacts
    fingerprint returns a cached observation, never re-spends), **staleness** (an unchanged
    resubmission after a FAIL is refused, not looped), **independent** convergence (the observer's
    verdict decides, never the worker's).
- `test_independent_verifier.py` — 10 model-free tests; the dedup/staleness tests use a
  call-counting fake observer so they fail loudly if the loop over-calls.

## Try it
```
python3 -I test_independent_verifier.py
```

## Honest limits / next rungs (NOT done here)
1. **Wiring:** not connected to hopper's finish path. The rung: at `POST /hopper-nodes/:id/finish`,
   gather the branch diff + the node's test evidence into `Artifacts`, run `VerifyLoop` with
   `claude_cli_observer` on B before a node is accepted; a FAIL opens a patch node (retry escalates
   tier, as today). Mirror into the sprint-lane batched merge-back gate.
2. **Diff gathering** is the caller's job here; a helper to pull `git diff` for a node_branch is
   the obvious companion.
3. The heuristic floor is deliberately shallow — it is the always-on cheap gate, not the judge.
   The model observer on B is where the real signal is; keep it independent (fresh context).
4. Cost: one extra cheap-model call per finish. Gate it behind a throttle dial and the account-B
   ceilings so it can never run the window dry.
