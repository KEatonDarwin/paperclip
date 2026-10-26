# Talk-seat daily rollover (goal #19)

Keeps `cockpit:alpha-talk` as ONE chat but stops it re-reading its whole history
every step. At ~04:00 CT (and as a mid-day safety net) a Claude-B one-shot distils
the day's turns into a **day card**, posts a visible divider, and clears the
session pointer so the next message starts a fresh CLI session — seeded by the
persona digest with the recent cards. Plan: `outbox/talk-daily-rollover/PLAN.md`.

## What's on this branch (`talk/daily-rollover`)

- **`src/talk-rollover.ts`** — the whole feature: day-card writer (B one-shot,
  `CLAUDE_CONFIG_DIR` pinned to account B), the `bump`-role divider card (never a
  user turn, never wakes the seat), the session-pointer clear (same mechanism as
  `conversation-db.ts:348` — only ever NULLs the pointer, never deletes a turn),
  the 04:00 CT worker + the ~400k-token mid-day safety net, and the kill switch.
- **`src/index.ts`** — 7-line wiring: `startTalkRolloverWorker()` next to the
  other boot workers. (This file was byte-identical to the live working tree at
  build time, so the delta applies cleanly.)
- **`scripts/talk-rollover/digest.py`** — the patched persona digest. Additions
  ONLY vs the live `/home/kevin/alpha-jarvis/digest.py`: a "Talk seat — carried
  forward" seed (last card's open items + the last 3 cards in full + an index of
  older), gated by the kill switch so **with the switch OFF it is byte-identical**.
- **`scripts/talk-rollover-check.ts`** — 45 hermetic assertions (sqlite `:memory`/
  temp, no real model) incl. fail-closed on a thrown/empty writer, idempotence,
  the in-flight skip, bump-not-a-message, and mutation proofs that the on-disk
  card actually changed.
- **`scripts/talk-rollover/digest-check.py`** — 10 hermetic assertions for the
  seed: gated OFF by default, assembled correctly ON, mutation-proven.
- **`scripts/talk-rollover/proof.ts`** — the non-hermetic end-to-end proof (2 real
  B calls, isolated temp DB + `cockpit:alpha-talk-rollover-test`).

## Proof (already run)

- `npm run talk-rollover:check` → **45 passed, 0 failed**
- `npm run talk-rollover:digest-check` → **10 passed, 0 failed**
- `npx tsx scripts/talk-rollover/proof.ts` → **recall 10/10** (pass ≥9), tokens per
  step **1,520,012 → 86,205 (94% smaller)**, session cleared, divider posted.

## Kill switch

Settings-KV **`talk_daily_rollover`** = `on` | `off`. Anything other than `on`
(including absent) = OFF. Ships OFF. With it off the worker only holds timers and
does nothing, and the digest is byte-identical to today.

Mid-day cap is tunable without a redeploy: `talk_rollover_midday_token_cap`
(default 400000).

## Deploy (Kevin — this never deploys itself)

All against the LIVE untrusted working tree at `/home/kevin/paperclip/darwin-assistant`.
Nothing here merges to master or restarts the service for you.

```
WT=/home/kevin/paperclip-worktrees/talk-daily-rollover/darwin-assistant
LIVE=/home/kevin/paperclip/darwin-assistant

# 1. new module + test scripts (new files — safe copies)
cp "$WT/src/talk-rollover.ts" "$LIVE/src/talk-rollover.ts"
cp "$WT/scripts/talk-rollover-check.ts" "$LIVE/scripts/talk-rollover-check.ts"
mkdir -p "$LIVE/scripts/talk-rollover"
cp "$WT/scripts/talk-rollover/"*.py "$LIVE/scripts/talk-rollover/"
cp "$WT/scripts/talk-rollover/README.md" "$LIVE/scripts/talk-rollover/README.md"

# 2. the 7-line index.ts wiring. The branch index.ts was byte-identical to live
#    at build time, so a straight copy is exact. (If live has moved, apply the
#    2 inserts shown by: git -C "$WT/.." diff -- darwin-assistant/src/index.ts)
cp "$WT/src/index.ts" "$LIVE/src/index.ts"

# 3. the patched persona digest (additions-only; verify with a diff first)
diff "$LIVE/../../alpha-jarvis/digest.py" "$WT/scripts/talk-rollover/digest.py"  # review: additions only
cp "$WT/scripts/talk-rollover/digest.py" /home/kevin/alpha-jarvis/digest.py

# 4. build (tsc emits on error — a clean exit is the gate)
cd "$LIVE" && npm run build

# 5. restart the service via a transient unit (survives this shell, self-verifies)
sudo systemd-run --unit=jarvis-restart-$(date +%s) --on-active=3 systemctl restart jarvis.service

# 6. re-run the proof against the restarted build if you want belt-and-braces:
#    JARVIS_DB_PATH=/tmp/tr.db npx tsx scripts/talk-rollover/proof.ts
```

## Flip it ON (after you're happy)

```
sqlite3 /home/kevin/paperclip/darwin-assistant/jarvis.db \
  "INSERT INTO settings (key,value,updated_at) VALUES ('talk_daily_rollover','on',datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value='on', updated_at=datetime('now');"
```

Takes effect on the next message / the next 04:00 CT run — no restart needed to
flip the switch.

## Turn it OFF (instant rollback of behaviour)

```
sqlite3 /home/kevin/paperclip/darwin-assistant/jarvis.db \
  "UPDATE settings SET value='off', updated_at=datetime('now') WHERE key='talk_daily_rollover';"
```

That restores today's behaviour (one growing session, no cards, digest byte-identical).
Your standing rollback order (`memory_dedupe=off`, `claude_autocompact_tokens=0`)
is untouched and still applies.

## Notes

- Day cards live in `agent-memory/jarvis-alpha-talk/days/YYYY-MM-DD.md` (same
  persona dir). A mid-day re-roll the same date becomes `…-partN.md` — no card is
  ever overwritten.
- Order is fail-closed: write the card file → post the divider → ONLY THEN clear
  the session. A writer failure leaves the session intact (no stranded seat).
- The divider uses the existing `bump` role, so it shows as a distinct card and is
  never counted as a message or replayed to the fresh head.

## Known limits (reviewed, accepted by design)

A two-pass codex review ran; the real correctness/safety findings are fixed
(concurrency lock, re-check-before-clear + the start-and-finish race, window-end
marker, atomic clear+marker, chronological card sort, card-heading validation,
worker error boundaries, prompt tail-truncation + per-turn cap, morning retry on
any transient reason, proof DB guard). These were weighed and left as-is:

- **Mid-day token measure is a heuristic**, not precise per-session accounting
  (the turns table doesn't tag sessions). It only decides WHEN to cut a fresh
  head; the "no new turns" marker guard means an early/late/stale read is a
  harmless no-op, never a double-roll. Tunable via `talk_rollover_midday_token_cap`.
- **04:00 scheduling can be ±1h at the two DST transitions a year** — the same
  approximation the existing 8am briefing cron uses (reused deliberately). Fine
  for a "roughly 04:00" housekeeping job; the idle-retry loop absorbs it.
- **The card is a lossy summary.** On a marathon day whose new conversation text
  exceeds the prompt budget, the oldest turns are dropped from the card (the full
  transcript still exists and is reachable via `find_chats`/`read_chat`). The
  mid-day net keeps days from getting that large in the first place.
- **Card validation is structural** (must have a `## ` heading) — it catches the
  realistic failure (a CLI error string authorizing a clear), not a
  well-formed-but-wrong card, which can't be judged without another model call.
