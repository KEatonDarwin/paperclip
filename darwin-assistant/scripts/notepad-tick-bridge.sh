#!/bin/bash
# BRIDGE ONLY — runs the notepad brain's tick as a standalone process until the
# in-service driver (startNotepadDriver, index.ts) goes live at the next
# jarvis.service restart.
#
# The driver shipped in dist/ at 2026-09-26T15:01:07-05:00 but jarvis.service is still
# running the pre-driver build, and the idle-gated restart cannot fire while a
# shift keeps workers busy. Rather than force a restart mid-shift, this timer
# calls the SAME exported runNotepadTick() out of process.
#
# SELF-DISARMING: the moment jarvis.service restarts (and therefore owns the
# tick itself), this exits and disables its own timer — so the two can never
# both be ticking and double-spend a model call on one settle.
DRIVER_DEPLOYED_AT=1790452867
SVC_STARTED_AT=$(date -d "$(systemctl show jarvis.service -p ActiveEnterTimestamp --value)" +%s 2>/dev/null || echo 0)

if [ "$SVC_STARTED_AT" -gt "$DRIVER_DEPLOYED_AT" ]; then
  echo "[notepad-bridge] jarvis.service restarted at $SVC_STARTED_AT — in-service driver owns the tick now; disarming."
  systemctl disable --now notepad-tick-bridge.timer 2>/dev/null
  exit 0
fi

cd /home/kevin/paperclip/darwin-assistant
exec node -e "import('./dist/notepad-driver.js').then(m => m.runNotepadTick())"
