#!/usr/bin/env python3
"""Acceptance check for watchdog commitment wake-back.

Uses only a scratch sqlite database and a local HTTP stub. It does not call the
live cockpit or open the live jarvis.db.
"""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.parse


ROOT = Path(__file__).resolve().parents[1]
WATCHDOG = ROOT / "scripts" / "jarvis-watchdog.py"
SCRATCH = Path(os.environ.get("WATCHDOG_WAKE_BACK_TMP", "/tmp/watchdog-wake-back"))
PAST = "2026-10-13 05:00:00"
CREATED = "2026-10-13 04:00:00"
NOW = dt.datetime(2026, 10, 13, 6, 0, 0)


class StubHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {"_raw": raw.decode("utf-8", errors="replace")}
        self.server.records.append({
            "method": "POST",
            "path": self.path,
            "body": body,
            "authorization": self.headers.get("authorization"),
        })
        self.send_response(202 if "/threads/" in self.path else 200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *_args):
        pass


class StubServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), StubHandler)
        self.records = []
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)

    @property
    def api_base(self):
        host, port = self.server_address
        return f"http://{host}:{port}/api/v1"

    def start(self):
        self.thread.start()

    def stop(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=5)

    def reset(self):
        self.records.clear()


class InProcessStub:
    api_base = "http://127.0.0.1:9/api/v1"

    def __init__(self):
        self.records = []

    def start(self):
        pass

    def stop(self):
        pass

    def reset(self):
        self.records.clear()

    def http(self, method, url, key, payload=None, timeout=20):
        parsed = urllib.parse.urlparse(url)
        self.records.append({
            "method": method,
            "path": parsed.path,
            "body": payload or {},
            "authorization": "Bearer " + key,
        })
        return {"ok": True}


def load_watchdog(db_path, cockpit):
    os.environ["WATCHDOG_DB"] = str(db_path)
    os.environ["WATCHDOG_COCKPIT"] = cockpit
    spec = importlib.util.spec_from_file_location("jarvis_watchdog_under_test", WATCHDOG)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.COCKPIT_KEY = "test-cockpit-key"
    module.LOG = str(SCRATCH / "watchdog-test.log")
    return module


def thread_posts(stub):
    return [r for r in stub.records if "/threads/" in r["path"] and r["path"].endswith("/messages")]


def notifications(stub):
    return [r for r in stub.records if r["path"].endswith("/notifications")]


def make_db(watchdog, name):
    path = SCRATCH / f"{name}.db"
    if path.exists():
        path.unlink()
    watchdog.DB = str(path)
    conn = sqlite3.connect(path)
    watchdog.ensure_schema(conn)
    conn.executescript("""
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE,
      title TEXT,
      updated_at TEXT,
      status TEXT
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT,
      created_at TEXT,
      content TEXT,
      turn_index INTEGER,
      tool_name TEXT
    );
    """)
    conn.commit()
    return conn


def add_commitment(conn, **overrides):
    row = {
        "subject": "wake Kevin",
        "thread_ext": "thread-a",
        "check_type": "manual",
        "check_ref": None,
        "due_at": PAST,
        "status": "open",
        "created_at": CREATED,
        "notes": None,
    }
    row.update(overrides)
    cur = conn.execute(
        """INSERT INTO watch_commitments
           (subject, thread_ext, check_type, check_ref, due_at, status, created_at, notes)
           VALUES (:subject, :thread_ext, :check_type, :check_ref, :due_at, :status, :created_at, :notes)""",
        row,
    )
    conn.commit()
    return int(cur.lastrowid)


def add_turn(conn, external_id, content, created_at="2026-10-13 04:30:00", role="assistant"):
    conv = conn.execute(
        "INSERT INTO conversations (external_id, title, updated_at, status) VALUES (?, ?, ?, ?)",
        (external_id, "Origin", created_at, "active"),
    )
    conn.execute(
        "INSERT INTO turns (conversation_id, role, created_at, content, turn_index) VALUES (?, ?, ?, ?, ?)",
        (int(conv.lastrowid), role, created_at, content, 0),
    )
    conn.commit()


