#!/usr/bin/env python3
"""
jarvis-work — the operator switch for ALL autonomous work.

Kevin's ask (2026-09-25): a real "stop everything right now" plus independent
on/off per lane, WITHOUT quietly rewriting a pile of settings (workers to 0,
ceilings to 1, provider overrides off) to fake a stop. So this touches exactly
one file plus, on request, in-flight processes. Every dial stays where he left it.

Deliberately stdlib-only and DB-optional: the moments you need this most are the
moments jarvis.service is crash-looping or jarvis.db is locked.

  jarvis-work                        # status
  jarvis-work stop  [--kill] [--hard] [-r "reason"]
  jarvis-work resume
  jarvis-work off  <lane> [lane...]
  jarvis-work on   <lane> [lane...]
  jarvis-work park-node <id>         # park ONE runaway node so it stops re-arming
  jarvis-work kill-workers           # kill in-flight model workers, leave switch alone
"""
from __future__ import annotations
import json, os, re, subprocess, sys, time
from datetime import datetime, timezone

SWITCH = os.environ.get("JARVIS_WORK_SWITCH_PATH", "/var/lib/jarvis/work-switch.json")
DB = os.environ.get("JARVIS_DB_PATH", "/home/kevin/paperclip/darwin-assistant/jarvis.db")

# lane key -> (label, kind, unit)   — MUST stay in sync with src/work-switch.ts LANES
LANES = {
    "hopper":           ("Hopper dispatch",    "process", None),
    "night":            ("Shifts / Night",     "process", None),
    "autopilot":        ("Goals autopilot",    "process", None),
    "shepherd":         ("Check-ins",          "process", None),
    "watchdog":         ("Watchdog",           "timer", "jarvis-watchdog.service"),
    "spawn_reconcile":  ("Spawn reconciler",   "timer", "jarvis-spawn-reconcile.service"),
    "intel":            ("Intel Desk",         "timer", "intel-pull.service"),
    "bi":               ("BI sweep",           "timer", "bi-overnight-sweep.service"),
    "suppression":      ("Suppression monitor","timer", "suppression-monitor.service"),
    "kpi":              ("Darwin KPI run",     "timer", "darwin-kpi-run.service"),
}
# Model-worker binaries we are willing to kill on --kill.
WORKER_BINS = ("claude", "codex", "auggie", "devin")

C = sys.stdout.isatty()
def c(s, code):  return f"\033[{code}m{s}\033[0m" if C else s
def red(s):      return c(s, "1;31")
def green(s):    return c(s, "1;32")
def yellow(s):   return c(s, "1;33")
def dim(s):      return c(s, "2")
def bold(s):     return c(s, "1")

def now() -> str: return datetime.now(timezone.utc).isoformat()

def default_state() -> dict:
    return {"version": 1, "all_stopped": False, "all_stopped_at": None,
            "all_stopped_by": None, "all_stopped_reason": None,
            "lanes": {k: True for k in LANES}, "events": []}

def read_state() -> tuple[dict, bool]:
    """Returns (state, corrupt). Missing file = defaults; corrupt = fail safe."""
    if not os.path.exists(SWITCH):
        return default_state(), False
    try:
        raw = open(SWITCH).read().strip()
        if not raw: raise ValueError("empty")
        st = json.loads(raw)
        if not isinstance(st, dict): raise ValueError("not an object")
    except Exception:
        s = default_state(); s["all_stopped"] = True
        s["all_stopped_reason"] = "work-switch.json unreadable/corrupt — failing safe"
        return s, True
    base = default_state()
    base["all_stopped"] = st.get("all_stopped") is True
    for k in ("all_stopped_at", "all_stopped_by", "all_stopped_reason"):
        base[k] = st.get(k) if isinstance(st.get(k), str) else None
    lanes = st.get("lanes") or {}
    for k in LANES:
        base["lanes"][k] = False if lanes.get(k) is False else True
    evs = st.get("events")
    base["events"] = evs[-50:] if isinstance(evs, list) else []
    return base, False

