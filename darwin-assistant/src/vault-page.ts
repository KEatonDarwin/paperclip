import { Router, type Request, type Response } from 'express';
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { runClaude, parseToolCall } from './agent.js';
import {
  readWikiPage,
  writeWikiPage,
  listWikiPages,
  searchWiki,
  readMemory,
  writeMemory,
} from './tools/wiki.js';
import type { ToolDef } from './tools/index.js';

const VAULT_ROOT = '/home/kevin/obsidian/paperclip-wiki';
const MAX_HOLLOW_TURNS = 20;

function safePath(userPath: string): string {
  const resolved = resolve(VAULT_ROOT, userPath);
  const rel = relative(VAULT_ROOT, resolved);
  if (rel.startsWith('..') || resolve(VAULT_ROOT, rel) !== resolved) {
    throw new Error(`Path escapes vault root: ${userPath}`);
  }
  return resolved;
}

// -- Reusable vault accessors (shared by the legacy /api/vault/* routes below
// and the auth'd /api/v1/vault/* cockpit routes in handlers/api-v1.ts). Same
// path-safety contract; throw on escape so callers can 400/500 uniformly.
export type VaultEntry = { name: string; type: 'directory' | 'file' };

export async function listVaultTree(path: string): Promise<{ path: string; items: VaultEntry[] }> {
  const abs = safePath(path || '');
  const entries = await readdir(abs, { withFileTypes: true });
  const items: VaultEntry[] = entries
    .filter(e => !e.name.startsWith('.'))
    .map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
  return { path: path || '/', items };
}

export async function readVaultFile(path: string): Promise<{ path: string; content: string }> {
  const abs = safePath(path);
  const content = await readFile(abs, 'utf-8');
  return { path, content };
}

export async function searchVault(q: string): Promise<{ query: string; results: { path: string; matchLine: string }[] }> {
  const result = await searchWiki.execute({ keyword: q, max_results: 30 }) as { results?: { path: string; matchLine: string }[] };
  return { query: q, results: result.results ?? [] };
}

// ——— Hollow JARVIS Chat Engine ———

const HOLLOW_TOOLS: ToolDef[] = [
  readWikiPage, writeWikiPage, listWikiPages, searchWiki, readMemory, writeMemory,
];
const HOLLOW_TOOL_MAP = new Map(HOLLOW_TOOLS.map(t => [t.name, t]));

interface HollowMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

let hollowSessionId: string | null = null;
let hollowMessages: HollowMessage[] = [];
let hollowBusy = false;

function buildHollowSystemPrompt(): string {
  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  return `You are JARVIS — Kevin's personal AI assistant, running in Memory Vault mode.

In this mode, you ONLY have access to the Obsidian wiki vault and your persistent memory file. You cannot access SHIM, Paperclip, Calendar, or any other systems.

## Current Time
${now} (US Central)

## What you can do
- Read, search, and browse the Obsidian wiki vault
- Read and update your persistent memory file (agent-memory/jarvis/memory.md)
- Answer questions about what's stored in the vault
- Add, edit, or organize information in the vault and memory

## When to use memory vs. wiki
- **Memory** (read_memory/write_memory): Kevin's personal preferences, commitments, things to remember
- **Wiki** (read_wiki_page/write_wiki_page): Shared company knowledge, agent docs, runbooks
- **Search** (search_wiki): Find things across the entire vault by keyword

## Rules
- Be concise and direct
- Search before answering to verify what's actually in the vault
- If you can't find something, say so clearly
- Don't hallucinate — only report what's in the vault`;
}

function buildHollowToolsBlock(): string {
  const defs = HOLLOW_TOOLS.map(
    (t) => `### ${t.name}\n${t.description}\nParameters: ${JSON.stringify(t.parameters, null, 2)}`,
  ).join('\n\n');

  return [
    '## Tools',
    'When you need to call a tool, output EXACTLY this format then STOP:',
    '<tool_call>',
    '{"name": "tool_name", "arguments": {"param": "value"}}',
    '</tool_call>',
    '',
    'Available tools:',
    defs,
  ].join('\n');
}

