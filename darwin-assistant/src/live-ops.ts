// LIVE OPERATIONS (lean/harness-gaps, 2026-10-17) — the CLI's OWN tool calls,
// as plain one-line steps, while a turn runs.
//
// Until now the cockpit saw live thinking + reply text (live-stream.ts) and a
// `tool_call` event only for JARVIS's own tools. Everything Claude Code does by
// itself — Bash, Read, Edit, Grep, sub-agents, claude.ai connectors — was
// invisible until the turn ended, and those are most of what a coding chat or a
// hopper worker does. The data was always in the stream-json we already parse:
// an `assistant` message carries `tool_use` blocks, the following `user` message
// carries the matching `tool_result` (with is_error). This file pairs them up.
//
// Kevin's ask: show them, but never clutter — the cockpit renders them inside a
// collapsed "Operations" strip (one summary line, expand for the list).
//
// Secrets: a Bash command line can carry a token. Everything shown goes through
// redact() first, and tool OUTPUT is never shown except a short redacted tail
// on a failed step.

export type OpKind = 'shell' | 'read' | 'edit' | 'write' | 'search' | 'web' | 'agent' | 'jarvis' | 'connector' | 'plan' | 'other';
export type OpStatus = 'running' | 'done' | 'error';

export interface LiveOp {
  id: string;
  /** tool_use id of the sub-agent this step ran inside (null = top level). */
  parent: string | null;
  tool: string;
  kind: OpKind;
  /** Present tense, shown while running ("Running npm run build"). */
  active: string;
  /** Past tense, shown once finished ("Ran npm run build"). */
  label: string;
  /** Optional second line (full path, full command), already redacted. */
  detail?: string;
  status: OpStatus;
  started_at: number;
  ms?: number;
  /** Redacted tail of the output, ONLY when the step failed. */
  error?: string;
}

