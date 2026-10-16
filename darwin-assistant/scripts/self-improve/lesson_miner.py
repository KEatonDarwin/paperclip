#!/usr/bin/env python3
"""
Reflection Lesson Miner — FIRST CUT (overnight 2026-10-15, branch feat/reflection-lessons-miner)

WHY: research on self-improving agents (Reflexion 2023; ReAP 2025; IBM trajectory-informed
memory 2026) is consistent on one point — the single biggest cheap win is turning a system's
OWN past run trajectories into reusable, retrievable lessons that get injected into future
work. JARVIS already runs ~1,700 hopper nodes; the ones that RETRIED or BLOCKED are a free,
high-signal corpus of "what bit us and how we fixed it" that currently evaporates.

WHAT THIS IS: a standalone, READ-ONLY miner over jarvis.db hopper_nodes. It
  1. selects trajectories worth a lesson (retried / blocked / failure-flavoured result text),
  2. distills each into a compact lesson via an INJECTABLE distiller (default stub =
     model-free; production would call the `claude` CLI on account B — NO API KEYS),
  3. writes de-duplicated lessons to a lessons store (sqlite),
  4. retrieves the top-k lessons for a given task query (keyword/tag overlap; embeddings later).

WHAT THIS IS NOT (yet): it does not auto-inject into worker-core.md / spawn briefs — that is
the next rung (see README). It never writes to jarvis.db; the lessons store is a separate file.

SAFETY: opens jarvis.db read-only (mode=ro). No writes to any production DB. No network in the
default/test path (the real distiller is opt-in and shells to the local claude CLI).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from dataclasses import dataclass, asdict
from typing import Callable, Iterable, Optional

DEFAULT_JARVIS_DB = "/home/kevin/paperclip/darwin-assistant/jarvis.db"
DEFAULT_LESSONS_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lessons.db")

# words that, in a node result/title, suggest a lesson is lurking
_FAILURE_HINTS = re.compile(
    r"\b(fail|failed|error|blocked|wrong|incorrect|broke|broken|regress|"
    r"false[-\s]?pass|clobber|wiped?|timeout|timed out|stall|revert|hole|"
    r"vacuous|silently|gotcha|lesson|never again|caught)\b",
    re.IGNORECASE,
)

_STOPWORDS = set(
    "the a an and or of to in for on with from into over per your this that is are be it "
    "fix feat build make add use via not no yes new all any one two get set run node tree "
    "jarvis kevin".split()
)


@dataclass
class Trajectory:
    node_id: int
    tree_id: str
    tree_topic: str
    title: str
    status: str
    attempts: int
    spec_head: str
    result: str
    reason: str  # why this was selected as lesson-worthy


@dataclass
class Lesson:
    fingerprint: str
    source_node_id: int
    tree_id: str
    title: str
    situation: str  # what the work was
    pitfall: str    # what went wrong / was hard
    guidance: str   # what to do next time
    tags: str       # space-joined keyword tags for retrieval
    created_from: str  # "stub" | "claude-cli" etc.


# ---------------------------------------------------------------------------
# selection
# ---------------------------------------------------------------------------
def _connect_ro(path: str) -> sqlite3.Connection:
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def select_trajectories(conn: sqlite3.Connection, limit: int = 200) -> list[Trajectory]:
    """Pick nodes that carry a lesson: retried (attempts>=2), blocked, or failure-flavoured."""
    rows = conn.execute(
        """
        SELECT n.id, n.tree_id, n.title, n.status, n.attempts,
               COALESCE(n.spec,'')          AS spec,
               COALESCE(n.result,'')        AS result,
               COALESCE(n.result_summary,'') AS result_summary,
               COALESCE(n.answer,'')        AS answer,
               COALESCE(t.topic,'')         AS topic
        FROM hopper_nodes n
        LEFT JOIN hopper_trees t ON t.id = n.tree_id
        ORDER BY n.id DESC
        """
    ).fetchall()
    out: list[Trajectory] = []
    for r in rows:
        result_text = r["result"] or r["result_summary"] or r["answer"] or ""
        blob = f"{r['title']}\n{result_text}"
        reason = None
        if (r["attempts"] or 0) >= 2:
            reason = f"retried x{r['attempts']}"
        elif r["status"] in ("blocked", "blocked_question", "failed", "error"):
            reason = f"status={r['status']}"
        elif _FAILURE_HINTS.search(blob):
            reason = "failure-flavoured result"
        if not reason:
            continue
        out.append(
            Trajectory(
                node_id=r["id"],
                tree_id=r["tree_id"] or "",
                tree_topic=r["topic"][:160],
                title=r["title"] or "",
                status=r["status"] or "",
                attempts=r["attempts"] or 0,
                spec_head=(r["spec"] or "")[:400],
                result=result_text[:1200],
                reason=reason,
            )
        )
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------------------
# distillation (INJECTABLE — tests pass a fake; prod shells to claude CLI on B)
# ---------------------------------------------------------------------------
Distiller = Callable[[Trajectory], dict]


def _tags_for(text: str, extra: Iterable[str] = ()) -> str:
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9_\-]{2,}", text.lower())
    seen, tags = set(), []
    for w in list(extra) + words:
        if w in _STOPWORDS or w in seen:
            continue
        seen.add(w)
        tags.append(w)
        if len(tags) >= 14:
            break
    return " ".join(tags)


def stub_distiller(tj: Trajectory) -> dict:
    """Model-free distiller: deterministic, good enough to prove the pipeline + for tests.

    Extracts a one-line pitfall from the most failure-flavoured sentence in the result."""
    sentences = re.split(r"(?<=[.;])\s+|\n", tj.result)
    pitfall = ""
    for s in sentences:
        if _FAILURE_HINTS.search(s):
            pitfall = s.strip()
            break
    if not pitfall:
        pitfall = (tj.result.strip().split("\n", 1)[0] or tj.reason)[:200]
    situation = tj.title[:180]
    guidance = f"Re-check this path before similar work ({tj.reason})."
    return {
        "situation": situation,
        "pitfall": pitfall[:300],
        "guidance": guidance,
        "tags": _tags_for(f"{tj.title} {tj.tree_topic}", extra=[tj.status]),
        "created_from": "stub",
    }


def claude_cli_distiller(tj: Trajectory) -> dict:  # pragma: no cover - opt-in, needs CLI
    """Production distiller: one-shot the local `claude` CLI on account B. NO API KEYS.

    Deliberately not exercised by tests (tests inject stub_distiller). Mirrors the project's
    subscription-CLI pattern: spawn claude --print, prompt on stdin, delete ANTHROPIC_API_KEY.
    """
    import subprocess

    prompt = (
        "You are mining a past autonomous-worker run for ONE reusable lesson. "
        "Given the task and its result, reply with STRICT JSON "
        '{"situation","pitfall","guidance"} — each one sentence, concrete, no preamble.\n\n'
        f"TASK: {tj.title}\nWHY FLAGGED: {tj.reason}\nRESULT:\n{tj.result}"
    )
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)
    env["CLAUDE_CONFIG_DIR"] = env.get("JARVIS_CLAUDE_CONFIG_DIR", "/home/kevin/.claude-b")
    proc = subprocess.run(
        ["claude", "--print", "-", "--output-format", "json", "--model", "claude-haiku-5-5",
         "--dangerously-skip-permissions"],
        input=prompt, env=env, capture_output=True, text=True, timeout=120,
    )
    data = json.loads(proc.stdout)
    inner = json.loads(data.get("result", "{}"))
    return {
        "situation": inner.get("situation", tj.title)[:180],
        "pitfall": inner.get("pitfall", "")[:300],
        "guidance": inner.get("guidance", "")[:300],
        "tags": _tags_for(f"{tj.title} {tj.tree_topic}", extra=[tj.status]),
        "created_from": "claude-cli",
    }


def distill(tj: Trajectory, distiller: Distiller) -> Lesson:
    d = distiller(tj)
    fp = hashlib.sha1(
        f"{tj.title}|{d.get('pitfall','')}".encode("utf-8")
    ).hexdigest()[:16]
    return Lesson(
        fingerprint=fp,
        source_node_id=tj.node_id,
        tree_id=tj.tree_id,
        title=tj.title[:200],
        situation=d.get("situation", "")[:200],
        pitfall=d.get("pitfall", "")[:300],
        guidance=d.get("guidance", "")[:300],
        tags=d.get("tags", ""),
        created_from=d.get("created_from", "stub"),
    )


# ---------------------------------------------------------------------------
# lessons store (separate sqlite file — never jarvis.db)
# ---------------------------------------------------------------------------
def open_store(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS lessons (
            fingerprint    TEXT PRIMARY KEY,
            source_node_id INTEGER,
            tree_id        TEXT,
            title          TEXT,
            situation      TEXT,
            pitfall        TEXT,
            guidance       TEXT,
            tags           TEXT,
            created_from   TEXT,
            created_at     TEXT DEFAULT (datetime('now'))
        )
        """
    )
    return conn


