#!/usr/bin/env bash
# multi-claude-setup.sh — idempotent provisioning for ONE additional Claude
# subscription account (tree-44d2ff4a node #293).
#
# Account 'a' (the default ~/.claude subscription) is NEVER touched by this
# script and needs none of this — it already works exactly as before this
# feature existed. Run this once per EXTRA account (e.g. 'b').
#
# What it does, in order (every step is safe to re-run):
#   1. Prints the exact one-time CLI login command for this account, unless
#      it's already logged in (checked via `claude auth status`) — and, when
#      logged in, auto-detects the account's org id from that same call.
#   2. Prints the exact steps to drop this account's claude.ai browser
#      session cookie at its cookie_file, unless that file already exists.
#   3. Seeds/updates this account in the `claude_accounts` settings-KV
#      registry via POST /api/v1/claude-accounts (upsert by key — never
#      clobbers account 'a' or any other already-registered account).
#   4. Installs (or refreshes) this account's usage-poller systemd instance
#      (claude-usage-poll@<key>.{service,timer}, template units in
#      ./systemd/) so /tmp/claude-usage-<key>-live.json starts updating.
#
# DEGRADES GRACEFULLY: if the account isn't logged in yet and/or its cookie
# file doesn't exist yet, steps 3-4 still run (registry entry + poller get
# installed) — the poller just no-ops (exit 0, no file written) until both
# are in place. Nothing here ever blocks or breaks account 'a'.
#
# Never touches/commits secrets: the session cookie's VALUE is never printed
# back, logged, or written anywhere by this script — only its PATH is
# recorded (in the registry and the per-account EnvironmentFile), and Kevin
# drops the value himself, outside the repo, per the printed instructions.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: multi-claude-setup.sh --key <key> [options]

Required:
  --key <key>            Short account id, e.g. "b". Never use "a" (the default account).

Options:
  --label <label>        Cockpit-facing label. Default: "Claude <KEY uppercased>".
  --config-dir <dir>     CLAUDE_CONFIG_DIR for this account. Default: ~/.claude-<key>
  --cookie-file <path>   Where the browser session cookie lives. Default: <config-dir>/claude-ai-session-cookie
  --org-id <id>          Override the org id instead of auto-detecting via `claude auth status`.
  --api-base <url>       darwin-assistant API base. Default: http://localhost:3201/api/v1
  --api-key <key>        Bearer key for the API. Default: reads JARVIS_COCKPIT_KEY from
                          jarvis-command-center/.env (override its path with JARVIS_COCKPIT_ENV).
  --env-dir <dir>        Where per-account systemd EnvironmentFiles are written. Default: ~/.claude-accounts
  --systemd-dir <dir>    Where unit files get installed. Default: /etc/systemd/system
  --no-install-unit      Skip the systemd install step (registry seed only).
  --dry-run              Print every step without touching the CLI, systemd, or the API.
  -h, --help             Show this help.
EOF
}

KEY=""
LABEL=""
CONFIG_DIR=""
COOKIE_FILE=""
ORG_ID_OVERRIDE=""
API_BASE="${CLAUDE_ACCOUNTS_API_BASE:-http://localhost:3201/api/v1}"
API_KEY="${CLAUDE_ACCOUNTS_API_KEY:-}"
JARVIS_COCKPIT_ENV="${JARVIS_COCKPIT_ENV:-/home/kevin/paperclip/jarvis-command-center/.env}"
ENV_DIR="${HOME}/.claude-accounts"
SYSTEMD_DEST_DIR="/etc/systemd/system"
INSTALL_UNIT=1
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --config-dir) CONFIG_DIR="$2"; shift 2 ;;
    --cookie-file) COOKIE_FILE="$2"; shift 2 ;;
    --org-id) ORG_ID_OVERRIDE="$2"; shift 2 ;;
    --api-base) API_BASE="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --env-dir) ENV_DIR="$2"; shift 2 ;;
    --systemd-dir) SYSTEMD_DEST_DIR="$2"; shift 2 ;;
    --no-install-unit) INSTALL_UNIT=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ -z "$KEY" ]; then
  echo "ERROR: --key is required" >&2
  usage >&2
  exit 1