def row_status(conn, row_id):
    return conn.execute("SELECT status, notes FROM watch_commitments WHERE id=?", (row_id,)).fetchone()


def set_flag(watchdog, enabled):
    flag = SCRATCH / "wake-back.enabled"
    watchdog.WAKE_BACK_FLAG = str(flag)
    if enabled:
        flag.write_text("1", encoding="utf-8")
    elif flag.exists():
        flag.unlink()


def check_env_overrides_and_defaults(watchdog, initial_db, stub):
    assert watchdog.DEFAULT_DB == "/home/kevin/paperclip/darwin-assistant/jarvis.db"
    assert watchdog.DEFAULT_COCKPIT == "http://localhost:3201/api/v1"
    assert watchdog.DB == str(initial_db)
    assert watchdog.COCKPIT == stub.api_base


def check_overdue_posts_once(watchdog, stub):
    stub.reset()
    conn = make_db(watchdog, "posts-once")
    set_flag(watchdog, True)
    row_id = add_commitment(conn, subject="finish the wake-back check", thread_ext="origin-thread")
    watchdog.sentinel_commitments(conn, NOW)
    posts = thread_posts(stub)
    assert len(posts) == 1, f"expected 1 wake post, saw {len(posts)}"
    assert posts[0]["path"] == "/api/v1/threads/origin-thread/messages"
    text = posts[0]["body"]["text"]
    assert '"finish the wake-back check"' in text
    assert f'"{PAST} UTC"' in text
    assert '"manual commitment' in text
    assert text.endswith("check this and report status in one line.")
    status, notes = row_status(conn, row_id)
    assert status == "breached"
    assert "woke=" in notes and "pending" not in notes, notes
    assert "wake=posted" in notifications(stub)[0]["body"]["body"]
    watchdog.sentinel_commitments(conn, NOW)
    assert len(thread_posts(stub)) == 1, "second run posted again"
    conn.close()


def check_flag_absent_still_notifies(watchdog, stub):
    stub.reset()
    conn = make_db(watchdog, "flag-absent")
    set_flag(watchdog, False)
    row_id = add_commitment(conn, thread_ext="thread-flag-off")
    watchdog.sentinel_commitments(conn, NOW)
    assert len(thread_posts(stub)) == 0
    assert len(notifications(stub)) == 1, "notify() did not fire"
    status, notes = row_status(conn, row_id)
    assert status == "breached"
    assert "woke=" not in (notes or "")
    conn.close()


def check_missing_thread_does_not_post(watchdog, stub):
    stub.reset()
    conn = make_db(watchdog, "no-thread")
    set_flag(watchdog, True)
    add_commitment(conn, thread_ext=None)
    watchdog.sentinel_commitments(conn, NOW)
    assert len(thread_posts(stub)) == 0
    assert len(notifications(stub)) == 1
    conn.close()


def check_cap_three(watchdog, stub):
    stub.reset()
    conn = make_db(watchdog, "cap-three")
    set_flag(watchdog, True)
    for i in range(5):
        add_commitment(conn, subject=f"commitment {i}", thread_ext=f"thread-{i}")
    watchdog.sentinel_commitments(conn, NOW)
    assert len(thread_posts(stub)) == 3, f"expected cap of 3 posts, saw {len(thread_posts(stub))}"
    assert len(notifications(stub)) == 5
    conn.close()


def check_chat_report_satisfied(watchdog, stub):
    stub.reset()
    conn = make_db(watchdog, "chat-report-satisfied")
    set_flag(watchdog, True)
    add_turn(conn, "origin-report", "done [report:child-chat-1]", created_at="2026-10-13 04:30:00")
    row_id = add_commitment(
        conn,
        subject="child chat reports back",
        thread_ext="origin-report",
        check_type="chat_report",
        check_ref="child-chat-1",
    )
    watchdog.sentinel_commitments(conn, NOW)
    status, notes = row_status(conn, row_id)
    assert status == "satisfied"
    assert "1 report marker" in notes
    assert len(thread_posts(stub)) == 0
    assert len(notifications(stub)) == 0
    conn.close()


