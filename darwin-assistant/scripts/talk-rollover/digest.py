#!/usr/bin/env python3
"""Alpha JARVIS global-read digest — READ ONLY.

Opens the live jarvis.db in read-only URI mode (never writes) and assembles the
cross-system picture the Alpha chat sees: every active thread + what it's doing,
goals, flight-deck workstreams, open commitments, recent decisions, daily wraps.

Run: python3 -I /home/kevin/alpha-jarvis/digest.py

TALK-SEAT ROLLOVER (goal #19): when settings-KV `talk_daily_rollover` = 'on',
a "Talk seat — carried forward" section is prepended: the open items from the
most recent day card + the last 3 day cards in full + a one-line index of older
cards. It is gated so that with the switch OFF (the default) this script's output
is byte-identical to before the rollover shipped.
"""
import sqlite3, os, datetime, sys, re, glob

# Paths default to the live locations; env overrides exist ONLY so the hermetic
# check can point at a temp DB + temp days dir. Unset env == byte-identical to
# the original script.
DB = os.environ.get("JARVIS_DB_PATH", "/home/kevin/paperclip/darwin-assistant/jarvis.db")
WRAPS = "/home/kevin/obsidian/paperclip-wiki/daily-wraps"
# Day cards written by the rollover (src/talk-rollover.ts). Kept in sync with
# the alpha-talk persona dir in agent-memory/personas.json.
TALK_DAYS_DIR = os.environ.get(
    "TALK_DAYS_DIR",
    "/home/kevin/obsidian/paperclip-wiki/agent-memory/jarvis-alpha-talk/days",
)
TALK_RECENT_CARDS = 3
TALK_SEED_MAX_CHARS = 16000

def conn():
    # read-only: the DB can never be modified by this process
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)

def cols(c, table):
    try:
        return {r[1] for r in c.execute(f"PRAGMA table_info({table})").fetchall()}
    except sqlite3.Error:
        return set()

def snippet(s, n=90):
    if not s:
        return ""
    s = " ".join(str(s).split())
    return (s[:n] + "…") if len(s) > n else s

def section(title):
    print(f"\n## {title}\n")

def get_setting(c, key, default=None):
    try:
        r = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return r[0] if r else default
    except sqlite3.Error:
        return default

def talk_rollover_on(c):
    return (get_setting(c, "talk_daily_rollover", "off") or "off").strip().lower() == "on"

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
    """The fresh-head seed: open items + last 3 day cards + index of older.
    Gated by the kill switch; returns '' (nothing printed) when OFF or empty."""
    if not talk_rollover_on(c):
        return
    try:
        cards = sorted(glob.glob(os.path.join(TALK_DAYS_DIR, "*.md")))
    except OSError:
        cards = []
    if not cards:
        return

    buf = []
    buf.append("\n## Talk seat — carried forward\n")

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

    recent = cards[-TALK_RECENT_CARDS:]
    older = cards[:-TALK_RECENT_CARDS] if len(cards) > TALK_RECENT_CARDS else []

    buf.append(f"### Recent day cards (last {len(recent)})")
    for p in recent:
        name = os.path.basename(p)
        try:
            with open(p, "r", encoding="utf-8") as f:
                body = f.read().strip()
        except OSError:
            body = "_(unreadable)_"
        buf.append(f'<day-card file="{name}">')
        buf.append(body)
        buf.append("</day-card>")
        buf.append("")

    if older:
        buf.append(f"### Older cards ({len(older)}, read on demand via the days folder)")
        buf.append(", ".join(os.path.basename(p)[:-3] for p in older))
        buf.append("")

    out = "\n".join(buf)
    if len(out) > TALK_SEED_MAX_CHARS:
        out = out[:TALK_SEED_MAX_CHARS] + "\n_(seed truncated)_\n"
    print(out)

