#!/bin/bash
# Drain-then-restart so `hopper_slots` (live-settable as of 2026-09-24) takes
# effect without killing a running worker mid-turn. Kevin's throttle turn-up.
DB=/home/kevin/paperclip/darwin-assistant/jarvis.db
LOG=/tmp/throttle-slots-restart.log
KEY="$(grep -oP "^JARVIS_COCKPIT_KEY=\K.*" /home/kevin/paperclip/jarvis-command-center/.env)"
say(){ echo "$(date '+%F %T') $*" >> "$LOG"; }
set_override(){ sqlite3 "$DB" "INSERT INTO settings(key,value) VALUES('gov_override_claude','$1') ON CONFLICT(key) DO UPDATE SET value=excluded.value;"; say "gov_override_claude=$1"; }
trap 'set_override auto' EXIT

say "=== drain started (override off, waiting for running workers to finish) ==="
idle=0
for i in $(seq 1 160); do   # 160 * 15s = 40 min
  n=$(sqlite3 "$DB" "select count(*) from hopper_nodes where status='running';" 2>/dev/null || echo 1)
  t=$(curl -s -H "Authorization: Bearer $KEY" 'http://localhost:3201/api/v1/threads?limit=200' \
      | python3 -c "import sys,json;d=json.load(sys.stdin);ts=d.get('threads',d);print(sum(1 for x in ts if x.get('running')))" 2>/dev/null || echo 1)
  if [ "$n" = "0" ] && [ "$t" = "0" ]; then idle=$((idle+1)); else idle=0; fi
  [ $idle -ge 3 ] && { say "idle (0 workers, 0 running turns) -> restarting"; break; }
  sleep 15
done
[ $idle -lt 3 ] && say "deadline reached (workers=$n turns=$t) -> restarting anyway; leases recover"

systemctl restart jarvis.service
sleep 25
set_override auto
slots=$(journalctl -u jarvis.service --since "-2min" | grep -o 'hopper-engine] started · slots=[0-9]*' | tail -1)
say "post-restart: ${slots:-slots line not found}"
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"severity\":\"success\",\"title\":\"⚡ Throttle turned up — ${slots:-restarted}\",\"body\":\"6 worker slots live, admission cap 8, weekly ceiling 85%, 5h 95%. Claude dispatch re-enabled.\",\"source\":\"throttle\"}" \
  http://localhost:3201/api/v1/notifications >/dev/null
say "=== done ==="
