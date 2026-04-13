import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "darwin.obsidian-vault";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Obsidian Vault",
  description:
    "Gives Paperclip agents semantic read/write access to the Darwin Second Brain Obsidian vault (wiki pages, raw articles, log, and agent memory).",
  author: "Darwin CTO",
  categories: ["connector"],
  capabilities: [
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      vaultPath: {
        type: "string",
        description:
          "Absolute path to the Obsidian vault directory. Defaults to the Darwin wiki location.",
        default: "/home/r1kon/.paperclip/instances/default/paperclip-wiki",
      },
    },
  },
  tools: [
    // Wiki pages
    {
      name: "vault_read_wiki_page",
      displayName: "Vault: Read Wiki Page",
      description:
        "Read a Second Brain wiki page by title (e.g. 'OpenClaw') or path (e.g. 'wiki/openclaw.md').",
      parametersSchema: {
        type: "object",
        properties: {
          page: { type: "string", description: "Page title or relative path" },
        },
        required: ["page"],
      },
    },
    {
      name: "vault_write_wiki_page",
      displayName: "Vault: Write Wiki Page",
      description:
        "Create or overwrite a wiki page. Content must include YAML frontmatter per CLAUDE.md schema.",
      parametersSchema: {
        type: "object",
        properties: {
          page: { type: "string", description: "Page title or relative path" },
          content: { type: "string", description: "Full markdown content with frontmatter" },
        },
        required: ["page", "content"],
      },
    },
    {
      name: "vault_list_wiki_pages",
      displayName: "Vault: List Wiki Pages",
      description: "Return wiki/index.md — the master catalog of all wiki pages.",
      parametersSchema: { type: "object", properties: {} },
    },
    {
      name: "vault_search_wiki",
      displayName: "Vault: Search Wiki",
      description: "Search wiki/index.md for pages matching a keyword query.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keyword" },
        },
        required: ["query"],
      },
    },
    {
      name: "vault_update_wiki_index",
      displayName: "Vault: Update Wiki Index",
      description: "Overwrite wiki/index.md with updated content (after adding/editing pages).",
      parametersSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Full updated wiki/index.md" },
        },
        required: ["content"],
      },
    },
    // Raw articles
    {
      name: "vault_read_raw_article",
      displayName: "Vault: Read Raw Article",
      description: "Read an immutable source article from raw/articles/.",
      parametersSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Filename in raw/articles/ (e.g. 'openclaw-2026-04.md')",
          },
        },
        required: ["filename"],
      },
    },
    {
      name: "vault_write_raw_article",
      displayName: "Vault: Write Raw Article",
      description:
        "Save a new (write-once) source article to raw/articles/. Fails if the file already exists.",
      parametersSchema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Target filename in raw/articles/" },
          content: { type: "string", description: "Article text" },
        },
        required: ["filename", "content"],
      },
    },
    {
      name: "vault_list_raw_articles",
      displayName: "Vault: List Raw Articles",
      description: "List all filenames in raw/articles/.",
      parametersSchema: { type: "object", properties: {} },
    },
    // Log
    {
      name: "vault_append_log",
      displayName: "Vault: Append Log",
      description:
        "Prepend a structured entry to log.md (newest-first). Required after every ingest/query/lint operation.",
      parametersSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["ingest", "query", "lint", "update", "delete"],
          },
          title: { type: "string" },
          agent_id: { type: "string" },
          issue_id: { type: "string" },
          run_id: { type: "string" },
          detail: { type: "string" },
        },
        required: ["operation", "title", "agent_id", "issue_id", "run_id", "detail"],
      },
    },
    {
      name: "vault_read_log",
      displayName: "Vault: Read Log",
      description: "Read the full log.md (append-only operations log with agent attribution).",
      parametersSchema: { type: "object", properties: {} },
    },
    // Agent memory
    {
      name: "vault_read_agent_memory",
      displayName: "Vault: Read Agent Memory",
      description: "Read a file from agent-memory/<agentName>/<file>.",
      parametersSchema: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Agent folder (e.g. 'cto', 'cdo', 'shared')" },
          file: { type: "string", description: "File path within agent folder" },
        },
        required: ["agent_name", "file"],
      },
    },
    {
      name: "vault_write_agent_memory",
      displayName: "Vault: Write Agent Memory",
      description: "Overwrite agent-memory/<agentName>/<file>.",
      parametersSchema: {
        type: "object",
        properties: {
          agent_name: { type: "string" },
          file: { type: "string" },
          content: { type: "string" },
        },
        required: ["agent_name", "file", "content"],
      },
    },
    {
      name: "vault_append_agent_memory",
      displayName: "Vault: Append Agent Memory",
      description: "Append content to agent-memory/<agentName>/<file> (for daily logs).",
      parametersSchema: {
        type: "object",
        properties: {
          agent_name: { type: "string" },
          file: { type: "string" },
          content: { type: "string" },
        },
        required: ["agent_name", "file", "content"],
      },
    },
    {
      name: "vault_list_agent_memory_files",
      displayName: "Vault: List Agent Memory Files",
      description: "List files in agent-memory/<agentName>/.",
      parametersSchema: {
        type: "object",
        properties: {
          agent_name: { type: "string" },
        },
        required: ["agent_name"],
      },
    },
    // Schema
    {
      name: "vault_read_schema",
      displayName: "Vault: Read Schema",
      description: "Read CLAUDE.md — the vault schema and conventions. Always read before any operation.",
      parametersSchema: { type: "object", properties: {} },
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "obsidian-vault-widget",
        displayName: "Obsidian Vault",
        exportName: "VaultDashboardWidget",
      },
    ],
  },
};

export default manifest;
