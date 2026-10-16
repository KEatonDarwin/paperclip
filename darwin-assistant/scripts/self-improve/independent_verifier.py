#!/usr/bin/env python3
"""
Independent Verifier + bounded recovery loop — FIRST CUT
(overnight 2026-10-15, branch feat/independent-verifier)

WHY (with sources): reliability research is blunt about two things.
  1. A generator checking its OWN output verifies worse than an INDEPENDENT observer. Self-
     critique with no fresh signal can make results worse (Huang et al.; "Where Does Agent
     Reliability Come From?" 2026 ablation; "self-correction loop that shared its verifier's
     blind spot"). Today a JARVIS worker self-reports `VERDICT: PASS` from inside the same
     context that produced the work — the exact anti-pattern.
  2. Retry loops drain budget through four recurring bugs: no bounded retry policy, no dedup of
     repeated identical calls, a convergence check the model grades itself, and no staleness
     check (practitioner failure-mode list).

WHAT THIS IS: a verifier that observes a node's artifacts (spec + self-reported result + diff)
with a FRESH observer that never sees the worker's reasoning, and a `VerifyLoop` that wraps it
with the four fixes above. The observer is INJECTABLE (tests pass a fake; production shells to a
cheap `claude`/`codex` CLI on account B — NO API KEYS).

WHAT THIS IS NOT (yet): not wired into hopper's finish path or the sprint-lane referee. This is
the standalone, deterministically-tested mechanism. See README for the wiring rung.

SAFETY: no DB writes, no network in the default/test path, no live deploy.
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional


class Verdict(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    INCONCLUSIVE = "INCONCLUSIVE"


@dataclass
class Artifacts:
    """Everything the independent observer is allowed to see. Deliberately EXCLUDES the worker's
    own chain-of-thought / self-assessment — the observer must form its own view."""
    spec: str                     # the task / done_means
    self_reported_result: str     # what the worker claimed it did (fact claims, not reasoning)
    diff_text: str = ""           # the actual code/data change
    evidence: str = ""            # test output, SELECT results, etc.

    def fingerprint(self) -> str:
        h = hashlib.sha1()
        for part in (self.spec, self.self_reported_result, self.diff_text, self.evidence):
            h.update(part.encode("utf-8", "replace"))
            h.update(b"\x00")
        return h.hexdigest()[:16]


@dataclass
class Observation:
    verdict: Verdict
    reasons: list[str] = field(default_factory=list)
    confidence: float = 0.0
    observer: str = "stub"


# An observer takes ONLY the artifacts and returns an independent Observation.
Observer = Callable[[Artifacts], Observation]


# ---------------------------------------------------------------------------
# the independent observation (default = heuristic stub; prod = claude/codex CLI on B)
# ---------------------------------------------------------------------------
def heuristic_observer(art: Artifacts) -> Observation:
    """Model-free sanity observer: cheap checks that catch the most common hollow 'PASS'.

    This is NOT a substitute for the model observer — it is the deterministic floor that
    always runs and that the tests exercise. It flags the classic false-pass shapes."""
    reasons: list[str] = []
    result = art.self_reported_result.lower()

    # A claim of done with literally no artifact behind it.
    if not art.diff_text.strip() and not art.evidence.strip():
        reasons.append("no diff and no evidence behind the claim")

    # Worker claims success but its own result text confesses a gap.
    confession = any(w in result for w in (
        "todo", "not implemented", "stub", "couldn't", "could not", "failed to",
        "left broken", "did not finish", "unverified", "assumed",
    ))
    if confession and "pass" in result:
        reasons.append("result claims success but also confesses an unfinished/assumed part")

    # Evidence that is present but shows a failure.
    ev = art.evidence.lower()
    if ev and any(w in ev for w in ("traceback", "assertionerror", "fail", "error:", "exit code 1")):
        reasons.append("evidence contains a failure signal")

    if reasons:
        return Observation(Verdict.FAIL, reasons, confidence=0.6, observer="heuristic")
    if not art.evidence.strip():
        # nothing wrong, but nothing proving it either
        return Observation(Verdict.INCONCLUSIVE, ["no failing signal, but no proof of success"],
                           confidence=0.3, observer="heuristic")
    return Observation(Verdict.PASS, ["no failure signal; evidence present"], confidence=0.7,
                       observer="heuristic")


def claude_cli_observer(art: Artifacts) -> Observation:  # pragma: no cover - opt-in, needs CLI
    """Production observer: a FRESH adversarial reviewer via the local claude CLI on account B.

    Given only the artifacts (never the worker's reasoning), returns strict-JSON
    {verdict, reasons, confidence}. NO API KEYS — subscription CLI pattern."""
    import subprocess

    prompt = (
        "You are an INDEPENDENT adversarial verifier. You did not do this work and must not "
        "trust the worker's claim. Judge ONLY whether the artifacts prove the spec is met. "
        'Reply strict JSON {"verdict":"PASS|FAIL|INCONCLUSIVE","reasons":[..],"confidence":0..1}.\n\n'
        f"SPEC:\n{art.spec}\n\nWORKER CLAIM:\n{art.self_reported_result}\n\n"
        f"DIFF:\n{art.diff_text[:6000]}\n\nEVIDENCE:\n{art.evidence[:4000]}"
    )
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)
    env["CLAUDE_CONFIG_DIR"] = env.get("JARVIS_CLAUDE_CONFIG_DIR", "/home/kevin/.claude-b")
    proc = subprocess.run(
        ["claude", "--print", "-", "--output-format", "json", "--model", "claude-sonnet-5-5",
         "--dangerously-skip-permissions"],
        input=prompt, env=env, capture_output=True, text=True, timeout=180,
    )
    inner = json.loads(json.loads(proc.stdout).get("result", "{}"))
    return Observation(
        Verdict(inner.get("verdict", "INCONCLUSIVE")),
        list(inner.get("reasons", [])),
        float(inner.get("confidence", 0.0)),
        observer="claude-cli",
    )


# ---------------------------------------------------------------------------
# the bounded recovery loop (the four retry-bug fixes)
# ---------------------------------------------------------------------------
@dataclass
class LoopResult:
    verdict: Verdict
    attempts: int
    observations: list[Observation]
    stopped_reason: str


class VerifyLoop:
    """Wraps an independent observer with bounded retries, dedup, and a staleness gate.

    - bounded:   never more than `max_attempts` observations.
    - dedup:     the SAME artifacts fingerprint is never observed twice (returns the cached
                 observation) — a worker that re-submits byte-identical work does not re-spend.
    - staleness: `verify_after_fix` only re-runs if the artifacts actually changed since the last
                 FAIL; an unchanged resubmission is refused as 'stale' instead of looping.
    - independent: the convergence decision is the observer's verdict, never the worker's.
    """

    def __init__(self, observer: Observer, max_attempts: int = 2):
        self.observer = observer
        self.max_attempts = max_attempts
        self._cache: dict[str, Observation] = {}
        self._last_fingerprint: Optional[str] = None

    def observe(self, art: Artifacts) -> Observation:
        fp = art.fingerprint()
        if fp in self._cache:
            cached = self._cache[fp]
            return Observation(cached.verdict, cached.reasons + ["(dedup: cached observation)"],
                               cached.confidence, cached.observer)
        obs = self.observer(art)
        self._cache[fp] = obs
        self._last_fingerprint = fp
        return obs

    def run(self, produce_attempt: Callable[[int], Artifacts]) -> LoopResult:
        """`produce_attempt(i)` yields the artifacts for attempt i (0-based). The caller re-runs
        the worker between attempts; this loop only verifies and decides whether to continue."""
        observations: list[Observation] = []
        for i in range(self.max_attempts):
            art = produce_attempt(i)
            if i > 0 and art.fingerprint() == self._last_fingerprint:
                return LoopResult(Verdict.FAIL, i, observations,
                                  "stale: resubmitted artifacts unchanged after a FAIL")
            obs = self.observe(art)
            observations.append(obs)
            if obs.verdict == Verdict.PASS:
                return LoopResult(Verdict.PASS, i + 1, observations, "verified")
        return LoopResult(observations[-1].verdict if observations else Verdict.INCONCLUSIVE,
                          self.max_attempts, observations, "exhausted max_attempts")


# ---------------------------------------------------------------------------
# convenience single-shot
# ---------------------------------------------------------------------------
def verify_once(art: Artifacts, observer: Observer = heuristic_observer) -> Observation:
    return VerifyLoop(observer, max_attempts=1).observe(art)