def upsert_lesson(store: sqlite3.Connection, lesson: Lesson) -> bool:
    """Returns True if newly inserted, False if it was a duplicate fingerprint."""
    existing = store.execute(
        "SELECT 1 FROM lessons WHERE fingerprint=?", (lesson.fingerprint,)
    ).fetchone()
    if existing:
        return False
    store.execute(
        """INSERT INTO lessons
           (fingerprint, source_node_id, tree_id, title, situation, pitfall, guidance, tags, created_from)
           VALUES (:fingerprint,:source_node_id,:tree_id,:title,:situation,:pitfall,:guidance,:tags,:created_from)""",
        asdict(lesson),
    )
    store.commit()
    return True


def retrieve(store: sqlite3.Connection, query: str, k: int = 5) -> list[dict]:
    """First-cut retrieval: score by tag/keyword overlap with the query. Embeddings later."""
    q_terms = set(re.findall(r"[a-zA-Z][a-zA-Z0-9_\-]{2,}", query.lower())) - _STOPWORDS
    scored = []
    for row in store.execute("SELECT * FROM lessons"):
        hay = f"{row['tags']} {row['title']} {row['situation']}".lower()
        hay_terms = set(re.findall(r"[a-zA-Z][a-zA-Z0-9_\-]{2,}", hay))
        score = len(q_terms & hay_terms)
        if score:
            d = dict(row)
            d["_score"] = score
            scored.append(d)
    scored.sort(key=lambda d: d["_score"], reverse=True)
    return scored[:k]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def mine(jarvis_db: str, lessons_db: str, limit: int, distiller: Distiller) -> dict:
    with _connect_ro(jarvis_db) as conn:
        trajectories = select_trajectories(conn, limit=limit)
    store = open_store(lessons_db)
    new = dup = 0
    for tj in trajectories:
        if upsert_lesson(store, distill(tj, distiller)):
            new += 1
        else:
            dup += 1
    return {"candidates": len(trajectories), "new": new, "duplicates": dup}


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Reflection lesson miner (read-only over jarvis.db)")
    ap.add_argument("--jarvis-db", default=DEFAULT_JARVIS_DB)
    ap.add_argument("--lessons-db", default=DEFAULT_LESSONS_DB)
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--scan", action="store_true", help="only list candidate trajectories")
    ap.add_argument("--retrieve", metavar="QUERY", help="retrieve top lessons for a task query")
    ap.add_argument("--use-claude", action="store_true",
                    help="use the claude CLI distiller (opt-in; default is the model-free stub)")
    args = ap.parse_args(argv)

    if args.retrieve:
        store = open_store(args.lessons_db)
        for d in retrieve(store, args.retrieve):
            print(f"[{d['_score']}] {d['pitfall']}  -> {d['guidance']}  (node {d['source_node_id']})")
        return 0

    if args.scan:
        with _connect_ro(args.jarvis_db) as conn:
            tjs = select_trajectories(conn, limit=args.limit)
        print(f"{len(tjs)} candidate trajectories:")
        for tj in tjs[:40]:
            print(f"  node {tj.node_id} [{tj.reason}] {tj.title[:90]}")
        return 0

    distiller = claude_cli_distiller if args.use_claude else stub_distiller
    summary = mine(args.jarvis_db, args.lessons_db, args.limit, distiller)
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