def write_state(st: dict, by: str, op: str, lane=None, reason=None) -> None:
    st = dict(st)
    st["events"] = (st.get("events") or [])
    ev = {"at": now(), "by": by, "op": op}
    if lane: ev["lane"] = lane
    if reason: ev["reason"] = reason
    st["events"] = (st["events"] + [ev])[-50:]
    st.pop("corrupt", None)
    os.makedirs(os.path.dirname(SWITCH), exist_ok=True)
    tmp = f"{SWITCH}.tmp.{os.getpid()}"
    with open(tmp, "w") as fh:
        fh.write(json.dumps(st, indent=2) + "\n")
    os.replace(tmp, SWITCH)   # atomic: a half-written switch reads as corrupt

def who() -> str:
    return f"cli:{os.environ.get('SUDO_USER') or os.environ.get('USER') or 'kevin'}"

# --- process handling --------------------------------------------------------

def ancestors(pid: int) -> set[int]:
    out, cur = set(), pid
    for _ in range(40):
        try:
            with open(f"/proc/{cur}/stat") as fh:
                ppid = int(fh.read().split(") ", 1)[1].split()[1])
        except Exception:
            break
        if ppid <= 1: break
        out.add(ppid); cur = ppid
    return out

def worker_procs() -> list[tuple[int, str]]:
    """Model-worker processes inside the jarvis.service cgroup, EXCLUDING our own
    ancestry — so running this from inside a JARVIS chat turn never kills the very
    turn doing the killing."""
    mine = ancestors(os.getpid()) | {os.getpid()}
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit(): continue
        pid = int(entry)
        if pid in mine: continue
        try:
            cg = open(f"/proc/{pid}/cgroup").read()
            if "jarvis.service" not in cg: continue
            cmd = open(f"/proc/{pid}/cmdline").read().replace("\0", " ").strip()
        except Exception:
            continue
        if not cmd: continue
        exe = os.path.basename(cmd.split()[0])
        if exe in WORKER_BINS or any(f"/{b}" == f"/{exe}" for b in WORKER_BINS):
            found.append((pid, cmd[:110]))
    return found

def kill_workers(dry=False) -> int:
    procs = worker_procs()
    if not procs:
        print(dim("  no in-flight model workers under jarvis.service")); return 0
    for pid, cmd in procs:
        print(f"  {red('kill')} {pid}  {dim(cmd)}")
        if not dry:
            try: os.kill(pid, 15)
            except Exception as e: print(f"    (SIGTERM failed: {e})")
    if dry: return len(procs)
    time.sleep(2)
    for pid, _ in procs:
        if os.path.exists(f"/proc/{pid}"):
            try: os.kill(pid, 9); print(f"  {red('SIGKILL')} {pid} (did not exit)")
            except Exception: pass
    return len(procs)

def systemctl(*args) -> tuple[int, str]:
    try:
        p = subprocess.run(["systemctl", *args], capture_output=True, text=True, timeout=20)
        return p.returncode, (p.stdout + p.stderr).strip()
    except Exception as e:
        return 1, str(e)

def stop_inflight_timer_services() -> None:
    for key, (_lbl, kind, unit) in LANES.items():
        if kind != "timer" or not unit: continue
        rc, out = systemctl("is-active", unit)
        if out.strip() in ("active", "activating"):
            print(f"  {red('stop')} {unit} (was {out.strip()})")
            subprocess.run(["sudo", "-n", "systemctl", "stop", unit], capture_output=True)

# --- db (best effort, read-only) --------------------------------------------

def db_rows(sql: str):
    try:
        import sqlite3
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2.0)
        try:
            return con.execute(sql).fetchall()
        finally:
            con.close()
    except Exception:
        return None

# --- commands ---------------------------------------------------------------

