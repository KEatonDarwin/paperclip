#!/usr/bin/env python3
"""Alpha JARVIS global-read digest — READ ONLY.

Opens the live jarvis.db in read-only URI mode (never writes) and assembles the
cross-system picture the Alpha chat sees: every active thread + what it's doing,
goals, flight-deck workstreams, open commitments, recent decisions, daily wraps.

Run: python3 -I /home/kevin/alpha-jarvis/digest.py
"""
import sqlite3, os, datetime, sys
import re, glob

DB = "/home/kevin/paperclip/darwin-assistant/jarvis.db"
WRAPS = "/home/kevin/obsidian/paperclip-wiki/daily-wraps"
# Day cards written by the rollover (src/talk-rollover.ts), in the alpha-talk
# persona dir (agent-memory/personas.json). Seed is gated by talk_daily_rollover.
TALK_DAYS_DIR = "/home/kevin/obsidian/paperclip-wiki/agent-memory/jarvis-alpha-talk/days"
TALK_SEED_MAX_CHARS = 3000   # SMALL seed: open items + card index + pointer, never full cards

def conn():
    # read-only: the DB can never be modified by this process
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)

def cols(c, table):
    try:
        return {r[1] for r in c.execute(f"PRAGMA table_info({table})").fetchall()}
    except sqlite3.Error:
        return set()

EXCLUDED_THREAD_PREFIXES = (
    "cockpit:hopper-", "cockpit:unblocker-", "cockpit:shift-", "cockpit:workstream-", "cockpit:spawn-",
    "cockpit:alpha-lane-", "cockpit:alpha-", "cockpit:goal-", "cockpit:notepad-line-", "cockpit:jobhunt-",
    "ephemeral:", "checkin", "slack:",
)
HARD_CAP_BYTES = 9500   # whole-digest ceiling; measured before/after in outbox/seat-diet/

def _is_test_goal(title):
    t = (title or "").lower()
    return "staydesk" in t or "dryrun" in t or "dry-run" in t or "dry run" in t

def snippet(s, n=90):
    if not s:
        return ""
    s = " ".join(str(s).split())
    return (s[:n] + "…") if len(s) > n else s

def section(title):
    print(f"\n## {title}\n")

# ── talk-seat carried-forward seed (goal #19; gated OFF by default) ─────

def get_setting(c, key, default=None):
    try:
        r = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return r[0] if r else default
    except sqlite3.Error:
        return default

def talk_rollover_on(c):
    return (get_setting(c, "talk_daily_rollover", "off") or "off").strip().lower() == "on"

_CARD_RE = re.compile(r"(\d{4}-\d{2}-\d{2})(?:-part(\d+))?\.md$")
def _card_sort_key(p):
    """Chronological key for a card path: (date, part). A bare YYYY-MM-DD.md is
    part 1; -partN is part N. A plain lexical sort would put the bare date AFTER
    its parts and part10 before part2 — wrong for the 'last card'."""
    m = _CARD_RE.search(os.path.basename(p))
    if not m:
        return (os.path.basename(p), 0)
    return (m.group(1), int(m.group(2)) if m.group(2) else 1)

def _extract_section(card_text, heading):
    """Pull the bullet lines under a '## <heading>' section of a day card."""
    out = []
    grabbing = False
    for line in card_text.splitlines():
        if line.strip().lower().startswith("## "):
            grabbing = line.strip()[3:].strip().lower() == heading.lower()
            continue
        if grabbing and line.strip():
            out.append(line.rstrip())
    return out

