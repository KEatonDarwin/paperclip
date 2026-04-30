import { useState, useEffect, useCallback, useRef } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import {
  ChevronDown,
  ChevronRight,
  Play,
  X,
  Clock,
  Copy,
  CheckCircle2,
  XCircle,
  Wifi,
  History,
  Wrench,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

interface ToolQueryParam {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  enum?: string[];
}

interface ShimTool {
  name: string;
  displayName: string;
  description: string;
  category: string;
  method: HttpMethod;
  urlTemplate: string;
  bodyTemplate: string;
  queryParams: ToolQueryParam[];
  pathParams: string[];
}

interface HistoryEntry {
  id: string;
  timestamp: number;
  toolName: string;
  method: HttpMethod;
  url: string;
  status: number | null;
  durationMs: number | null;
  responseBody: unknown;
  error: string | null;
}

// ─── SHIM Tool Catalog ────────────────────────────────────────────────────────

const SHIM_TOOLS: ShimTool[] = [
  // ── Tasks ──────────────────────────────────────────────────────────────────
  {
    name: "shim_list_tasks",
    displayName: "List Tasks",
    description: "Returns Kevin's Darwin workday tasks. Optionally filter by status or priority.",
    category: "Tasks",
    method: "GET",
    urlTemplate: "/api/v1/tasks",
    bodyTemplate: "",
    queryParams: [
      {
        name: "status",
        type: "string",
        description: "Filter by task status",
        required: false,
        enum: ["open", "in_progress", "completed", "blocked"],
      },
      { name: "priority", type: "number", description: "Priority: 1=Low 2=Med 3=High 4=Urgent", required: false },
      { name: "project_id", type: "number", description: "Filter by project ID", required: false },
    ],
    pathParams: [],
  },
  {
    name: "shim_create_task",
    displayName: "Create Task",
    description: "Creates a new Darwin workday task for Kevin.",
    category: "Tasks",
    method: "POST",
    urlTemplate: "/api/v1/tasks",
    bodyTemplate: JSON.stringify(
      { title: "", description: "", priority: 2, due_date: "", project_id: null, parent_task_id: null },
      null,
      2,
    ),
    queryParams: [],
    pathParams: [],
  },
  {
    name: "shim_update_task",
    displayName: "Update Task",
    description: "Updates an existing task's status, priority, title, or description.",
    category: "Tasks",
    method: "PUT",
    urlTemplate: "/api/v1/tasks/{id}",
    bodyTemplate: JSON.stringify(
      { title: "", description: "", status: "in_progress", priority: 2, due_date: "" },
      null,
      2,
    ),
    queryParams: [],
    pathParams: ["id"],
  },
  {
    name: "shim_complete_task",
    displayName: "Complete Task",
    description: "Marks a task (and all its subtasks) as completed.",
    category: "Tasks",
    method: "PUT",
    urlTemplate: "/api/v1/tasks/{id}",
    bodyTemplate: JSON.stringify({ mark_complete: true }, null, 2),
    queryParams: [],
    pathParams: ["id"],
  },
  // ── Projects ───────────────────────────────────────────────────────────────
  {
    name: "shim_list_projects",
    displayName: "List Projects",
    description: "Returns Kevin's active Darwin projects from SHIM.",
    category: "Projects",
    method: "GET",
    urlTemplate: "/api/v1/projects",
    bodyTemplate: "",
    queryParams: [
      {
        name: "status",
        type: "string",
        description: "Filter by project status",
        required: false,
        enum: ["active", "paused", "on-hold", "completed"],
      },
    ],
    pathParams: [],
  },
  // ── Fridge Items ───────────────────────────────────────────────────────────
  {
    name: "shim_create_fridge_item",
    displayName: "Add to Fridge",
    description: "Captures an idea to the Fridge (quick-capture backlog) before it evaporates.",
    category: "Fridge Items",
    method: "POST",
    urlTemplate: "/api/v1/fridge-items",
    bodyTemplate: JSON.stringify({ title: "", body: "", project_id: null }, null, 2),
    queryParams: [],
    pathParams: [],
  },
  {
    name: "shim_list_fridge_items",
    displayName: "List Fridge Items",
    description: "Lists ideas currently on ice in the Fridge, including freshness status.",
    category: "Fridge Items",
    method: "GET",
    urlTemplate: "/api/v1/fridge-items",
    bodyTemplate: "",
    queryParams: [
      {
        name: "status",
        type: "string",
        description: "Filter by status",
        required: false,
        enum: ["active", "promoted", "archived"],
      },
    ],
    pathParams: [],
  },
  // ── Focus Sessions ─────────────────────────────────────────────────────────
  {
    name: "shim_start_focus_session",
    displayName: "Start Focus Session",
    description: "Starts a new Pomodoro focus session.",
    category: "Focus Sessions",
    method: "POST",
    urlTemplate: "/api/v1/focus-sessions/start",
    bodyTemplate: JSON.stringify(
      { project_id: null, task_description: "", planned_duration: 25 },
      null,
      2,
    ),
    queryParams: [],
    pathParams: [],
  },
  {
    name: "shim_stop_focus_session",
    displayName: "Stop Focus Session",
    description: "Ends an active focus session.",
    category: "Focus Sessions",
    method: "POST",
    urlTemplate: "/api/v1/focus-sessions/{id}/stop",
    bodyTemplate: "",
    queryParams: [],
    pathParams: ["id"],
  },
  // ── Analytics ──────────────────────────────────────────────────────────────
  {
    name: "shim_get_today_summary",
    displayName: "Today's Focus Sessions",
    description:
      "Returns today's focus sessions. Combine with the tasks endpoint for a full workday summary.",
    category: "Analytics",
    method: "GET",
    urlTemplate: "/api/v1/focus-sessions",
    bodyTemplate: "",
    queryParams: [
      { name: "date", type: "string", description: "Date filter (YYYY-MM-DD)", required: false },
    ],
    pathParams: [],
  },
];

const SHIM_CATEGORIES = [...new Set(SHIM_TOOLS.map((t) => t.category))];

// ─── Persistence ──────────────────────────────────────────────────────────────

const HISTORY_KEY = "paperclip_shim_runner_history";
const CONFIG_KEY = "paperclip_shim_runner_config";
const MAX_HISTORY = 20;
const DEFAULT_BASE_URL = "https://somehow.thedarwinhub.com";

function loadHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as HistoryEntry[];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)));
  } catch {
    // ignore
  }
}

