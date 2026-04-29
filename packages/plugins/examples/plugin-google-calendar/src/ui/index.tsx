import React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

// ─── Shared styles ────────────────────────────────────────────────────────────

const styles = {
  card: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: "16px 20px",
    marginBottom: 12,
  } as React.CSSProperties,
  badge: (ok: boolean): React.CSSProperties => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
    background: ok ? "#d1fae5" : "#fee2e2",
    color: ok ? "#065f46" : "#991b1b",
    marginLeft: 6,
  }),
  pre: {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 6,
    padding: 12,
    fontSize: 13,
    whiteSpace: "pre-wrap" as const,
    overflowX: "auto" as const,
    maxHeight: 400,
    overflow: "auto",
  } as React.CSSProperties,
};

// ─── Types ────────────────────────────────────────────────────────────────────

type TodaySummary = {
  date: string | null;
  summary: string | null;
  eventCount: number;
};

type ConfigStatus = {
  gogAccount: string;
  gogWorking: boolean;
  calendarId: string;
  timezone: string;
};

// ─── Today Widget (dashboard) ─────────────────────────────────────────────────

export function TodayWidget() {
  const { data, loading } = usePluginData<TodaySummary>("today-summary");

  if (loading)
    return <div style={{ padding: 16, color: "#6b7280" }}>Loading calendar…</div>;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>📅 Today's Events</div>
      {data?.summary ? (
        <>
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
            {data.eventCount} event{data.eventCount === 1 ? "" : "s"} · {data.date}
          </div>
          <div style={styles.pre}>{data.summary}</div>
        </>
      ) : (
        <div style={{ color: "#6b7280", fontSize: 14 }}>
          No events found or gog is not configured.
        </div>
      )}
    </div>
  );
}

// ─── Full Calendar Page ───────────────────────────────────────────────────────

export function CalendarPage() {
  const { data: status } = usePluginData<ConfigStatus>("config-status");
  const { data: today, loading: todayLoading } = usePluginData<TodaySummary>("today-summary");

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>📅 Google Calendar</h1>
      <p style={{ color: "#6b7280", marginBottom: 24, fontSize: 14 }}>
        Google Calendar connector powered by the{" "}
        <code>gog</code> CLI. No OAuth credentials needed here — auth is managed via{" "}
        <code>gog auth add</code> on the server.
      </p>

      {/* Connection Status */}
      <div style={styles.card}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Connection Status</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>
          <div>
            gog CLI
            <span style={styles.badge(Boolean(status?.gogWorking))}>
              {status?.gogWorking ? "connected" : "not reachable"}
            </span>
          </div>
          <div>
            Account
            <span style={{ marginLeft: 8, fontWeight: 600 }}>
              {status?.gogAccount ?? "—"}
            </span>
          </div>
          <div>
            Calendar ID
            <span style={{ marginLeft: 8, fontWeight: 600 }}>
              {status?.calendarId ?? "primary"}
            </span>
          </div>
          <div>
            Timezone
            <span style={{ marginLeft: 8, fontWeight: 600 }}>
              {status?.timezone ?? "America/Chicago"}
            </span>
          </div>
        </div>
      </div>

      {/* Available Tools */}
      <div style={styles.card}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Available Agent Tools</div>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.8 }}>
          <li>
            <code>gcal_get_day_summary</code> — human-readable summary of a day's events
          </li>
          <li>
            <code>gcal_list_events</code> — list events in a date range
          </li>
          <li>
            <code>gcal_get_event</code> — fetch a single event by ID
          </li>
          <li>
            <code>gcal_create_event</code> — create a new event
          </li>
          <li>
            <code>gcal_update_event</code> — update an existing event
          </li>
          <li>
            <code>gcal_delete_event</code> — delete an event permanently
          </li>
        </ul>
      </div>

      {/* Today's Events */}
      <div style={styles.card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Today's Events</div>
        {!status?.gogWorking ? (
          <div style={{ color: "#6b7280", fontSize: 14 }}>
            gog is not reachable. Check that <code>/usr/local/bin/gog</code> is installed and{" "}
            <code>gog auth list</code> works on the server.
          </div>
        ) : todayLoading ? (
          <div style={{ color: "#6b7280", fontSize: 14 }}>Loading…</div>
        ) : today?.summary ? (
          <>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
              {today.eventCount} event{today.eventCount === 1 ? "" : "s"} · {today.date}
            </div>
            <div style={styles.pre}>{today.summary}</div>
          </>
        ) : (
          <div style={{ color: "#6b7280", fontSize: 14 }}>No events found for today.</div>
        )}
      </div>

      {/* Setup Notes */}
      <div style={styles.card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>How Authentication Works</div>
        <p style={{ margin: "0 0 8px", fontSize: 13, color: "#374151", lineHeight: 1.6 }}>
          This plugin delegates all Google API calls to the{" "}
          <code>gog</code> CLI tool installed at{" "}
          <code>/usr/local/bin/gog</code>. Auth tokens are stored in{" "}
          <code>~/.config/gogcli/keyring/</code> and managed by{" "}
          <code>gog auth</code> — no credentials are needed in plugin settings.
        </p>
        <p style={{ margin: 0, fontSize: 13, color: "#374151", lineHeight: 1.6 }}>
          To re-authorize, run <code>gog auth add &lt;email&gt; --services calendar --remote</code>{" "}
          on the server.
        </p>
      </div>
    </div>
  );
}
