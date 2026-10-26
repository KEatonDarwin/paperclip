#!/usr/bin/env python3
"""Hermetic check for the digest.py talk-seat seed section (deliverable #4).

Builds a throwaway sqlite DB (settings table only) + a temp days dir of cards,
then runs digest.py under its env overrides (JARVIS_DB_PATH / TALK_DAYS_DIR) and
asserts the seed is correctly gated and correctly assembled. Mutation-proves that
the open-items line is re-read from the latest card, not fabricated.

Run: python3 -I scripts/talk-rollover/digest-check.py
"""
import os, sys, sqlite3, tempfile, subprocess, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
DIGEST = os.path.join(HERE, "digest.py")

passed = 0
failed = 0
def ok(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1; print(f"  ✓ {name}")
    else:
        failed += 1; print(f"  ✗ {name}" + (f" — {detail}" if detail else ""))

def make_db(path, switch):
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))")
    if switch is not None:
        c.execute("INSERT INTO settings (key, value) VALUES ('talk_daily_rollover', ?)", (switch,))
    c.commit(); c.close()

def run_digest(db, days):
    env = dict(os.environ)
    env["JARVIS_DB_PATH"] = db
    env["TALK_DAYS_DIR"] = days
    # -I to match the production persona hook (proves env is still honored under isolation)
    r = subprocess.run([sys.executable, "-I", DIGEST], capture_output=True, text=True, env=env, timeout=30)
    return r.stdout

def main():
    tmp = tempfile.mkdtemp(prefix="talk-digest-check-")
    try:
        days = os.path.join(tmp, "days")
        os.makedirs(days)
        for i, d in enumerate(["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]):
            if i == 3:
                body = "# \U0001F4C5 day\n\n## Done\n- CARD%d\n\n## Still open\n- finish the audit\n- ANCHOR_OPEN_ITEM\n" % i
            else:
                body = "# \U0001F4C5 day\n\n## Done\n- CARD%d\n" % i
            with open(os.path.join(days, d + ".md"), "w", encoding="utf-8") as f:
                f.write(body)

        # OFF (switch absent)
        db_off = os.path.join(tmp, "off.db"); make_db(db_off, None)
        out_off = run_digest(db_off, days)
        ok("OFF: no seed section when switch absent", "Talk seat — carried forward" not in out_off)
        ok("OFF: still prints the digest header", "Alpha JARVIS — global digest" in out_off)

        # explicit off
        db_off2 = os.path.join(tmp, "off2.db"); make_db(db_off2, "off")
        ok("OFF: explicit 'off' also suppresses seed", "Talk seat" not in run_digest(db_off2, days))

        # ON
        db_on = os.path.join(tmp, "on.db"); make_db(db_on, "on")
        out = run_digest(db_on, days)
        ok("ON: seed section present", "Talk seat — carried forward" in out)
        ok("ON: open items pulled from last card's '## Still open'", "ANCHOR_OPEN_ITEM" in out and "finish the audit" in out)
        ok("ON: last 3 cards embedded in full", all(m in out for m in ["CARD1", "CARD2", "CARD3"]))
        ok("ON: oldest card is indexed, not embedded", '<day-card file="2026-10-21' not in out)
        ok("ON: older index names the oldest card", "Older cards (1" in out and "2026-10-21" in out)

        # mutation: change the latest card's open items -> must re-appear (file re-read, not cached)
        with open(os.path.join(days, "2026-10-24.md"), "w", encoding="utf-8") as f:
            f.write("# \U0001F4C5 day\n\n## Done\n- CARD3\n\n## Still open\n- MUTATED_OPEN_ITEM\n")
        out2 = run_digest(db_on, days)
        ok("MUT: mutated open item appears", "MUTATED_OPEN_ITEM" in out2)
        ok("MUT: stale open item gone", "ANCHOR_OPEN_ITEM" not in out2)

        print(f"\n{passed} passed, {failed} failed")
        if failed:
            sys.exit(1)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":
    main()
