import express from 'express';
import {
  listAllConversations,
  listActiveConversations,
  getConversationById,
  getTurns,
  countTurns,
  type ConversationRow,
  type TurnRow,
} from './conversation-db.js';
import { getActiveConversation } from './agent.js';
import { query } from './db.js';

const UI_PORT = parseInt(process.env.JARVIS_UI_PORT ?? '3201', 10);

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr + 'Z').getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTimestamp(dateStr: string): string {
  const d = new Date(dateStr + 'Z');
  return d.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function renderLayout(title: string, body: string, nav?: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — JARVIS</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; line-height: 1.5; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 960px; margin: 0 auto; padding: 16px; }
    header { background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 0; margin-bottom: 16px; }
    header .container { display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 18px; color: #f0f6fc; }
    header nav a { color: #8b949e; font-size: 14px; }
    header nav a:hover, header nav a.active { color: #f0f6fc; }
    .status-bar { display: flex; gap: 24px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; margin-bottom: 16px; font-size: 13px; }
    .status-bar .label { color: #8b949e; }
    .status-bar .value { color: #f0f6fc; font-weight: 500; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
    .badge-active { background: #1f6f2b; color: #3fb950; }
    .badge-closed { background: #3d1d26; color: #f85149; }
    .badge-running { background: #1a3a5c; color: #58a6ff; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px 12px; border-bottom: 2px solid #30363d; color: #8b949e; font-size: 12px; text-transform: uppercase; }
    td { padding: 8px 12px; border-bottom: 1px solid #21262d; font-size: 14px; }
    tr:hover td { background: #161b22; }
    .turn { border: 1px solid #30363d; border-radius: 6px; margin-bottom: 8px; overflow: hidden; }
    .turn-header { padding: 8px 12px; background: #161b22; font-size: 12px; color: #8b949e; display: flex; justify-content: space-between; }
    .turn-body { padding: 12px; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
    .turn-user .turn-header { border-left: 3px solid #58a6ff; }
    .turn-assistant .turn-header { border-left: 3px solid #3fb950; }
    .turn-tool_call .turn-header { border-left: 3px solid #d29922; }
    .turn-tool_result .turn-header { border-left: 3px solid #a371f7; }
    .section { margin-bottom: 24px; }
    .section h2 { font-size: 16px; color: #f0f6fc; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid #21262d; }
    .checkin-item { padding: 8px 12px; border: 1px solid #30363d; border-radius: 6px; margin-bottom: 6px; font-size: 13px; }
    .checkin-time { color: #d29922; font-weight: 500; }
    .empty { color: #484f58; font-style: italic; padding: 16px; }
    .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; }
    .back { margin-bottom: 12px; font-size: 14px; }
    .conv-id { color: #8b949e; font-size: 12px; font-family: monospace; }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <h1>JARVIS</h1>
      <nav>
        <a href="/" ${nav === 'home' ? 'class="active"' : ''}>Conversations</a>
        &nbsp;·&nbsp;
        <a href="/checkins" ${nav === 'checkins' ? 'class="active"' : ''}>Check-ins</a>
      </nav>
    </div>
  </header>
  <div class="container">${body}</div>
</body>
</html>`;
}

function renderStatusBar(): string {
  const active = getActiveConversation();
  const activeConvs = listActiveConversations();
  const runningHtml = active
    ? `<span class="badge badge-running">Processing</span> conv #${active.conversationId}`
    : '<span style="color:#3fb950">Idle</span>';

  return `<div class="status-bar">
    <div><span class="label">Status:</span> <span class="value">${runningHtml}</span></div>
    <div><span class="label">Active threads:</span> <span class="value">${activeConvs.length}</span></div>
    <div><span class="label">Process uptime:</span> <span class="value">${formatUptime()}</span></div>
  </div>`;
}

const processStartTime = Date.now();
function formatUptime(): string {
  const secs = Math.floor((Date.now() - processStartTime) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function renderConversationList(): string {
  const convs = listAllConversations();
  if (!convs.length) return '<div class="empty">No conversations yet.</div>';

  const active = getActiveConversation();
  const rows = convs.map((c) => {
    const turns = countTurns(c.id);
    const isRunning = active?.conversationId === c.id;
    const statusBadge = isRunning
      ? '<span class="badge badge-running">Running</span>'
      : c.status === 'active'
        ? '<span class="badge badge-active">Active</span>'
        : '<span class="badge badge-closed">Closed</span>';
    const parts = c.external_id.split(':');
    const label = parts[0] === 'slack' ? `#${parts[1]}` : parts[0];
    const threadId = parts[0] === 'slack' ? parts[2]?.slice(0, 10) : c.external_id.slice(0, 20);

    return `<tr>
      <td><a href="/conversations/${c.id}">${label}</a></td>
      <td class="conv-id">${escapeHtml(threadId ?? '')}</td>
      <td>${statusBadge}</td>
      <td>${turns}</td>
      <td>${c.claude_session_id ? escapeHtml(c.claude_session_id.slice(0, 12)) + '…' : '—'}</td>
      <td>${timeAgo(c.updated_at)}</td>
    </tr>`;
  }).join('');

  return `<table>
    <thead><tr><th>Source</th><th>Thread</th><th>Status</th><th>Turns</th><th>Session</th><th>Last Active</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderTurn(t: TurnRow): string {
  const roleLabel: Record<string, string> = {
    user: 'User',
    assistant: 'Assistant',
    tool_call: `Tool Call → ${t.tool_name ?? '?'}`,
    tool_result: `Tool Result ← ${t.tool_name ?? '?'}`,
  };
  const label = roleLabel[t.role] ?? t.role;
  let body = '';

  if (t.role === 'user' || t.role === 'assistant') {
    body = escapeHtml(t.content ?? '');
  } else if (t.role === 'tool_call') {
    body = `<span class="mono">${escapeHtml(t.tool_args ?? '{}')}</span>`;
  } else if (t.role === 'tool_result') {
    const raw = t.tool_result ?? '';
    const truncated = raw.length > 2000 ? raw.slice(0, 2000) + '\n… (truncated)' : raw;
    body = `<span class="mono">${escapeHtml(truncated)}</span>`;
  }

  return `<div class="turn turn-${escapeHtml(t.role)}">
    <div class="turn-header"><span>${escapeHtml(label)}</span><span>${formatTimestamp(t.created_at)}</span></div>
    <div class="turn-body">${body}</div>
  </div>`;
}

function renderConversationDetail(conv: ConversationRow, turns: TurnRow[]): string {
  const active = getActiveConversation();
  const isRunning = active?.conversationId === conv.id;
  const statusBadge = isRunning
    ? '<span class="badge badge-running">Running</span>'
    : conv.status === 'active'
      ? '<span class="badge badge-active">Active</span>'
      : '<span class="badge badge-closed">Closed</span>';

  const meta = `<div class="status-bar">
    <div><span class="label">ID:</span> <span class="value conv-id">${escapeHtml(conv.external_id)}</span></div>
    <div><span class="label">Status:</span> <span class="value">${statusBadge}</span></div>
    <div><span class="label">Session:</span> <span class="value mono">${conv.claude_session_id ? escapeHtml(conv.claude_session_id) : '—'}</span></div>
    <div><span class="label">Turns:</span> <span class="value">${turns.length}</span></div>
  </div>`;

  const turnsHtml = turns.length
    ? turns.map(renderTurn).join('')
    : '<div class="empty">No turns recorded yet.</div>';

  return `<div class="back"><a href="/">← All Conversations</a></div>${meta}<div class="section"><h2>Turns</h2>${turnsHtml}</div>`;
}

async function renderCheckins(): Promise<string> {
  try {
    const pending = await query<{ id: string; fire_at: string; reason: string; source_type: string; status: string }>(
      `SELECT id, fire_at, reason, source_type, status FROM jarvis_checkins WHERE status = 'pending' ORDER BY fire_at ASC LIMIT 50`,
    );
    const recent = await query<{ id: string; fire_at: string; reason: string; source_type: string; status: string }>(
      `SELECT id, fire_at, reason, source_type, status FROM jarvis_checkins WHERE status != 'pending' ORDER BY fire_at DESC LIMIT 20`,
    );

    let html = '<div class="section"><h2>Pending Check-ins</h2>';
    if (!pending.length) {
      html += '<div class="empty">No pending check-ins.</div>';
    } else {
      html += pending.map((c) => {
        const fireTime = new Date(c.fire_at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        return `<div class="checkin-item"><span class="checkin-time">${escapeHtml(fireTime)}</span> — ${escapeHtml(c.reason)} <span class="badge badge-active">${escapeHtml(c.source_type)}</span></div>`;
      }).join('');
    }
    html += '</div>';

    html += '<div class="section"><h2>Recent Check-ins</h2>';
    if (!recent.length) {
      html += '<div class="empty">No recent check-ins.</div>';
    } else {
      html += `<table><thead><tr><th>Time</th><th>Reason</th><th>Source</th><th>Status</th></tr></thead><tbody>`;
      html += recent.map((c) => {
        const fireTime = new Date(c.fire_at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const badge = c.status === 'fired' ? 'badge-active' : c.status === 'skipped' ? 'badge-closed' : '';
        return `<tr><td>${escapeHtml(fireTime)}</td><td>${escapeHtml(c.reason.slice(0, 80))}</td><td>${escapeHtml(c.source_type)}</td><td><span class="badge ${badge}">${escapeHtml(c.status)}</span></td></tr>`;
      }).join('');
      html += '</tbody></table>';
    }
    html += '</div>';

    return html;
  } catch (err) {
    return `<div class="empty">Failed to load check-ins: ${escapeHtml(String(err))}</div>`;
  }
}

export function startUiServer(): void {
  const app = express();

  app.get('/', (_req, res) => {
    const body = renderStatusBar() + renderConversationList();
    res.send(renderLayout('Dashboard', body, 'home'));
  });

  app.get('/conversations/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).send('Invalid ID'); return; }
    const conv = getConversationById(id);
    if (!conv) { res.status(404).send('Not found'); return; }
    const turns = getTurns(conv.id);
    const body = renderConversationDetail(conv, turns);
    res.send(renderLayout(`Conv #${id}`, body));
  });

  app.get('/checkins', async (_req, res) => {
    const body = renderStatusBar() + await renderCheckins();
    res.send(renderLayout('Check-ins', body, 'checkins'));
  });

  // JSON API for programmatic access
  app.get('/api/status', (_req, res) => {
    const active = getActiveConversation();
    const convs = listActiveConversations();
    res.json({
      running: !!active,
      activeConversation: active,
      activeThreads: convs.length,
      uptimeSeconds: Math.floor((Date.now() - processStartTime) / 1000),
    });
  });

  app.get('/api/conversations', (_req, res) => {
    const convs = listAllConversations();
    res.json(convs.map((c) => ({ ...c, turnCount: countTurns(c.id) })));
  });

  app.get('/api/conversations/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
    const conv = getConversationById(id);
    if (!conv) { res.status(404).json({ error: 'Not found' }); return; }
    const turns = getTurns(conv.id);
    res.json({ ...conv, turns });
  });

  app.listen(UI_PORT, () => {
    console.log(`JARVIS Observability UI: http://localhost:${UI_PORT}`);
  });
}
