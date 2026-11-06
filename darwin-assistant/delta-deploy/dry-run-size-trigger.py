#!/usr/bin/env python3
"""Talk-seat rollover — READ-ONLY dry run (NOT a test; makes no model calls,
writes nothing). Prints the live alpha-talk per-step context size, the size
threshold, the gating state (kill switch / queued-or-steered messages), and a
single WOULD ROLL / WOULD NOT ROLL verdict with the reason.

It mirrors the real worker's size gate (src/talk-rollover.ts): replayed context
= input_tokens + cache_read_tokens + cache_write_tokens of the most recent
assistant turn; threshold = settings-KV talk_rollover_size_tokens (fallback to
legacy talk_rollover_midday_token_cap), default 180000. The live roll ALSO
requires no turn in flight (isConversationActive — an in-process runtime check
this static script cannot observe) AND an empty message queue/steer inbox (the
persistent part, which this script DOES check, fail-closed).

Run: python3 -I dry-run-size-trigger.py
"""
import sqlite3, os, glob

DB = "/home/kevin/paperclip/darwin-assistant/jarvis.db"
# steer-inbox.ts: ROOT = $JARVIS_STEER_ROOT ?? ~/.jarvis/steer ; steerDir = ROOT/<conversationId>
STEER_ROOT = os.environ.get("JARVIS_STEER_ROOT") or os.path.expanduser("~/.jarvis/steer")
SEAT = "cockpit:alpha-talk"
DEFAULT_SIZE = 180_000


def ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def get_setting(c, key):
    try:
        r = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return r[0] if r and r[0] is not None and str(r[0]).strip() != "" else None
    except sqlite3.Error:
        return None


def main():
    c = ro(DB)

    row = c.execute("SELECT id FROM conversations WHERE external_id=?", (SEAT,)).fetchone()
    if not row:
        print(f"seat {SEAT} not found — WOULD NOT ROLL (no conversation)")
        return
    cid = row[0]

    # replayed context of the most recent token-bearing assistant turn
    t = c.execute(
        "SELECT turn_index, COALESCE(input_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0) "
        "FROM turns WHERE conversation_id=? AND role='assistant' "
        "AND (input_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL) "
        "ORDER BY turn_index DESC LIMIT 1",
        (cid,),
    ).fetchone()
    replayed = t[1] if t else 0
    last_turn = t[0] if t else None

    # threshold
    raw = get_setting(c, "talk_rollover_size_tokens") or get_setting(c, "talk_rollover_midday_token_cap")
    try:
        threshold = int(raw) if raw else DEFAULT_SIZE
    except ValueError:
        threshold = DEFAULT_SIZE

    # kill switch
    enabled = (get_setting(c, "talk_daily_rollover") or "off").strip().lower() == "on"

    # queued messages (non-expired) — fail-closed on error
    try:
        qrows = c.execute(
            "SELECT expires_at FROM thread_message_queue WHERE conversation_id=?", (cid,)
        ).fetchall()
        import datetime
        now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
        def expired(e):
            if not e:
                return False
            try:
                return datetime.datetime.strptime(str(e)[:19], "%Y-%m-%d %H:%M:%S") <= now
            except ValueError:
                return False
        queued = sum(1 for (e,) in qrows if not expired(e))
    except sqlite3.Error:
        queued = -1  # unknown -> treat as pending

    # steer files on disk (pending/claimed) — best-effort
    steer_pending = 0
    d = os.path.join(STEER_ROOT, str(cid))
    try:
        if os.path.isdir(d):
            steer_pending += sum(1 for f in os.listdir(d) if f.endswith((".pending.json", ".claimed.json")))
    except OSError:
        steer_pending += 1

    size_ok = replayed >= threshold
    queue_clear = (queued == 0) and (steer_pending == 0)

    print(f"seat                : {SEAT} (conversation id {cid})")
    print(f"last assistant turn : #{last_turn}")
    print(f"replayed context    : {replayed:,} tokens")
    print(f"size threshold      : {threshold:,} tokens  (settings-KV talk_rollover_size_tokens, default {DEFAULT_SIZE:,})")
    print(f"kill switch         : talk_daily_rollover = {'ON' if enabled else 'off'}")
    print(f"queued messages     : {queued} (non-expired)")
    print(f"steer pending/claim : {steer_pending}")

    reasons = []
    if not enabled:
        reasons.append("kill switch talk_daily_rollover is OFF")
    if not size_ok:
        reasons.append(f"context {replayed:,} < threshold {threshold:,}")
    if not queue_clear:
        reasons.append(f"a message is queued/steered (queued={queued}, steer={steer_pending})")

    if not reasons:
        print(f"VERDICT             : WOULD ROLL (context {replayed:,} >= {threshold:,}, switch ON, queue empty; "
              f"runtime also requires no turn in flight)")
    else:
        print(f"VERDICT             : WOULD NOT ROLL because " + "; ".join(reasons))
        # If the ONLY blocker is the kill switch, say what happens the moment it flips.
        if reasons == ["kill switch talk_daily_rollover is OFF"] and size_ok and queue_clear:
            print(f"                      (if the switch were ON: WOULD ROLL now — context "
                  f"{replayed:,} >= {threshold:,}, queue empty)")

    c.close()


if __name__ == "__main__":
    main()