function loadConfig(): { baseUrl: string; apiToken: string } {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}") as {
      baseUrl: string;
      apiToken: string;
    };
  } catch {
    return { baseUrl: DEFAULT_BASE_URL, apiToken: "" };
  }
}

function saveConfig(config: { baseUrl: string; apiToken: string }) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // ignore
  }
}

// ─── JsonNode ─────────────────────────────────────────────────────────────────

function JsonNode({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);

  if (value === null) return <span className="text-muted-foreground">null</span>;
  if (typeof value === "boolean")
    return <span className={value ? "text-green-500" : "text-red-500"}>{String(value)}</span>;
  if (typeof value === "number") return <span className="text-blue-500">{value}</span>;
  if (typeof value === "string") return <span className="text-amber-600">"{value}"</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">[]</span>;
    return (
      <span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-muted-foreground hover:text-foreground"
        >
          {open ? "▼" : "▶"} [{value.length}]
        </button>
        {open && (
          <div className="ml-4 border-l border-border pl-2">
            {value.map((v, i) => (
              <div key={i} className="flex gap-1">
                <span className="text-muted-foreground text-xs shrink-0">{i}</span>
                <span className="text-muted-foreground">:</span>
                <JsonNode value={v} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    if (keys.length === 0) return <span className="text-muted-foreground">{"{}"}</span>;
    return (
      <span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-muted-foreground hover:text-foreground"
        >
          {open ? "▼" : "▶"} {"{" + keys.length + "}"}
        </button>
        {open && (
          <div className="ml-4 border-l border-border pl-2">
            {keys.map((k) => (
              <div key={k} className="flex gap-1 flex-wrap">
                <span className="text-purple-500 text-xs shrink-0">"{k}"</span>
                <span className="text-muted-foreground">:</span>
                <JsonNode value={(value as Record<string, unknown>)[k]} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }

  return <span>{String(value)}</span>;
}

// ─── StatusBadge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: number }) {
  const color =
    status >= 500
      ? "text-red-600 bg-red-50 border-red-200"
      : status >= 400
        ? "text-orange-600 bg-orange-50 border-orange-200"
        : status >= 300
          ? "text-amber-600 bg-amber-50 border-amber-200"
          : "text-green-600 bg-green-50 border-green-200";
  return (
    <span className={`text-xs font-mono px-1.5 py-0.5 rounded border ${color}`}>{status}</span>
  );
}

// ─── MethodBadge ─────────────────────────────────────────────────────────────

function MethodBadge({ method }: { method: HttpMethod }) {
  const color =
    method === "GET"
      ? "text-green-700"
      : method === "POST"
        ? "text-blue-700"
        : method === "PUT"
          ? "text-amber-700"
          : "text-red-700";
  return <span className={`text-xs font-mono font-bold ${color}`}>{method}</span>;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ShimRunner() {
  const { setBreadcrumbs } = useBreadcrumbs();

  // Config
  const [baseUrl, setBaseUrl] = useState(() => loadConfig().baseUrl || DEFAULT_BASE_URL);
  const [apiToken, setApiToken] = useState(() => loadConfig().apiToken || "");
  const [showConfig, setShowConfig] = useState(false);
  const [connStatus, setConnStatus] = useState<"unknown" | "ok" | "error">("unknown");
  const [connChecking, setConnChecking] = useState(false);

  // Tool selection
  const [selectedTool, setSelectedTool] = useState<ShimTool | null>(SHIM_TOOLS[0] ?? null);
  const [search, setSearch] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(true);
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());

  // Inputs
  const [pathVars, setPathVars] = useState<Record<string, string>>({});
  const [queryValues, setQueryValues] = useState<Record<string, string>>({});
  const [body, setBody] = useState("");

  // Response + execution
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<HistoryEntry | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // History
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Developers" }, { label: "SHIM Runner" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    saveConfig({ baseUrl, apiToken });
  }, [baseUrl, apiToken]);

  // Reset inputs when tool changes
  useEffect(() => {
    if (!selectedTool) return;
    setBody(selectedTool.bodyTemplate);
    const pv: Record<string, string> = {};
    selectedTool.pathParams.forEach((p) => (pv[p] = ""));
    setPathVars(pv);
    const qv: Record<string, string> = {};
    selectedTool.queryParams.forEach((p) => (qv[p.name] = ""));
    setQueryValues(qv);
    setResponse(null);
  }, [selectedTool]);

  function resolveUrl(tool: ShimTool): string {
    let url = baseUrl.replace(/\/$/, "") + tool.urlTemplate;
    tool.pathParams.forEach((p) => {
      url = url.replace(`{${p}}`, encodeURIComponent(pathVars[p] ?? ""));
    });
    const qps = tool.queryParams
      .filter((p) => queryValues[p.name]?.trim())
      .map(
        (p) =>
          `${encodeURIComponent(p.name)}=${encodeURIComponent(queryValues[p.name]!.trim())}`,
      );
    if (qps.length > 0) url += "?" + qps.join("&");
    return url;
  }

  async function testConnection() {
    setConnChecking(true);
    try {
      const base = baseUrl.replace(/\/$/, "");
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiToken.trim()) headers["Authorization"] = `Bearer ${apiToken.trim()}`;
      const res = await fetch(`${base}/api/v1/tasks?status=open`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      setConnStatus(res.ok ? "ok" : "error");
    } catch {
      setConnStatus("error");
    } finally {
      setConnChecking(false);
    }
  }

  const run = useCallback(async () => {
    if (!selectedTool) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setResponse(null);

    const url = resolveUrl(selectedTool);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiToken.trim()) headers["Authorization"] = `Bearer ${apiToken.trim()}`;
    const hasBody =
      selectedTool.method !== "GET" && selectedTool.method !== "DELETE" && body.trim();
    if (hasBody) headers["Content-Type"] = "application/json";

    const t0 = Date.now();
    let entry: HistoryEntry;
    try {
      const res = await fetch(url, {
        method: selectedTool.method,
        headers,
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
        toolName: selectedTool.name,
        method: selectedTool.method,
        url,
        status: res.status,
        durationMs,
        responseBody,
        error: null,
      };
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") {
        setLoading(false);
        return;
      }
      entry = {
        id: Math.random().toString(36).slice(2),
        timestamp: Date.now(),
        toolName: selectedTool.name,
        method: selectedTool.method,
        url,
        status: null,
        durationMs: Date.now() - t0,
        responseBody: null,
        error: (err as Error).message ?? "Unknown error",
      };
    }

    setResponse(entry);
    setLoading(false);
    const updated = [entry, ...history];
    setHistory(updated);
    saveHistory(updated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTool, baseUrl, apiToken, body, pathVars, queryValues, history]);

  const filteredTools = search.trim()
    ? SHIM_TOOLS.filter(
        (t) =>
          t.name.toLowerCase().includes(search.toLowerCase()) ||
          t.displayName.toLowerCase().includes(search.toLowerCase()) ||
          t.description.toLowerCase().includes(search.toLowerCase()),
      )
    : SHIM_TOOLS;

  function toggleCat(cat: string) {
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* ── Header bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border shrink-0">
        <Wrench className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-semibold">SHIM Runner</span>
        <span className="text-xs text-muted-foreground flex-1">
          Somehow I Manage · MCP Tool Playground
        </span>

        <div className="flex items-center gap-2 shrink-0">
          {connStatus === "ok" && (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
              <span className="text-xs text-green-600">Connected</span>
            </>
          )}
          {connStatus === "error" && (
            <>
              <XCircle className="h-3.5 w-3.5 text-red-500" />
              <span className="text-xs text-red-600">Unreachable</span>
            </>
          )}
          {connStatus === "unknown" && (
            <>
              <Wifi className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Not tested</span>
            </>
          )}
          <button
            onClick={testConnection}
            disabled={connChecking}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-accent transition-colors disabled:opacity-50"
          >
            {connChecking ? "Testing…" : "Test Connection"}
          </button>
        </div>

        <button
          onClick={() => setShowConfig((v) => !v)}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-accent transition-colors shrink-0"
        >
          {showConfig ? "Hide Config" : "Config"}
        </button>
      </div>

      {/* ── Config panel ───────────────────────────────────────────────────── */}
      {showConfig && (
        <div className="flex items-center gap-6 px-4 py-2 border-b border-border bg-muted/30 text-xs shrink-0">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground w-20 shrink-0">Base URL</span>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="border border-border rounded px-2 py-1 text-xs bg-background w-72 font-mono"
              placeholder="https://somehow.thedarwinhub.com"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground shrink-0">API Token</span>
            <input
              type="password"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              className="border border-border rounded px-2 py-1 text-xs bg-background w-48 font-mono"
              placeholder="Optional bearer token"
            />
          </label>
        </div>
      )}

      {/* ── Main layout ────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Tool catalog */}
        {catalogOpen && (
          <div className="w-56 shrink-0 border-r border-border flex flex-col overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-2 border-b border-border shrink-0">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tools…"
                className="flex-1 text-xs border border-border rounded px-2 py-1 bg-background"
              />
              <button
                onClick={() => setCatalogOpen(false)}
                className="text-muted-foreground hover:text-foreground p-0.5"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {(search.trim() ? ["Results"] : SHIM_CATEGORIES).map((cat) => {
                const tools = search.trim()
                  ? filteredTools
                  : filteredTools.filter((t) => t.category === cat);
                const isCollapsed = collapsedCats.has(cat);
                return (
                  <div key={cat}>
                    <button
                      onClick={() => toggleCat(cat)}
                      className="flex items-center gap-1 w-full px-3 py-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors uppercase tracking-wide"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-3 w-3 shrink-0" />
                      ) : (
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      )}
                      {cat}
                    </button>
                    {!isCollapsed &&
                      tools.map((tool) => (
                        <button
                          key={tool.name}
                          onClick={() => setSelectedTool(tool)}
                          className={`w-full text-left px-4 py-2 text-xs transition-colors ${
                            selectedTool?.name === tool.name
                              ? "bg-accent text-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                          }`}
                        >
                          <div className="font-medium mb-0.5 text-foreground/80">
                            {tool.displayName}
                          </div>
                          <MethodBadge method={tool.method} />
                        </button>
                      ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Editor + Response */}
        <div className="flex-1 flex min-w-0 overflow-hidden">
          {/* Tool editor */}
          <div className="flex-1 min-w-0 flex flex-col border-r border-border overflow-hidden">
            {selectedTool ? (
              <>
                {/* Tool header */}
                <div className="px-4 py-3 border-b border-border shrink-0">
                  <div className="flex items-center gap-2 mb-1">
                    {!catalogOpen && (
                      <button
                        onClick={() => setCatalogOpen(true)}
                        className="text-xs px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground mr-1"
                      >
                        ☰
                      </button>
                    )}
                    <span className="text-sm font-semibold">{selectedTool.displayName}</span>
                    <MethodBadge method={selectedTool.method} />
                    <code className="text-[11px] text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded">
                      {selectedTool.name}
                    </code>
                  </div>
                  <p className="text-xs text-muted-foreground">{selectedTool.description}</p>
                </div>

                {/* URL bar + Run button */}
                <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/20 shrink-0">
                  <MethodBadge method={selectedTool.method} />
                  <code className="text-xs font-mono text-muted-foreground flex-1 truncate">
                    {resolveUrl(selectedTool)}
                  </code>
                  <button
                    onClick={run}
                    disabled={loading}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 shrink-0"
                  >
                    {loading ? (
                      <>
                        <div className="h-3 w-3 animate-spin rounded-full border border-primary-foreground border-t-transparent" />
                        Running
                      </>
                    ) : (
                      <>
                        <Play className="h-3 w-3" />
                        Run
                      </>
                    )}
                  </button>
                  {loading && (
                    <button
                      onClick={() => abortRef.current?.abort()}
                      className="text-muted-foreground hover:text-foreground"
                      title="Cancel"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Parameters */}
                <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
                  {selectedTool.pathParams.length > 0 && (
                    <section>
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                        Path Parameters
                      </div>
                      <div className="flex flex-col gap-2">
                        {selectedTool.pathParams.map((p) => (
                          <div key={p} className="flex items-center gap-3">
                            <code className="text-xs font-mono w-20 shrink-0 text-foreground">
                              {p}
                            </code>
                            <input
                              type="text"
                              value={pathVars[p] ?? ""}
                              onChange={(e) =>
                                setPathVars((prev) => ({ ...prev, [p]: e.target.value }))
                              }
                              placeholder={`{${p}}`}
                              className="flex-1 text-xs font-mono border border-border rounded px-2 py-1 bg-background"
                            />
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {selectedTool.queryParams.length > 0 && (
                    <section>
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                        Query Parameters
                      </div>
                      <div className="flex flex-col gap-3">
                        {selectedTool.queryParams.map((p) => (
                          <div key={p.name} className="flex items-start gap-3">
                            <div className="w-28 shrink-0 pt-1">
                              <code className="text-xs font-mono text-foreground">{p.name}</code>
                              {p.required && <span className="text-red-500 ml-0.5">*</span>}
                            </div>
                            <div className="flex-1">
                              {p.enum ? (
                                <select
                                  value={queryValues[p.name] ?? ""}
                                  onChange={(e) =>
                                    setQueryValues((prev) => ({
                                      ...prev,
                                      [p.name]: e.target.value,
                                    }))
                                  }
                                  className="w-full text-xs border border-border rounded px-2 py-1 bg-background"
                                >
                                  <option value="">— any —</option>
                                  {p.enum.map((v) => (
                                    <option key={v} value={v}>
                                      {v}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  value={queryValues[p.name] ?? ""}
                                  onChange={(e) =>
                                    setQueryValues((prev) => ({
                                      ...prev,
                                      [p.name]: e.target.value,
                                    }))
                                  }
                                  placeholder={p.type}
                                  className="w-full text-xs font-mono border border-border rounded px-2 py-1 bg-background"
                                />
                              )}
                              {p.description && (
                                <div className="text-[11px] text-muted-foreground mt-0.5">
                                  {p.description}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {selectedTool.method !== "GET" && selectedTool.method !== "DELETE" && (
                    <section className="flex-1 flex flex-col min-h-0">
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                        Request Body (JSON)
                      </div>
                      <textarea
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        className="flex-1 min-h-[180px] font-mono text-xs border border-border rounded p-2 bg-background resize-none leading-5"
                        spellCheck={false}
                      />
                    </section>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                Select a tool from the catalog
              </div>
            )}
          </div>

          {/* Response panel */}
          <div className="w-96 shrink-0 flex flex-col overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
              <span className="text-xs font-semibold text-muted-foreground">Response</span>
              {response?.status != null && <StatusBadge status={response.status} />}
              {response?.durationMs != null && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
                  <Clock className="h-3 w-3" />
                  {response.durationMs}ms
                </span>
              )}
              {response?.responseBody != null && (
                <button
                  onClick={() =>
                    navigator.clipboard.writeText(
                      JSON.stringify(response.responseBody, null, 2),
                    )
                  }
                  className="text-muted-foreground hover:text-foreground"
                  title="Copy response"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {loading && (
                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
                  Sending request…
                </div>
              )}
              {!loading && response?.error && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">
                  {response.error}
                </div>
              )}
              {!loading && !response?.error && response?.responseBody != null && (
                <div className="text-xs font-mono leading-5">
                  <JsonNode value={response.responseBody} />
                </div>
              )}
              {!loading && !response && (
                <div className="text-xs text-muted-foreground italic">
                  No response yet — select a tool and click Run.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── History ────────────────────────────────────────────────────────── */}
      <div className="border-t border-border shrink-0">
        <button
          onClick={() => setHistoryOpen((o) => !o)}
          className="flex items-center gap-2 w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {historyOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <History className="h-3.5 w-3.5" />
          History ({history.length})
          {history.length > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setHistory([]);
                saveHistory([]);
              }}
              className="ml-auto text-muted-foreground hover:text-foreground px-1"
            >
              Clear
            </button>
          )}
        </button>
        {historyOpen && history.length > 0 && (
          <div className="max-h-40 overflow-y-auto border-t border-border">
            {history.map((entry) => (
              <button
                key={entry.id}
                onClick={() => {
                  const tool = SHIM_TOOLS.find((t) => t.name === entry.toolName);
                  if (tool) setSelectedTool(tool);
                  setResponse(entry);
                }}
                className="flex items-center gap-2 w-full px-4 py-1.5 text-xs text-left hover:bg-accent transition-colors"
              >
                <MethodBadge method={entry.method} />
                <span className="text-muted-foreground truncate flex-1 font-mono text-[11px]">
                  {entry.toolName}
                </span>
                {entry.status != null && <StatusBadge status={entry.status} />}
                {entry.durationMs != null && (
                  <span className="text-muted-foreground text-[10px]">{entry.durationMs}ms</span>
                )}
                <span className="text-muted-foreground text-[10px]">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
