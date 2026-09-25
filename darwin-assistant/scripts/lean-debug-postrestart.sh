#!/bin/bash
# 2026-09-25 lean-debug deploy: wait idle -> stop jarvis -> VACUUM -> start -> verify -> bell
# (claude_input disk spool + SSE blob cut, commit bf60afc04; run as a systemd
#  transient unit, NEVER nohup — see the 2026-09-20 restart-that-never-fired lesson)
LOG=/tmp/lean-debug-postrestart.log
KEY="$(grep -oP "^JARVIS_COCKPIT_KEY=\K.*" /home/kevin/paperclip/jarvis-command-center/.env)"
DB=/home/kevin/paperclip/darwin-assistant/jarvis.db
idle=0
echo "$(date) start" >> $LOG
for i in $(seq 1 960); do
  n=$(curl -s -H "Authorization: Bearer $KEY" 'http://localhost:3201/api/v1/threads?limit=200' | python3 -c "import sys,json; d=json.load(sys.stdin); ts=d.get('threads',d); print(sum(1 for t in ts if t.get('running')))" 2>/dev/null || echo 1)
  w=$(sqlite3 $DB "SELECT COUNT(*) FROM hopper_nodes WHERE status='running';" 2>/dev/null || echo 1)
  if [ "$n" = "0" ] && [ "$w" = "0" ]; then idle=$((idle+1)); else idle=0; fi
  if [ $idle -ge 4 ]; then break; fi
  sleep 15
done
if [ $idle -lt 4 ]; then echo "$(date) never idle in 4h — NOT restarting; exiting" >> $LOG; exit 1; fi
echo "$(date) idle — stopping jarvis for vacuum + lean-debug deploy" >> $LOG
systemctl stop jarvis.service
SIZE_BEFORE=$(stat -c%s $DB)
/usr/local/bin/jarvis-db-retention.sh --vacuum >> $LOG 2>&1
SIZE_AFTER=$(stat -c%s $DB)
systemctl start jarvis.service
sleep 10
UP=$(systemctl is-active jarvis.service)
echo "$(date) DONE vacuum $((SIZE_BEFORE/1048576))MB->$((SIZE_AFTER/1048576))MB, jarvis=$UP" >> $LOG
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' http://localhost:3201/api/v1/notifications -d "{\"severity\":\"success\",\"title\":\"Lean debug capture live: claude_input now spools to disk, DB vacuumed $((SIZE_BEFORE/1048576))MB -> $((SIZE_AFTER/1048576))MB\",\"source\":\"lean-debug-postrestart\"}" >/dev/null 2>&1