def main():
    c = conn()
    now = datetime.datetime.now()
    print(f"# Alpha JARVIS — global digest ({now:%Y-%m-%d %H:%M} local)")

    # ---- Talk-seat carried-forward seed (goal #19 rollover; gated OFF by default) ----
    # Placed FIRST so the fresh head's most important context survives the
    # persona hook's 30k truncation (which trims from the end).
    try:
        talk_seed_section(c)
    except Exception as e:
        print(f"\n_(talk seed unavailable: {e})_\n")

    # ---- Shared Alpha Board (lanes coordinate here) ----
    # Failure-isolated: a board hiccup must never break the global digest.
    try:
        import subprocess
        bd = subprocess.run(
            ["python3", "-I", "/home/kevin/alpha-board/board.py", "digest", "--max-bytes", "6000"],
            capture_output=True, text=True, timeout=10,
        )
        if bd.returncode == 0 and bd.stdout.strip():
            print("\n" + bd.stdout.strip() + "\n")
    except Exception as e:
        print(f"\n_(alpha board unavailable: {e})_\n")

    # ---- Threads + what each is doing ----
    section("Active threads (most recent 25)")
    cc = cols(c, "conversations")
    has_title = "title" in cc
    has_pinned = "pinned" in cc
    sel = "id, external_id, status, updated_at"
    if has_title: sel += ", title"
    try:
        rows = c.execute(
            f"SELECT {sel} FROM conversations "
            f"WHERE status='active' OR status IS NULL "
            f"ORDER BY updated_at DESC LIMIT 25"
        ).fetchall()
    except sqlite3.Error as e:
        rows = []
        print(f"_(threads read failed: {e})_")
    for r in rows:
        cid, ext, status, updated = r[0], r[1], r[2], r[3]
        title = r[4] if has_title and len(r) > 4 else None
        # last non-tool turn for a human-readable sense of state
        try:
            lt = c.execute(
                "SELECT role, created_at, content FROM turns "
                "WHERE conversation_id=? AND (tool_name IS NULL OR tool_name='') "
                "ORDER BY turn_index DESC LIMIT 1", (cid,)
            ).fetchone()
        except sqlite3.Error:
            lt = None
        label = title or ext
        if lt:
            print(f"- **{label}** · {ext} · last: {lt[0]} @ {lt[1]} — {snippet(lt[2])}")
        else:
            print(f"- **{label}** · {ext} · updated {updated}")

    # ---- Goals ----
    section("Goals")
    gc = cols(c, "goals")
    if gc:
        try:
            gs = c.execute(
                "SELECT id, title, status, done_means FROM goals "
                "WHERE archived IS NULL OR archived=0 ORDER BY id"
            ).fetchall()
        except sqlite3.Error:
            gs = c.execute("SELECT id, title, status, done_means FROM goals ORDER BY id").fetchall()
        for gid, title, status, dm in gs:
            try:
                ncounts = c.execute(
                    "SELECT state, COUNT(*) FROM goal_nodes WHERE goal_id=? GROUP BY state", (gid,)
                ).fetchall()
                nsum = ", ".join(f"{st}:{n}" for st, n in ncounts) or "no nodes"
            except sqlite3.Error:
                nsum = "?"
            print(f"- #{gid} **{title}** [{status}] — {nsum}")
    else:
        print("_(no goals table)_")

    # ---- Workstreams (Flight Deck) ----
    section("Flight Deck — balls in the air")
    wc = cols(c, "workstreams")
    if wc:
        try:
            ws = c.execute(
                "SELECT id, title, turn, next_action, next_owner FROM workstreams "
                "WHERE archived IS NULL OR archived=0 ORDER BY id DESC LIMIT 40"
            ).fetchall()
        except sqlite3.Error as e:
            ws = []
            print(f"_(workstreams read failed: {e})_")
        for wid, title, turn, na, owner in ws:
            print(f"- #{wid} **{title}** · turn={turn} · next: {snippet(na,70)}" + (f" ({owner})" if owner else ""))
    else:
        print("_(no workstreams table)_")

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
    section("Recent decisions (10)")
    dc = cols(c, "jarvis_decisions")
    if dc:
        try:
            ds = c.execute(
                "SELECT created_at, decided_by, decision FROM jarvis_decisions "
                "ORDER BY id DESC LIMIT 10"
            ).fetchall()
            for created, by, dec in ds:
                print(f"- {created} [{by}] {snippet(dec,90)}")
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
    main()
