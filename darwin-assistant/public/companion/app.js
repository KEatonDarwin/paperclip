// Companion thin client — iPhone-first vanilla JS. Two views only (her chat,
// the shared reports), relative-path fetches to THIS server's own /api/*
// routes. No cockpit SPA, no other-thread id anywhere in this file.
(() => {
  'use strict';

  const navBtn = document.getElementById('nav-btn');
  const navTitle = document.getElementById('nav-title');
  const switchBtn = document.getElementById('switch-btn');
  const chatView = document.getElementById('chat-view');
  const reportsListView = document.getElementById('reports-list-view');
  const reportDetailView = document.getElementById('report-detail-view');
  const chatMessages = document.getElementById('chat-messages');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const reportsListEl = document.getElementById('reports-list');
  const reportContentEl = document.getElementById('report-content');

  // state: 'chat' | 'reports-list' | 'report-detail'
  let view = 'chat';
  let currentReportName = null;
  let pollTimer = null;
  let sending = false;
  let lastThreadSignature = '';

  // ---------------------------------------------------------------------
  // view / nav
  // ---------------------------------------------------------------------

  function render() {
    chatView.hidden = view !== 'chat';
    reportsListView.hidden = view !== 'reports-list';
    reportDetailView.hidden = view !== 'report-detail';

    if (view === 'chat') {
      navTitle.textContent = 'Chat';
      navBtn.hidden = true;
      switchBtn.hidden = false;
      switchBtn.textContent = 'Reports';
    } else if (view === 'reports-list') {
      navTitle.textContent = 'Reports';
      navBtn.hidden = false;
      navBtn.textContent = '‹ Chat';
      switchBtn.hidden = true;
    } else {
      navTitle.textContent = currentReportName || 'Report';
      navBtn.hidden = false;
      navBtn.textContent = '‹ Reports';
      switchBtn.hidden = true;
    }
  }

  function goChat() {
    view = 'chat';
    render();
    loadThread();
  }

  function goReportsList() {
    view = 'reports-list';
    render();
    loadReportsList();
  }

  function goReportDetail(name) {
    currentReportName = name;
    view = 'report-detail';
    render();
    loadReportDetail(name);
  }

  navBtn.addEventListener('click', () => {
    if (view === 'reports-list') goChat();
    else if (view === 'report-detail') goReportsList();
  });
  switchBtn.addEventListener('click', () => {
    if (view === 'chat') goReportsList();
  });

  // ---------------------------------------------------------------------
  // chat
  // ---------------------------------------------------------------------

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderThread(turns) {
    const sig = JSON.stringify(turns.map((t) => [t.role, t.content, t.turn_index]));
    if (sig === lastThreadSignature) return;
    lastThreadSignature = sig;

    chatMessages.innerHTML = '';
    let lastRole = null;
    for (const t of turns) {
      if (t.role === 'user' || t.role === 'assistant') {
        const row = document.createElement('div');
        row.className = `bubble-row ${t.role}`;
        const bubble = document.createElement('div');
        bubble.className = `bubble ${t.role}`;
        bubble.innerHTML = escapeHtml(t.content || '').replace(/\n/g, '<br>');
        row.appendChild(bubble);
        chatMessages.appendChild(row);
        lastRole = t.role;
      } else if (t.role === 'cross_chat_sidecar') {
        let fromLabel = 'Companion';
        try {
          const meta = JSON.parse(t.tool_args || '{}');
          if (typeof meta.from_label === 'string' && meta.from_label) fromLabel = meta.from_label;
        } catch { /* leave default */ }
        const row = document.createElement('div');
        row.className = 'sidecar-row';
        const card = document.createElement('div');
        card.className = 'sidecar-card';
        const label = document.createElement('div');
        label.className = 'sidecar-label';
        label.textContent = `from ${fromLabel} · cross-chat`;
        const text = document.createElement('div');
        text.className = 'sidecar-text';
        text.innerHTML = escapeHtml(t.content || '').replace(/\n/g, '<br>');
        card.appendChild(label);
        card.appendChild(text);
        row.appendChild(card);
        chatMessages.appendChild(row);
        lastRole = t.role;
      }
      // any other role (tool_call/tool_result/bump/etc.) is not part of her
      // two-thing view and is intentionally skipped.
    }

    // typing indicator while a reply is still pending
    const waitingOnReply = lastRole === 'user';
    chatSend.disabled = waitingOnReply || sending;
    if (waitingOnReply) {
      const row = document.createElement('div');
      row.className = 'typing-row';
      const bubble = document.createElement('div');
      bubble.className = 'typing-bubble';
      bubble.textContent = '…';
      row.appendChild(bubble);
      chatMessages.appendChild(row);
    }

    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  async function loadThread() {
    try {
      const res = await fetch('/api/thread');
      if (!res.ok) return;
      const body = await res.json();
      renderThread(body.turns || []);
    } catch {
      // transient network blip — next poll tick retries
    }
  }

  chatForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = chatInput.value.trim();
    if (!text || sending) return;
    sending = true;
    chatSend.disabled = true;
    try {
      const res = await fetch('/api/thread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.ok || res.status === 202) {
        chatInput.value = '';
        chatInput.style.height = 'auto';
      }
      lastThreadSignature = ''; // force a re-render on the next load
      await loadThread();
    } catch {
      // leave her text in the box so she can retry
    } finally {
      sending = false;
    }
  });

  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = `${Math.min(chatInput.scrollHeight, 120)}px`;
  });
  chatInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      chatForm.requestSubmit();
    }
  });

  // ---------------------------------------------------------------------
  // reports
  // ---------------------------------------------------------------------

  async function loadReportsList() {
    reportsListEl.innerHTML = '<div class="reports-empty">Loading…</div>';
    try {
      const res = await fetch('/api/reports');
      if (!res.ok) throw new Error('bad status');
      const body = await res.json();
      const reports = body.reports || [];
      if (!reports.length) {
        reportsListEl.innerHTML = '<div class="reports-empty">No reports yet.</div>';
        return;
      }
      reportsListEl.innerHTML = '';
      for (const name of reports) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = name;
        btn.addEventListener('click', () => goReportDetail(name));
        li.appendChild(btn);
        reportsListEl.appendChild(li);
      }
    } catch {
      reportsListEl.innerHTML = '<div class="reports-error">Couldn’t load reports. Pull to retry.</div>';
    }
  }

  async function loadReportDetail(name) {
    reportContentEl.innerHTML = '<p>Loading…</p>';
    try {
      const res = await fetch(`/api/reports/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error('bad status');
      const md = await res.text();
      reportContentEl.innerHTML = mdToHtml(md);
    } catch {
      reportContentEl.innerHTML = '<p class="reports-error">Couldn’t load that report.</p>';
    }
  }

  // ---------------------------------------------------------------------
  // minimal markdown renderer — headers, bold/italic, inline code, fenced
  // code, links, lists, blockquotes, hr, tables, and raw <details>/<summary>
  // passthrough so expanders work natively (first pass; #268 can polish).
  // ---------------------------------------------------------------------

  function escapeInline(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function applyInline(text) {
    let out = escapeInline(text);
    out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) =>
      `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`,
    );
    return out;
  }

  // Matches a whole line that IS (not just contains) a details/summary/br
  // tag, open or close, with or without inline text/attributes on the same
  // line (e.g. "<details>", "<summary>More detail</summary>", "</details>").
  const RAW_HTML_LINE_RE = /^\s*(<br\s*\/?>|<\/?(details|summary)\b[^>]*>(.*<\/(details|summary)>)?)\s*$/i;

  function mdToHtml(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let para = [];

    function flushPara() {
      if (para.length) {
        out.push(`<p>${applyInline(para.join(' '))}</p>`);
        para = [];
      }
    }

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      if (/^```/.test(line)) {
        flushPara();
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        out.push(`<pre><code>${escapeInline(code.join('\n'))}</code></pre>`);
        continue;
      }

      // raw <details>/<summary> passthrough
      if (RAW_HTML_LINE_RE.test(line)) {
        flushPara();
        out.push(line.trim());
        i++;
        continue;
      }

      // horizontal rule
      if (/^\s*(---|\*\*\*)\s*$/.test(line) && line.trim().length >= 3) {
        flushPara();
        out.push('<hr>');
        i++;
        continue;
      }

      // headers
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushPara();
        const level = h[1].length;
        out.push(`<h${level}>${applyInline(h[2])}</h${level}>`);
        i++;
        continue;
      }

      // blockquote
      if (/^\s*>\s?/.test(line)) {
        flushPara();
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${applyInline(quote.join(' '))}</blockquote>`);
        continue;
      }

      // table (header row + separator row)
      if (/^\s*\|.*\|\s*$/.test(line) && lines[i + 1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
        flushPara();
        const headerCells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        i += 2;
        const bodyRows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          bodyRows.push(
            lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()),
          );
          i++;
        }
        let table = '<table><thead><tr>';
        for (const c of headerCells) table += `<th>${applyInline(c)}</th>`;
        table += '</tr></thead><tbody>';
        for (const row of bodyRows) {
          table += '<tr>';
          for (const c of row) table += `<td>${applyInline(c)}</td>`;
          table += '</tr>';
        }
        table += '</tbody></table>';
        out.push(table);
        continue;
      }

      // unordered list
      if (/^\s*[-*]\s+/.test(line)) {
        flushPara();
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
          i++;
        }
        out.push(`<ul>${items.map((it) => `<li>${applyInline(it)}</li>`).join('')}</ul>`);
        continue;
      }

      // ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        flushPara();
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
          i++;
        }
        out.push(`<ol>${items.map((it) => `<li>${applyInline(it)}</li>`).join('')}</ol>`);
        continue;
      }

      // blank line -> paragraph break
      if (/^\s*$/.test(line)) {
        flushPara();
        i++;
        continue;
      }

      // plain text line -> accumulate into the current paragraph
      para.push(line.trim());
      i++;
    }
    flushPara();
    return out.join('\n');
  }

  // ---------------------------------------------------------------------
  // polling + boot
  // ---------------------------------------------------------------------

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (view === 'chat') loadThread();
    }, 2500);
  }

  render();
  loadThread();
  startPolling();
})();