function buildHollowInitialPrompt(userMessage: string): string {
  return [
    buildHollowSystemPrompt(),
    buildHollowToolsBlock(),
    '---',
    `Human: ${userMessage}`,
    'Assistant:',
  ].join('\n\n');
}

async function runHollowChat(userMessage: string): Promise<string> {
  hollowMessages.push({
    role: 'user',
    content: userMessage,
    timestamp: new Date().toISOString(),
  });

  let stdinContent: string;
  if (hollowSessionId) {
    stdinContent = userMessage;
  } else {
    stdinContent = buildHollowInitialPrompt(userMessage);
  }

  for (let turn = 0; turn < MAX_HOLLOW_TURNS; turn++) {
    let result = await runClaude(stdinContent, hollowSessionId);

    if (hollowSessionId && !result.text && !result.sessionId) {
      hollowSessionId = null;
      stdinContent = buildHollowInitialPrompt(userMessage);
      result = await runClaude(stdinContent, null);
    }

    if (result.sessionId) {
      hollowSessionId = result.sessionId;
    }

    const toolCall = parseToolCall(result.text);
    if (!toolCall) {
      hollowMessages.push({
        role: 'assistant',
        content: result.text,
        timestamp: new Date().toISOString(),
      });
      return result.text;
    }

    const tool = HOLLOW_TOOL_MAP.get(toolCall.name);
    let toolResult: unknown;
    try {
      toolResult = tool
        ? await tool.execute(toolCall.arguments)
        : { error: `Unknown tool: ${toolCall.name}` };
    } catch (err) {
      toolResult = { error: err instanceof Error ? err.message : String(err) };
    }

    stdinContent = `<tool_result name="${toolCall.name}">\n${JSON.stringify(toolResult, null, 2)}\n</tool_result>`;
  }

  const msg = 'Tool call limit reached. Please try a simpler question.';
  hollowMessages.push({ role: 'assistant', content: msg, timestamp: new Date().toISOString() });
  return msg;
}

// ——— Page Rendering ———

type RenderLayoutFn = (title: string, body: string, nav?: string, scripts?: string) => string;

