#!/usr/bin/env python3
"""JARVIS Watchdog — nothing gets dropped.

Runs every 60s (systemd timer). Server-owned state, model-independent: if the
model/session dies mid-turn, if a Foreman job stalls, if JARVIS promised to do
something and never did — this catches it, attempts a NON-DESTRUCTIVE recovery,
and escalates to Kevin via a cockpit notification.

Mission statement (Kevin, 2026-08-30): "no matter what happens, even if it's the
foreman itself that breaks, it should attempt to be solved in a non-destructive
way instead of just suddenly stopping or dying without being handled."

Sentinels
  foreman     — jobs stalled in an active status, or newly failed / needs_review
  dead_turn   — a thread whose last message is Kevin's with no reply (session died)
  commitment  — registered promises past their deadline (see jarvis-commit.py)
  services    — the units this whole stack depends on
  self        — writes its own heartbeat so a missing watchdog is itself visible

Escalation is state-change-driven (watch_events dedupes), so a stuck thing alerts
ONCE, not every minute.
"""
import sqlite3, json, os, subprocess, urllib.parse, urllib.request, datetime, traceback

DB          = "/home/kevin/paperclip/darwin-assistant/jarvis.db"
COCKPIT_ENV = "/home/kevin/paperclip/jarvis-command-center/.env"
JARVIS_ENV  = "/home/kevin/paperclip/darwin-assistant/.env"
COCKPIT     = "http://localhost:3201/api/v1"
PAPERCLIP   = "http://localhost:3100/api/v1"
COMPANY_ID  = "ffbbb56f-af79-49a0-a95a-9eb89f5b3034"
HEARTBEAT   = "/tmp/jarvis-watchdog-heartbeat.json"
LOG         = "/tmp/jarvis-watchdog.log"

# --- thresholds (minutes) ---
FOREMAN_STALE_MIN   = 20   # active job with no update this long -> stuck
DEAD_TURN_MIN       = 8    # user message with no reply this long -> turn died
DEAD_TURN_MAX_AGE_H = 48   # ignore anything older than this (don't alert on history)
MAX_FOREMAN_RECOVER = 2    # re-kick attempts per job, ever
MAX_TURN_RECOVER    = 1    # auto-resume attempts per dead turn, ever
RECOVER_MAX_AGE_H   = 24   # never auto-recover work older than this — a months-old
                           # stalled job gets flagged for a human, not silently
                           # re-run into live workers

FOREMAN_TERMINAL = {"merged", "completed", "cancelled", "done"}
FOREMAN_ACTIVE   = {"planning", "decomposed", "dispatched", "running",
                    "integrating", "verifying", "queued", "pending"}
SERVICES = ["jarvis.service", "jarvis-command-center.service",
            "paperclip-dev.service", "foreman-eye.service"]


def log(msg):
    line = f"{datetime.datetime.utcnow().isoformat()}Z {msg}"
    print(line)
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def env_val(path, name):
    try:
        for line in open(path):
            if line.strip().startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return ""


COCKPIT_KEY = env_val(COCKPIT_ENV, "JARVIS_COCKPIT_KEY")
PAPERCLIP_KEY = (env_val(JARVIS_ENV, "PAPERCLIP_BOARD_API_KEY")
                 or env_val(JARVIS_ENV, "PAPERCLIP_API_KEY"))


def http(method, url, key, payload=None, timeout=20):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Authorization": "Bearer " + key}
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode()
    return json.loads(body) if body.strip() else {}


def notify(sev, title, body, link=None):
    try:
        http("POST", COCKPIT + "/notifications", COCKPIT_KEY,
             {"severity": sev, "title": title, "body": body,
              "source": "watchdog", **({"link": link} if link else {})})
        log(f"  NOTIFY [{sev}] {title}")
    except Exception as e:
        log(f"  notify FAILED: {e}")


def nudge(source, subject_ref, context):
    """Create a needs-Kevin nudge when the route exists.

    This script may be deployed before or after the JARVIS nudge API. A missing
    /nudges route must not break the watchdog, so all failures are soft.
    """
    try:
        http("POST", COCKPIT + "/nudges", COCKPIT_KEY,
             {"source": source, "subject_ref": subject_ref, "context": context},
             timeout=8)
        log(f"  NUDGE [{source}] {subject_ref}")
    except Exception as e:
        log(f"  nudge skipped/failed: {e}")


