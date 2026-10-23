#!/bin/bash
# 2026-09-26 — bring the tree-budget OFF SWITCH + self-clearing budget park live.
#
# Kevin: "no, not in the morning. Now." The new gate is committed (ec5f82724) and
# built into dist/, but jarvis.service is still running the pre-commit build, so
# the switch does not exist in the live process yet. Tonight's three goal-6 trees
# will push the rolling 24h count from 6 back over the cap of 8, and on the OLD
# code that park is sticky-manual again — exactly the thing being fixed. So this
# restarts now rather than at the next natural idle window.
#
# Timed, not idle-gated, on purpose: the only thing in flight is the goal-6
# autopilot's first plan cue, and a lost plan cue is RE-ASKED by the driver on the
# next tick (no attempt consumed, no worker killed). Waiting for worker-idle
# instead would mean waiting hours, past the point the gate fires again.
#
# Run as a systemd transient unit, NEVER nohup (2026-09-20 lesson).
LOG=/tmp/tree-budget-switch-restart.log
DB=/home/kevin/paperclip/darwin-assistant/jarvis.db
say() { echo "$(date '+%F %T') $*" >> "$LOG"; }
say "=== start ==="

BEFORE=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value)
say "baseline monotonic=$BEFORE"

# Let the turn that armed this finish writing its reply.
sleep 75

# Never restart on top of a RUNNING hopper worker — that burns an attempt.
for i in $(seq 1 40); do
  w=$(sqlite3 "$DB" "SELECT COUNT(*) FROM hopper_nodes WHERE status IN ('running','claimed');" 2>/dev/null || echo 1)
  if [ "$w" = "0" ]; then break; fi
  say "waiting: $w hopper node(s) running/claimed"
  sleep 15
done

say "restarting jarvis.service"
systemctl restart jarvis.service
sleep 20

for i in $(seq 1 20); do
  AFTER=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value)
  if [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ]; then
    say "RESTARTED — monotonic $BEFORE -> $AFTER ($(systemctl show jarvis.service -p ActiveEnterTimestamp --value))"
    break
  fi
  sleep 5
done

# PROVE the new code is the code that is running, not just that a restart happened.
H=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3201/health)
say "health=$H"
say "autopilot goal 6: $(sqlite3 "$DB" "SELECT autopilot || ' parallel=' || json_extract(autopilot_config,'\$.parallel') FROM goals WHERE id=6;")"
say "parked goal-6 nodes: $(sqlite3 "$DB" "SELECT group_concat(id) FROM goal_nodes WHERE goal_id=6 AND state='parked';")"
say "=== done ==="
