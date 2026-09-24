#!/bin/bash
# Multi-claude usage poller — generalized version of ~/.claude/claude-usage-poll.sh
# for accounts OTHER THAN the default 'a' (tree-44d2ff4a node #293).
#
# Account 'a' is UNCHANGED: it keeps its existing standalone script
# (~/.claude/claude-usage-poll.sh) writing /tmp/claude-usage-live.json, wired
# to claude-usage-poll.service/.timer exactly as before this feature existed.
#
# This script is the ONE poller body every OTHER account's systemd instance
# runs (see systemd/claude-usage-poll@.service, template-instantiated per
# account key via `systemctl enable --now claude-usage-poll@<key>.timer`).
# Per-account config comes from the environment (an EnvironmentFile written by
# scripts/multi-claude-setup.sh, one per account, at
# ~/.claude-accounts/<key>.env) — nothing here is account-specific.
#
# Polls the authenticated claude.ai usage endpoint (browser sessionKey cookie
# — a DIFFERENT credential than the CLI's own OAuth token/CLAUDE_CONFIG_DIR
# login). Does NOT consume any Claude API/subscription usage — plain HTTP GET.
set -euo pipefail

ACCOUNT_KEY="${ACCOUNT_KEY:?ACCOUNT_KEY env var is required (e.g. 'b')}"
COOKIE_FILE="${COOKIE_FILE:?COOKIE_FILE env var is required}"
# ORG_ID is legitimately EMPTY until the account has logged in once (the setup
# script writes the env file before that can happen, by design — "degrades
# gracefully"). Treat it like a missing cookie: no-op with exit 0 so the timer
# instance doesn't sit in `failed` every 60s; one journal line says why.
ORG_ID="${ORG_ID:-}"
if [ -z "$ORG_ID" ]; then
  logger -t "claude-usage-poll-${ACCOUNT_KEY}" "no ORG_ID yet for account '${ACCOUNT_KEY}' — re-run multi-claude-setup.sh after 'claude auth login' (no-op)"
  exit 0
fi
# Mirrors darwin-assistant/src/claude-accounts.ts usageFilePath() EXACTLY:
# account 'a' keeps the legacy unsuffixed path; every other key gets its own
# file. (This script should never actually be pointed at 'a' — that account
# keeps its original standalone poller — but the rule is kept identical here
# so the two never drift if it ever is.)
if [ "${ACCOUNT_KEY}" = "a" ]; then
  DEFAULT_OUT_FILE="/tmp/claude-usage-live.json"
else
  DEFAULT_OUT_FILE="/tmp/claude-usage-${ACCOUNT_KEY}-live.json"
fi
OUT_FILE="${OUT_FILE:-$DEFAULT_OUT_FILE}"

# --- OAuth fallback (added 2026-09-23 by JARVIS): claude.ai cookie path got Cloudflare-challenged (HTTP 403 HTML).
# The CLI's own OAuth usage endpoint returns the identical payload. Read-only, no model call, no API key.
oauth_fallback() {
  local creds="$1" out="$2"
  [ -f "$creds" ] || return 1
  local tok
  tok=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('claudeAiOauth',{}).get('accessToken',''))" "$creds" 2>/dev/null) || return 1
  [ -n "$tok" ] || return 1
  local tmp2 code2
  tmp2=$(mktemp)
  code2=$(curl -s -o "$tmp2" -w "%{http_code}" "https://api.anthropic.com/api/oauth/usage" \
    -H "Authorization: Bearer ${tok}" -H "anthropic-beta: oauth-2025-04-20" -H "Accept: application/json" -H "User-Agent: claude-code/2.0")
  if [ "$code2" = "200" ] && python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert 'five_hour' in d" "$tmp2" 2>/dev/null; then
    mv "$tmp2" "$out"; return 0
  fi
  rm -f "$tmp2"; return 1
}

CREDS_FILE="${CREDS_FILE:-${CLAUDE_CONFIG_DIR:-/home/kevin/.claude-${ACCOUNT_KEY}}/.credentials.json}"

UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"

if [ ! -f "$COOKIE_FILE" ] || [ -z "$(cat "$COOKIE_FILE")" ]; then oauth_fallback "$CREDS_FILE" "$OUT_FILE"; exit 0; fi
COOKIE=$(cat "$COOKIE_FILE")

TMP=$(mktemp)
HTTP_CODE=$(curl -s -o "$TMP" -w "%{http_code}" \
  "https://claude.ai/api/organizations/${ORG_ID}/usage" \
  -H "Cookie: sessionKey=${COOKIE}" \
  -H "User-Agent: ${UA}" \
  -H "Accept: application/json")

if [ "$HTTP_CODE" = "200" ]; then
  mv "$TMP" "$OUT_FILE"
else
  rm -f "$TMP"
  if oauth_fallback "$CREDS_FILE" "$OUT_FILE"; then logger -t "claude-usage-poll-${ACCOUNT_KEY}" "cookie path HTTP ${HTTP_CODE}; wrote usage via OAuth fallback"; exit 0; fi
  logger -t "claude-usage-poll-${ACCOUNT_KEY}" "poll failed with HTTP ${HTTP_CODE} (cookie likely expired) org=${ORG_ID}"
fi
