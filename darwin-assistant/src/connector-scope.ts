/**
 * Per-thread connector scoping for Claude CLI turns.
 *
 * `null` preserves the legacy merge behavior (all claude.ai account connectors).
 * An array is an explicit allowlist and therefore requires --strict-mcp-config.
 * The JARVIS native tool server is always added separately by agent.ts.
 */

export const ROUTABLE_MCP_CONNECTORS = {
  'smarty-pants': {
    type: 'http' as const,
    url: 'https://mcp.thedarwinhub.com/mcp/kevin-connected',
  },
} as const;

export type RoutableMcpConnector = keyof typeof ROUTABLE_MCP_CONNECTORS;

export function validateConnectorAllowlist(value: unknown): RoutableMcpConnector[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error('mcp_connectors must be an array or null');
  const unique: RoutableMcpConnector[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !(raw in ROUTABLE_MCP_CONNECTORS)) {
      throw new Error(`mcp_connectors entries must be one of ${Object.keys(ROUTABLE_MCP_CONNECTORS).join(', ')}`);
    }
    const connector = raw as RoutableMcpConnector;
    if (!unique.includes(connector)) unique.push(connector);
  }
  return unique;
}

export function parseStoredConnectorAllowlist(value: string | null | undefined): RoutableMcpConnector[] | null {
  if (value == null) return null;
  try {
    return validateConnectorAllowlist(JSON.parse(value));
  } catch {
    // A corrupt stored scope must fail closed instead of silently restoring all
    // account-level connectors to a supposedly scoped thread.
    return [];
  }
}

export function connectorServerEntries(scope: RoutableMcpConnector[] | null): Record<string, { type: 'http'; url: string }> {
  if (scope === null) return {};
  return Object.fromEntries(scope.map((name) => [name, ROUTABLE_MCP_CONNECTORS[name]]));
}