def talk_seed_section(c):
    """The fresh-head seed: last card's open items + a one-line index of every
    card + a pointer to the days folder. Gated by the kill switch; prints nothing
    (output byte-identical to before) when OFF or when there are no cards."""
    if not talk_rollover_on(c):
        return
    try:
        cards = sorted(glob.glob(os.path.join(TALK_DAYS_DIR, "*.md")), key=_card_sort_key)
    except OSError:
        cards = []
    if not cards:
        return

    buf = ["\n## Talk seat — carried forward\n"]

    # Open items = the "Still open" bullets from the most recent card.
    try:
        with open(cards[-1], "r", encoding="utf-8") as f:
            latest_text = f.read()
    except OSError:
        latest_text = ""
    open_items = _extract_section(latest_text, "Still open")
    if open_items:
        buf.append("### Open items (from the last card)")
        buf.extend(open_items)
        buf.append("")

    # One-line index of EVERY card (dates only — not the bodies) + a pointer.
    names = [os.path.basename(p)[:-3] for p in cards]
    buf.append(f"### Day-card index ({len(names)}, newest last)")
    buf.append(", ".join(names))
    buf.append("")
    buf.append(f"_Read any card in full: {TALK_DAYS_DIR}/<date>.md (also via find_chats / read_chat)._")

    out = "\n".join(buf)
    if len(out) > TALK_SEED_MAX_CHARS:
        out = out[:TALK_SEED_MAX_CHARS] + "\n_(seed truncated)_\n"
    print(out)

