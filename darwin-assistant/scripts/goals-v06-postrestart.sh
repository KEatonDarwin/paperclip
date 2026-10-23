#!/bin/bash
# Waits for a jarvis.service restart, verifies GET /goals/board is live, THEN deploys the
# cockpit (v0.6 command deck was merged but deliberately not built until the backend is up,
# so /goals never renders an empty board against a 404ing endpoint). Marks commitment #77.
KEY="$(grep -oP '^JARVIS_COCKPIT_KEY=\K.*' /home/kevin/paperclip/jarvis-command-center/.env)"
LOG=/tmp/goals-v06-postrestart.log
start_ts=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value)
restarted=0
for i in $(seq 1 1440); do
  now_ts=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value)
  if [ "$now_ts" != "$start_ts" ]; then restarted=1; break; fi
  sleep 15
done
if [ $restarted = 0 ]; then echo "== $(date) NO RESTART OBSERVED IN 6H — #77 left open, cockpit NOT deployed" >> $LOG; exit 1; fi
sleep 25
{
  echo "== $(date) post-restart verify (ActiveEnter=$(systemctl show jarvis.service -p ActiveEnterTimestamp --value))"
  systemctl is-active jarvis.service
  curl -s -o /tmp/goals-board.json -w 'GET /goals/board http=%{http_code}\n' -H "Authorization: Bearer $KEY" http://localhost:3201/api/v1/goals/board
  python3 - <<'PY'
import json
d=json.load(open('/tmp/goals-board.json'))
ok=all(k in d for k in ('goals','map','attention','in_flight'))
print('keys goals/map/attention/in_flight present:',ok,'| goals:',len(d.get('goals',[])),'| map:',len(d.get('map',[])),'| attention:',len(d.get('attention',[])),'| in_flight:',len(d.get('in_flight',[])))
print('BOARD_V06_OK' if ok else 'BOARD_V06_MISSING')
PY
} >> $LOG 2>&1
if grep -q "BOARD_V06_OK" $LOG && systemctl is-active --quiet jarvis.service; then
  {
    echo "== deploying cockpit v0.6 command deck"
    runuser -u kevin -- /usr/local/bin/jarvis-cockpit-deploy.sh build
    runuser -u kevin -- /usr/local/bin/jarvis-cockpit-deploy.sh restart
    sleep 4
    curl -s -o /dev/null -w 'cockpit /goals http=%{http_code}\n' http://localhost:8080/goals
  } >> $LOG 2>&1
  if grep -q "cockpit /goals http=200" $LOG; then
    cd /home/kevin/paperclip/darwin-assistant && runuser -u kevin -- python3 scripts/jarvis-commit.py done 77 >> $LOG 2>&1
    curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d '{"severity":"success","title":"🖥 Goals v0.6 COMMAND DECK is live","body":"Backend restart landed, /goals/board verified, cockpit deployed. Refresh /goals — mini-map rail, stacked cards, Your-turn + In-flight rails.","source":"goals-v06-deploy"}' \
      http://localhost:3201/api/v1/notifications >/dev/null
    echo "VERIFY OK — cockpit deployed, #77 (goals v0.6 command deck) marked done" >> $LOG
  else echo "COCKPIT DEPLOY FAILED — #77 left open, check jarvis-cockpit-deploy output above" >> $LOG; fi
else echo "VERIFY FAILED — board endpoint missing; cockpit NOT deployed, #77 left open" >> $LOG; fi
