#!/bin/bash
KEY="$(grep -oP "^JARVIS_COCKPIT_KEY=\K.*" /home/kevin/paperclip/jarvis-command-center/.env)"; idle=0
for i in $(seq 1 480); do
  n=$(curl -s -H "Authorization: Bearer $KEY" 'http://localhost:3201/api/v1/threads?limit=200' | python3 -c "import sys,json; d=json.load(sys.stdin); ts=d.get('threads',d); print(sum(1 for t in ts if t.get('running')))" 2>/dev/null || echo 1)
  if [ "$n" = "0" ]; then idle=$((idle+1)); else idle=0; fi
  if [ $idle -ge 4 ]; then echo "$(date) idle -> restarting jarvis.service" >> /tmp/jarvis-idle-restart.log; systemctl restart jarvis.service; exit 0; fi
  sleep 15
done
echo "$(date) gave up (never idle 60s in 2h)" >> /tmp/jarvis-idle-restart.log