fi
if [ "$KEY" = "a" ]; then
  echo "ERROR: 'a' is the default account and is never managed by this script." >&2
  exit 1
fi

CONFIG_DIR="${CONFIG_DIR:-${HOME}/.claude-${KEY}}"
LABEL="${LABEL:-Claude $(echo "$KEY" | tr '[:lower:]' '[:upper:]')}"
COOKIE_FILE="${COOKIE_FILE:-${CONFIG_DIR}/claude-ai-session-cookie}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_SRC_DIR="$(cd "$SCRIPT_DIR/../systemd" && pwd)"

echo "== multi-claude-setup: account '${KEY}' =="
echo "  config_dir  : ${CONFIG_DIR}"
echo "  cookie_file : ${COOKIE_FILE}"
echo "  label       : ${LABEL}"
[ "$DRY_RUN" = "1" ] && echo "  (--dry-run: no CLI/systemd/API calls will actually run)"
echo

[ "$DRY_RUN" = "1" ] || mkdir -p "$CONFIG_DIR"

# ── Step 1: CLI login state + org id auto-detect ────────────────────────────
ORG_ID="$ORG_ID_OVERRIDE"
LOGGED_IN=0
if [ "$DRY_RUN" = "1" ]; then
  echo "[1/4] (dry-run) would check: CLAUDE_CONFIG_DIR=${CONFIG_DIR} claude auth status"
elif ! command -v claude >/dev/null 2>&1; then
  echo "[1/4] 'claude' CLI not found on PATH — skipping login check."
  echo "      Once installed, re-run this script to pick up login + org id."
else
  set +e
  AUTH_STATUS="$(CLAUDE_CONFIG_DIR="$CONFIG_DIR" claude auth status 2>/dev/null)"
  set -e
  if echo "$AUTH_STATUS" | grep -q '"loggedIn": *true'; then
    LOGGED_IN=1
    if [ -z "$ORG_ID" ]; then
      ORG_ID="$(echo "$AUTH_STATUS" | { grep -o '"orgId": *"[^"]*"' || true; } | sed -E 's/.*"orgId": *"([^"]*)".*/\1/')"
    fi
    if [ -n "$ORG_ID" ]; then
      echo "[1/4] Account '${KEY}' is already logged in (org id: ${ORG_ID})."
    else
      echo "[1/4] Account '${KEY}' is already logged in, but its org id didn't come back"
      echo "      from this call. Get it directly (not through this script) with:"
      echo
      echo "        CLAUDE_CONFIG_DIR=${CONFIG_DIR} claude auth status"
      echo
      echo "      then re-run this script with --org-id <that id>."
    fi
  else
    echo "[1/4] Account '${KEY}' is NOT logged in yet. Run this ONCE, by hand:"
    echo
    echo "      CLAUDE_CONFIG_DIR=${CONFIG_DIR} claude auth login"
    echo
    echo "      Then re-run this script to auto-detect its org id and finish setup."
  fi
fi
echo

# ── Step 2: browser session cookie ───────────────────────────────────────────
if [ -s "$COOKIE_FILE" ]; then
  echo "[2/4] Cookie file already present: ${COOKIE_FILE}"
else
  echo "[2/4] No session cookie yet at ${COOKIE_FILE}. To capture it:"
  echo "      1. In a browser, log into claude.ai AS ACCOUNT '${KEY}'."
  echo "      2. Open devtools -> Application/Storage -> Cookies -> https://claude.ai"
  echo "      3. Copy the value of the 'sessionKey' cookie."
  echo "      4. Run:"
  echo
  echo "         printf '%s' '<sessionKey value>' > ${COOKIE_FILE} && chmod 600 ${COOKIE_FILE}"
  echo
  echo "      The poller no-ops safely until this file exists — nothing else here is blocked on it."
fi
echo