const MAX_OPS = 400;
const LABEL_MAX = 110;

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-•••'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-•••'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, 'xox-•••'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_•••'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}/g, 'jwt•••'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1•••'],
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PASS)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1=•••'],
  [/(--?(?:password|pass|token|secret|api-key|apikey|key)[= ])("[^"]*"|'[^']*'|\S+)/gi, '$1•••'],
  [/(\bmysql\b[^\n|;&]*?\s-p)(\S+)/g, '$1•••'],
  [/(:\/\/[^:\s/@]+:)[^@\s/]+@/g, '$1•••@'],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function oneLine(s: unknown, max = LABEL_MAX): string {
  const t = redact(String(s ?? '')).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function base(p: unknown): string {
  const s = String(p ?? '');
  return s.split('/').filter(Boolean).pop() ?? s;
}

function host(u: unknown): string {
  try { return new URL(String(u)).host; } catch { return oneLine(u, 60); }
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

/** One tool_use → kind + labels. Pure, exported for tests. */
export function describeToolUse(name: string, input: Record<string, unknown> = {}): Pick<LiveOp, 'kind' | 'active' | 'label' | 'detail'> {
  const i = input ?? {};
  const mk = (kind: OpKind, verbNow: string, verbDone: string, what: string, detail?: string) => ({
    kind, active: `${verbNow} ${what}`.trim(), label: `${verbDone} ${what}`.trim(),
    ...(detail && detail !== what ? { detail: oneLine(detail, 400) } : {}),
  });
  switch (name) {
    case 'Bash': {
      const cmd = oneLine(i.command);
      const desc = typeof i.description === 'string' && i.description.trim() ? oneLine(i.description, 80) : null;
      return desc ? { kind: 'shell', active: desc, label: desc, detail: oneLine(i.command, 400) } : mk('shell', 'Running', 'Ran', cmd);
    }
    case 'BashOutput': return mk('shell', 'Checking', 'Checked', 'background command output');
    case 'KillShell': case 'KillBash': return mk('shell', 'Stopping', 'Stopped', 'a background command');
    case 'Read': return mk('read', 'Reading', 'Read', base(i.file_path), String(i.file_path ?? ''));
    case 'Edit': case 'MultiEdit': return mk('edit', 'Editing', 'Edited', base(i.file_path), String(i.file_path ?? ''));
    case 'Write': return mk('write', 'Writing', 'Wrote', base(i.file_path), String(i.file_path ?? ''));
    case 'NotebookEdit': return mk('edit', 'Editing', 'Edited', base(i.notebook_path), String(i.notebook_path ?? ''));
    case 'Grep': return mk('search', 'Searching for', 'Searched for', `“${oneLine(i.pattern, 60)}”`, i.path ? `in ${i.path}` : undefined);
    case 'Glob': return mk('search', 'Listing', 'Listed', `files matching ${oneLine(i.pattern, 60)}`, i.path ? `in ${i.path}` : undefined);
    case 'LS': return mk('search', 'Listing', 'Listed', base(i.path) || 'a folder', String(i.path ?? ''));
    case 'WebFetch': return mk('web', 'Fetching', 'Fetched', host(i.url), String(i.url ?? ''));
    case 'WebSearch': return mk('web', 'Searching the web for', 'Searched the web for', `“${oneLine(i.query, 70)}”`);
    case 'Task': case 'Agent': return mk('agent', 'Helper working:', 'Helper:', oneLine(i.description ?? i.subagent_type ?? 'sub-agent', 80), typeof i.prompt === 'string' ? i.prompt : undefined);
    case 'TodoWrite': return mk('plan', 'Updating', 'Updated', 'its working checklist');
    case 'ToolSearch': return mk('other', 'Loading', 'Loaded', 'tool definitions', oneLine(i.query, 200));
    case 'ExitPlanMode': return mk('plan', 'Presenting', 'Presented', 'a plan');
    case 'Skill': return mk('other', 'Loading skill', 'Loaded skill', oneLine(i.skill ?? i.name ?? '', 60));
    case 'Monitor': return mk('other', 'Watching', 'Watched', oneLine(i.description ?? 'a background job', 80));
  }
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (m) {
    const [, server, tool] = m;
    const op = typeof i.operation === 'string' ? ` (${oneLine(i.operation, 40)})` : '';
    if (server === 'jarvis') return mk('jarvis', 'JARVIS tool:', 'JARVIS tool:', `${tool}${op}`);
    const srv = titleCase(server.replace(/^claude_ai_/, ''));
    return mk('connector', `${srv}:`, `${srv}:`, `${tool.replace(/-tool$/, '')}${op}`);
  }
  return mk('other', 'Using', 'Used', name);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n');
  }
  return '';
}

export interface OpsTracker {
  readonly ops: LiveOp[];
  /** Feed one raw adapter stream event; returns the ops that changed (to emit). */
  handle(event: Record<string, unknown>): LiveOp[];
}

export function createOpsTracker(now: () => number = Date.now): OpsTracker {
  const ops: LiveOp[] = [];
  const byId = new Map<string, LiveOp>();

  const start = (id: string, tool: string, input: Record<string, unknown>, parent: string | null): LiveOp | null => {
    if (!id || byId.has(id)) return null;
    const op: LiveOp = { id, parent, tool, ...describeToolUse(tool, input), status: 'running', started_at: now() };
    ops.push(op);
    byId.set(id, op);
    if (ops.length > MAX_OPS) {
      const dropped = ops.shift();
      if (dropped) byId.delete(dropped.id);
    }
    return op;
  };

  const finish = (id: string, isError: boolean, output: string): LiveOp | null => {
    const op = byId.get(id);
    if (!op || op.status !== 'running') return null;
    op.status = isError ? 'error' : 'done';
    op.ms = Math.max(0, now() - op.started_at);
    if (isError) {
      const tail = redact(output).replace(/<\/?tool_use_error>/g, '').trim();
      op.error = tail.length > 300 ? `…${tail.slice(-300)}` : tail;
      // The CLI refused a tool name it doesn't have (e.g. a JARVIS tool called without its
      // mcp__jarvis__ prefix) — say that, not "Used thread_todos" in red.
      if (/No such tool available/i.test(tail)) op.label = `Called a tool that doesn't exist here: ${op.tool}`;
    }
    return op;
  };

  const handle = (event: Record<string, unknown>): LiveOp[] => {
    if (event.type === 'stream_event' && event.event && typeof event.event === 'object') return [];
    const parent = typeof event.parent_tool_use_id === 'string' ? event.parent_tool_use_id : null;
    const changed: LiveOp[] = [];

    // Claude CLI stream-json: tool_use in assistant messages, tool_result in user messages.
    if (event.type === 'assistant' || event.type === 'user') {
      const content = (event.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return changed;
      for (const b of content as Record<string, unknown>[]) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          const op = start(String(b.id ?? ''), String(b.name ?? 'tool'), (b.input as Record<string, unknown>) ?? {}, parent);
          if (op) changed.push({ ...op });
        } else if (b.type === 'tool_result') {
          const op = finish(String(b.tool_use_id ?? ''), b.is_error === true, resultText(b.content));
          if (op) changed.push({ ...op });
        }
      }
      return changed;
    }

    // Codex (`codex exec --json`), passed through by codexMapStreamEvent as
    // {type:'codex_item', phase, item}. Best-effort: item shapes are Codex's.
    if (event.type === 'codex_item') {
      const item = (event.item ?? {}) as Record<string, unknown>;
      const id = String(item.id ?? '');
      const t = String(item.type ?? '');
      const input: Record<string, unknown> =
        t === 'command_execution' ? { command: item.command }
        : t === 'web_search' ? { query: item.query }
        : t === 'file_change' ? { file_path: (Array.isArray(item.changes) ? (item.changes as { path?: string }[]).map((c) => c.path).join(', ') : '') }
        : {};
      const tool =
        t === 'command_execution' ? 'Bash'
        : t === 'web_search' ? 'WebSearch'
        : t === 'file_change' ? 'Edit'
        : t === 'mcp_tool_call' ? `mcp__${String(item.server ?? 'mcp')}__${String(item.tool ?? 'tool')}`
        : t;
      const s = start(id, tool, input, null);
      if (s) changed.push({ ...s });
      if (event.phase === 'completed') {
        const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
        const f = finish(id, failed, String(item.aggregated_output ?? ''));
        if (f) changed.push({ ...f });
      }
      return changed;
    }

    // The final result line: anything still "running" was cut off (stop, crash).
    if (event.type === 'result') {
      for (const op of ops) {
        if (op.status === 'running') {
          op.status = event.is_error === true ? 'error' : 'done';
          op.ms = Math.max(0, now() - op.started_at);
          changed.push({ ...op });
        }
      }
    }
    return changed;
  };

  return { get ops() { return ops; }, handle };
}

/** Rebuild a finished turn's operations from its persisted raw stream
 *  (`turns.claude_output`). Null when there were none. Timings are not in the
 *  raw stream, so `ms` is omitted here. */
export function parseTurnOps(rawOutput: string | null | undefined): LiveOp[] | null {
  if (!rawOutput) return null;
  const tracker = createOpsTracker(() => 0);
  for (const line of rawOutput.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(s) as Record<string, unknown>; } catch { continue; }
    if (ev.type === 'item.started' || ev.type === 'item.completed') {
      const item = ev.item as Record<string, unknown> | undefined;
      if (item && item.type !== 'agent_message' && item.type !== 'reasoning') {
        tracker.handle({ type: 'codex_item', phase: ev.type === 'item.started' ? 'started' : 'completed', item });
      }
      continue;
    }
    tracker.handle(ev);
  }
  const ops = tracker.ops.map(({ ms: _ms, started_at: _s, ...rest }) => ({ ...rest, started_at: 0 }));
  return ops.length ? ops : null;
}

/** "Ran 12 operations · 1 failed · 41s" — the collapsed summary line. */
export function summarizeOps(ops: LiveOp[]): string {
  const n = ops.length;
  if (!n) return '';
  const running = ops.filter((o) => o.status === 'running').length;
  const failed = ops.filter((o) => o.status === 'error').length;
  const parts = [running ? `${n} operations · ${running} running` : `${n} operation${n === 1 ? '' : 's'}`];
  if (failed) parts.push(`${failed} failed`);
  return parts.join(' · ');
}