def parse_ts(s):
    if not s:
        return None
    s = s.replace("T", " ").replace("Z", "")[:19]
    try:
        return datetime.datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def ensure_schema(c):
    c.executescript("""
    CREATE TABLE IF NOT EXISTS watch_commitments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      thread_ext TEXT,
      check_type TEXT NOT NULL DEFAULT 'manual',
      check_ref TEXT,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      recovery_attempts INTEGER NOT NULL DEFAULT 0,
      last_checked TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_watch_commitments_status
      ON watch_commitments(status, due_at);
    CREATE TABLE IF NOT EXISTS watch_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sentinel TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      state TEXT,
      severity TEXT,
      message TEXT,
      recovery_attempts INTEGER NOT NULL DEFAULT 0,
      notified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sentinel, subject_key)
    );
    """)
    c.commit()


def seen_state(c, sentinel, key):
    r = c.execute("SELECT state, recovery_attempts FROM watch_events "
                  "WHERE sentinel=? AND subject_key=?", (sentinel, key)).fetchone()
    return (r[0], r[1]) if r else (None, 0)


def record_state(c, sentinel, key, state, sev=None, msg=None, bump_recovery=0):
    c.execute("""INSERT INTO watch_events (sentinel, subject_key, state, severity, message,
                   recovery_attempts, notified_at)
                 VALUES (?,?,?,?,?,?,datetime('now'))
                 ON CONFLICT(sentinel, subject_key) DO UPDATE SET
                   state=excluded.state, severity=excluded.severity, message=excluded.message,
                   recovery_attempts=watch_events.recovery_attempts+?,
                   notified_at=datetime('now'), updated_at=datetime('now')""",
              (sentinel, key, state, sev, msg, bump_recovery, bump_recovery))
    c.commit()


# ---------------------------------------------------------------- sentinels

def sentinel_foreman(c, now):
    """Stalled / failed / review-waiting Foreman jobs. Recovery = re-kick the run."""
    if not PAPERCLIP_KEY:
        log("  foreman: no paperclip key, skipping")
        return
    try:
        jobs = http("GET", f"{PAPERCLIP}/jobs?companyId={COMPANY_ID}&limit=60",
                    PAPERCLIP_KEY).get("jobs", [])
    except Exception as e:
        # Foreman/Paperclip itself is down -- that IS the alert.
        prev, _ = seen_state(c, "foreman", "_api")
        if prev != "down":
            notify("error", "Foreman API unreachable",
                   f"Watchdog could not list jobs: {e}. Paperclip may be down — "
                   f"check paperclip-dev.service and the healthcheck timer.")
            record_state(c, "foreman", "_api", "down", "error", str(e))
        return
    prev_api, _ = seen_state(c, "foreman", "_api")
    if prev_api == "down":
        notify("success", "Foreman API back up", "Job listing is responding again.")
        record_state(c, "foreman", "_api", "up", "success", "recovered")

    for j in jobs:
        jid, status = j.get("id"), (j.get("status") or "").lower()
        if status in FOREMAN_TERMINAL:
            continue
        upd = parse_ts(j.get("updatedAt")) or parse_ts(j.get("createdAt"))
        age_min = (now - upd).total_seconds() / 60 if upd else 0
        ask = (j.get("ask") or "")[:110].replace("\n", " ")
        prev, attempts = seen_state(c, "foreman", jid)

        if status == "failed":
            if prev != "failed":
                notify("error", "Foreman job FAILED",
                       f"{ask}\n\nJob {jid[:8]} · {j.get('summary') or j.get('errorMessage') or 'no summary'}"
                       f"\nForeman Eye: http://localhost:8081/jobs/{jid}")
                record_state(c, "foreman", jid, "failed", "error", ask)
            continue

        if status == "needs_review":
            if prev != "needs_review":
                notify("warning", "Foreman job needs your review",
                       f"{ask}\n\nJob {jid[:8]} · verify={j.get('verifyResult')} · "
                       f"waiting {int(age_min//60)}h\nForeman Eye: http://localhost:8081/jobs/{jid}")
                record_state(c, "foreman", jid, "needs_review", "warning", ask)
            continue

        if status in FOREMAN_ACTIVE and age_min >= FOREMAN_STALE_MIN:
            too_old = age_min > RECOVER_MAX_AGE_H * 60
            if too_old:
                if prev != "stale_abandoned":
                    notify("warning", "Foreman job abandoned (too old to auto-recover)",
                           f"{ask}\n\nJob {jid[:8]} has been stuck in '{status}' for "
                           f"{int(age_min//60)}h. Not auto-re-running it — it predates the "
                           f"{RECOVER_MAX_AGE_H}h recovery window. Re-run or cancel it by hand."
                           f"\nForeman Eye: http://localhost:8081/jobs/{jid}")
                    record_state(c, "foreman", jid, "stale_abandoned", "warning", ask)
            elif attempts < MAX_FOREMAN_RECOVER:
                ok, err = True, ""
                try:
                    http("POST", f"{PAPERCLIP}/jobs/{jid}/run", PAPERCLIP_KEY, {})
                except Exception as e:
                    ok, err = False, str(e)
                record_state(c, "foreman", jid, f"stalled:{status}", "warning", ask,
                             bump_recovery=1)
                notify("warning" if ok else "error",
                       f"Foreman job stalled — {'re-kicked' if ok else 'recovery failed'}",
                       f"{ask}\n\nJob {jid[:8]} stuck in '{status}' for {int(age_min)}m. "
                       f"{'Re-ran it (attempt %d/%d).' % (attempts+1, MAX_FOREMAN_RECOVER) if ok else 'Re-run failed: ' + err}"
                       f"\nForeman Eye: http://localhost:8081/jobs/{jid}")
            elif prev != "stalled_exhausted":
                notify("error", "Foreman job stuck — recovery exhausted",
                       f"{ask}\n\nJob {jid[:8]} still stuck in '{status}' after "
                       f"{MAX_FOREMAN_RECOVER} re-kicks ({int(age_min)}m idle). Needs a human.")
                record_state(c, "foreman", jid, "stalled_exhausted", "error", ask)