def main():
    c = conn()
    now = datetime.datetime.now()
    print(f"# Alpha JARVIS — global digest ({now:%Y-%m-%d %H:%M} local)")

    # ---- Talk-seat carried-forward seed (goal #19 rollover; gated OFF by default) ----
    # Placed FIRST so the fresh head's most important context survives the hard cap
    # below (which trims from the end). Prints NOTHING when the switch is OFF, so this
    # script's output is byte-identical to the pre-seed digest until Kevin flips it on.
    talk_seed_section(c)

    # ---- Shared Alpha Board (lanes coordinate here) ----
    # Failure-isolated: a board hiccup must never break the global digest.
    try:
        import subprocess
        bd = subprocess.run(
            ["python3", "-I", "/home/kevin/alpha-board/board.py", "digest", "--max-bytes", "6200"],
            capture_output=True, text=True, timeout=10,
        )
        if bd.returncode == 0 and bd.stdout.strip():
            print("\n" + bd.stdout.strip() + "\n")
    except Exception as e:
        print(f"\n_(alpha board unavailable: {e})_\n")

    # ---- Threads (live-or-relevant only, 2026-11-06 diet) ----
    # Excluded: workers/ephemerals, spawned children + alpha lanes (they live on the board), goal
    # threads (they live under Goals), check-ins, and the PRIVATE job-hunt lane (never in a shared digest).
    section("Active human threads (most recent 8, titled, last 3d)")
    cc = cols(c, "conversations")
    has_title = "title" in cc
    sel = "id, external_id, status, updated_at"
    if has_title: sel += ", title"
    try:
        rows = c.execute(
            f"SELECT {sel} FROM conversations "
            f"WHERE (status='active' OR status IS NULL) "
            f"AND updated_at >= datetime('now','-3 days') AND title IS NOT NULL AND title != '' "
            + "".join(f"AND external_id NOT LIKE '{pre}%' " for pre in EXCLUDED_THREAD_PREFIXES) +
            "ORDER BY updated_at DESC LIMIT 8"
        ).fetchall()
    except sqlite3.Error as e:
        rows = []
        print(f"_(threads read failed: {e})_")
    for r in rows:
        cid, ext, status, updated = r[0], r[1], r[2], r[3]
        title = r[4] if has_title and len(r) > 4 else None
        try:
            lt = c.execute(
                "SELECT role, created_at, content FROM turns "
                "WHERE conversation_id=? AND (tool_name IS NULL OR tool_name='') "
                "ORDER BY turn_index DESC LIMIT 1", (cid,)
            ).fetchone()
        except sqlite3.Error:
            lt = None
        label = snippet(title or ext, 60)
        if lt:
            print(f"- **{label}** · {ext} · {lt[0]} @ {lt[1][5:16]} — {snippet(lt[2], 70)}")
        else:
            print(f"- **{label}** · {ext} · updated {updated}")

    # ---- Goals (live-or-relevant only) ----
    section("Goals")
    gc = cols(c, "goals")
    if gc:
        try:
            gs = c.execute(
                "SELECT g.id, g.title, g.status, "
                " (SELECT MAX(x) FROM (SELECT g.updated_at x UNION ALL SELECT MAX(updated_at) FROM goal_nodes WHERE goal_id=g.id "
                "   UNION ALL SELECT MAX(created_at) FROM goal_events WHERE goal_id=g.id)) act "
                "FROM goals g WHERE (g.archived IS NULL OR g.archived=0) ORDER BY g.id"
            ).fetchall()
        except sqlite3.Error:
            gs = []
        fresh, carry, hidden_test, hidden_old = [], [], 0, 0
        now_utc = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
        for gid, title, status, act in gs:
            if _is_test_goal(title):
                hidden_test += 1
                continue
            try:
                age = (now_utc - datetime.datetime.strptime((act or "")[:19], "%Y-%m-%d %H:%M:%S")).total_seconds() / 86400
            except ValueError:
                age = 999
            if age <= 8:
                fresh.append((gid, title, status))
            elif age <= 21:
                carry.append((gid, title, age))   # residual memory: ages out after ~3 weeks
            else:
                hidden_old += 1
        for gid, title, status in fresh:
            try:
                ncounts = c.execute("SELECT state, COUNT(*) FROM goal_nodes WHERE goal_id=? GROUP BY state", (gid,)).fetchall()
                nsum = ", ".join(f"{st}:{n}" for st, n in ncounts) or "no nodes"
            except sqlite3.Error:
                nsum = "?"
            print(f"- #{gid} **{snippet(title, 90)}** [{status}] — {nsum}")
        if carry:
            print("- _carry-over (touched 8–21d ago):_ " + "; ".join(f"#{g} {snippet(t, 45)} ({a:.0f}d)" for g, t, a in carry[:6]))
        print(f"- _not shown: {hidden_test} StayDesk/DRYRUN test goals, {hidden_old} goals idle >21d. Full list: /goals_")
    else:
        print("_(no goals table)_")

    # ---- Flight Deck (shelved 2026-11-06 — Kevin: not used; no live reader besides its own page + tool) ----
    wc = cols(c, "workstreams")
    if wc:
        try:
            n_ws = c.execute("SELECT COUNT(*) FROM workstreams WHERE (archived IS NULL OR archived=0) AND turn NOT IN ('done')").fetchone()[0]
            print(f"\n_Flight Deck: shelved, {n_ws} open items not shown (workstreams tool / Flight Deck page still work)._")
        except sqlite3.Error:
            pass

    # ---- Commitments ----
    section("Open commitments")
    mc = cols(c, "watch_commitments")
    if mc:
        try:
            ms = c.execute(
                "SELECT subject, status, due_at, thread_ext FROM watch_commitments "
                "WHERE status IN ('open','pending','active') "
                "ORDER BY due_at DESC LIMIT 20"
            ).fetchall()
            for subj, status, due, ext in ms:
                print(f"- [{status}] {snippet(subj,80)} · due {due}")
            if not ms:
                print("_(none open)_")
        except sqlite3.Error as e:
            print(f"_(commitments read failed: {e})_")
    else:
        print("_(no watch_commitments table)_")

    # ---- Recent decisions ----
    section("Recent JARVIS decisions (7d, max 5)")
    dc = cols(c, "jarvis_decisions")
    if dc:
        try:
            ds = c.execute(
                "SELECT created_at, decided_by, decision FROM jarvis_decisions "
                "WHERE created_at >= datetime('now','-7 days') ORDER BY id DESC LIMIT 5"
            ).fetchall()
            for created, by, dec in ds:
                print(f"- {created[5:16]} [{by}] {snippet(dec,80)}")
        except sqlite3.Error as e:
            print(f"_(decisions read failed: {e})_")
    else:
        print("_(no jarvis_decisions table)_")

    # ---- Daily wraps ----
    section("Daily wraps")
    today = f"{now:%Y-%m-%d}"
    yest = f"{(now - datetime.timedelta(days=1)):%Y-%m-%d}"
    for d in (today, yest):
        p = os.path.join(WRAPS, f"{d}.md")
        print(f"- {d}: {'present' if os.path.exists(p) else 'missing'}")

    c.close()

if __name__ == "__main__":
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        main()
    out = buf.getvalue()
    if len(out.encode()) > HARD_CAP_BYTES:   # hard budget: cut at a line boundary, say so
        cut = out.encode()[: HARD_CAP_BYTES - 60].decode(errors="ignore")
        out = cut[: cut.rfind("\n")] + f"\n_(digest capped at {HARD_CAP_BYTES} bytes)_\n"
    sys.stdout.write(out)