def cmd_status() -> int:
    st, corrupt = read_state()
    print()
    if corrupt:
        print(red("  ⚠  work-switch.json is CORRUPT — every lane is failing SAFE (stopped)."))
        print(dim("     Run:  jarvis-work resume     to rewrite a clean file."))
    if st["all_stopped"]:
        print(red(bold("  ■ ALL WORK STOPPED")))
        meta = []
        if st["all_stopped_at"]: meta.append(f"since {st['all_stopped_at']}")
        if st["all_stopped_by"]: meta.append(f"by {st['all_stopped_by']}")
        if meta: print(dim("    " + " · ".join(meta)))
        if st["all_stopped_reason"]: print(dim(f"    reason: {st['all_stopped_reason']}"))
    else:
        off = [k for k in LANES if st["lanes"].get(k) is False]
        if off: print(yellow(bold(f"  ◐ RUNNING — {len(off)} lane(s) switched off")))
        else:   print(green(bold("  ● ALL WORK RUNNING")))
    print(dim(f"    switch: {SWITCH}"))
    print()
    print(bold("  LANES"))
    for key, (label, kind, unit) in LANES.items():
        enabled = st["lanes"].get(key) is not False
        stopped = st["all_stopped"] or not enabled
        mark = red("OFF ") if stopped else green("ON  ")
        note = ""
        if stopped and st["all_stopped"] and enabled: note = dim(" (via stop-all)")
        elif stopped: note = dim(" (lane off)")
        extra = ""
        if kind == "timer" and unit:
            rc, nxt = systemctl("show", unit.replace(".service", ".timer"), "-p", "NextElapseUSecRealtime", "--value")
            extra = dim(f"  next:{nxt.strip()[:16]}") if nxt.strip() and nxt.strip() != "n/a" else ""
        print(f"    {mark} {key:<16} {dim(kind):<18} {label}{note}{extra}")
    print()
    procs = worker_procs()
    print(bold("  IN FLIGHT"))
    print(f"    model workers: {red(str(len(procs))) if procs else green('0')}")
    for pid, cmd in procs[:6]:
        print(dim(f"      {pid}  {cmd[:88]}"))
    rows = db_rows("SELECT id,status,attempts,tree_id FROM hopper_nodes WHERE status IN ('running','pending') ORDER BY status,id")
    if rows is None:
        print(dim("    hopper nodes: (db unavailable)"))
    else:
        run = [r for r in rows if r[1] == "running"]; pend = [r for r in rows if r[1] == "pending"]
        print(f"    hopper nodes: {len(run)} running, {len(pend)} pending")
        for r in (run + pend)[:8]:
            flag = red(" ← retry-looping") if r[2] and r[2] >= 3 else ""
            print(dim(f"      #{r[0]} {r[1]} attempts={r[2]} {r[3]}") + flag)
    evs = st.get("events") or []
    if evs:
        print(); print(bold("  RECENT SWITCH HISTORY"))
        for e in evs[-5:]:
            line = f"    {dim(e.get('at','')[:19])}  {e.get('op','')}"
            if e.get("lane"): line += f" {e['lane']}"
            line += dim(f"  by {e.get('by','?')}")
            if e.get("reason"): line += dim(f" — {e['reason']}")
            print(line)
    print()
    return 0

def cmd_stop(argv) -> int:
    kill = "--kill" in argv
    hard = "--hard" in argv
    reason = None
    if "-r" in argv:
        i = argv.index("-r")
        if i + 1 < len(argv): reason = argv[i + 1]
    st, _ = read_state()
    st["all_stopped"] = True
    st["all_stopped_at"] = now()
    st["all_stopped_by"] = who()
    st["all_stopped_reason"] = reason
    write_state(st, who(), "stop_all", reason=reason)
    print()
    print(red(bold("  ■ ALL WORK STOPPED")) + dim("  (no settings changed — every dial is where you left it)"))
    print(dim("    · hopper / shifts / autopilot / check-ins: held at the dispatch tick"))
    print(dim("    · watchdog / reconciler / intel / bi / suppression / kpi: services will skip"))
    if hard:
        print(); print(bold("  stopping in-flight timer services")); stop_inflight_timer_services()
    if kill:
        print(); print(bold("  killing in-flight model workers")); n = kill_workers()
        print(dim(f"    {n} killed"))
    else:
        procs = worker_procs()
        if procs:
            print(); print(yellow(f"  ⚠ {len(procs)} model worker(s) still in flight — they will finish, then nothing follows."))
            print(dim("    Add --kill to end them right now."))
    print(); print(dim("  resume with:  jarvis-work resume")); print()
    return 0