# ── Step 3: seed/update the claude_accounts registry via the API ────────────
if [ "$DRY_RUN" = "1" ]; then
  echo "[3/4] (dry-run) would POST ${API_BASE}/claude-accounts {key:${KEY}, config_dir:${CONFIG_DIR}, org_id:${ORG_ID:-null}, ...}"
else
  if [ -z "$API_KEY" ]; then
    if [ -f "$JARVIS_COCKPIT_ENV" ]; then
      API_KEY="$({ grep -E '^JARVIS_COCKPIT_KEY=' "$JARVIS_COCKPIT_ENV" || true; } | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
    fi
  fi
  if [ -z "$API_KEY" ]; then
    echo "[3/4] ERROR: no API key. Pass --api-key, set CLAUDE_ACCOUNTS_API_KEY, or ensure JARVIS_COCKPIT_KEY is in ${JARVIS_COCKPIT_ENV}." >&2
    exit 1
  fi

  PAYLOAD="$(node -e '
    const [key, label, configDir, cookieFile, orgId] = process.argv.slice(1);
    const obj = { key, label, config_dir: configDir, cookie_file: cookieFile, enabled: true };
    if (orgId) obj.org_id = orgId;
    process.stdout.write(JSON.stringify(obj));
  ' "$KEY" "$LABEL" "$CONFIG_DIR" "$COOKIE_FILE" "$ORG_ID")"

  RESPONSE="$(curl -fsS -X POST "${API_BASE}/claude-accounts" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")"
  echo "[3/4] Registered account '${KEY}' in claude_accounts: ${RESPONSE}"
fi
echo

# ── Step 4: install the poller (template unit instance for this account) ───
if [ "$INSTALL_UNIT" = "0" ]; then
  echo "[4/4] --no-install-unit: skipping poller install."
elif [ "$DRY_RUN" = "1" ]; then
  echo "[4/4] (dry-run) would write ${ENV_DIR}/${KEY}.env, install claude-usage-poll@.{service,timer} to ${SYSTEMD_DEST_DIR}, and enable --now claude-usage-poll@${KEY}.timer"
else
  mkdir -p "$ENV_DIR"
  ENV_FILE="${ENV_DIR}/${KEY}.env"
  # The template unit hardcodes EnvironmentFile=/home/kevin/.claude-accounts/%i.env
  # (systemd can't read $HOME). A custom --env-dir needs a matching unit edit.
  if [ "$ENV_DIR" != "/home/kevin/.claude-accounts" ]; then
    echo "      WARNING: --env-dir '${ENV_DIR}' differs from the path baked into claude-usage-poll@.service" >&2
    echo "               (/home/kevin/.claude-accounts). Edit the installed unit's EnvironmentFile= to match." >&2
  fi
  {
    echo "ACCOUNT_KEY=${KEY}"
    echo "ORG_ID=${ORG_ID}"
    echo "COOKIE_FILE=${COOKIE_FILE}"
    echo "OUT_FILE=/tmp/claude-usage-${KEY}-live.json"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  sudo install -m 0644 "${SYSTEMD_SRC_DIR}/claude-usage-poll@.service" "${SYSTEMD_DEST_DIR}/claude-usage-poll@.service"
  sudo install -m 0644 "${SYSTEMD_SRC_DIR}/claude-usage-poll@.timer" "${SYSTEMD_DEST_DIR}/claude-usage-poll@.timer"
  sudo systemctl daemon-reload
  sudo systemctl enable --now "claude-usage-poll@${KEY}.timer"

  echo "[4/4] Installed + enabled claude-usage-poll@${KEY}.timer (env file: ${ENV_FILE})"
  if [ -z "$ORG_ID" ]; then
    echo "      NOTE: org id is still unknown — the poller will no-op until you re-run this"
    echo "      script (or PATCH the registry) once account '${KEY}' has logged in."
  fi
fi
echo

echo "== done =="
if [ "$LOGGED_IN" = "1" ] && [ -s "$COOKIE_FILE" ]; then
  echo "Account '${KEY}' is fully wired: logged in, cookie present, registered, poller running."
else
  echo "Account '${KEY}' is registered; re-run this script after finishing any steps printed above."
fi