function renderVaultBody(): string {
  return `
    <style>
      body .container { max-width: 1400px; }
      .vault-layout { display: flex; flex-direction: column; height: calc(100vh - 76px); gap: 8px; }
      .vault-search-bar { display: flex; gap: 8px; align-items: center; }
      .vault-search-bar input { flex: 1; padding: 8px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; color: #f0f6fc; font-size: 14px; outline: none; }
      .vault-search-bar input:focus { border-color: #58a6ff; }
      .vault-search-bar button { padding: 8px 16px; background: #21262d; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 13px; cursor: pointer; white-space: nowrap; }
      .vault-search-bar button:hover { background: #30363d; color: #f0f6fc; }
      .vault-main { display: flex; flex: 1; min-height: 0; gap: 8px; }
      .vault-tree { width: 260px; min-width: 200px; overflow-y: auto; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px; font-size: 13px; font-family: 'SF Mono', 'Fira Code', monospace; }
      .tree-item { padding: 3px 6px; cursor: pointer; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tree-item:hover { background: #21262d; }
      .tree-item.active { background: #1a3a5c; color: #58a6ff; }
      .tree-dir { color: #d29922; }
      .tree-file { color: #c9d1d9; }
      .tree-children { padding-left: 16px; }
      .tree-loading { color: #484f58; font-style: italic; padding: 8px; }
      .tree-toggle { display: inline-block; width: 14px; color: #6e7681; }
      .vault-content { flex: 1; overflow-y: auto; background: #161b22; border: 1px solid #30363d; border-radius: 6px; display: flex; flex-direction: column; }
      .vault-breadcrumb { padding: 8px 12px; font-size: 12px; color: #8b949e; border-bottom: 1px solid #21262d; font-family: 'SF Mono', 'Fira Code', monospace; min-height: 33px; }
      .vault-breadcrumb span.bc-active { color: #f0f6fc; }
      .vault-toolbar { display: flex; gap: 4px; padding: 6px 12px; border-bottom: 1px solid #21262d; align-items: center; }
      .vault-toolbar button { padding: 4px 12px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #8b949e; font-size: 12px; cursor: pointer; }
      .vault-toolbar button:hover { color: #f0f6fc; background: #30363d; }
      .vault-toolbar button.vt-active { background: #1a3a5c; color: #58a6ff; border-color: #1a3a5c; }
      #vault-viewer { flex: 1; overflow-y: auto; padding: 16px; }
      #vault-search-results { flex: 1; overflow-y: auto; padding: 16px; }
      .vault-empty { color: #484f58; font-style: italic; }
      .rendered-content { line-height: 1.6; color: #c9d1d9; }
      .rendered-content h1 { font-size: 24px; color: #f0f6fc; margin: 16px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #21262d; }
      .rendered-content h2 { font-size: 20px; color: #f0f6fc; margin: 14px 0 6px; }
      .rendered-content h3 { font-size: 16px; color: #f0f6fc; margin: 12px 0 4px; }
      .rendered-content h4 { font-size: 14px; color: #f0f6fc; margin: 10px 0 4px; }
      .rendered-content p { margin: 8px 0; }
      .rendered-content code { background: #21262d; padding: 2px 6px; border-radius: 3px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; }
      .rendered-content pre { background: #0d1117; padding: 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
      .rendered-content pre code { background: none; padding: 0; }
      .rendered-content blockquote { border-left: 3px solid #30363d; padding-left: 12px; color: #8b949e; margin: 8px 0; }
      .rendered-content ul, .rendered-content ol { padding-left: 24px; margin: 8px 0; }
      .rendered-content li { margin: 2px 0; }
      .rendered-content a { color: #58a6ff; }
      .rendered-content table { border-collapse: collapse; margin: 8px 0; }
      .rendered-content th, .rendered-content td { border: 1px solid #30363d; padding: 6px 12px; }
      .rendered-content th { background: #21262d; }
      .rendered-content hr { border: none; border-top: 1px solid #21262d; margin: 16px 0; }
      .raw-content { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; white-space: pre-wrap; word-break: break-word; color: #c9d1d9; line-height: 1.5; }
      .edit-area { width: 100%; min-height: 400px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; padding: 12px; resize: vertical; line-height: 1.5; outline: none; }
      .edit-area:focus { border-color: #58a6ff; }
      .edit-actions { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
      .btn-save { padding: 6px 16px; background: #238636; border: 1px solid #2ea043; border-radius: 6px; color: #fff; font-size: 13px; cursor: pointer; }
      .btn-save:hover { background: #2ea043; }
      .btn-cancel { padding: 6px 16px; background: #21262d; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 13px; cursor: pointer; }
      .btn-cancel:hover { background: #30363d; }
      .save-status { font-size: 12px; }
      .search-result { padding: 8px 12px; border: 1px solid #21262d; border-radius: 6px; margin-bottom: 6px; cursor: pointer; }
      .search-result:hover { background: #21262d; }
      .search-path { color: #58a6ff; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; }
      .search-match { color: #8b949e; font-size: 12px; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .vault-chat { height: 280px; min-height: 200px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; display: flex; flex-direction: column; flex-shrink: 0; }
      .vault-chat-header { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid #21262d; }
      .vault-chat-header button { padding: 4px 10px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #8b949e; font-size: 11px; cursor: pointer; }
      .vault-chat-header button:hover { color: #f0f6fc; background: #30363d; }
      .vault-chat-messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
      .chat-empty { color: #484f58; font-style: italic; font-size: 13px; }
      .chat-msg { max-width: 80%; padding: 8px 12px; border-radius: 8px; font-size: 13px; line-height: 1.4; word-break: break-word; white-space: pre-wrap; }
      .chat-user { align-self: flex-end; background: #1a3a5c; color: #a5d6ff; border-bottom-right-radius: 2px; }
      .chat-assistant { align-self: flex-start; background: #1a3321; color: #afd9ab; border-bottom-left-radius: 2px; }
      .chat-thinking { align-self: flex-start; color: #8b949e; font-style: italic; font-size: 12px; }
      .vault-chat-input { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid #21262d; }
      .vault-chat-input input { flex: 1; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #f0f6fc; font-size: 13px; outline: none; }
      .vault-chat-input input:focus { border-color: #58a6ff; }
      .vault-chat-input button { padding: 8px 16px; background: #238636; border: 1px solid #2ea043; border-radius: 6px; color: #fff; font-size: 13px; cursor: pointer; }
      .vault-chat-input button:hover { background: #2ea043; }
      .vault-chat-input button:disabled { opacity: 0.5; cursor: not-allowed; }
    </style>
    <div class="vault-layout">
      <div class="vault-search-bar">
        <input type="text" id="vault-search" placeholder="Search vault contents..." />
        <button onclick="doSearch()">Search</button>
        <button onclick="newFile()" style="margin-left:auto; background:#238636; border-color:#2ea043; color:#fff;">+ New File</button>
      </div>
      <div class="vault-main">
        <div class="vault-tree" id="vault-tree">
          <div class="tree-loading">Loading...</div>
        </div>
        <div class="vault-content">
          <div class="vault-breadcrumb" id="vault-breadcrumb"></div>
          <div class="vault-toolbar" id="vault-toolbar" style="display:none;">
            <button id="btn-rendered" class="vt-active" onclick="setView('rendered')">Rendered</button>
            <button id="btn-raw" onclick="setView('raw')">Raw</button>
            <button id="btn-edit" onclick="setView('edit')">Edit</button>
            <button id="btn-delete" onclick="deleteFile()" style="margin-left:auto; color:#f85149;">Delete</button>
          </div>
          <div id="vault-viewer">
            <div class="vault-empty">Select a file from the tree to view it.</div>
          </div>
          <div id="vault-search-results" style="display:none;"></div>
        </div>
      </div>
      <div class="vault-chat">
        <div class="vault-chat-header">
          <span style="font-weight:500; color:#f0f6fc;">Hollow JARVIS</span>
          <span style="font-size:11px; color:#8b949e;">Memory-only mode</span>
          <button onclick="resetChat()" style="margin-left:auto;">Reset</button>
        </div>
        <div class="vault-chat-messages" id="chat-messages">
          <div class="chat-empty">Ask JARVIS about the vault contents, memory, or anything stored in the knowledge base.</div>
        </div>
        <form class="vault-chat-input" onsubmit="sendChat(event)">
          <input type="text" id="chat-input" placeholder="Ask JARVIS about the vault..." autocomplete="off" />
          <button type="submit" id="chat-send">Send</button>
        </form>
      </div>
    </div>`;
}

