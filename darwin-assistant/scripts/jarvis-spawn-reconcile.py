#!/usr/bin/env python3
"""JARVIS spawn-task heartbeat reconciler.
Runs every 5 min (systemd timer). Reconciles the spawn_tasks table against live
cockpit run-state, flips stuck/dead workers, captures results, surfaces stuck/failed
via a cockpit notification. Server-owned run-state is the liveness signal (no OS PID
exposed by the API yet). See skills/jarvis-worker-protocol/SKILL.md.
"""
import sqlite3, json, urllib.parse, urllib.request, datetime, sys, os

DB = "/home/kevin/paperclip/darwin-assistant/jarvis.db"
ENV = "/home/kevin/paperclip/jarvis-command-center/.env"
BASE = "http://localhost:3201/api/v1"
STALE_MINUTES = 25          # running but no progress this long -> stuck
DISPATCH_TIMEOUT_MIN = 15   # never ran (turn_count 0) this long -> failed
LOG = "/tmp/jarvis-spawn-reconcile.log"

def key():
    for line in open(ENV):
        if line.startswith("JARVIS_COCKPIT_KEY"):
            return line.split("=", 1)[1].strip().strip('"')
    return ""

KEY = key()

def api_get(path):
    req = urllib.request.Request(BASE + path, headers={"Authorization": "Bearer " + KEY})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

def notify(sev, title, body):
    try:
        data = json.dumps({"severity": sev, "title": title, "body": body,
                           "source": "spawn-reconciler"}).encode()
        req = urllib.request.Request(BASE + "/notifications", data=data,
              headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        log(f"notify failed: {e}")

def parse_ts(s):
    if not s: return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
        try: return datetime.datetime.strptime(s[:19] if "%H:%M:%S" in fmt else s, fmt)
        except Exception: pass
    try: return datetime.datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S")
    except Exception: return None

def log(msg):
    line = f"{datetime.datetime.utcnow().isoformat()}Z {msg}"
    print(line)
    try:
        with open(LOG, "a") as f: f.write(line + "\n")
    except Exception: pass

def main():
    now = datetime.datetime.utcnow()
    c = sqlite3.connect(DB, timeout=15)
    c.row_factory = sqlite3.Row
    rows = c.execute("SELECT * FROM spawn_tasks WHERE status IN ('running','stuck')").fetchall()
    log(f"reconcile start: {len(rows)} active worker(s)")
    for row in rows:
        ext = row["thread_ext"]; prev = row["status"]
        try:
            d = api_get("/threads/" + urllib.parse.quote(ext, safe=""))
        except Exception as e:
            log(f"  {row['label']}: descriptor fetch failed ({e}) — leaving as-is"); continue
        running = bool(d.get("running"))
        turns = d.get("turn_count") or 0
        upd = parse_ts(d.get("updated_at"))
        created = parse_ts(row["created_at"]) or now
        new_status, result, error = prev, None, None
        if running:
            new_status = "running"
            if upd and (now - upd).total_seconds() > STALE_MINUTES * 60 and turns <= (row["turn_count"] or 0):
                new_status = "stuck"; error = f"no progress >{STALE_MINUTES}m while running"
        else:
            if turns >= 1:
                new_status = "done"
                result = d.get("latest_summary") or f"completed (turn_count={turns}); open thread for detail"
            elif (now - created).total_seconds() > DISPATCH_TIMEOUT_MIN * 60:
                new_status = "failed"; error = f"never processed (turn_count=0) after {DISPATCH_TIMEOUT_MIN}m"
            else:
                new_status = "running"  # young, give it time
        c.execute("""UPDATE spawn_tasks SET status=?, turn_count=?, last_seen_running=?,
                     result=COALESCE(?,result), error=COALESCE(?,error),
                     updated_at=datetime('now'), last_heartbeat=datetime('now') WHERE id=?""",
                  (new_status, turns, 1 if running else 0, result, error, row["id"]))
        log(f"  {row['label']}: {prev} -> {new_status} (running={running}, turns={turns})")
        if new_status in ("stuck", "failed") and prev not in ("stuck", "failed"):
            notify("warning", f"Worker {new_status}: {row['label']}",
                   f"{error or ''} — thread {ext} (parent {row['parent_thread_ext']})")
    c.commit(); c.close()
    log("reconcile done")

if __name__ == "__main__":
    main()
