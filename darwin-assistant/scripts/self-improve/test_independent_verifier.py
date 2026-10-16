#!/usr/bin/env python3
"""Tests for the independent verifier + bounded recovery loop. Model-free: injected observers.

Run: python3 -I test_independent_verifier.py

Discipline: the dedup and staleness tests use a COUNTING fake observer so the test fails loudly
if the loop ever calls the observer more often than it should — they are not self-consistent
with the implementation, they measure real call counts.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import independent_verifier as iv  # noqa: E402


class HeuristicTests(unittest.TestCase):
    def test_no_artifact_claim_fails(self):
        art = iv.Artifacts(spec="add X", self_reported_result="Done, all good.")
        obs = iv.heuristic_observer(art)
        self.assertEqual(obs.verdict, iv.Verdict.FAIL)
        self.assertTrue(any("no diff" in r for r in obs.reasons))

    def test_confessed_stub_despite_pass_claim_fails(self):
        art = iv.Artifacts(spec="add X", self_reported_result="PASS - but left a stub for later",
                           diff_text="+ def x(): pass")
        obs = iv.heuristic_observer(art)
        self.assertEqual(obs.verdict, iv.Verdict.FAIL)

    def test_failure_signal_in_evidence_fails(self):
        art = iv.Artifacts(spec="add X", self_reported_result="done", diff_text="+code",
                           evidence="Ran 3 tests ... AssertionError: nope")
        self.assertEqual(iv.heuristic_observer(art).verdict, iv.Verdict.FAIL)

    def test_clean_with_evidence_passes(self):
        art = iv.Artifacts(spec="add X", self_reported_result="added x",
                           diff_text="+ def x(): return 1", evidence="Ran 3 tests ... OK")
        self.assertEqual(iv.heuristic_observer(art).verdict, iv.Verdict.PASS)

    def test_no_evidence_is_inconclusive_not_pass(self):
        art = iv.Artifacts(spec="add X", self_reported_result="added x",
                           diff_text="+ def x(): return 1")
        self.assertEqual(iv.heuristic_observer(art).verdict, iv.Verdict.INCONCLUSIVE)


class LoopTests(unittest.TestCase):
    def _counting(self, verdicts):
        calls = {"n": 0}
        seq = list(verdicts)

        def obs(art):
            i = calls["n"]
            calls["n"] += 1
            v = seq[min(i, len(seq) - 1)]
            return iv.Observation(v, [f"call {i}"], 0.9, "fake")
        return obs, calls

    def test_passes_on_first_attempt(self):
        obs, calls = self._counting([iv.Verdict.PASS])
        loop = iv.VerifyLoop(obs, max_attempts=3)
        arts = [iv.Artifacts("s", "r1", "d1")]
        res = loop.run(lambda i: arts[i])
        self.assertEqual(res.verdict, iv.Verdict.PASS)
        self.assertEqual(res.attempts, 1)
        self.assertEqual(calls["n"], 1, "must not keep observing after a PASS")

    def test_bounded_retry_stops_at_cap(self):
        obs, calls = self._counting([iv.Verdict.FAIL, iv.Verdict.FAIL])
        loop = iv.VerifyLoop(obs, max_attempts=2)
        # caller produces DIFFERENT artifacts each attempt (a real re-run)
        res = loop.run(lambda i: iv.Artifacts("s", f"r{i}", f"d{i}"))
        self.assertEqual(res.verdict, iv.Verdict.FAIL)
        self.assertEqual(res.attempts, 2)
        self.assertEqual(res.stopped_reason, "exhausted max_attempts")
        self.assertEqual(calls["n"], 2, "exactly max_attempts observations")

    def test_staleness_refuses_unchanged_resubmission(self):
        obs, calls = self._counting([iv.Verdict.FAIL, iv.Verdict.PASS])
        loop = iv.VerifyLoop(obs, max_attempts=3)
        same = iv.Artifacts("s", "r", "d")
        res = loop.run(lambda i: same)  # worker resubmits identical work
        self.assertEqual(res.verdict, iv.Verdict.FAIL)
        self.assertIn("stale", res.stopped_reason)
        self.assertEqual(calls["n"], 1, "unchanged resubmission must not be re-observed")

    def test_dedup_caches_identical_artifacts(self):
        obs, calls = self._counting([iv.Verdict.FAIL])
        loop = iv.VerifyLoop(obs, max_attempts=5)
        art = iv.Artifacts("s", "r", "d")
        o1 = loop.observe(art)
        o2 = loop.observe(art)  # identical -> cached, observer not called again
        self.assertEqual(calls["n"], 1)
        self.assertEqual(o1.verdict, o2.verdict)
        self.assertTrue(any("dedup" in r for r in o2.reasons))

    def test_fingerprint_changes_with_content(self):
        a = iv.Artifacts("s", "r", "d")
        b = iv.Artifacts("s", "r", "d2")
        self.assertNotEqual(a.fingerprint(), b.fingerprint())


if __name__ == "__main__":
    unittest.main(verbosity=2)