function getVaultScripts(): string {
  return `
  <script src="https://cdn.jsdelivr.net/npm/marked@14.0.0/marked.min.js"></script>
  <script>
  (function() {
    var currentPath = '';
    var currentContent = '';
    var currentView = 'rendered';
    var expandedDirs = new Set();

    function esc(s) {
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function renderMd(text) {
      if (typeof marked !== 'undefined') {
        try { return marked.parse(text); } catch(e) {}
      }
      return '<pre class="raw-content">' + esc(text) + '</pre>';
    }

    // ——— Tree ———

    async function loadTree(path, container) {
      try {
        var res = await fetch('/api/vault/tree?path=' + encodeURIComponent(path || ''));
        var data = await res.json();
        if (data.error) {
          container.innerHTML = '<div class="tree-loading">' + esc(data.error) + '</div>';
          return;
        }

        var dirs = data.items
          .filter(function(i) { return i.type === 'directory'; })
          .sort(function(a, b) { return a.name.localeCompare(b.name); });
        var files = data.items
          .filter(function(i) { return i.type === 'file'; })
          .sort(function(a, b) { return a.name.localeCompare(b.name); });

        container.innerHTML = '';

        dirs.forEach(function(item) {
          var fullPath = path ? path + '/' + item.name : item.name;
          var isExpanded = expandedDirs.has(fullPath);

          var div = document.createElement('div');
          var header = document.createElement('div');
          header.className = 'tree-item tree-dir';
          header.innerHTML = '<span class="tree-toggle">' + (isExpanded ? '\\u25BE' : '\\u25B8') + '</span> ' + esc(item.name);
          div.appendChild(header);

          var children = document.createElement('div');
          children.className = 'tree-children';
          children.style.display = isExpanded ? 'block' : 'none';
          div.appendChild(children);

          if (isExpanded) loadTree(fullPath, children);

          header.onclick = function() {
            if (expandedDirs.has(fullPath)) {
              expandedDirs.delete(fullPath);
              children.style.display = 'none';
              header.querySelector('.tree-toggle').textContent = '\\u25B8';
            } else {
              expandedDirs.add(fullPath);
              children.style.display = 'block';
              children.innerHTML = '<div class="tree-loading">Loading...</div>';
              loadTree(fullPath, children);
              header.querySelector('.tree-toggle').textContent = '\\u25BE';
            }
          };

          container.appendChild(div);
        });

        files.forEach(function(item) {
          var fullPath = path ? path + '/' + item.name : item.name;
          var div = document.createElement('div');
          div.className = 'tree-item tree-file';
          div.setAttribute('data-path', fullPath);
          div.innerHTML = '<span class="tree-toggle"></span> ' + esc(item.name);
          div.onclick = function() {
            document.querySelectorAll('.tree-item.active').forEach(function(el) { el.classList.remove('active'); });
            div.classList.add('active');
            loadFile(fullPath);
          };
          container.appendChild(div);
        });

        if (!dirs.length && !files.length) {
          container.innerHTML = '<div class="tree-loading">Empty directory</div>';
        }
      } catch(err) {
        container.innerHTML = '<div class="tree-loading">Error: ' + esc(err.message) + '</div>';
      }
    }

    // ——— File viewer ———

    async function loadFile(path) {
      currentPath = path;
      document.getElementById('vault-search-results').style.display = 'none';
      document.getElementById('vault-viewer').style.display = 'block';
      document.getElementById('vault-toolbar').style.display = 'flex';

      var parts = path.split('/');
      var bc = parts.map(function(p, i) {
        if (i < parts.length - 1) return '<a href="#" onclick="return false;">' + esc(p) + '</a>';
        return '<span class="bc-active">' + esc(p) + '</span>';
      }).join(' / ');
      document.getElementById('vault-breadcrumb').innerHTML = bc;

      try {
        var res = await fetch('/api/vault/file?path=' + encodeURIComponent(path));
        var data = await res.json();
        if (data.error) {
          document.getElementById('vault-viewer').innerHTML = '<div class="vault-empty">Error: ' + esc(data.error) + '</div>';
          return;
        }
        currentContent = data.content;
        setView(currentView);
      } catch(err) {
        document.getElementById('vault-viewer').innerHTML = '<div class="vault-empty">Error: ' + esc(err.message) + '</div>';
      }
    }

    window.setView = function(view) {
      currentView = view;
      document.querySelectorAll('.vault-toolbar button[id^="btn-"]').forEach(function(b) { b.classList.remove('vt-active'); });
      var btn = document.getElementById('btn-' + view);
      if (btn) btn.classList.add('vt-active');

      var viewer = document.getElementById('vault-viewer');

      if (view === 'rendered') {
        viewer.innerHTML = '<div class="rendered-content">' + renderMd(currentContent) + '</div>';
      } else if (view === 'raw') {
        viewer.innerHTML = '<pre class="raw-content">' + esc(currentContent) + '</pre>';
      } else if (view === 'edit') {
        viewer.innerHTML = '<textarea class="edit-area" id="edit-textarea">' + esc(currentContent) + '</textarea>'
          + '<div class="edit-actions">'
          + '<button class="btn-save" onclick="saveFile()">Save</button>'
          + '<button class="btn-cancel" onclick="setView(\\'rendered\\')">Cancel</button>'
          + '<span class="save-status" id="save-status"></span>'
          + '</div>';
      }
    };

    window.saveFile = async function() {
      var textarea = document.getElementById('edit-textarea');
      var status = document.getElementById('save-status');
      if (!textarea || !currentPath) return;

      try {
        status.textContent = 'Saving...';
        status.style.color = '#8b949e';
        var res = await fetch('/api/vault/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: currentPath, content: textarea.value }),
        });
        var data = await res.json();
        if (data.ok) {
          currentContent = textarea.value;
          status.textContent = 'Saved!';
          status.style.color = '#3fb950';
          setTimeout(function() { setView('rendered'); }, 800);
        } else {
          status.textContent = 'Error: ' + (data.error || 'unknown');
          status.style.color = '#f85149';
        }
      } catch(err) {
        status.textContent = 'Error: ' + err.message;
        status.style.color = '#f85149';
      }
    };

    window.deleteFile = async function() {
      if (!currentPath || !confirm('Delete ' + currentPath + '?')) return;
      try {
        var res = await fetch('/api/vault/file?path=' + encodeURIComponent(currentPath), { method: 'DELETE' });
        var data = await res.json();
        if (data.ok) {
          currentPath = '';
          currentContent = '';
          document.getElementById('vault-toolbar').style.display = 'none';
          document.getElementById('vault-breadcrumb').innerHTML = '';
          document.getElementById('vault-viewer').innerHTML = '<div class="vault-empty">File deleted.</div>';
          loadTree('', document.getElementById('vault-tree'));
        } else {
          alert('Error: ' + (data.error || 'unknown'));
        }
      } catch(err) {
        alert('Error: ' + err.message);
      }
    };

    window.newFile = function() {
      var path = prompt('File path (relative to vault root):', 'new-file.md');
      if (!path) return;
      currentPath = path;
      currentContent = '';
      document.getElementById('vault-search-results').style.display = 'none';
      document.getElementById('vault-viewer').style.display = 'block';
      document.getElementById('vault-toolbar').style.display = 'flex';
      document.getElementById('vault-breadcrumb').innerHTML = '<span style="color:#3fb950;">New: ' + esc(path) + '</span>';
      setView('edit');
    };

    // ——— Search ———

    window.doSearch = async function() {
      var q = document.getElementById('vault-search').value.trim();
      if (!q) return;

      document.getElementById('vault-viewer').style.display = 'none';
      document.getElementById('vault-toolbar').style.display = 'none';
      var results = document.getElementById('vault-search-results');
      results.style.display = 'block';
      results.innerHTML = '<div class="tree-loading">Searching...</div>';

      try {
        var res = await fetch('/api/vault/search?q=' + encodeURIComponent(q));
        var data = await res.json();

        if (!data.results || !data.results.length) {
          results.innerHTML = '<div class="vault-empty">No results for "' + esc(q) + '"</div>';
          return;
        }

        results.innerHTML = '<div style="color:#8b949e; font-size:12px; margin-bottom:8px;">'
          + data.results.length + ' result' + (data.results.length !== 1 ? 's' : '') + ' for "' + esc(q) + '"</div>';
        data.results.forEach(function(r) {
          var div = document.createElement('div');
          div.className = 'search-result';
          div.innerHTML = '<div class="search-path">' + esc(r.path) + '</div>'
            + '<div class="search-match">' + esc(r.matchLine) + '</div>';
          div.onclick = function() { loadFile(r.path); };
          results.appendChild(div);
        });
      } catch(err) {
        results.innerHTML = '<div class="vault-empty">Error: ' + esc(err.message) + '</div>';
      }
    };

    document.getElementById('vault-search').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') doSearch();
    });

    // ——— Chat ———

    async function loadChatHistory() {
      try {
        var res = await fetch('/api/vault/chat/history');
        var data = await res.json();
        var container = document.getElementById('chat-messages');
        if (!data.messages || !data.messages.length) return;

        container.innerHTML = '';
        data.messages.forEach(function(m) {
          addChatBubble(m.role, m.content);
        });
        container.scrollTop = container.scrollHeight;
      } catch(e) {}
    }

    function addChatBubble(role, content) {
      var container = document.getElementById('chat-messages');
      var empty = container.querySelector('.chat-empty');
      if (empty) empty.remove();

      var div = document.createElement('div');
      div.className = 'chat-msg chat-' + role;
      div.textContent = content;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    }

    window.sendChat = async function(e) {
      if (e) e.preventDefault();
      var input = document.getElementById('chat-input');
      var msg = input.value.trim();
      if (!msg) return;

      input.value = '';
      addChatBubble('user', msg);

      var thinking = document.createElement('div');
      thinking.className = 'chat-thinking';
      thinking.textContent = 'JARVIS is thinking...';
      thinking.id = 'chat-thinking';
      var msgContainer = document.getElementById('chat-messages');
      msgContainer.appendChild(thinking);
      msgContainer.scrollTop = msgContainer.scrollHeight;

      document.getElementById('chat-send').disabled = true;

      try {
        var res = await fetch('/api/vault/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg }),
        });
        var data = await res.json();

        var th = document.getElementById('chat-thinking');
        if (th) th.remove();

        if (data.error) {
          addChatBubble('assistant', 'Error: ' + data.error);
        } else {
          addChatBubble('assistant', data.reply);
        }

        // Refresh tree in case chat modified files
        loadTree('', document.getElementById('vault-tree'));
      } catch(err) {
        var th2 = document.getElementById('chat-thinking');
        if (th2) th2.remove();
        addChatBubble('assistant', 'Error: ' + err.message);
      } finally {
        document.getElementById('chat-send').disabled = false;
        input.focus();
      }
    };

    window.resetChat = async function() {
      try {
        await fetch('/api/vault/chat/reset', { method: 'POST' });
        document.getElementById('chat-messages').innerHTML =
          '<div class="chat-empty">Ask JARVIS about the vault contents, memory, or anything stored in the knowledge base.</div>';
      } catch(e) {}
    };

    // ——— Init ———

    loadTree('', document.getElementById('vault-tree'));
    loadChatHistory();
  })();
  </script>`;
}

