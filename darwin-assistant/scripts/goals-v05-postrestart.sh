#!/bin/bash
# Waits for a jarvis.service restart, then verifies goals v0.5 forest payload is live; marks commitment #76 done.
KEY="$(grep -oP '^JARVIS_COCKPIT_KEY=\K.*' /home/kevin/paperclip/jarvis-command-center/.env)"
LOG=/tmp/goals-v05-postrestart.log
start_ts=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value)
restarted=0
for i in $(seq 1 1440); do
  now_ts=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value)
  if [ "$now_ts" != "$start_ts" ]; then restarted=1; break; fi
  sleep 15
done
if [ $restarted = 0 ]; then echo "== $(date) NO RESTART OBSERVED IN 6H — #76 left open" >> $LOG; exit 1; fi
sleep 25
{
  echo "== $(date) post-restart verify (ActiveEnter=$(systemctl show jarvis.service -p ActiveEnterTimestamp --value))"
  systemctl is-active jarvis.service
  curl -s -o /tmp/goals-forest.json -w 'GET /goals http=%{http_code}\n' -H "Authorization: Bearer $KEY" http://localhost:3201/api/v1/goals
  python3 - <<'PY'
import json
d=json.load(open('/tmp/goals-forest.json'))
gs=d.get('goals',[])
la=all('last_activity' in g for g in gs)
hn=all('hot_nodes' in g for g in gs)
print('goals:',len(gs),'| last_activity on all:',la,'| hot_nodes on all:',hn)
print('FOREST_V05_OK' if (gs and la and hn) else 'FOREST_V05_MISSING')
PY
  journalctl -u jarvis.service --since "-3 min" --no-pager | grep -iE "error|ENOENT" | head -5
} >> $LOG 2>&1
if grep -q "FOREST_V05_OK" $LOG && systemctl is-active --quiet jarvis.service; then
  cd /home/kevin/paperclip/darwin-assistant && python3 scripts/jarvis-commit.py done 76 >> $LOG 2>&1
  echo "VERIFY OK — #76 (goals v0.5 forest dashboard) marked done" >> $LOG
else echo "VERIFY FAILED — #76 left open" >> $LOG; fi
