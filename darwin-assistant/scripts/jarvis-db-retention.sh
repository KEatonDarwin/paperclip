#!/bin/bash
# JARVIS DB retention sweep — roll the debug capture off the hot DB so the
# single Node event loop (better-sqlite3 is synchronous) never has to drag
# hundreds of MB of claude_input/claude_output through a SELECT.
#
# What it nulls (ONLY these two debug columns; conversation `content`,
# tool_args/tool_result and thread membership are never touched):
#   claude_input   older than INPUT_DAYS   (default 2)  — no runtime reader
#   claude_output  older than OUTPUT_DAYS  (default 14) — read only by the
#                  collapsible "thinking steps" view in the cockpit
#   both columns   older than WORKER_DAYS  (default 1)  on ephemeral threads
#                  (cockpit:hopper-node-*, quick:*, checkin:*) — nobody opens
#                  a finished worker's steps a day later, and they are the
#                  400 KB/turn rows that grew the file to 1.5 GB (2026-09-25).
#
# Batched (BATCH rows per transaction) so a live jarvis.service only ever waits
# on a sub-second write lock. Ends with wal_checkpoint(TRUNCATE). No VACUUM by
# default (freed pages get reused, file plateaus); pass --vacuum for a one-time
# shrink. Logs to /tmp/jarvis-db-retention.log. Installed at
# /usr/local/bin/jarvis-db-retention.sh from this repo copy (deploy = cp).
set -u
DB="${JARVIS_DB_PATH:-/home/kevin/paperclip/darwin-assistant/jarvis.db}"
LOG=/tmp/jarvis-db-retention.log
INPUT_DAYS="${INPUT_DAYS:-2}"; OUTPUT_DAYS="${OUTPUT_DAYS:-14}"; WORKER_DAYS="${WORKER_DAYS:-1}"
BATCH="${BATCH:-200}"
VACUUM=0; [ "${1:-}" = "--vacuum" ] && VACUUM=1
say(){ echo "$(date '+%F %T') $*" | tee -a "$LOG"; }
q(){ sqlite3 -cmd '.timeout 15000' "$DB" "$1"; }
size(){ echo $(( $(stat -c %s "$DB") / 1048576 ))MB; }

say "=== retention start db=$(size) wal=$(( $(stat -c %s "$DB-wal" 2>/dev/null || echo 0) / 1048576 ))MB windows: input ${INPUT_DAYS}d output ${OUTPUT_DAYS}d worker ${WORKER_DAYS}d"
EPHEMERAL="(c.external_id LIKE 'cockpit:hopper-node-%' OR c.external_id LIKE 'quick:%' OR c.external_id LIKE 'checkin:%')"

sweep(){ # $1 label  $2 column  $3 where-clause (rows still holding data)
  local label="$1" col="$2" where="$3" n total=0
  while :; do
    n=$(q "UPDATE turns SET $col=NULL WHERE id IN (SELECT t.id FROM turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.$col IS NOT NULL AND ($where) LIMIT $BATCH); SELECT changes();")
    [ -z "$n" ] && { say "  $label: sqlite error, stopping this sweep"; return 1; }
    total=$((total + n))
    [ "$n" -lt "$BATCH" ] && break
    sleep 0.2
  done
  say "  $label: nulled $total row(s)"
}
sweep "claude_input>${INPUT_DAYS}d"  claude_input  "t.created_at < datetime('now','-${INPUT_DAYS} days')"
sweep "claude_output>${OUTPUT_DAYS}d" claude_output "t.created_at < datetime('now','-${OUTPUT_DAYS} days')"
sweep "worker claude_input>${WORKER_DAYS}d"  claude_input  "t.created_at < datetime('now','-${WORKER_DAYS} days') AND $EPHEMERAL"
sweep "worker claude_output>${WORKER_DAYS}d" claude_output "t.created_at < datetime('now','-${WORKER_DAYS} days') AND $EPHEMERAL"

q "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
say "checkpointed; freelist=$(q 'PRAGMA freelist_count;') pages db=$(size)"
if [ "$VACUUM" = "1" ]; then
  say "VACUUM (one-time shrink) ..."
  t0=$(date +%s); q "VACUUM;" && q "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
  say "VACUUM done in $(( $(date +%s) - t0 ))s db=$(size)"
fi
say "=== retention done db=$(size) turns=$(q 'SELECT count(*) FROM turns;') debug_mb=$(q 'SELECT (coalesce(sum(length(claude_input)),0)+coalesce(sum(length(claude_output)),0))/1048576 FROM turns;')"
