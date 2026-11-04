#!/bin/bash
# 2026-09-27 — bring #188's block-action routes (/read /chat /done) + the
# action_ref COALESCE fix live. Kevin asked where the feature was; the cockpit
# UI is already deployed (release 20260927-074839-57645fd) and its menu calls
# these routes, so the backend restart should not wait for an idle window.
# Timed + worker-gated, same pattern as tree-budget-switch-restart.sh.
LOG=/tmp/notepad-188-restart.log
DB=/home/kevin/paperclip/darwin-assistant/jarvis.db
say() { echo "$(date '+%F %T') $*" >> "$LOG"; }
say "=== start ==="
BEFORE=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value)
sleep 75
for i in $(seq 1 40); do
  w=$(sqlite3 "$DB" "SELECT COUNT(*) FROM hopper_nodes WHERE status IN ('running','claimed');" 2>/dev/null || echo 1)
  [ "$w" = "0" ] && break
  say "waiting: $w hopper node(s) running/claimed"; sleep 15
done
say "restarting jarvis.service"
systemctl restart jarvis.service
sleep 20
AFTER=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value)
[ "$AFTER" != "$BEFORE" ] && say "RESTARTED ($(systemctl show jarvis.service -p ActiveEnterTimestamp --value))" || say "ERROR: monotonic did not move"
# PROVE the routes exist in the running process: an unknown block id must 404
# (route present), not 404-html/405 (route absent). Auth via cockpit key.
KEY="$(grep -oP '^JARVIS_COCKPIT_KEY=\K.*' /home/kevin/paperclip/jarvis-command-center/.env)"
C=$(curl -s -o /tmp/n188probe.json -w '%{http_code}' -m 20 -X POST -H "Authorization: Bearer $KEY" http://localhost:3201/api/v1/notepad/blocks/999999999/read)
say "probe POST /notepad/blocks/999999999/read -> $C body=$(head -c 120 /tmp/n188probe.json)"
say "=== done ==="
