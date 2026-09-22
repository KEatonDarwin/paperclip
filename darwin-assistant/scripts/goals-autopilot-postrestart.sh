#!/bin/bash
# Goals Autopilot v0.4 post-restart verifier (runs as a transient systemd unit, root).
LOG=/tmp/goals-autopilot-postrestart.log; KEY="$(grep -oP "^JARVIS_COCKPIT_KEY=\K.*" /home/kevin/paperclip/jarvis-command-center/.env)"
ARMED_AT=$(date +%s); echo "$(date) armed" >> $LOG
for i in $(seq 1 600); do
  ts=$(systemctl show jarvis.service -p ActiveEnterTimestamp --value); ep=$(date -d "$ts" +%s 2>/dev/null || echo 0)
  if [ "$ep" -gt "$ARMED_AT" ]; then sleep 25; break; fi; sleep 15
done
ts=$(systemctl show jarvis.service -p ActiveEnterTimestamp --value); ep=$(date -d "$ts" +%s 2>/dev/null || echo 0)
if [ "$ep" -le "$ARMED_AT" ]; then echo "$(date) FAIL: restart never landed" >> $LOG; exit 1; fi
code=$(curl -s -o /tmp/ap-get.json -w '%{http_code}' -H "Authorization: Bearer $KEY" http://localhost:3201/api/v1/goals/1/autopilot)
echo "$(date) restarted at $ts; GET /goals/1/autopilot -> $code $(head -c 300 /tmp/ap-get.json)" >> $LOG
[ "$code" = "200" ] || { echo "$(date) FAIL: route not live" >> $LOG; exit 1; }
systemctl stop goals-autopilot-hb-goal1.timer 2>/dev/null; systemctl stop goals-autopilot-hb-goal1.service 2>/dev/null
echo "$(date) hand-run heartbeat timer stopped" >> $LOG
on=$(curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"on":true,"config":{"build_model":"claude-sonnet-5","light_model":"claude-haiku-4-5","verify_model":"claude-opus-5","parallel":1,"max_depth":4,"tick_minutes":10,"max_attempts":2}}' \
  http://localhost:3201/api/v1/goals/1/autopilot)
echo "$(date) autopilot ON goal 1 -> $(echo "$on" | head -c 400)" >> $LOG
sleep 20
curl -s -H "Authorization: Bearer $KEY" http://localhost:3201/api/v1/goals/1/autopilot | head -c 500 >> $LOG; echo >> $LOG
cd /home/kevin/paperclip/darwin-assistant && sudo -u kevin python3 scripts/jarvis-commit.py done 72 >> $LOG 2>&1
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"severity":"success","title":"🌙 Goals Autopilot v0.4 LIVE","body":"Backend + cockpit deployed; goal #1 switched to server-driven autopilot (hand-run heartbeat retired). Commitment #72 done.","source":"autopilot-deploy"}' http://localhost:3201/api/v1/notifications >/dev/null
echo "$(date) DONE" >> $LOG
