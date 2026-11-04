#!/bin/bash
# Verifier for tree-b32ef869 (per-thread Claude A/B account pin). Runs as a
# transient systemd unit AFTER the idle-gated jarvis.service restart.
KEY="$(grep -oP '^JARVIS_COCKPIT_KEY=\K.*' /home/kevin/paperclip/jarvis-command-center/.env)"
LOG=/tmp/account-pick-postrestart.log
BASE=http://localhost:3201/api/v1
BEFORE="${1:-0}"
echo "=== $(date) account-pick verifier (waiting for restart past epoch $BEFORE) ===" >> $LOG
for i in $(seq 1 480); do
  now=$(date -d "$(systemctl show jarvis.service -p ActiveEnterTimestamp --value)" +%s 2>/dev/null || echo 0)
  if [ "$now" -gt "$BEFORE" ] 2>/dev/null; then echo "restart landed at $now" >> $LOG; break; fi
  sleep 15
done
sleep 10
ACC=$(curl -s -H "Authorization: Bearer $KEY" "$BASE/claude-accounts")
echo "GET /claude-accounts -> $ACC" >> $LOG
echo "$ACC" | grep -q '"key": *"b"' || echo "WARN: account b missing" >> $LOG
echo "$ACC" | grep -q 'locked_reason' && echo "locked_reason present (selector weekly fix live)" >> $LOG
# Account-only pin round-trip on a throwaway thread (never a real one).
EXT="cockpit:acctpin-verify-$(date +%s)"
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"external_id\":\"$EXT\",\"label\":\"acct pin verify\"}" "$BASE/threads" > /dev/null
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$EXT")
PIN=$(curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"claude_account":"b"}' "$BASE/threads/$ENC/model")
echo "PATCH {claude_account:b} -> $PIN" >> $LOG
OK=$(echo "$PIN" | grep -c '"claude_account": *"b"')
BAD=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"claude_account":"zzz"}' "$BASE/threads/$ENC/model")
echo "bad key -> HTTP $BAD (expect 400)" >> $LOG
curl -s -X DELETE -H "Authorization: Bearer $KEY" "$BASE/threads/$ENC" > /dev/null
if [ "$OK" -ge 1 ] && [ "$BAD" = "400" ]; then
  sqlite3 /home/kevin/paperclip/darwin-assistant/jarvis.db \
    "UPDATE watch_commitments SET status='satisfied', resolved_at=datetime('now') WHERE id=90;"
  curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d '{"severity":"success","title":"Claude A/B account picker is live","body":"Pick Claude A or B per thread from the model dropdown. Commitment #90 closed.","source":"account-pick"}' \
    "$BASE/notifications" > /dev/null
  echo "DONE ok" >> $LOG
else
  curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d '{"severity":"error","title":"Account-pick verifier FAILED","body":"See /tmp/account-pick-postrestart.log","source":"account-pick"}' \
    "$BASE/notifications" > /dev/null
  echo "DONE FAILED" >> $LOG
fi