def sentinel_dead_turn(c, now):
    """A thread whose LAST turn is Kevin's, with no reply — the run died mid-turn.

    Auto-resume ONLY when the dead turn did literally nothing (no assistant text,
    no tool calls) — that is safely retryable. If it did partial work, notify only;
    replaying could double-execute a side effect.
    """
    cutoff = (now - datetime.timedelta(hours=DEAD_TURN_MAX_AGE_H)).strftime("%Y-%m-%d %H:%M:%S")
    rows = c.execute("""
        SELECT cv.id, cv.external_id, cv.title, t.role, t.created_at, t.content, t.turn_index
        FROM conversations cv
        JOIN turns t ON t.id = (
            SELECT id FROM turns WHERE conversation_id = cv.id
            ORDER BY turn_index DESC, id DESC LIMIT 1)
        WHERE cv.updated_at > ? AND cv.status = 'active'
    """, (cutoff,)).fetchall()

    for cid, ext, title, role, tcreated, content, tindex in rows:
        if role != "user":
            continue
        ts = parse_ts(tcreated)
        if not ts or (now - ts).total_seconds() / 60 < DEAD_TURN_MIN:
            continue
        # is it actively running right now? server owns that answer. We must
        # POSITIVELY confirm it is idle before any re-post — if the status check
        # errors/times out we assume it MIGHT still be running (fail closed) and
        # skip this tick, rather than defaulting to "idle" and double-executing.
        running, running_known = True, False
        try:
            d = http("GET", COCKPIT + "/threads/" + urllib.parse.quote(ext, safe=""), COCKPIT_KEY)
            running = bool(d.get("running"))
            running_known = True
        except Exception:
            pass
        if running or not running_known:
            continue

        key = f"{cid}:{tindex}"
        prev, attempts = seen_state(c, "dead_turn", key)
        if prev == "handled":
            continue

        did_work = c.execute(
            "SELECT COUNT(*) FROM turns WHERE conversation_id=? AND turn_index>=? "
            "AND (tool_name IS NOT NULL OR role='assistant')", (cid, tindex)).fetchone()[0]
        label = title or ext
        snippet = (content or "")[:160].replace("\n", " ")

        if did_work == 0 and attempts < MAX_TURN_RECOVER and content:
            ok, err = True, ""
            try:
                http("POST", COCKPIT + "/threads/" + urllib.parse.quote(ext, safe="") + "/messages",
                     COCKPIT_KEY, {"text": content})
            except Exception as e:
                ok, err = False, str(e)
            record_state(c, "dead_turn", key, "handled" if ok else "resume_failed",
                         "warning", snippet, bump_recovery=1)
            notify("warning" if ok else "error",
                   f"Dead turn auto-resumed: {label}" if ok else f"Dead turn — resume FAILED: {label}",
                   f"Your message got no reply for {int((now-ts).total_seconds()//60)}m "
                   f"(session died before doing anything). "
                   f"{'Re-sent it; JARVIS is running it now.' if ok else 'Could not re-send: ' + err}"
                   f"\n\n> {snippet}")
        else:
            record_state(c, "dead_turn", key, "handled", "error", snippet)
            notify("error", f"Dead turn — needs you: {label}",
                   f"Your message got no reply for {int((now-ts).total_seconds()//60)}m and the run "
                   f"had already done partial work, so I did NOT auto-replay it "
                   f"(risk of double-executing). Open the thread and say 'continue'.\n\n> {snippet}")


