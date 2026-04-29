import React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

// ─── Types ────────────────────────────────────────────────────────────────────

type TodaySnapshot = {
  date: string | null;
  sessionCount: number;
  activeSession: { id: number; task_description?: string } | null;
  openTaskCount: number;
  urgentTaskCount: number;
};

type ConfigStatus = {
  baseUrl: string;
  hasApiToken: boolean;
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
  page: { padding: "24px 32px", maxWidth: 720 } as React.CSSProperties,
  title: { fontSize: 22, fontWeight: 700, marginBottom: 4 } as React.CSSProperties,
  subtitle: { fontSize: 14, color: "#6b7280", marginBottom: 24 } as React.CSSProperties,
  card: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: "16px 20px",
    marginBottom: 16,
  } as React.CSSProperties,
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 } as React.CSSProperties,
  stat: {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: "14px 18px",
    textAlign: "center" as const,
  } as React.CSSProperties,
  statNum: { fontSize: 28, fontWeight: 700, color: "#111827" } as React.CSSProperties,
  statLabel: { fontSize: 12, color: "#6b7280", marginTop: 2 } as React.CSSProperties,
  badge: (ok: boolean): React.CSSProperties => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
    background: ok ? "#d1fae5" : "#fee2e2",
    color: ok ? "#065f46" : "#991b1b",
  }),
  activeBadge: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
    background: "#dbeafe",
    color: "#1e40af",
  } as React.CSSProperties,
  section: { fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 8 } as React.CSSProperties,
  row: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, fontSize: 13 } as React.CSSProperties,
};

// ─── Today Widget ─────────────────────────────────────────────────────────────

export function ShimTodayWidget() {
  const { data: snapshot } = usePluginData<TodaySnapshot>("today-snapshot");

  if (!snapshot || !snapshot.date) {
    return (
      <div style={s.card}>
        <div style={s.section}>Darwin Workday</div>
        <div style={{ fontSize: 13, color: "#9ca3af" }}>Unable to connect to SHIM.</div>
      </div>
    );
  }

  return (
    <div style={s.card}>
      <div style={{ ...s.section, display: "flex", justifyContent: "space-between" }}>
        <span>Darwin Workday — {snapshot.date}</span>
        {snapshot.activeSession && (
          <span style={s.activeBadge}>🎯 Session Active</span>
        )}
      </div>
      <div style={s.grid}>
        <div style={s.stat}>
          <div style={s.statNum}>{snapshot.sessionCount}</div>
          <div style={s.statLabel}>Focus Sessions</div>
        </div>
        <div style={s.stat}>
          <div style={{ ...s.statNum, color: snapshot.urgentTaskCount > 0 ? "#dc2626" : "#111827" }}>
            {snapshot.urgentTaskCount}
          </div>
          <div style={s.statLabel}>Urgent Tasks</div>
        </div>
      </div>
      {snapshot.activeSession?.task_description && (
        <div style={{ fontSize: 12, color: "#6b7280" }}>
          Currently: {snapshot.activeSession.task_description}
        </div>
      )}
    </div>
  );
}

// ─── Full Page ────────────────────────────────────────────────────────────────

export function ShimPage() {
  const { data: snapshot } = usePluginData<TodaySnapshot>("today-snapshot");
  const { data: config } = usePluginData<ConfigStatus>("config-status");

  return (
    <div style={s.page}>
      <div style={s.title}>Somehow I Manage</div>
      <div style={s.subtitle}>Kevin's ADHD-optimized Darwin workday dashboard</div>

      <div style={s.card}>
        <div style={s.section}>Connection</div>
        <div style={s.row}>
          <span>Base URL</span>
          <span style={{ fontSize: 12, color: "#6b7280" }}>{config?.baseUrl ?? "—"}</span>
        </div>
        <div style={s.row}>
          <span>API Token</span>
          <span style={s.badge(Boolean(config?.hasApiToken))}>
            {config?.hasApiToken ? "Configured" : "Not set (public access)"}
          </span>
        </div>
      </div>

      {snapshot?.date ? (
        <div style={s.card}>
          <div style={{ ...s.section, display: "flex", justifyContent: "space-between" }}>
            <span>Today — {snapshot.date}</span>
            {snapshot.activeSession && <span style={s.activeBadge}>🎯 Session Active</span>}
          </div>
          <div style={s.grid}>
            <div style={s.stat}>
              <div style={s.statNum}>{snapshot.sessionCount}</div>
              <div style={s.statLabel}>Focus Sessions Today</div>
            </div>
            <div style={s.stat}>
              <div style={s.statNum}>{snapshot.openTaskCount}</div>
              <div style={s.statLabel}>Open Tasks</div>
            </div>
            <div style={s.stat}>
              <div style={{ ...s.statNum, color: snapshot.urgentTaskCount > 0 ? "#dc2626" : "#16a34a" }}>
                {snapshot.urgentTaskCount}
              </div>
              <div style={s.statLabel}>High/Urgent Tasks</div>
            </div>
          </div>
          {snapshot.activeSession?.task_description && (
            <div style={{ fontSize: 13, color: "#374151", marginTop: 8 }}>
              <strong>Active session:</strong> {snapshot.activeSession.task_description}
            </div>
          )}
        </div>
      ) : (
        <div style={s.card}>
          <div style={{ fontSize: 13, color: "#9ca3af" }}>
            Could not load today's snapshot — check SHIM base URL in plugin settings.
          </div>
        </div>
      )}

      <div style={s.card}>
        <div style={s.section}>Available Agent Tools</div>
        {[
          ["shim_list_tasks", "List Kevin's Darwin workday tasks"],
          ["shim_create_task", "Create a new task"],
          ["shim_update_task", "Update task status, priority, or title"],
          ["shim_complete_task", "Mark a task (and subtasks) complete"],
          ["shim_list_projects", "List active Darwin projects"],
          ["shim_create_fridge_item", "Capture an idea to the Fridge"],
          ["shim_list_fridge_items", "List ideas on ice in the Fridge"],
          ["shim_get_today_summary", "Get today's workday summary"],
          ["shim_start_focus_session", "Start a Pomodoro focus session"],
          ["shim_stop_focus_session", "Stop an active focus session"],
        ].map(([name, desc]) => (
          <div key={name} style={{ ...s.row, borderBottom: "1px solid #f3f4f6", paddingBottom: 6 }}>
            <code style={{ fontSize: 12, background: "#f3f4f6", padding: "2px 6px", borderRadius: 4 }}>
              {name}
            </code>
            <span style={{ fontSize: 12, color: "#6b7280", flex: 1, marginLeft: 12 }}>{desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
