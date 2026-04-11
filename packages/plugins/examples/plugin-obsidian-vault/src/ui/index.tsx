import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

type VaultStatus = {
  vaultPath: string;
  wikiPageCount: number;
  rawArticleCount: number;
  recentLogEntries: string[];
};

export function VaultDashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<VaultStatus>("vault_status");

  if (loading) return <div>Loading vault status...</div>;
  if (error) return <div>Vault error: {error.message}</div>;
  if (!data) return <div>No vault data</div>;

  return (
    <div style={{ display: "grid", gap: "0.75rem", fontFamily: "monospace", fontSize: "0.85rem" }}>
      <strong style={{ fontSize: "1rem" }}>Obsidian Vault</strong>

      <div style={{ display: "flex", gap: "1.5rem" }}>
        <div>
          <div style={{ color: "#888", fontSize: "0.75rem" }}>WIKI PAGES</div>
          <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{data.wikiPageCount}</div>
        </div>
        <div>
          <div style={{ color: "#888", fontSize: "0.75rem" }}>RAW ARTICLES</div>
          <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{data.rawArticleCount}</div>
        </div>
      </div>

      {data.recentLogEntries.length > 0 && (
        <div>
          <div style={{ color: "#888", fontSize: "0.75rem", marginBottom: "0.25rem" }}>RECENT LOG</div>
          {data.recentLogEntries.map((entry, i) => (
            <div
              key={i}
              style={{
                padding: "0.25rem 0.5rem",
                background: "rgba(255,255,255,0.05)",
                borderRadius: 4,
                marginBottom: "0.2rem",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={entry}
            >
              {entry.replace("## ", "")}
            </div>
          ))}
        </div>
      )}

      <div style={{ color: "#555", fontSize: "0.7rem" }}>
        {data.vaultPath}
      </div>
    </div>
  );
}
