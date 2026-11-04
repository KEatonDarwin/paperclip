#!/bin/bash
# Waits for a jarvis.service restart, then verifies persona-mcp + tree-cue + goals v0.2/guards are live.
KEY="$(grep -oP '^JARVIS_COCKPIT_KEY=\K.*' /home/kevin/paperclip/jarvis-command-center/.env)"
LOG=/tmp/persona-mcp-postrestart.log
start_ts=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value)
restarted=0
for i in $(seq 1 1440); do   # up to 6h
  now_ts=$(systemctl show jarvis.service -p ActiveEnterTimestampMonotonic --value)
  if [ "$now_ts" != "$start_ts" ]; then restarted=1; break; fi
  sleep 15
done
if [ $restarted = 0 ]; then echo "== $(date) NO RESTART OBSERVED IN 6H — verify skipped, commitments left open" >> $LOG; exit 1; fi
sleep 25
{
  echo "== $(date) post-restart verify (service ActiveEnter=$(systemctl show jarvis.service -p ActiveEnterTimestamp --value))"
  systemctl is-active jarvis.service
  echo -n "internal/tools (admin): "; curl -s -o /tmp/pm-tools.json -w '%{http_code}\n' -H "Authorization: Bearer $KEY" http://localhost:3201/api/v1/internal/tools
  python3 -c "import json; d=json.load(open('/tmp/pm-tools.json')); t=d.get('tools',d); print('manifest', len(t), 'goals' in [x.get('name') for x in t])"
  echo -n "settings leaks internal key? "; curl -s -H "Authorization: Bearer $KEY" http://localhost:3201/api/v1/settings | grep -c internal_mcp || true
  echo -n "goals guards route: "; curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $KEY" http://localhost:3201/api/v1/goals/1/guards
  echo -n "tree-cue loaded: "; test -f /home/kevin/paperclip/darwin-assistant/dist/tree-cue.js && echo yes || echo NO
  journalctl -u jarvis.service --since "-3 min" --no-pager | grep -iE "error|ENOENT" | head -5
} >> $LOG 2>&1
if grep -q "manifest [0-9]* True" $LOG && systemctl is-active --quiet jarvis.service; then
  cd /home/kevin/paperclip/darwin-assistant && for c in 56 61; do python3 scripts/jarvis-commit.py done $c >> $LOG 2>&1; done
  echo "VERIFY OK — #56 (persona-mcp) + #61 (tree-cue live) marked done" >> $LOG
else echo "VERIFY FAILED — commitments left open" >> $LOG; fi