// ——— Router ———

export function createVaultRouter(renderLayout: RenderLayoutFn): Router {
  const router = Router();

  router.get('/vault', (_req: Request, res: Response) => {
    const body = renderVaultBody();
    res.send(renderLayout('Memory Vault', body, 'vault', getVaultScripts()));
  });

  router.get('/api/vault/tree', async (req: Request, res: Response) => {
    const path = (req.query.path as string) || '';
    try {
      const abs = safePath(path);
      const entries = await readdir(abs, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' as const : 'file' as const }));
      res.json({ path: path || '/', items });
    } catch (err) {
      res.json({ error: err instanceof Error ? err.message : String(err), items: [] });
    }
  });

  router.get('/api/vault/file', async (req: Request, res: Response) => {
    const path = req.query.path as string;
    if (!path) { res.json({ error: 'Path is required' }); return; }
    try {
      const abs = safePath(path);
      const content = await readFile(abs, 'utf-8');
      res.json({ path, content });
    } catch (err) {
      res.json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/api/vault/file', async (req: Request, res: Response) => {
    const { path, content } = req.body as { path?: string; content?: string };
    if (!path || content == null) { res.json({ ok: false, error: 'Path and content are required' }); return; }
    try {
      const abs = safePath(path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf-8');
      res.json({ ok: true, path });
    } catch (err) {
      res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/api/vault/file', async (req: Request, res: Response) => {
    const path = req.query.path as string;
    if (!path) { res.json({ ok: false, error: 'Path is required' }); return; }
    try {
      const abs = safePath(path);
      await unlink(abs);
      res.json({ ok: true, path });
    } catch (err) {
      res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/vault/search', async (req: Request, res: Response) => {
    const q = (req.query.q as string) || '';
    if (!q) { res.json({ results: [] }); return; }
    try {
      const result = await searchWiki.execute({ keyword: q, max_results: 30 }) as { results?: { path: string; matchLine: string }[] };
      res.json({ query: q, results: result.results || [] });
    } catch (err) {
      res.json({ error: err instanceof Error ? err.message : String(err), results: [] });
    }
  });

  router.post('/api/vault/chat', async (req: Request, res: Response) => {
    if (hollowBusy) {
      res.status(429).json({ error: 'JARVIS is still thinking... please wait.' });
      return;
    }
    const { message } = req.body as { message?: string };
    if (!message?.trim()) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }
    hollowBusy = true;
    try {
      const reply = await runHollowChat(message.trim());
      res.json({ reply });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      hollowBusy = false;
    }
  });

  router.get('/api/vault/chat/history', (_req: Request, res: Response) => {
    res.json({ messages: hollowMessages });
  });

  router.post('/api/vault/chat/reset', (_req: Request, res: Response) => {
    hollowSessionId = null;
    hollowMessages = [];
    res.json({ ok: true });
  });

  return router;
}
