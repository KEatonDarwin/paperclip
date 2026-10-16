#!/usr/bin/env python3
"""Tests for the reflection lesson miner. Model-free: a fixture jarvis.db + injected distillers.

Run:  python3 -I test_lesson_miner.py
Discipline note: the fixture is built from the REAL hopper_nodes column shape (see schema in
the miner's SELECT), and the dedupe test uses a distiller that returns a FIXED pitfall so two
different nodes collide on fingerprint — i.e. the test can actually FAIL if dedupe breaks,
rather than being self-consistent with the implementation.
"""
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lesson_miner as lm  # noqa: E402


def _make_fixture(path: str) -> None:
    c = sqlite3.connect(path)
    c.execute(
        "CREATE TABLE hopper_trees (id TEXT PRIMARY KEY, topic TEXT)"
    )
    c.execute(
        """CREATE TABLE hopper_nodes (
            id INTEGER PRIMARY KEY, tree_id TEXT, parent_id INTEGER, title TEXT, spec TEXT,
            status TEXT, attempts INTEGER, question TEXT, answer TEXT, result TEXT,
            result_summary TEXT)"""
    )
    c.execute("INSERT INTO hopper_trees VALUES ('tree-1','Rebuild the leads table')")
    rows = [
        # clean first-try done node -> NOT selected
        (1, "tree-1", None, "Add a passing helper", "spec", "done", 1, None, None,
         "All good, built cleanly.", "", ),
        # retried node -> selected (attempts>=2)
        (2, "tree-1", None, "Wire the governor ceiling", "spec head here", "done", 2, None, None,
         "First attempt used the wrong column; fixed on retry by reading Drop_priv in python.", ""),
        # blocked node -> selected
        (3, "tree-1", None, "Export bot_clicks for the gap", "READ BRIEF", "blocked", 1, None, None,
         "", ""),
        # failure-flavoured result on a done node -> selected
        (4, "tree-1", None, "Verify db safety guard", "spec", "done", 1, None, None,
         "A guard test that could never fail was a FALSE PASS; use git checkout --detach.", ""),
    ]
    c.executemany(
        "INSERT INTO hopper_nodes VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows
    )
    c.commit()
    c.close()


class LessonMinerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.jdb = os.path.join(self.tmp, "fixture.db")
        self.ldb = os.path.join(self.tmp, "lessons.db")
        _make_fixture(self.jdb)

    def test_selection_picks_only_lesson_worthy(self):
        with lm._connect_ro(self.jdb) as conn:
            tjs = lm.select_trajectories(conn)
        ids = {t.node_id for t in tjs}
        self.assertEqual(ids, {2, 3, 4}, "clean first-try node must be skipped; others kept")
        reasons = {t.node_id: t.reason for t in tjs}
        self.assertIn("retried", reasons[2])
        self.assertIn("status=blocked", reasons[3])

    def test_read_only_connection_rejects_writes(self):
        with lm._connect_ro(self.jdb) as conn:
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("INSERT INTO hopper_nodes (id,title) VALUES (999,'x')")

    def test_stub_distiller_extracts_failure_sentence(self):
        with lm._connect_ro(self.jdb) as conn:
            tjs = {t.node_id: t for t in lm.select_trajectories(conn)}
        lesson = lm.distill(tjs[4], lm.stub_distiller)
        self.assertIn("FALSE PASS", lesson.pitfall)
        self.assertTrue(lesson.tags)

    def test_mine_populates_store_and_dedupes(self):
        summary = lm.mine(self.jdb, self.ldb, 200, lm.stub_distiller)
        self.assertEqual(summary["candidates"], 3)
        self.assertEqual(summary["new"], 3)
        # second run: identical inputs -> all duplicates, no growth
        summary2 = lm.mine(self.jdb, self.ldb, 200, lm.stub_distiller)
        self.assertEqual(summary2["new"], 0)
        self.assertEqual(summary2["duplicates"], 3)
        store = lm.open_store(self.ldb)
        n = store.execute("SELECT count(*) FROM lessons").fetchone()[0]
        self.assertEqual(n, 3)

    def test_fingerprint_collision_is_deduped(self):
        # a distiller that always returns the SAME pitfall for the same title -> idempotent
        def fixed(tj):
            return {"situation": tj.title, "pitfall": "FIXED", "guidance": "g", "tags": "x"}
        store = lm.open_store(self.ldb)
        with lm._connect_ro(self.jdb) as conn:
            tjs = lm.select_trajectories(conn)
        first = lm.upsert_lesson(store, lm.distill(tjs[0], fixed))
        again = lm.upsert_lesson(store, lm.distill(tjs[0], fixed))
        self.assertTrue(first)
        self.assertFalse(again, "same node+pitfall must dedupe on fingerprint")

    def test_retrieve_ranks_by_overlap(self):
        lm.mine(self.jdb, self.ldb, 200, lm.stub_distiller)
        store = lm.open_store(self.ldb)
        hits = lm.retrieve(store, "governor ceiling column", k=5)
        self.assertTrue(hits, "query sharing terms with a lesson must return it")
        self.assertEqual(hits[0]["source_node_id"], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
