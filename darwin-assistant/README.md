# Darwin Assistant

An external AI assistant for Darwin Investor Network. Runs **outside** of Paperclip with full database read/write access, a Slack bot interface, and an HTTP webhook for Apple Watch / Siri Shortcut intake.

## Architecture

```
Apple Watch (Siri dictation)
  → Siri Shortcut → POST /api/intake
    → Agent (Claude claude-sonnet-4-5 + tools)
      → Paperclip DB (reads) / Paperclip API (writes)
      → Google Calendar
      → Slack (response / clarification)

Slack DM
  → Slack bot (Socket Mode)
    → Agent (same pipeline)
      → Paperclip DB / API / Calendar
      → Slack thread reply
```

## Setup

### 1. Install dependencies

```bash
cd darwin-assistant
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `PAPERCLIP_BOARD_API_KEY` | Paperclip → Settings → API Keys → New Board Key |
| `SLACK_BOT_TOKEN` | api.slack.com → your app → OAuth & Permissions |
| `SLACK_APP_TOKEN` | api.slack.com → your app → Basic Information → App-Level Tokens |

### 3. Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From manifest
2. Paste this manifest:

```yaml
display_information:
  name: Darwin Assistant
features:
  bot_user:
    display_name: Darwin
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:history
      - im:read
      - im:write
      - reactions:write
      - reactions:read
      - commands
settings:
  event_subscriptions:
    bot_events:
      - message.im
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
  token_rotation_enabled: false
```

3. Enable **Socket Mode** in Settings → Socket Mode → Generate an App-Level Token with `connections:write` scope
4. Install the app to your workspace
5. Message **@Darwin** directly (DM) to chat

### 4. Run

```bash
# Development (auto-restart on changes)
npm run dev

# Production (systemd — recommended)
./deploy.sh
```

### 5. Systemd Service (Production)

JARVIS runs as a systemd service that auto-starts on boot and auto-restarts on crash.

```bash
# View status
systemctl status jarvis

# View logs (follow)
journalctl -u jarvis -f

# Restart after code changes
./deploy.sh          # builds + restarts
# or manually:
npm run build && sudo systemctl restart jarvis

# Stop / start
sudo systemctl stop jarvis
sudo systemctl start jarvis
```

The service unit file lives at `/etc/systemd/system/jarvis.service` (source: `jarvis.service` in this directory). If you edit the source, re-install with:
```bash
sudo cp jarvis.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart jarvis
```

The service starts:
- **Webhook** on `http://localhost:3200`
- **Slack bot** via Socket Mode (no public URL needed)
- **Observability UI** on `http://localhost:3201`

JARVIS status is visible on the Paperclip dashboard (green/red indicator with uptime and memory).

## Apple Watch / Siri Shortcut

Create a Shortcut on your iPhone/Watch:
1. **Dictate Text** action
2. **Get Contents of URL** action:
   - URL: `http://<pi-ip>:3200/api/intake`
   - Method: POST
   - Headers: `Content-Type: application/json`
   - Body (JSON): `{"text": "[Dictated Text]", "source": "watch"}`
3. **Show Result** — displays the assistant's response

The Pi must be reachable from your phone (same LAN, or via Tailscale).

## Google Calendar

The calendar tool uses a Google Service Account key. The `gog-auth.json` already present in the repo root should work if it has Calendar API access. Set `GOOGLE_SERVICE_ACCOUNT_KEY` to its path if needed.

Make sure the service account email is added as a guest/editor on the calendar you want to write to, or use a personal calendar via OAuth (swap the auth method in `src/tools/calendar.ts`).

## Tools available to the agent

| Tool | Description |
|---|---|
| `createIssue` | Create a Paperclip issue/task |
| `searchIssues` | Search issues by status, keyword, assignee |
| `getIssue` | Full issue details + recent comments |
| `updateIssueStatus` | Move issue to new status, optional comment |
| `addComment` | Post a comment on an issue |
| `listAgents` | List agents and their current status |
| `listProjects` | List projects with open issue counts |
| `getSystemHealth` | Quick health snapshot |
| `createCalendarEvent` | Add an event to Google Calendar |

## Extending

- Add more tools in `src/tools/` and export from `src/tools/index.ts`
- Modify the system prompt in `src/prompt.ts` to adjust behavior
- Swap model in `src/agent.ts` (`anthropic('claude-opus-4-5')` for heavier tasks)
