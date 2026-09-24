#!/bin/bash
# NIGHT SHIFT CHECK (node #681, skills/night-shift/CONTRACT.md §10).
#
# Boots the real compiled server on a throwaway port against a READ-ONLY
# .backup() copy of the LIVE jarvis.db, then drives it over real HTTP
# (scripts/night-shift-check.mjs) through thread -> plan -> board -> move ->
# start -> pause -> resume -> stop -> report, on Kevin's actual goal data.
#
# Companion to `npm run night:sim` (which drives a synthetic scratch DB
# in-process for every behavioural scenario); this one proves the wire
# protocol end-to-end against real data with zero risk to the live file.
#
# The DB copy is deliberately kept on the HOME DISK, not /tmp — CONTRACT.md's
# own sim already hit an out-of-space failure once from putting a ~1.1GB
# jarvis.db copy on a small tmpfs; this script repeats that lesson rather
# than the literal "/tmp/night-check.db" path a first draft of the spec
# suggested. Same for the report: GOALS_VAULT_ROOT is overridden to a scratch
# vault dir so the report can never land in (or overwrite anything in) the
# real Obsidian wiki.
#
# Usage: npm run night:check   (builds first)
#    or: bash scripts/night-shift-check.sh   (uses whatever dist/ already has)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

LIVE_DB="/home/kevin/paperclip/darwin-assistant/jarvis.db"
SCRATCH_DIR="${NIGHT_CHECK_DIR:-$HOME/.cache/night-shift-check}"
mkdir -p "$SCRATCH_DIR"
DB_COPY="$SCRATCH_DIR/night-check.db"
VAULT_DIR="$SCRATCH_DIR/vault"
STOP_FILE="$SCRATCH_DIR/night-check.stop"

rm -f "$DB_COPY" "$DB_COPY-wal" "$DB_COPY-shm"
rm -rf "$VAULT_DIR"
rm -f "$STOP_FILE"

if [ ! -f "$LIVE_DB" ]; then
  echo "FATAL: live jarvis.db not found at $LIVE_DB — nothing to check against." >&2
  exit 2
fi

echo "[night-check] copying live DB (read-only .backup) -> $DB_COPY"
sqlite3 "$LIVE_DB" ".backup '$DB_COPY'"
if [ ! -f "$DB_COPY" ]; then
  echo "FATAL: sqlite3 .backup did not produce $DB_COPY" >&2
  exit 2
fi

export JARVIS_DB_PATH="$DB_COPY"
export GOALS_VAULT_ROOT="$VAULT_DIR"
export NIGHT_SHIFT_STOP_FILE="$STOP_FILE"
export NIGHT_SHIFT_DRIVER=0
export GOALS_AUTOPILOT_DRIVER=0
export GOAL_GUARD_POLLER=0
export HOPPER_GOV_ENABLED=0
export HOPPER_ENGINE_SLOTS=8
unset ANTHROPIC_API_KEY

node "$SCRIPT_DIR/night-shift-check.mjs"
status=$?

rm -f "$DB_COPY" "$DB_COPY-wal" "$DB_COPY-shm"

exit $status
