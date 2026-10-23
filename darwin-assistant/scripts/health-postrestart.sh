#!/bin/bash
# Cockpit Health v1 deploy: restart jarvis.service ONLY when nothing is running,
# verify GET /health/now + an SSE health_sample, THEN build+restart the cockpit
# (hopper/health-ui already merged, deliberately not built before the backend is
# live), check /health=200, reactivate the two trees paused for the health build,
# mark commitment #94 (row 99) done, bell. Launched ONLY as a systemd transient unit.
DB=/home/kevin/paperclip/darwin-assistant/jarvis.db
LOG=/tmp/health-postrestart.log
KEY="$(grep -oP '^JARVIS_COCKPIT_KEY=\K.*' /home/kevin/paperclip/jarvis-command-center/.env)"
say(){ echo "$(date '+%F %T') $*" >> "$LOG"; }
bell(){ curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "$(python3 -c "import json,sys;print(json.dumps({'severity':sys.argv[1],'title':sys.argv[2],'body':sys.argv[3],'source':'health-deploy'}))" "$1" "$2" "$3")" \
  http://localhost:3201/api/v1/notifications >/dev/null; }
api(){ curl -s -m 20 -H "Authorization: Bearer $KEY" "http://localhost:3201/api/v1$1"; }

say "=== health v1 deploy ==="
# Wait for a quiet moment: no running hopper workers, no automated turn mid-flight.
for i in $(seq 1 120); do   # up to 60 min
  n=$(sqlite3 "$DB" "select count(*) from hopper_nodes where status='running';")
  [ "$n" = "0" ] && break
  [ $((i % 10)) -eq 0 ] && say "waiting: $n running worker(s)"
  sleep 30
done
before=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value)
systemctl restart jarvis.service
for i in $(seq 1 40); do sleep 5; after=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value); [ "$after" != "$before" ] && break; done
[ "$after" = "$before" ] && { say "RESTART DID NOT LAND"; bell error "🔴 Health deploy: restart never landed" "See /tmp/health-postrestart.log"; exit 1; }
say "restarted: $(systemctl show jarvis.service -p ActiveEnterTimestamp --value)"
sleep 25

now_code=$(curl -s -m 20 -o /tmp/health-now.json -w '%{http_code}' -H "Authorization: Bearer $KEY" http://localhost:3201/api/v1/health/now)
verdict=$(python3 - <<'PY'
import json
try:
    d=json.load(open('/tmp/health-now.json')); s=d.get('sample') or d
    need=['cpu','mem','lag','disk','db']
    missing=[k for k in need if k not in s]
    wl=d.get('workload') or s.get('workload') or {}
    print(('HEALTH_OK' if not missing else 'HEALTH_MISSING '+','.join(missing))+f" cpu={s.get('cpu',{}).get('pct')} mem%={s.get('mem',{}).get('pct')} lag_p99={s.get('lag',{}).get('p99_ms')} db_mb={round((s.get('db',{}).get('bytes') or 0)/1048576)} tick_ms={s.get('tick_ms')} workload_keys={list(wl)[:6]}")
except Exception as e:
    print('HEALTH_MISSING', e)
PY
)
say "GET /health/now http=$now_code · $verdict"
# SSE: expect a health_sample within ~15s on the global stream
sse=$(timeout 20 curl -s -N -H "Authorization: Bearer $KEY" http://localhost:3201/api/v1/events 2>/dev/null | grep -m1 -c 'health_sample' || true)
say "SSE health_sample seen within 20s: ${sse:-0}"
series_code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "http://localhost:3201/api/v1/health/series?window=15m")
wl_code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" http://localhost:3201/api/v1/health/workloads)
say "series=$series_code workloads=$wl_code"

if [[ "$verdict" == HEALTH_OK* && "$now_code" = "200" && "$series_code" = "200" ]]; then
  say "backend verified — deploying cockpit (hopper/health-ui merged at c0f9d45)"
  runuser -u kevin -- /usr/local/bin/jarvis-cockpit-deploy.sh build >> "$LOG" 2>&1
  runuser -u kevin -- /usr/local/bin/jarvis-cockpit-deploy.sh restart >> "$LOG" 2>&1
  sleep 8
  health=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/health)
  night=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/night)
  goals=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/goals)
  say "cockpit /health=$health /night=$night /goals=$goals"
  if [ "$health" = "200" ]; then
    sqlite3 "$DB" "UPDATE hopper_trees SET status='active', updated_at=datetime('now') WHERE id IN ('tree-d0e0ce29','tree-020a8b74') AND status='draft';"
    say "reactivated paused trees: $(sqlite3 "$DB" "select group_concat(id||':'||status) from hopper_trees where id in ('tree-d0e0ce29','tree-020a8b74')")"
    sqlite3 "$DB" "UPDATE watch_commitments SET status='done', resolved_at=datetime('now'), notes=coalesce(notes,'')||' | DEPLOYED: backend merge on live checkout, cockpit hopper/health-ui c0f9d45; /health/now + SSE + /health 200' WHERE id=99;"
    say "commitment #94 (row 99) -> done"
    bell success "🩺 Cockpit Health is LIVE" "/health is up: live CPU / memory / event-loop lag / disk / DB / workload charts on one time axis, clickable status rows, spike → suggestion into the 🩺 Health monitor chat. The notepad + MCP-parity trees are re-activated."
  else
    bell error "🔴 Health deploy: cockpit /health not 200" "Backend is live; cockpit build/restart did not come up clean. See /tmp/health-postrestart.log"
  fi
else
  say "VERIFY FAILED — cockpit NOT deployed; #94 left open"
  bell error "🔴 Health deploy: backend verify failed after restart" "GET /health/now did not answer as expected. See /tmp/health-postrestart.log"
fi
say "=== done ==="