def sentinel_commitments(c, now):
    """Registered promises. Overdue + unmet => escalate."""
    rows = c.execute("SELECT * FROM watch_commitments WHERE status='open'").fetchall()
    cols = [d[0] for d in c.execute("SELECT * FROM watch_commitments LIMIT 0").description]
    for r in rows:
        row = dict(zip(cols, r))
        due = parse_ts(row["due_at"])
        satisfied, detail = check_commitment(row)
        if satisfied:
            c.execute("UPDATE watch_commitments SET status='satisfied', resolved_at=datetime('now'),"
                      " last_checked=datetime('now'), notes=? WHERE id=?", (detail, row["id"]))
            c.commit()
            log(f"  commitment #{row['id']} satisfied: {row['subject'][:60]}")
            continue
        c.execute("UPDATE watch_commitments SET last_checked=datetime('now') WHERE id=?", (row["id"],))
        c.commit()
        if due and now >= due:
            c.execute("UPDATE watch_commitments SET status='breached', resolved_at=datetime('now'),"
                      " notes=? WHERE id=?", (detail, row["id"]))
            c.commit()
            notify("error", "JARVIS promised this and it never happened",
                   f"{row['subject']}\n\nDue {row['due_at']} UTC · check={row['check_type']}"
                   f"{':' + row['check_ref'] if row['check_ref'] else ''} · {detail}"
                   f"\nThread: {row['thread_ext'] or 'n/a'}")
            nudge("commitment", f"commitment-{row['id']}", {
                "summary": f"overdue commitment: {row['subject']}",
                "why_jarvis_could_not_clear": (
                    f"The watchdog registry says I promised this by {row['due_at']} UTC, "
                    f"but the check did not satisfy: {detail}"
                ),
                "answer_route": {
                    "method": "manual",
                    "path": "",
                    "body_template": {"answer": "$KEVIN_REPLY"},
                },
                "source_link": (
                    "/thread/" + urllib.parse.quote(row["thread_ext"], safe="")
                    if row["thread_ext"] else ""
                ),
            })


def check_commitment(row):
    t, ref = row["check_type"], row["check_ref"]
    if t == "foreman_job" and ref and PAPERCLIP_KEY:
        try:
            j = http("GET", f"{PAPERCLIP}/jobs/{ref}", PAPERCLIP_KEY)
            j = j.get("job", j)
            st = (j.get("status") or "").lower()
            if st and st not in ("planning", "pending", "queued"):
                return True, f"job advanced to {st}"
            return False, f"job still {st or 'unknown'}"
        except Exception as e:
            return False, f"job lookup failed: {e}"
    if t == "thread_reply" and ref:
        try:
            c2 = sqlite3.connect(DB, timeout=15)
            n = c2.execute("SELECT COUNT(*) FROM turns t JOIN conversations cv ON cv.id=t.conversation_id "
                           "WHERE cv.external_id=? AND t.role='assistant' AND t.created_at > ?",
                           (row["thread_ext"], ref)).fetchone()[0]
            c2.close()
            return (n > 0), f"{n} assistant turn(s) since {ref}"
        except Exception as e:
            return False, f"reply check failed: {e}"
    return False, "manual commitment — never auto-satisfied, mark it done explicitly"


