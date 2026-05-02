import { useState, useEffect, useCallback, useRef } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import {
  Send,
  ChevronDown,
  ChevronRight,
  Clock,
  Puzzle,
  Copy,
  RotateCcw,
  Search,
  X,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { JsonNode } from "../components/dev/JsonNode";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PluginToolDescriptor {
  name: string;
  displayName: string;
  description: string;
  parametersSchema?: JsonSchema;
  pluginId: string;
  pluginKey?: string;
  pluginDisplayName?: string;
  workerRunning?: boolean;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  items?: JsonSchemaProperty;
}

interface HistoryEntry {
  id: string;
  timestamp: number;
  toolName: string;
  toolDisplayName: string;
  parameters: Record<string, unknown>;
  durationMs: number | null;
  result: unknown;
  error: string | null;
  success: boolean;
}

// ─── History Persistence ─────────────────────────────────────────────────────

const HISTORY_KEY = "paperclip_plugin_runner_history";
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

// ─── Parameter Form ──────────────────────────────────────────────────────────

function ParameterForm({
  schema,
  values,
  onChange,
}: {
  schema: JsonSchema | undefined;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  if (!schema?.properties || Object.keys(schema.properties).length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic py-2">
        This tool takes no parameters.
      </div>
    );
  }

  const required = new Set(schema.required ?? []);

  return (
    <div className="flex flex-col gap-3">
      {Object.entries(schema.properties).map(([key, prop]) => (
        <div key={key} className="flex flex-col gap-1">
          <label className="text-xs font-medium text-foreground">
            {key}
            {required.has(key) && <span className="text-destructive ml-0.5">*</span>}
            {prop.type && (
              <span className="text-muted-foreground font-normal ml-1.5">({prop.type})</span>
            )}
          </label>
          {prop.description && (
            <span className="text-[11px] text-muted-foreground">{prop.description}</span>
          )}
          {prop.enum ? (
            <select
              value={values[key] ?? ""}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
              className="px-2 py-1.5 text-sm rounded border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">— select —</option>
              {prop.enum.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          ) : prop.type === "boolean" ? (
            <select
              value={values[key] ?? ""}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
              className="px-2 py-1.5 text-sm rounded border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">— default —</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              value={values[key] ?? ""}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
              placeholder={prop.default !== undefined ? String(prop.default) : ""}
              className="px-2 py-1.5 text-sm rounded border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Catalog Panel ───────────────────────────────────────────────────────────

interface ToolGroup {
  pluginDisplayName: string;
  pluginId: string;
  tools: PluginToolDescriptor[];
  workerRunning: boolean;
}

function CatalogPanel({
  groups,
  selectedTool,
  onSelect,
  onClose,
}: {
  groups: ToolGroup[];
  selectedTool: PluginToolDescriptor | null;
  onSelect: (tool: PluginToolDescriptor) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(groups.map((g) => g.pluginId)),
  );

  function toggleGroup(id: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtered = query.trim()
    ? groups
        .map((g) => ({
          ...g,
          tools: g.tools.filter(
            (t) =>
              t.displayName.toLowerCase().includes(query.toLowerCase()) ||
              t.name.toLowerCase().includes(query.toLowerCase()) ||
              t.description.toLowerCase().includes(query.toLowerCase()),
          ),
        }))
        .filter((g) => g.tools.length > 0)
    : groups;

  return (
    <div className="flex flex-col border-r border-border bg-background w-64 shrink-0 min-h-0 h-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <Puzzle className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-semibold flex-1">Plugin Tools</span>
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
            placeholder="Filter tools…"
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
        {filtered.map((group) => (
          <div key={group.pluginId}>
            <button
              onClick={() => toggleGroup(group.pluginId)}
              className="flex items-center gap-1.5 w-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              {openGroups.has(group.pluginId) ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <span className="flex-1 text-left">{group.pluginDisplayName}</span>
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  group.workerRunning ? "bg-green-500" : "bg-amber-500"
                }`}
                title={group.workerRunning ? "Worker running" : "Worker idle — starts on first execution"}
              />
            </button>
            {openGroups.has(group.pluginId) && (
              <div className="mb-1">
                {group.tools.map((tool) => (
                  <button
                    key={tool.name}
                    onClick={() => onSelect(tool)}
                    className={`flex items-center gap-2 w-full px-4 py-1.5 text-xs text-left group ${
                      selectedTool?.name === tool.name
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50 text-foreground/80 group-hover:text-foreground"
                    }`}
                  >
                    <span className="truncate">{tool.displayName}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-xs text-muted-foreground text-center">
            No tools match "{query}"
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function PluginRunner() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();

  useEffect(() => {
    setBreadcrumbs([{ label: "Developers" }, { label: "Plugin Runner" }]);
  }, [setBreadcrumbs]);

  // ── Plugin tools state
  const [tools, setTools] = useState<PluginToolDescriptor[]>([]);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsError, setToolsError] = useState<string | null>(null);

  // ── Selection state
  const [selectedTool, setSelectedTool] = useState<PluginToolDescriptor | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});

  // ── Execution state
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<HistoryEntry | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── History
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [historyOpen, setHistoryOpen] = useState(true);

  // ── Catalog
  const [catalogOpen, setCatalogOpen] = useState(true);

  // ── Copy state
  const [copied, setCopied] = useState(false);

  // ── Fetch tools on mount
  useEffect(() => {
    async function fetchTools() {
      setToolsLoading(true);
      setToolsError(null);
      try {
        const res = await fetch("/api/plugins/tools", { credentials: "include" });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as PluginToolDescriptor[];
        setTools(data);
        if (data.length > 0 && !selectedTool) {
          setSelectedTool(data[0]);
        }
      } catch (err) {
        setToolsError((err as Error).message);
      } finally {
        setToolsLoading(false);
      }
    }
    fetchTools();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reset params when tool changes
  useEffect(() => {
    if (!selectedTool) return;
    const initial: Record<string, string> = {};
    const props = selectedTool.parametersSchema?.properties;
    if (props) {
      for (const [key, prop] of Object.entries(props)) {
        initial[key] = prop.default !== undefined ? String(prop.default) : "";
      }
    }
    setParamValues(initial);
    setResponse(null);
  }, [selectedTool]);

  // ── Group tools by plugin
  const groups: ToolGroup[] = (() => {
    const map = new Map<string, ToolGroup>();
    for (const tool of tools) {
      if (!map.has(tool.pluginId)) {
        map.set(tool.pluginId, {
          pluginId: tool.pluginId,
          pluginDisplayName: tool.pluginDisplayName ?? tool.pluginKey ?? tool.pluginId,
          tools: [],
          workerRunning: tool.workerRunning ?? false,
        });
      }
      map.get(tool.pluginId)!.tools.push(tool);
    }
    return [...map.values()];
  })();

  // ── Execute tool
  const execute = useCallback(async () => {
    if (!selectedTool) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setResponse(null);

    // Build parameters object — only include non-empty values, coerce types
    const parameters: Record<string, unknown> = {};
    const props = selectedTool.parametersSchema?.properties ?? {};
    for (const [key, val] of Object.entries(paramValues)) {
      if (val === "") continue;
      const propDef = props[key];
      if (propDef?.type === "number" || propDef?.type === "integer") {
        const num = Number(val);
        if (!isNaN(num)) parameters[key] = num;
      } else if (propDef?.type === "boolean") {
        parameters[key] = val === "true";
      } else {
        parameters[key] = val;
      }
    }

    const t0 = Date.now();
    let entry: HistoryEntry;
    try {
      const res = await fetch("/api/plugins/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          tool: selectedTool.name,
          parameters,
          runContext: {
            agentId: "board-user",
            runId: `plugin-runner-${Date.now()}`,
            companyId: selectedCompanyId ?? "",
          },
        }),
        signal: ctrl.signal,
      });
      const durationMs = Date.now() - t0;
      const body = await res.json().catch(() => null);
      entry = {
        id: Math.random().toString(36).slice(2),
        timestamp: Date.now(),
        toolName: selectedTool.name,
        toolDisplayName: selectedTool.displayName,
        parameters,
        durationMs,
        result: body,
        error: res.ok ? null : (body?.error ?? `HTTP ${res.status}`),
        success: res.ok,
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
        toolDisplayName: selectedTool.displayName,
        parameters,
        durationMs: Date.now() - t0,
        result: null,
        error: (err as Error).message,
        success: false,
      };
    }

    setResponse(entry);
    setLoading(false);
    const updated = [entry, ...history];
    setHistory(updated);
    saveHistory(updated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTool, paramValues, selectedCompanyId, history]);

  function copyResult() {
    if (!response?.result) return;
    navigator.clipboard.writeText(JSON.stringify(response.result, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function restore(entry: HistoryEntry) {
    const tool = tools.find((t) => t.name === entry.toolName);
    if (tool) {
      setSelectedTool(tool);
      const vals: Record<string, string> = {};
      for (const [k, v] of Object.entries(entry.parameters)) {
        vals[k] = String(v ?? "");
      }
      setParamValues(vals);
    }
    setResponse(entry);
  }

  function clearHistory() {
    setHistory([]);
    saveHistory([]);
  }

  // ── Loading / error states
  if (toolsLoading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading plugin tools…</span>
      </div>
    );
  }

  if (toolsError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <div className="text-sm text-center max-w-sm">
          <p className="font-medium text-foreground">Failed to load plugin tools</p>
          <p className="mt-1">{toolsError}</p>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-border hover:bg-accent"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    );
  }

  if (tools.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Puzzle className="h-8 w-8" />
        <div className="text-sm text-center max-w-sm">
          <p className="font-medium text-foreground">No plugin tools available</p>
          <p className="mt-1">Install and enable plugins with registered tools to use this runner.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Catalog sidebar */}
      {catalogOpen && (
        <CatalogPanel
          groups={groups}
          selectedTool={selectedTool}
          onSelect={setSelectedTool}
          onClose={() => setCatalogOpen(false)}
        />
      )}

      {/* Main content */}
      <div className="flex flex-col flex-1 min-h-0 gap-4 p-4 md:p-6 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 shrink-0">
          <Puzzle className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-bold">Plugin Runner</h1>
          <span className="text-xs text-muted-foreground ml-2">Execute plugin tools directly</span>
          <button
            onClick={() => setCatalogOpen(!catalogOpen)}
            title={catalogOpen ? "Hide tool catalog" : "Browse tool catalog"}
            className={`ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border transition-colors ${
              catalogOpen
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
            }`}
          >
            <Puzzle className="h-3.5 w-3.5" />
            Tools
          </button>
        </div>

        {/* Tool info + params + execute */}
        <div className="flex flex-col lg:flex-row gap-4 flex-1 min-h-0 overflow-hidden">
          {/* Left: tool info + params */}
          <div className="flex flex-col gap-4 lg:w-[400px] shrink-0 overflow-y-auto">
            {selectedTool ? (
              <>
                {/* Tool header */}
                <div className="rounded-lg border border-border p-4">
                  <h2 className="text-sm font-semibold">{selectedTool.displayName}</h2>
                  <p className="text-xs text-muted-foreground mt-1">{selectedTool.description}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <p className="text-[11px] text-muted-foreground/70 font-mono flex-1">
                      {selectedTool.name}
                    </p>
                    <span className={`flex items-center gap-1 text-[11px] ${
                      selectedTool.workerRunning
                        ? "text-green-600 dark:text-green-400"
                        : "text-amber-600 dark:text-amber-400"
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        selectedTool.workerRunning ? "bg-green-500" : "bg-amber-500"
                      }`} />
                      {selectedTool.workerRunning ? "Running" : "Idle"}
                    </span>
                  </div>
                </div>

                {/* Parameters */}
                <div className="rounded-lg border border-border p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    Parameters
                  </h3>
                  <ParameterForm
                    schema={selectedTool.parametersSchema}
                    values={paramValues}
                    onChange={setParamValues}
                  />
                </div>

                {/* Execute button */}
                <button
                  onClick={execute}
                  disabled={loading}
                  onKeyDown={(e) => { if (e.key === "Enter") execute(); }}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 shrink-0"
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Executing…
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4" />
                      Execute Tool
                    </>
                  )}
                </button>
              </>
            ) : (
              <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                Select a tool from the catalog
              </div>
            )}
          </div>

          {/* Right: response */}
          <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
            {response ? (
              <div className="flex flex-col flex-1 min-h-0 rounded-lg border border-border overflow-hidden">
                {/* Response header */}
                <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border shrink-0">
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded ${
                      response.success
                        ? "bg-green-500/10 text-green-600 dark:text-green-400"
                        : "bg-red-500/10 text-red-600 dark:text-red-400"
                    }`}
                  >
                    {response.success ? "SUCCESS" : "ERROR"}
                  </span>
                  {response.durationMs !== null && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {response.durationMs}ms
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground font-mono truncate flex-1">
                    {response.toolDisplayName}
                  </span>
                  <button
                    onClick={copyResult}
                    className="p-1.5 text-muted-foreground hover:text-foreground"
                    title="Copy response"
                  >
                    {copied ? (
                      <span className="text-green-500 text-[10px] font-medium">Copied!</span>
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>

                {/* Response body */}
                <div className="flex-1 overflow-auto p-4 bg-muted/20 font-mono text-xs">
                  {response.error && !response.result ? (
                    <div className="text-destructive">{response.error}</div>
                  ) : response.result != null ? (
                    <JsonNode value={response.result} depth={0} />
                  ) : (
                    <span className="text-muted-foreground italic">No response body</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center flex-1 rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                Execute a tool to see results here
              </div>
            )}
          </div>
        </div>

        {/* History */}
        {history.length > 0 && (
          <div className="shrink-0 border-t border-border pt-3">
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => setHistoryOpen(!historyOpen)}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {historyOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                History ({history.length})
              </button>
              {historyOpen && (
                <button
                  onClick={clearHistory}
                  className="text-[11px] text-muted-foreground hover:text-destructive ml-auto"
                >
                  Clear
                </button>
              )}
            </div>
            {historyOpen && (
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                {history.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() => restore(entry)}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs rounded hover:bg-accent/50 text-left"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        entry.success ? "bg-green-500" : "bg-red-500"
                      }`}
                    />
                    <span className="font-medium truncate flex-1">{entry.toolDisplayName}</span>
                    {entry.durationMs !== null && (
                      <span className="text-muted-foreground shrink-0">{entry.durationMs}ms</span>
                    )}
                    <span className="text-muted-foreground shrink-0">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