def check_chat_report_missing_breaches(watchdog, stub):
    stub.reset()
    conn = make_db(watchdog, "chat-report-missing")
    set_flag(watchdog, True)
    add_turn(conn, "origin-report-old", "early [report:child-chat-2]", created_at="2026-10-13 03:59:59")
    row_id = add_commitment(
        conn,
        subject="child chat never reported",
        thread_ext="origin-report-old",
        check_type="chat_report",
        check_ref="child-chat-2",
    )
    watchdog.sentinel_commitments(conn, NOW)
    status, notes = row_status(conn, row_id)
    assert status == "breached"
    assert "0 report marker" in notes
    assert len(thread_posts(stub)) == 1
    conn.close()


def check_preexisting_breached_never_wakes(watchdog, stub):
    stub.reset()
    conn = make_db(watchdog, "already-breached")
    set_flag(watchdog, True)
    add_commitment(conn, thread_ext="old-breached", status="breached")
    watchdog.sentinel_commitments(conn, NOW)
    assert len(thread_posts(stub)) == 0
    assert len(notifications(stub)) == 0
    conn.close()


class BreachLockedConn:
    """Delegates to a real connection but raises 'database is locked' on the breach UPDATE."""

    def __init__(self, conn):
        self._conn = conn
        self.locked = True

    def execute(self, sql, *args):
        if self.locked and "status='breached'" in sql and sql.lstrip().upper().startswith("UPDATE"):
            raise sqlite3.OperationalError("database is locked")
        return self._conn.execute(sql, *args)

    def __getattr__(self, name):
        return getattr(self._conn, name)


def check_breach_write_fails_never_double_wakes(watchdog, stub):
    stub.reset()
    conn = make_db(watchdog, "breach-locked")
    set_flag(watchdog, True)
    row_id = add_commitment(conn, thread_ext="thread-locked")
    locked = BreachLockedConn(conn)
    try:
        watchdog.sentinel_commitments(locked, NOW)
    except sqlite3.OperationalError:
        pass  # main()'s per-sentinel handler swallows this in production
    assert len(thread_posts(stub)) == 0, "posted before the breach was committed"
    assert row_status(conn, row_id)[0] == "open"
    locked.locked = False
    watchdog.sentinel_commitments(locked, NOW)
    watchdog.sentinel_commitments(locked, NOW)
    assert len(thread_posts(stub)) == 1, f"expected exactly 1 wake across retries, saw {len(thread_posts(stub))}"
    conn.close()


def check_post_failure_marks_and_never_retries(watchdog, stub):
    stub.reset()
    conn = make_db(watchdog, "post-fails")
    set_flag(watchdog, True)
    row_id = add_commitment(conn, thread_ext="thread-post-fails")
    real_http = watchdog.http
    attempts = []

    def failing_http(method, url, key, payload=None, timeout=20):
        if "/threads/" in url:
            attempts.append(timeout)
            raise OSError("connection refused")
        return real_http(method, url, key, payload, timeout)

    watchdog.http = failing_http
    try:
        watchdog.sentinel_commitments(conn, NOW)
        watchdog.sentinel_commitments(conn, NOW)
    finally:
        watchdog.http = real_http
    assert len(attempts) == 1, f"wake attempted {len(attempts)} times"
    assert attempts[0] <= 5, f"wake POST timeout {attempts[0]}s > 5s"
    status, notes = row_status(conn, row_id)
    assert status == "breached"
    assert "wake_failed=" in notes and "woke=" not in notes, notes
    assert "wake=failed" in notifications(stub)[0]["body"]["body"]
    conn.close()


def check_wake_detail_capped(watchdog, stub):
    text = watchdog.wake_back_text({"subject": "s", "due_at": PAST}, "x" * 5000)
    assert len(text) < 600, f"wake text {len(text)} chars"


