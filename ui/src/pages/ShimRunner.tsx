import { useState, useEffect, useCallback, useRef } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import {
  Send,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Clock,
  Wrench,
  Copy,
  RotateCcw,
  BookOpen,
  Search,
  X,
  Settings,
} from "lucide-react";
import { JsonNode } from "../components/dev/JsonNode";
import { HttpStatusBadge, METHOD_COLORS, type HttpMethod } from "../components/dev/HttpBadges";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KVPair {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

interface HistoryEntry {
  id: string;
  timestamp: number;
  method: HttpMethod;
  url: string;
  status: number | null;
  durationMs: number | null;
  responseBody: unknown;
  error: string | null;
  params: KVPair[];
  headers: KVPair[];
  body: string;
}

interface CatalogEndpoint {
  label: string;
  method: HttpMethod;
  url: string;
  body?: string;
}

interface CatalogCategory {
  label: string;
  endpoints: CatalogEndpoint[];
}

// ─── SHIM Catalog ─────────────────────────────────────────────────────────────

const SHIM_CATALOG: CatalogCategory[] = [
  {
    label: "Tasks",
    endpoints: [
      { label: "List Tasks", method: "GET", url: "/api/v1/tasks" },
      { label: "List Tasks (open)", method: "GET", url: "/api/v1/tasks?status=open" },
      { label: "List Tasks (in progress)", method: "GET", url: "/api/v1/tasks?status=in_progress" },
      {
        label: "Create Task",
        method: "POST",
        url: "/api/v1/tasks",
        body: '{\n  "title": "",\n  "description": "",\n  "priority": 2,\n  "due_date": "",\n  "project_id": null,\n  "parent_task_id": null\n}',
      },
      {
        label: "Update Task",
        method: "PUT",
        url: "/api/v1/tasks/{id}",
        body: '{\n  "title": "",\n  "description": "",\n  "status": "in_progress",\n  "priority": 2,\n  "due_date": ""\n}',
      },
      {
        label: "Complete Task",
        method: "PUT",
        url: "/api/v1/tasks/{id}",
        body: '{\n  "mark_complete": true\n}',
      },
    ],
  },
  {
    label: "Projects",
    endpoints: [
      { label: "List Projects", method: "GET", url: "/api/v1/projects" },
      { label: "List Projects (active)", method: "GET", url: "/api/v1/projects?status=active" },
    ],
  },
  {
    label: "Fridge Items",
    endpoints: [
      { label: "List Fridge Items", method: "GET", url: "/api/v1/fridge-items" },
      { label: "List Fridge Items (active)", method: "GET", url: "/api/v1/fridge-items?status=active" },
      {
        label: "Add to Fridge",
        method: "POST",
        url: "/api/v1/fridge-items",
        body: '{\n  "title": "",\n  "body": "",\n  "project_id": null\n}',
      },
    ],
  },
  {
    label: "Focus Sessions",
    endpoints: [
      { label: "List Focus Sessions", method: "GET", url: "/api/v1/focus-sessions" },
      {
        label: "Start Focus Session",
        method: "POST",
        url: "/api/v1/focus-sessions/start",
        body: '{\n  "project_id": null,\n  "task_description": "",\n  "planned_duration": 25\n}',
      },
      { label: "Stop Focus Session", method: "POST", url: "/api/v1/focus-sessions/{id}/stop" },
    ],
  },
];

// ─── Key-Value Editor ─────────────────────────────────────────────────────────

function newKV(): KVPair {
  return { id: Math.random().toString(36).slice(2), key: "", value: "", enabled: true };
}

function KeyValueEditor({
  pairs,
  onChange,
  placeholder = "key",
}: {
  pairs: KVPair[];
  onChange: (pairs: KVPair[]) => void;
  placeholder?: string;
}) {
  function update(id: string, field: keyof KVPair, val: string | boolean) {
    onChange(pairs.map((p) => (p.id === id ? { ...p, [field]: val } : p)));
  }
  function remove(id: string) {
    onChange(pairs.filter((p) => p.id !== id));
  }
  return (
    <div className="flex flex-col gap-1">
      {pairs.map((pair) => (
        <div key={pair.id} className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={pair.enabled}
            onChange={(e) => update(pair.id, "enabled", e.target.checked)}
            className="h-3.5 w-3.5 shrink-0 accent-primary"
          />
          <input
            value={pair.key}
            onChange={(e) => update(pair.id, "key", e.target.value)}
            placeholder={placeholder}
            className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <input
            value={pair.value}
            onChange={(e) => update(pair.id, "value", e.target.value)}
            placeholder="value"
            className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button onClick={() => remove(pair.id)} className="p-1 text-muted-foreground hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...pairs, newKV()])}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1"
      >
        <Plus className="h-3.5 w-3.5" /> Add
      </button>
    </div>
  );
}

// ─── Catalog Panel ────────────────────────────────────────────────────────────

function CatalogPanel({
  onSelect,
  onClose,
}: {
  onSelect: (ep: CatalogEndpoint) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [openCats, setOpenCats] = useState<Set<string>>(
    () => new Set(SHIM_CATALOG.map((c) => c.label)),
  );

  function toggleCat(label: string) {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  const filtered = query.trim()
    ? SHIM_CATALOG.map((cat) => ({
        ...cat,
        endpoints: cat.endpoints.filter(
          (ep) =>
            ep.label.toLowerCase().includes(query.toLowerCase()) ||
            ep.url.toLowerCase().includes(query.toLowerCase()),
        ),
      })).filter((cat) => cat.endpoints.length > 0)
    : SHIM_CATALOG;

  return (
    <div className="flex flex-col border-r border-border bg-background w-64 shrink-0 min-h-0 h-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-semibold flex-1">Endpoints</span>
        <button
          onClick={onClose}
          className="p-1 text-muted-foreground hover:text-foreground"
          title="Close catalog"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded border border-border bg-muted/30">
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter endpoints…"
            className="flex-1 text-xs bg-transparent focus:outline-none min-w-0"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {filtered.map((cat) => (
          <div key={cat.label}>
            <button
              onClick={() => toggleCat(cat.label)}
              className="flex items-center gap-1.5 w-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              {openCats.has(cat.label) ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {cat.label}
            </button>
            {openCats.has(cat.label) && (
              <div className="mb-1">
                {cat.endpoints.map((ep) => (
                  <button
                    key={ep.label}
                    onClick={() => onSelect(ep)}
                    className="flex items-center gap-2 w-full px-4 py-1.5 text-xs hover:bg-accent/50 text-left group"
                  >
                    <span className={`text-[10px] font-bold w-10 shrink-0 ${METHOD_COLORS[ep.method]}`}>
                      {ep.method}
                    </span>
                    <span className="truncate text-foreground/80 group-hover:text-foreground">
                      {ep.label}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-xs text-muted-foreground text-center">
            No endpoints match "{query}"
          </div>
        )}
      </div>
    </div>
  );
}

// ─── History Persistence ──────────────────────────────────────────────────────

const HISTORY_KEY = "paperclip_shim_runner_history";
const CONFIG_KEY = "paperclip_shim_runner_config";
const MAX_HISTORY = 50;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)));
  } catch {
    // ignore quota errors
  }
}

interface ShimConfig {
  baseUrl: string;
  token: string;
}

function loadConfig(): ShimConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as ShimConfig) : { baseUrl: "https://somehow.thedarwinhub.com", token: "" };
  } catch {
    return { baseUrl: "https://somehow.thedarwinhub.com", token: "" };
  }
}

function saveConfig(config: ShimConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // ignore quota errors
  }
}

// ─── Main Component ───────────────────────────────────────────────────────────

const METHODS: HttpMethod[] = ["GET", "POST", "PATCH", "PUT", "DELETE"];
type RequestTab = "params" | "headers" | "body";

export function ShimRunner() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Developers" }, { label: "SHIM Runner" }]);
  }, [setBreadcrumbs]);

  // ── Config
  const [config, setConfig] = useState<ShimConfig>(() => loadConfig());
  const [configOpen, setConfigOpen] = useState(false);

  function updateConfig(patch: Partial<ShimConfig>) {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      saveConfig(next);
      return next;
    });
  }

  // ── Request state
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [url, setUrl] = useState("/api/v1/tasks");
  const [params, setParams] = useState<KVPair[]>([newKV()]);
  const [headers, setHeaders] = useState<KVPair[]>([newKV()]);
  const [body, setBody] = useState("");
  const [activeTab, setActiveTab] = useState<RequestTab>("params");

  // ── Response state
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<HistoryEntry | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── History
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [historyOpen, setHistoryOpen] = useState(true);

  // ── Catalog
  const [catalogOpen, setCatalogOpen] = useState(false);

  function loadTemplate(ep: CatalogEndpoint) {
    setMethod(ep.method);
    setUrl(ep.url);
    setParams([newKV()]);
    setHeaders([newKV()]);
    setBody(ep.body ?? "");
    if (ep.body) setActiveTab("body");
    else setActiveTab("params");
    setResponse(null);
  }

  // ── Copy helper
  const [copied, setCopied] = useState(false);
  function copyResponse() {
    if (!response?.responseBody) return;
    navigator.clipboard.writeText(JSON.stringify(response.responseBody, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  // ── Build final URL (prepend base URL to relative paths, append query params)
  function buildUrl() {
    const base = config.baseUrl.replace(/\/$/, "");
    const resolved = url.startsWith("http") ? url : `${base}${url}`;
    const enabled = params.filter((p) => p.enabled && p.key);
    if (enabled.length === 0) return resolved;
    const qs = new URLSearchParams(enabled.map((p) => [p.key, p.value])).toString();
    return resolved.includes("?") ? `${resolved}&${qs}` : `${resolved}?${qs}`;
  }

  // ── Send request
  const send = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setResponse(null);

    const finalUrl = buildUrl();
    const enabledHeaders: Record<string, string> = {};
    headers.filter((h) => h.enabled && h.key).forEach((h) => {
      enabledHeaders[h.key] = h.value;
    });
    if (config.token && !enabledHeaders["Authorization"]) {
      enabledHeaders["Authorization"] = `Bearer ${config.token}`;
    }
    const hasBody = method !== "GET" && method !== "DELETE" && body.trim();
    if (hasBody && !enabledHeaders["Content-Type"]) {
      enabledHeaders["Content-Type"] = "application/json";
    }

    const t0 = Date.now();
    let entry: HistoryEntry;
    try {
      const res = await fetch(finalUrl, {
        method,
        headers: enabledHeaders,
        body: hasBody ? body : undefined,
        signal: ctrl.signal,
      });
      const durationMs = Date.now() - t0;
      let responseBody: unknown = null;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("json")) {
        responseBody = await res.json().catch(() => null);
      } else {
        responseBody = await res.text().catch(() => null);
      }
      entry = {
        id: Math.random().toString(36).slice(2),
        timestamp: Date.now(),
        method, url: finalUrl, status: res.status,
        durationMs, responseBody, error: null,
        params, headers, body,
      };
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") { setLoading(false); return; }
      entry = {
        id: Math.random().toString(36).slice(2),
        timestamp: Date.now(),
        method, url: finalUrl, status: null,
        durationMs: Date.now() - t0,
        responseBody: null,
        error: (err as Error).message,
        params, headers, body,
      };
    }

    setResponse(entry);
    setLoading(false);
    const updated = [entry, ...history];
    setHistory(updated);
    saveHistory(updated);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, url, params, headers, body, history, config]);

  // ── Restore from history
  function restore(entry: HistoryEntry) {
    setMethod(entry.method);
    setUrl(entry.url);
    setParams(entry.params.length ? entry.params : [newKV()]);
    setHeaders(entry.headers.length ? entry.headers : [newKV()]);
    setBody(entry.body);
    setResponse(entry);
  }

  // ── Clear history
  function clearHistory() {
    setHistory([]);
    saveHistory([]);
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Catalog sidebar */}
      {catalogOpen && (
        <CatalogPanel onSelect={loadTemplate} onClose={() => setCatalogOpen(false)} />
      )}

      {/* Main content */}
      <div className="flex flex-col flex-1 min-h-0 gap-4 p-4 md:p-6 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 shrink-0">
          <Wrench className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-bold">SHIM Runner</h1>
          <span className="text-xs text-muted-foreground ml-2">Somehow I Manage · Workday API Client</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setConfigOpen(!configOpen)}
              title="Connection settings"
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border transition-colors ${
                configOpen
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
              }`}
            >
              <Settings className="h-3.5 w-3.5" />
              Config
            </button>
            <button
              onClick={() => setCatalogOpen(!catalogOpen)}
              title={catalogOpen ? "Hide endpoint catalog" : "Browse endpoint catalog"}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border transition-colors ${
                catalogOpen
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
              }`}
            >
              <BookOpen className="h-3.5 w-3.5" />
              Endpoints
            </button>
          </div>
        </div>

        {/* Config panel */}
        {configOpen && (
          <div className="flex flex-col gap-2 p-3 border border-border rounded-lg bg-muted/20 shrink-0">
            <div className="flex items-center gap-3">
              <label className="text-xs text-muted-foreground w-20 shrink-0">Base URL</label>
              <input
                value={config.baseUrl}
                onChange={(e) => updateConfig({ baseUrl: e.target.value })}
                placeholder="https://somehow.thedarwinhub.com"
                className="flex-1 min-w-0 px-2 py-1 text-xs font-mono rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs text-muted-foreground w-20 shrink-0">Bearer Token</label>
              <input
                type="password"
                value={config.token}
                onChange={(e) => updateConfig({ token: e.target.value })}
                placeholder="Auto-added as Authorization header"
                className="flex-1 min-w-0 px-2 py-1 text-xs font-mono rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
        )}

        {/* Request Bar */}
        <div className="flex items-center gap-2 shrink-0">
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as HttpMethod)}
            className={`px-3 py-2 text-sm font-bold rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring shrink-0 ${METHOD_COLORS[method]}`}
          >
            {METHODS.map((m) => (
              <option key={m} value={m} className={METHOD_COLORS[m]}>{m}</option>
            ))}
          </select>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") send(); }}
            placeholder="/api/v1/tasks"
            className="flex-1 min-w-0 px-3 py-2 text-sm font-mono rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            onClick={send}
            disabled={loading || !url.trim()}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 shrink-0"
          >
            {loading ? (
              <><span className="h-3.5 w-3.5 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> Sending</>
            ) : (
              <><Send className="h-3.5 w-3.5" /> Send</>
            )}
          </button>
        </div>

        {/* Request Config Tabs + Response — two column layout */}
        <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0">
          {/* Left: Tabs */}
          <div className="flex flex-col border border-border rounded-lg overflow-hidden md:w-1/2 min-h-0">
            <div className="flex border-b border-border bg-muted/30 shrink-0">
              {(["params", "headers", "body"] as RequestTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 text-xs font-medium capitalize transition-colors ${
                    activeTab === tab
                      ? "text-foreground border-b-2 border-primary -mb-px"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab}
                  {tab === "params" && params.filter((p) => p.enabled && p.key).length > 0 && (
                    <span className="ml-1 text-[10px] bg-primary/20 text-primary px-1 rounded-full">
                      {params.filter((p) => p.enabled && p.key).length}
                    </span>
                  )}
                  {tab === "headers" && headers.filter((h) => h.enabled && h.key).length > 0 && (
                    <span className="ml-1 text-[10px] bg-primary/20 text-primary px-1 rounded-full">
                      {headers.filter((h) => h.enabled && h.key).length}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {activeTab === "params" && (
                <KeyValueEditor pairs={params} onChange={setParams} placeholder="param" />
              )}
              {activeTab === "headers" && (
                <KeyValueEditor pairs={headers} onChange={setHeaders} placeholder="header" />
              )}
              {activeTab === "body" && (
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder='{"key": "value"}'
                  spellCheck={false}
                  className="w-full h-full min-h-[160px] text-xs font-mono p-2 rounded border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                />
              )}
            </div>
          </div>

          {/* Right: Response */}
          <div className="flex flex-col border border-border rounded-lg overflow-hidden md:w-1/2 min-h-0">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30 shrink-0">
              <span className="text-xs font-medium text-muted-foreground">Response</span>
              {response && (
                <>
                  <HttpStatusBadge status={response.status} />
                  {response.durationMs !== null && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1 ml-auto">
                      <Clock className="h-3 w-3" /> {response.durationMs}ms
                    </span>
                  )}
                  <button
                    onClick={copyResponse}
                    className="p-1 text-muted-foreground hover:text-foreground"
                    title="Copy response"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  {copied && <span className="text-xs text-green-500">Copied!</span>}
                </>
              )}
            </div>
            <div className="flex-1 overflow-auto p-3 text-xs font-mono">
              {!response && !loading && (
                <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                  Hit Send to execute a request
                </div>
              )}
              {loading && (
                <div className="h-full flex items-center justify-center text-muted-foreground text-sm gap-2">
                  <span className="h-4 w-4 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
                  Waiting for response…
                </div>
              )}
              {response && !loading && (
                <>
                  {response.error && (
                    <div className="text-destructive mb-2">{response.error}</div>
                  )}
                  {response.responseBody !== null && (
                    <JsonNode value={response.responseBody} depth={0} />
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* History */}
        <div className="border border-border rounded-lg overflow-hidden shrink-0">
          <button
            onClick={() => setHistoryOpen(!historyOpen)}
            className="flex items-center gap-2 w-full px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/30 border-b border-border"
          >
            {historyOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            History ({history.length})
            {history.length > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); clearHistory(); }}
                className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" /> Clear
              </button>
            )}
          </button>
          {historyOpen && history.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground text-center">No requests yet</div>
          )}
          {historyOpen && history.length > 0 && (
            <div className="max-h-48 overflow-y-auto divide-y divide-border">
              {history.map((entry) => (
                <div
                  key={entry.id}
                  onClick={() => restore(entry)}
                  className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50 cursor-pointer group"
                >
                  <span className={`text-xs font-bold w-14 shrink-0 ${METHOD_COLORS[entry.method]}`}>
                    {entry.method}
                  </span>
                  <span className="text-xs font-mono text-muted-foreground truncate flex-1">{entry.url}</span>
                  <HttpStatusBadge status={entry.status} />
                  {entry.durationMs !== null && (
                    <span className="text-xs text-muted-foreground shrink-0">{entry.durationMs}ms</span>
                  )}
                  <span className="text-xs text-muted-foreground shrink-0">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); restore(entry); }}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground shrink-0"
                    title="Restore this request"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