def sentinel_services(c, now):
    for unit in SERVICES:
        try:
            state = subprocess.run(["systemctl", "is-active", unit], capture_output=True,
                                   text=True, timeout=10).stdout.strip()
        except Exception as e:
            state = f"unknown({e})"
        prev, _ = seen_state(c, "service", unit)
        if state != prev:
            record_state(c, "service", unit, state,
                         "error" if state != "active" else "success", state)
            if state != "active" and prev is not None:
                notify("error", f"Service down: {unit}",
                       f"systemctl is-active returned '{state}'. "
                       f"Check: journalctl -u {unit} -n 50")
            elif state == "active" and prev not in (None, "active"):
                notify("success", f"Service recovered: {unit}", f"back to active (was {prev})")


HOPPER_STALL_MIN = 60


def sentinel_hopper_stall(c, now):
    # An agreed tree with dispatchable work but nothing running for >HOPPER_STALL_MIN
    # means the governor (or a bug) has been holding it silently — the 2026-09-09
    # demo-eve failure mode. Alert loudly instead of letting it sit all night.
    rows = c.execute(
        "SELECT t.id, t.topic,"
        " SUM(CASE WHEN n.status='running' THEN 1 ELSE 0 END) AS running,"
        " SUM(CASE WHEN n.status='pending' THEN 1 ELSE 0 END) AS pending,"
        " MAX(COALESCE(n.updated_at, n.created_at)) AS last_activity"
        " FROM hopper_trees t JOIN hopper_nodes n ON n.tree_id=t.id"
        " WHERE t.status='active' GROUP BY t.id"
    ).fetchall()
    gov_reason, gov_detail = None, None
    if rows:
        try:
            g = http("GET", COCKPIT + "/hopper-engine/governor", COCKPIT_KEY)
            if not g.get("allow"):
                gov_reason, gov_detail = g.get("reason"), g.get("detail")
        except Exception as e:
            gov_reason, gov_detail = "unreachable", str(e)
    for tree_id, topic, running, pending, last_activity in rows:
        key = f"tree-{tree_id}"
        stalled = False
        if running == 0 and pending > 0 and gov_reason != "kevin_active":
            ts = parse_ts(last_activity)
            stalled = ts is not None and (now - ts).total_seconds() > HOPPER_STALL_MIN * 60
        state = "stalled" if stalled else "flowing"
        prev, _ = seen_state(c, "hopper_stall", key)
        if state != prev:
            record_state(c, "hopper_stall", key, state,
                         "error" if stalled else "success", state)
            if stalled:
                gov = (f"\nGovernor: reason={gov_reason} — {gov_detail}"
                       if gov_reason else "\nGovernor: allowing — suspect the engine itself")
                notify("error", f"Hopper tree stalled: {topic}",
                       f"Tree {tree_id} is active with {pending} pending node(s) and ZERO running "
                       f"for over {HOPPER_STALL_MIN}m (last activity {last_activity}).{gov}")
            elif prev == "stalled":
                notify("success", f"Hopper tree flowing again: {topic}",
                       f"Tree {tree_id} resumed dispatching.")


def main():
    now = datetime.datetime.utcnow()
    c = sqlite3.connect(DB, timeout=20)
    ensure_schema(c)
    errors = []
    for name, fn in (("foreman", sentinel_foreman), ("dead_turn", sentinel_dead_turn),
                     ("commitments", sentinel_commitments), ("services", sentinel_services),
                     ("hopper_stall", sentinel_hopper_stall)):
        try:
            fn(c, now)
        except Exception:
            errors.append(f"{name}: {traceback.format_exc(limit=3)}")
            log(f"  SENTINEL {name} THREW:\n{traceback.format_exc(limit=3)}")
    c.close()
    try:
        with open(HEARTBEAT, "w") as f:
            json.dump({"ran_at": now.isoformat() + "Z", "errors": errors,
                       "sentinels": ["foreman", "dead_turn", "commitments", "services", "hopper_stall"]}, f)
    except Exception:
        pass
    if errors:
        notify("error", "Watchdog sentinel error",
               "A watchdog sentinel threw — the watchdog itself still ran.\n" + errors[0][:600])
    log(f"watchdog tick done ({len(errors)} sentinel error(s))")


if __name__ == "__main__":
    main()
