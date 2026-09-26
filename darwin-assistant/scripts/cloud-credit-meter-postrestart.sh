#!/bin/bash
# 2026-09-26: $250 cloud-session credit meter in the Provider Usage widget.
# Delayed restart -> verify the new "Cloud credits" window is served -> notify.
LOG=/tmp/cloud-credit-meter-postrestart.log
KEY="$(grep -oP "^JARVIS_COCKPIT_KEY=\K.*" /home/kevin/paperclip/jarvis-command-center/.env)"
echo "$(date) start; sleeping 90s so the deploying turn can finish" >> $LOG
sleep 90
BEFORE=$(systemctl show jarvis.service -p ActiveEnterTimestamp --value)
systemctl restart jarvis.service
sleep 12
AFTER=$(systemctl show jarvis.service -p ActiveEnterTimestamp --value)
echo "$(date) restarted: '$BEFORE' -> '$AFTER'" >> $LOG
BODY=$(curl -s -H "Authorization: Bearer $KEY" http://localhost:3201/api/v1/provider-usage)
FOUND=$(python3 - "$BODY" <<'PY'
import json,sys
try: d=json.loads(sys.argv[1])
except Exception: print(""); raise SystemExit
out=[]
for src in ([d.get("claude")] if d.get("claude") else []) + (d.get("claude_accounts") or []):
    for w in (src.get("windows") or []):
        if w.get("label")=="Cloud credits":
            out.append(f"{src.get('label','claude')}: {w.get('value_label')} ({w.get('used_percentage')}% used)")
print(" | ".join(out))
PY
)
echo "$(date) meter: ${FOUND:-NONE}" >> $LOG
if [ "$BEFORE" != "$AFTER" ] && [ -n "$FOUND" ]; then
  SEV=success; TITLE="Cloud-credit meter LIVE in Provider Usage — $FOUND"
else
  SEV=warning; TITLE="Cloud-credit meter deploy inconclusive: restart '$BEFORE'->'$AFTER', meter=${FOUND:-not found}"
fi
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' http://localhost:3201/api/v1/notifications -d "$(python3 -c "import json,sys; print(json.dumps({'severity':sys.argv[1],'title':sys.argv[2],'source':'cloud-credit-meter'}))" "$SEV" "$TITLE")" >/dev/null 2>&1
echo "$(date) DONE $SEV: $TITLE" >> $LOG