def cmd_resume(argv) -> int:
    st, _ = read_state()
    st["all_stopped"] = False
    st["all_stopped_at"] = None; st["all_stopped_by"] = None; st["all_stopped_reason"] = None
    if "--all-lanes" in argv:
        for k in LANES: st["lanes"][k] = True
    write_state(st, who(), "resume_all")
    off = [k for k in LANES if st["lanes"].get(k) is False]
    print()
    if off:
        print(green(bold("  ● WORK RESUMED")) + yellow(f"  — but these lanes stay off: {', '.join(off)}"))
        print(dim("    turn them on individually, or:  jarvis-work resume --all-lanes"))
    else:
        print(green(bold("  ● ALL WORK RESUMED")))
    print(); return 0

def cmd_lane(on: bool, lanes: list[str]) -> int:
    bad = [l for l in lanes if l not in LANES]
    if bad:
        print(red(f"unknown lane(s): {', '.join(bad)}"))
        print(f"known: {', '.join(LANES)}"); return 2
    st, _ = read_state()
    for l in lanes:
        st["lanes"][l] = on
        write_state(st, who(), "lane_on" if on else "lane_off", lane=l)
    word = green("ON") if on else red("OFF")
    print(f"\n  {word}  {', '.join(lanes)}")
    if st["all_stopped"]:
        print(yellow("  ⚠ ALL WORK is still stopped globally — lane flags take effect after `resume`."))
    print(); return 0

def cmd_park_node(argv) -> int:
    if not argv or not argv[0].isdigit():
        print("usage: jarvis-work park-node <node_id>"); return 2
    nid = int(argv[0])
    try:
        import sqlite3
        con = sqlite3.connect(DB, timeout=5.0)
        cur = con.execute("SELECT id,status,attempts FROM hopper_nodes WHERE id=?", (nid,))
        row = cur.fetchone()
        if not row:
            print(red(f"node {nid} not found")); return 1
        con.execute("UPDATE hopper_nodes SET status='blocked', lease_expires_at=NULL WHERE id=?", (nid,))
        con.commit(); con.close()
        print(f"\n  {red('PARKED')} node #{nid} (was {row[1]}, attempts={row[2]}) → blocked")
        print(dim("  it will not be re-dispatched. Re-pend it by hand when you want it back.\n"))
        return 0
    except Exception as e:
        print(red(f"could not park node {nid}: {e}")); return 1

def main() -> int:
    argv = sys.argv[1:]
    if not argv or argv[0] in ("status", "st"): return cmd_status()
    cmd, rest = argv[0], argv[1:]
    if cmd in ("stop", "stop-all", "halt", "panic"): return cmd_stop(rest)
    if cmd in ("resume", "go", "start-all"):        return cmd_resume(rest)
    if cmd == "off":  return cmd_lane(False, rest) if rest else (print("usage: jarvis-work off <lane>") or 2)
    if cmd == "on":   return cmd_lane(True, rest) if rest else (print("usage: jarvis-work on <lane>") or 2)
    if cmd == "lanes":
        for k, (label, kind, unit) in LANES.items(): print(f"  {k:<16} {kind:<8} {label}  {dim(unit or '')}")
        return 0
    if cmd == "park-node": return cmd_park_node(rest)
    if cmd == "kill-workers":
        print(); n = kill_workers(); print(dim(f"  {n} killed\n")); return 0
    print(__doc__); return 2

if __name__ == "__main__":
    sys.exit(main())