def check_chat_report_same_second(watchdog, stub):
    stub.reset()
    conn = make_db(watchdog, "report-same-second")
    set_flag(watchdog, True)
    row_id = add_commitment(conn, check_type="chat_report", check_ref="child-same",
                            thread_ext="origin-same")
    add_turn(conn, "origin-same", "[report:child-same] done", created_at=CREATED)
    watchdog.sentinel_commitments(conn, NOW)
    assert row_status(conn, row_id)[0] == "satisfied"
    assert len(thread_posts(stub)) == 0
    conn.close()


def check_preflight_cockpit_key_can_post_cross_thread():
    api_v1 = (ROOT / "src" / "handlers" / "api-v1.ts").read_text(encoding="utf-8")
    api_keys = (ROOT / "src" / "api-keys.ts").read_text(encoding="utf-8")
    route_at = api_v1.index("router.post('/threads/:external_id/messages'")
    route_block = api_v1[route_at:route_at + 3000]
    assert "findConversationForCaller(caller, externalId)" in route_block
    assert "const ADMIN_SCOPES = new Set(['admin', 'cockpit']);" in api_keys
    assert "if (row && isAdminScope(row.scope)) return true;" in api_keys
    print("  preflight: cockpit/admin scope owns every thread; /threads/:external_id/messages uses findConversationForCaller")


def run_check(name, fn):
    try:
        fn()
    except Exception as exc:
        print(f"FAIL {name}: {exc}")
        raise
    print(f"PASS {name}")


def main():
    if SCRATCH.exists():
        shutil.rmtree(SCRATCH)
    SCRATCH.mkdir(parents=True)
    try:
        stub = StubServer()
    except PermissionError:
        if os.environ.get("WATCHDOG_WAKE_BACK_ALLOW_INPROC") != "1":
            raise SystemExit("FAIL local socket unavailable; real HTTP path not exercised "
                             "(set WATCHDOG_WAKE_BACK_ALLOW_INPROC=1 to accept the in-process stub)")
        stub = InProcessStub()
        print("WARN local socket unavailable; using in-process HTTP stub")
    stub.start()
    initial_db = SCRATCH / "initial.db"
    watchdog = load_watchdog(initial_db, stub.api_base)
    if isinstance(stub, InProcessStub):
        watchdog.http = stub.http
    checks = [
        ("env overrides with unchanged defaults", lambda: check_env_overrides_and_defaults(watchdog, initial_db, stub)),
        ("overdue open row posts exactly once", lambda: check_overdue_posts_once(watchdog, stub)),
        ("flag absent: no post but notify fires", lambda: check_flag_absent_still_notifies(watchdog, stub)),
        ("missing thread_ext: no post", lambda: check_missing_thread_does_not_post(watchdog, stub)),
        ("five overdue rows cap at three posts", lambda: check_cap_three(watchdog, stub)),
        ("chat_report marker satisfies without post", lambda: check_chat_report_satisfied(watchdog, stub)),
        ("chat_report missing after created_at breaches", lambda: check_chat_report_missing_breaches(watchdog, stub)),
        ("preexisting breached row never wakes", lambda: check_preexisting_breached_never_wakes(watchdog, stub)),
        ("breach write fails: no post, then exactly one wake", lambda: check_breach_write_fails_never_double_wakes(watchdog, stub)),
        ("wake POST fails: wake_failed noted, never retried, 5s timeout", lambda: check_post_failure_marks_and_never_retries(watchdog, stub)),
        ("wake detail capped at 300 chars", lambda: check_wake_detail_capped(watchdog, stub)),
        ("chat_report marker in the same second satisfies", lambda: check_chat_report_same_second(watchdog, stub)),
        ("preflight route auth read-only proof (source string match, not runtime)", check_preflight_cockpit_key_can_post_cross_thread),
    ]
    only = os.environ.get("WATCHDOG_WAKE_BACK_ONLY")
    if only:
        checks = [c for c in checks if only in c[0]]
    try:
        for name, fn in checks:
            run_check(name, fn)
    finally:
        stub.stop()
    print(f"PASS {len(checks)}/{len(checks)} watchdog wake-back checks")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
