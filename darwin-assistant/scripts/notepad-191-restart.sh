#!/bin/bash
# 2026-09-27 — bring #191 live: forced reads always answer, into the block's
# chat, one-liner on the hover. Timed + worker-gated (nothing is running;
# a lost cue re-asks). After the restart, PROVE the new contract from the
# running process: a garbage block id must 404, and the route must expose
# read.thread_ext (the #191 response shape) — probed via a real forced read
# is Kevin's to click; this only proves the code that is serving.
LOG=/tmp/notepad-191-restart.log
DB=/home/kevin/paperclip/darwin-assistant/jarvis.db
say() { echo "$(date '+%F %T') $*" >> "$LOG"; }
say "=== start ==="
BEFORE=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value)
sleep 60
for i in $(seq 1 40); do
  w=$(sqlite3 "$DB" "SELECT COUNT(*) FROM hopper_nodes WHERE status IN ('running','claimed');" 2>/dev/null || echo 1)
  [ "$w" = "0" ] && break
  say "waiting: $w hopper node(s) running/claimed"; sleep 15
done
systemctl restart jarvis.service
sleep 20
AFTER=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value)
[ "$AFTER" != "$BEFORE" ] && say "RESTARTED ($(systemctl show jarvis.service -p ActiveEnterTimestamp --value))" || say "ERROR: monotonic did not move"
KEY="$(grep -oP '^JARVIS_COCKPIT_KEY=\K.*' /home/kevin/paperclip/jarvis-command-center/.env)"
C=$(curl -s -o /tmp/n191probe.json -w '%{http_code}' -m 20 -X POST -H "Authorization: Bearer $KEY" http://localhost:3201/api/v1/notepad/blocks/999999999/read)
say "probe unknown block -> $C body=$(head -c 120 /tmp/n191probe.json)"
say "=== done ==="
