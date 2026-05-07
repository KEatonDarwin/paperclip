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
import { getActiveConversation, getAdapters, getActiveAdapterInfo } from './agent.js';
import { getAllSettings, getSetting, setSetting } from './conversation-db.js';
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

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// -- JSON syntax highlighting --

function highlightJsonValue(value: unknown, depth: number): string {
  if (value === null) return '<span class="json-lit">null</span>';
  if (typeof value === 'boolean') return `<span class="json-lit">${value}</span>`;
  if (typeof value === 'number') return `<span class="json-num">${value}</span>`;
  if (typeof value === 'string') {
    const str = escapeHtml(JSON.stringify(value));
    if (str.length > 500) return `<span class="json-str">${str.slice(0, 497)}…"</span>`;
    return `<span class="json-str">${str}</span>`;
  }

  const indent = '  '.repeat(depth);
  const inner = '  '.repeat(depth + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map(v => inner + highlightJsonValue(v, depth + 1));
    return `[\n${items.join(',\n')}\n${indent}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const items = entries.map(([k, v]) =>
      `${inner}<span class="json-key">${escapeHtml(JSON.stringify(k))}</span>: ${highlightJsonValue(v, depth + 1)}`
    );
    return `{\n${items.join(',\n')}\n${indent}}`;
  }

  return escapeHtml(String(value));
}

function highlightJson(raw: string): string {
  try {
    return highlightJsonValue(JSON.parse(raw), 0);
  } catch {
    return escapeHtml(raw);
  }
}

// -- API request/response rendering --

interface ParsedClaudeEvent {
  type: string;
  subtype?: string;
  raw: Record<string, unknown>;
}

function parseStreamJsonEvents(rawOutput: string): ParsedClaudeEvent[] {
  const events: ParsedClaudeEvent[] = [];
  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      events.push({
        type: (typeof obj.type === 'string' ? obj.type : 'unknown'),
        subtype: typeof obj.subtype === 'string' ? obj.subtype : undefined,
        raw: obj,
      });
    } catch { /* skip non-JSON lines */ }
  }
  return events;
}

interface ApiTurnSummary {
  model: string | null;
  stopReason: string | null;
  requestId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function extractApiSummary(events: ParsedClaudeEvent[]): ApiTurnSummary {
  let model: string | null = null;
  let stopReason: string | null = null;
  let requestId: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  for (const ev of events) {
    const r = ev.raw;
    if (typeof r.model === 'string') model = r.model;
    if (typeof r.stop_reason === 'string') stopReason = r.stop_reason;
    if (typeof r.request_id === 'string') requestId = r.request_id;
    if (ev.type === 'result') {
      if (typeof r.stop_reason === 'string') stopReason = r.stop_reason;
      const u = r.usage as Record<string, unknown> | undefined;
      if (u) {
        if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
        if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
        if (typeof u.cache_read_input_tokens === 'number') cacheReadTokens = u.cache_read_input_tokens;
        if (typeof u.cache_creation_input_tokens === 'number') cacheWriteTokens = u.cache_creation_input_tokens;
      }
    }
  }

  return { model, stopReason, requestId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function estimateCost(summary: ApiTurnSummary): string | null {
  if (!summary.model || (!summary.inputTokens && !summary.outputTokens)) return null;
  const m = summary.model.toLowerCase();
  let inRate = 0, outRate = 0;
  if (m.includes('opus')) { inRate = 15; outRate = 75; }
  else if (m.includes('sonnet')) { inRate = 3; outRate = 15; }
  else if (m.includes('haiku')) { inRate = 0.25; outRate = 1.25; }
  else return null;

  const cacheReadRate = inRate * 0.1;
  const nonCachedInput = Math.max(0, summary.inputTokens - summary.cacheReadTokens);
  const cost =
    (nonCachedInput / 1_000_000) * inRate +
    (summary.cacheReadTokens / 1_000_000) * cacheReadRate +
    (summary.outputTokens / 1_000_000) * outRate;
  return `~$${cost.toFixed(4)}`;
}

interface ApiTurnData {
  label: string;
  claudeInput: string | null;
  claudeOutput: string | null;
  timingMs: number | null;
}

function renderApiTurn(turn: ApiTurnData, index: number): string {
  const events = turn.claudeOutput ? parseStreamJsonEvents(turn.claudeOutput) : [];
  const summary = extractApiSummary(events);
  const cost = estimateCost(summary);

  const metaParts: string[] = [];
  if (summary.model) metaParts.push(escapeHtml(summary.model));
  if (turn.timingMs) metaParts.push(formatMs(turn.timingMs));
  if (summary.stopReason) metaParts.push(`stop: ${escapeHtml(summary.stopReason)}`);
  if (summary.inputTokens || summary.outputTokens) {
    metaParts.push(`${summary.inputTokens.toLocaleString()} in / ${summary.outputTokens.toLocaleString()} out`);
  }
  if (cost) metaParts.push(cost);

  let reqIdHtml = '';
  if (summary.requestId) {
    reqIdHtml = `<span class="req-id" title="Anthropic Request ID">${escapeHtml(summary.requestId)}</span>`;
  }

  let requestBlock = '';
  if (turn.claudeInput) {
    requestBlock = `<details class="api-detail">
      <summary>Request (stdin)</summary>
      <div class="copy-wrap"><button class="copy-btn" onclick="copyJson(this)">Copy</button><pre class="text-block">${escapeHtml(turn.claudeInput)}</pre></div>
    </details>`;
  }

  let responseBlock = '';
  if (events.length) {
    const eventsJson = JSON.stringify(events.map(e => e.raw), null, 2);
    responseBlock = `<details class="api-detail">
      <summary>Response (${events.length} event${events.length !== 1 ? 's' : ''})</summary>
      <div class="copy-wrap"><button class="copy-btn" onclick="copyJson(this)">Copy</button><pre class="json-block">${highlightJson(eventsJson)}</pre></div>
    </details>`;
  } else if (turn.claudeOutput) {
    responseBlock = `<details class="api-detail">
      <summary>Response (raw)</summary>
      <div class="copy-wrap"><button class="copy-btn" onclick="copyJson(this)">Copy</button><pre class="text-block">${escapeHtml(turn.claudeOutput)}</pre></div>
    </details>`;
  }

  return `<div class="api-turn">
    <div class="api-turn-header">
      <span class="api-turn-label">${escapeHtml(turn.label)}</span>
      <div class="api-turn-meta">${metaParts.join(' · ')}${reqIdHtml ? ' · ' + reqIdHtml : ''}</div>
    </div>
    ${requestBlock}${responseBlock}
  </div>`;
}

// -- Exchange grouping --

interface ToolCallPair { call: TurnRow; result: TurnRow | null }
interface Exchange { user?: TurnRow; toolCalls: ToolCallPair[]; assistant?: TurnRow }

function groupTurnsIntoExchanges(turns: TurnRow[]): Exchange[] {
  const exchanges: Exchange[] = [];
  let current: Exchange = { toolCalls: [] };

  for (const t of turns) {
    if (t.role === 'user') {
      if (current.user || current.assistant || current.toolCalls.length) {
        exchanges.push(current);
        current = { toolCalls: [] };
      }
      current.user = t;
    } else if (t.role === 'tool_call') {
      current.toolCalls.push({ call: t, result: null });
    } else if (t.role === 'tool_result') {
      const last = current.toolCalls[current.toolCalls.length - 1];
      if (last && !last.result) last.result = t;
    } else if (t.role === 'assistant') {
      current.assistant = t;
      exchanges.push(current);
      current = { toolCalls: [] };
    }
  }

  if (current.user || current.assistant || current.toolCalls.length) {
    exchanges.push(current);
  }

  return exchanges;
}

// -- Layout --

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
    .status-bar { display: flex; gap: 24px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; margin-bottom: 16px; font-size: 13px; flex-wrap: wrap; }
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
    .msg { border: 1px solid #30363d; border-radius: 6px; margin-bottom: 8px; overflow: hidden; }
    .msg-header { padding: 8px 12px; background: #161b22; font-size: 12px; color: #8b949e; display: flex; justify-content: space-between; align-items: center; }
    .msg-body { padding: 12px; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
    .msg-user .msg-header { border-left: 3px solid #58a6ff; }
    .msg-assistant .msg-header { border-left: 3px solid #3fb950; }
    .debug-panel { border-top: 1px solid #21262d; }
    .debug-panel[open] { background: #0d1117; }
    .debug-summary { padding: 8px 12px; font-size: 12px; color: #8b949e; cursor: pointer; display: flex; gap: 12px; align-items: center; list-style: none; user-select: none; }
    .debug-summary::-webkit-details-marker { display: none; }
    .debug-summary:hover { background: #161b22; color: #c9d1d9; }
    .debug-badge { background: #1a3a5c; color: #58a6ff; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
    .debug-stat { color: #6e7681; font-size: 11px; }
    .debug-content { padding: 8px 12px; }
    .tool-group { border: 1px solid #21262d; border-radius: 4px; margin-bottom: 6px; overflow: hidden; }
    .tool-group-header { padding: 6px 10px; background: #161b22; font-size: 12px; display: flex; justify-content: space-between; align-items: center; }
    .tool-name { color: #d29922; font-weight: 500; font-family: 'SF Mono', 'Fira Code', monospace; }
    .tool-timing { color: #6e7681; font-size: 11px; }
    .tool-detail { border-top: 1px solid #21262d; }
    .tool-detail summary { padding: 4px 10px; font-size: 12px; color: #8b949e; cursor: pointer; }
    .tool-detail summary:hover { color: #c9d1d9; }
    .json-block { padding: 8px 10px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; margin: 0; background: #0d1117; color: #c9d1d9; }
    .json-key { color: #79c0ff; }
    .json-str { color: #a5d6ff; }
    .json-num { color: #d2a8ff; }
    .json-lit { color: #ff7b72; }
    .copy-wrap { position: relative; }
    .copy-btn { position: absolute; top: 4px; right: 4px; background: #21262d; border: 1px solid #30363d; color: #8b949e; padding: 2px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; z-index: 1; }
    .copy-btn:hover { color: #f0f6fc; background: #30363d; }
    .token-bar { display: flex; gap: 16px; padding: 6px 10px; font-size: 11px; color: #6e7681; background: #161b22; border-top: 1px solid #21262d; flex-wrap: wrap; }
    .token-bar .tk-label { color: #484f58; }
    .api-panel { border-top: 1px solid #21262d; }
    .api-panel[open] { background: #0d1117; }
    .api-summary { padding: 8px 12px; font-size: 12px; color: #8b949e; cursor: pointer; display: flex; gap: 12px; align-items: center; list-style: none; user-select: none; }
    .api-summary::-webkit-details-marker { display: none; }
    .api-summary:hover { background: #161b22; color: #c9d1d9; }
    .api-badge { background: #2d1b3d; color: #d2a8ff; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
    .api-turn { border: 1px solid #21262d; border-radius: 4px; margin-bottom: 6px; overflow: hidden; }
    .api-turn-header { padding: 6px 10px; background: #161b22; font-size: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
    .api-turn-label { color: #d2a8ff; font-weight: 500; }
    .api-turn-meta { display: flex; gap: 12px; font-size: 11px; color: #6e7681; flex-wrap: wrap; }
    .api-turn-meta .req-id { color: #d29922; font-family: 'SF Mono', 'Fira Code', monospace; }
    .api-detail { border-top: 1px solid #21262d; }
    .api-detail summary { padding: 4px 10px; font-size: 12px; color: #8b949e; cursor: pointer; }
    .api-detail summary:hover { color: #c9d1d9; }
    .api-events { padding: 0; }
    .api-event { border-top: 1px solid #21262d; }
    .api-event-header { padding: 4px 10px; font-size: 11px; color: #6e7681; display: flex; gap: 8px; align-items: center; }
    .api-event-type { color: #d2a8ff; font-weight: 500; font-family: 'SF Mono', 'Fira Code', monospace; }
    .text-block { padding: 8px 10px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; margin: 0; background: #0d1117; color: #c9d1d9; }
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
        &nbsp;·&nbsp;
        <a href="/settings" ${nav === 'settings' ? 'class="active"' : ''}>Settings</a>
      </nav>
      <div style="margin-left:auto; font-size:12px; color:#8b949e;">
        ${(() => { const info = getActiveAdapterInfo(); const adapters = getAdapters(); const a = adapters[info.adapter]; return `<span style="color:#d2a8ff;">${escapeHtml(a?.name ?? info.adapter)}</span> · <span style="color:#3fb950;">${escapeHtml(info.model ?? 'default')}</span>`; })()}
      </div>
    </div>
  </header>
  <div class="container">${body}</div>
  <script>
  function copyJson(btn){var p=btn.closest('.copy-wrap').querySelector('pre');navigator.clipboard.writeText(p.textContent).then(function(){btn.textContent='Copied!';setTimeout(function(){btn.textContent='Copy'},1500)})}
  </script>
</body>
</html>`;
}

// -- Status / List --

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

// -- Exchange rendering --

function renderExchange(ex: Exchange): string {
  let html = '';

  if (ex.user) {
    html += `<div class="msg msg-user">
      <div class="msg-header"><span>User</span><span>${formatTimestamp(ex.user.created_at)}</span></div>
      <div class="msg-body">${escapeHtml(ex.user.content ?? '')}</div>
    </div>`;
  }

  if (ex.assistant || ex.toolCalls.length) {
    const content = ex.assistant?.content ?? '';
    const ts = ex.assistant?.created_at ?? ex.toolCalls[0]?.call.created_at ?? '';

    let totalModelMs = 0;
    let totalToolMs = 0;
    let totalIn = 0;
    let totalOut = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let model: string | null = null;

    for (const tc of ex.toolCalls) {
      if (tc.call.timing_ms) totalModelMs += tc.call.timing_ms;
      if (tc.result?.timing_ms) totalToolMs += tc.result.timing_ms;
      if (tc.call.input_tokens) totalIn += tc.call.input_tokens;
      if (tc.call.output_tokens) totalOut += tc.call.output_tokens;
      if (tc.call.cache_read_tokens) totalCacheRead += tc.call.cache_read_tokens;
      if (tc.call.cache_write_tokens) totalCacheWrite += tc.call.cache_write_tokens;
      if (tc.call.model) model = tc.call.model;
    }
    if (ex.assistant) {
      if (ex.assistant.timing_ms) totalModelMs += ex.assistant.timing_ms;
      if (ex.assistant.input_tokens) totalIn += ex.assistant.input_tokens;
      if (ex.assistant.output_tokens) totalOut += ex.assistant.output_tokens;
      if (ex.assistant.cache_read_tokens) totalCacheRead += ex.assistant.cache_read_tokens;
      if (ex.assistant.cache_write_tokens) totalCacheWrite += ex.assistant.cache_write_tokens;
      if (ex.assistant.model) model = ex.assistant.model;
    }

    const hasDebug = ex.toolCalls.length > 0 || totalModelMs > 0 || totalIn > 0;
    let debugHtml = '';

    if (hasDebug) {
      const stats: string[] = [];
      if (totalModelMs) stats.push(`<span class="debug-stat">Model: ${formatMs(totalModelMs)}</span>`);
      if (totalToolMs) stats.push(`<span class="debug-stat">Tools: ${formatMs(totalToolMs)}</span>`);
      if (totalIn || totalOut) {
        let tok = `${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out`;
        if (totalCacheRead) tok += ` (${totalCacheRead.toLocaleString()} cached)`;
        stats.push(`<span class="debug-stat">Tokens: ${tok}</span>`);
      }
      if (model) stats.push(`<span class="debug-stat">${escapeHtml(model)}</span>`);

      const badge = ex.toolCalls.length > 0
        ? `<span class="debug-badge">${ex.toolCalls.length} tool call${ex.toolCalls.length !== 1 ? 's' : ''}</span>`
        : '<span class="debug-badge">debug</span>';

      let toolsHtml = '';
      for (const tc of ex.toolCalls) {
        const cMs = tc.call.timing_ms ? `Model: ${formatMs(tc.call.timing_ms)}` : '';
        const rMs = tc.result?.timing_ms ? `Exec: ${formatMs(tc.result.timing_ms)}` : '';
        const timingStr = [cMs, rMs].filter(Boolean).join(' → ');

        let argsBlock = '';
        if (tc.call.tool_args) {
          argsBlock = `<details class="tool-detail">
            <summary>Arguments</summary>
            <div class="copy-wrap"><button class="copy-btn" onclick="copyJson(this)">Copy</button><pre class="json-block">${highlightJson(tc.call.tool_args)}</pre></div>
          </details>`;
        }

        let resultBlock = '';
        if (tc.result?.tool_result) {
          resultBlock = `<details class="tool-detail">
            <summary>Result</summary>
            <div class="copy-wrap"><button class="copy-btn" onclick="copyJson(this)">Copy</button><pre class="json-block">${highlightJson(tc.result.tool_result)}</pre></div>
          </details>`;
        }

        toolsHtml += `<div class="tool-group">
          <div class="tool-group-header">
            <span class="tool-name">${escapeHtml(tc.call.tool_name ?? '?')}</span>
            ${timingStr ? `<span class="tool-timing">${timingStr}</span>` : ''}
          </div>
          ${argsBlock}${resultBlock}
        </div>`;
      }

      let tokenBar = '';
      if (totalIn || totalOut) {
        tokenBar = `<div class="token-bar">
          <span><span class="tk-label">In:</span> ${totalIn.toLocaleString()}</span>
          <span><span class="tk-label">Out:</span> ${totalOut.toLocaleString()}</span>
          ${totalCacheRead ? `<span><span class="tk-label">Cache read:</span> ${totalCacheRead.toLocaleString()}</span>` : ''}
          ${totalCacheWrite ? `<span><span class="tk-label">Cache write:</span> ${totalCacheWrite.toLocaleString()}</span>` : ''}
        </div>`;
      }

      debugHtml = `<details class="debug-panel">
        <summary class="debug-summary">${badge}${stats.join('')}</summary>
        <div class="debug-content">${toolsHtml}</div>
        ${tokenBar}
      </details>`;
    }

    // API Request/Response panel — collect all Claude invocations in this exchange
    const apiTurns: ApiTurnData[] = [];
    for (let i = 0; i < ex.toolCalls.length; i++) {
      const tc = ex.toolCalls[i];
      if (tc.call.claude_input || tc.call.claude_output) {
        apiTurns.push({
          label: `Claude → ${escapeHtml(tc.call.tool_name ?? 'tool_use')}`,
          claudeInput: tc.call.claude_input,
          claudeOutput: tc.call.claude_output,
          timingMs: tc.call.timing_ms,
        });
      }
    }
    if (ex.assistant && (ex.assistant.claude_input || ex.assistant.claude_output)) {
      apiTurns.push({
        label: 'Claude → response',
        claudeInput: ex.assistant.claude_input,
        claudeOutput: ex.assistant.claude_output,
        timingMs: ex.assistant.timing_ms,
      });
    }

    let apiHtml = '';
    if (apiTurns.length > 0) {
      const apiTurnsHtml = apiTurns.map((t, i) => renderApiTurn(t, i)).join('');
      apiHtml = `<details class="api-panel">
        <summary class="api-summary"><span class="api-badge">${apiTurns.length} API turn${apiTurns.length !== 1 ? 's' : ''}</span><span class="debug-stat">Raw Claude request/response</span></summary>
        <div class="debug-content">${apiTurnsHtml}</div>
      </details>`;
    }

    html += `<div class="msg msg-assistant">
      <div class="msg-header"><span>Assistant</span><span>${ts ? formatTimestamp(ts) : ''}</span></div>
      ${content ? `<div class="msg-body">${escapeHtml(content)}</div>` : ''}
      ${debugHtml}
      ${apiHtml}
    </div>`;
  }

  return html;
}

function renderConversationDetail(conv: ConversationRow, turns: TurnRow[]): string {
  const active = getActiveConversation();
  const isRunning = active?.conversationId === conv.id;
  const statusBadge = isRunning
    ? '<span class="badge badge-running">Running</span>'
    : conv.status === 'active'
      ? '<span class="badge badge-active">Active</span>'
      : '<span class="badge badge-closed">Closed</span>';

  const exchanges = groupTurnsIntoExchanges(turns);
  const userTurns = turns.filter(t => t.role === 'user' || t.role === 'assistant').length;

  const meta = `<div class="status-bar">
    <div><span class="label">ID:</span> <span class="value conv-id">${escapeHtml(conv.external_id)}</span></div>
    <div><span class="label">Status:</span> <span class="value">${statusBadge}</span></div>
    <div><span class="label">Session:</span> <span class="value mono">${conv.claude_session_id ? escapeHtml(conv.claude_session_id) : '—'}</span></div>
    <div><span class="label">Messages:</span> <span class="value">${userTurns}</span></div>
    <div><span class="label">Tool calls:</span> <span class="value">${turns.filter(t => t.role === 'tool_call').length}</span></div>
  </div>`;

  const exchangesHtml = exchanges.length
    ? exchanges.map(renderExchange).join('')
    : '<div class="empty">No turns recorded yet.</div>';

  return `<div class="back"><a href="/">← All Conversations</a></div>${meta}<div class="section"><h2>Conversation</h2>${exchangesHtml}</div>`;
}

// -- Check-ins --

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

// -- Settings page --

function renderSettingsPage(): string {
  const adapters = getAdapters();
  const info = getActiveAdapterInfo();
  const currentAdapter = adapters[info.adapter] ?? adapters.claude;
  const currentModel = info.model ?? '';

  const adapterOptions = Object.values(adapters).map(a =>
    `<option value="${escapeHtml(a.id)}" ${a.id === currentAdapter.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`
  ).join('');

  const adapterModelsJson = JSON.stringify(
    Object.fromEntries(Object.values(adapters).map(a => [a.id, a.models]))
  );

  return `
    <div class="section">
      <h2>Settings</h2>
      <form id="settings-form" style="max-width: 480px;">
        <div style="margin-bottom: 16px;">
          <label style="display:block; color:#8b949e; font-size:13px; margin-bottom:4px;">Adapter / Provider</label>
          <select id="adapter-select" name="adapter" style="width:100%; padding:8px 12px; background:#161b22; border:1px solid #30363d; border-radius:6px; color:#f0f6fc; font-size:14px;">
            ${adapterOptions}
          </select>
        </div>
        <div style="margin-bottom: 16px;">
          <label style="display:block; color:#8b949e; font-size:13px; margin-bottom:4px;">Model</label>
          <select id="model-select" name="model" style="width:100%; padding:8px 12px; background:#161b22; border:1px solid #30363d; border-radius:6px; color:#f0f6fc; font-size:14px;">
          </select>
          <div style="color:#484f58; font-size:12px; margin-top:4px;">Leave as "Default" to use the adapter's default model.</div>
        </div>
        <div id="save-status" style="display:none; padding:8px 12px; border-radius:6px; margin-bottom:12px; font-size:13px;"></div>
        <button type="submit" style="padding:8px 20px; background:#238636; border:1px solid #2ea043; border-radius:6px; color:#fff; font-size:14px; cursor:pointer; font-weight:500;">
          Save Settings
        </button>
        <span id="session-warning" style="display:none; margin-left:12px; color:#d29922; font-size:12px;">
          ⚠ Changing adapter will reset active sessions
        </span>
      </form>
    </div>

    <div class="section" style="margin-top: 24px;">
      <h2>Current Configuration</h2>
      <div class="status-bar">
        <div><span class="label">Adapter:</span> <span class="value">${escapeHtml(currentAdapter.name)}</span></div>
        <div><span class="label">Model:</span> <span class="value">${escapeHtml(currentModel || 'default')}</span></div>
        <div><span class="label">Binary:</span> <span class="value mono">${escapeHtml(currentAdapter.bin)}</span></div>
      </div>
    </div>

    <script>
    (function() {
      var adapterModels = ${adapterModelsJson};
      var adapterSel = document.getElementById('adapter-select');
      var modelSel = document.getElementById('model-select');
      var form = document.getElementById('settings-form');
      var status = document.getElementById('save-status');
      var warning = document.getElementById('session-warning');
      var origAdapter = '${escapeHtml(currentAdapter.id)}';
      var currentModel = '${escapeHtml(currentModel)}';

      function populateModels(adapterId) {
        var models = adapterModels[adapterId] || [];
        modelSel.innerHTML = '<option value="">Default</option>';
        models.forEach(function(m) {
          var opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.label + ' (' + m.id + ')';
          if (m.id === currentModel && adapterId === origAdapter) opt.selected = true;
          modelSel.appendChild(opt);
        });
      }

      populateModels(adapterSel.value);

      adapterSel.addEventListener('change', function() {
        currentModel = '';
        populateModels(this.value);
        warning.style.display = this.value !== origAdapter ? 'inline' : 'none';
      });

      form.addEventListener('submit', function(e) {
        e.preventDefault();
        var body = { adapter: adapterSel.value, model: modelSel.value };
        fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).then(function(r) { return r.json(); }).then(function(data) {
          if (data.ok) {
            status.textContent = 'Settings saved. Changes apply to new turns.';
            status.style.background = '#1f6f2b';
            status.style.color = '#3fb950';
            status.style.display = 'block';
            origAdapter = body.adapter;
            currentModel = body.model;
            warning.style.display = 'none';
            setTimeout(function() { location.reload(); }, 1200);
          } else {
            status.textContent = 'Error: ' + (data.error || 'unknown');
            status.style.background = '#3d1d26';
            status.style.color = '#f85149';
            status.style.display = 'block';
          }
        }).catch(function(err) {
          status.textContent = 'Network error: ' + err.message;
          status.style.background = '#3d1d26';
          status.style.color = '#f85149';
          status.style.display = 'block';
        });
      });
    })();
    </script>`;
}

// -- Server --

export function startUiServer(): void {
  const app = express();
  app.use(express.json());

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

  app.get('/settings', (_req, res) => {
    const body = renderSettingsPage();
    res.send(renderLayout('Settings', body, 'settings'));
  });

  app.get('/api/settings', (_req, res) => {
    const settings = getAllSettings();
    const adapters = getAdapters();
    const info = getActiveAdapterInfo();
    res.json({ settings, activeAdapter: info.adapter, activeModel: info.model, adapters: Object.values(adapters).map(a => ({ id: a.id, name: a.name, models: a.models })) });
  });

  app.post('/api/settings', (req, res) => {
    const { adapter, model } = req.body as { adapter?: string; model?: string };
    const adapters = getAdapters();

    if (adapter != null) {
      if (!adapters[adapter]) {
        res.json({ ok: false, error: `Unknown adapter: ${adapter}` });
        return;
      }
      setSetting('adapter', adapter);
    }

    if (model != null) {
      if (model === '') {
        setSetting('model', '');
      } else {
        setSetting('model', model);
      }
    }

    const info = getActiveAdapterInfo();
    res.json({ ok: true, adapter: info.adapter, model: info.model });
  });

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
