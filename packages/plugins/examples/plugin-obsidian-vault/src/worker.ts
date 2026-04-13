/**
 * worker.ts — Paperclip plugin worker for the Darwin Obsidian Vault.
 *
 * Registers 15 vault tools that any agent in the company can call to read/write
 * the Second Brain wiki, raw articles, log, and agent memory.
 *
 * All file I/O is resolved relative to the configured `vaultPath`
 * (default: /home/r1kon/.paperclip/instances/default/paperclip-wiki).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";

// ── Vault helpers ─────────────────────────────────────────────────────────────

function getVaultPath(ctx: PluginContext): string {
  const cfg = ctx.config as unknown as Record<string, unknown>;
  return typeof cfg["vaultPath"] === "string"
    ? cfg["vaultPath"]
    : "/home/r1kon/.paperclip/instances/default/paperclip-wiki";
}

function abs(vaultPath: string, ...segments: string[]): string {
  return path.join(vaultPath, ...segments);
}

async function vaultRead(vaultPath: string, relPath: string): Promise<string> {
  return fs.readFile(abs(vaultPath, relPath), "utf-8");
}

async function vaultWrite(vaultPath: string, relPath: string, content: string): Promise<void> {
  const target = abs(vaultPath, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf-8");
}

async function vaultAppend(vaultPath: string, relPath: string, content: string): Promise<void> {
  const target = abs(vaultPath, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, content, "utf-8");
}

async function vaultExists(vaultPath: string, relPath: string): Promise<boolean> {
  try {
    await fs.access(abs(vaultPath, relPath));
    return true;
  } catch {
    return false;
  }
}

async function vaultListDir(vaultPath: string, relPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(abs(vaultPath, relPath), { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

function wikiFilePath(titleOrFile: string): string {
  if (titleOrFile.startsWith("wiki/") || titleOrFile.startsWith("raw/")) {
    return titleOrFile;
  }
  const slug = titleOrFile
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `wiki/${slug}.md`;
}

function requireStr(params: unknown, key: string): string {
  const p = params as Record<string, unknown>;
  const val = p[key];
  if (typeof val !== "string" || !val.trim()) {
    throw new Error(`Missing required parameter: ${key}`);
  }
  return val;
}

// ── Tool registration ─────────────────────────────────────────────────────────

function registerVaultTools(ctx: PluginContext): void {
  const vp = () => getVaultPath(ctx);

  // ── Wiki pages ──────────────────────────────────────────────────────────────

  ctx.tools.register(
    "vault_read_wiki_page",
    {
      displayName: "Vault: Read Wiki Page",
      description: "Read a wiki page by title or path.",
      parametersSchema: {
        type: "object",
        properties: { page: { type: "string" } },
        required: ["page"],
      },
    },
    async (params): Promise<ToolResult> => {
      const page = requireStr(params, "page");
      const relPath = wikiFilePath(page);
      try {
        const content = await vaultRead(vp(), relPath);
        return { content };
      } catch {
        return { error: `Wiki page not found: ${page} (tried ${relPath})` };
      }
    },
  );

  ctx.tools.register(
    "vault_write_wiki_page",
    {
      displayName: "Vault: Write Wiki Page",
      description: "Create or overwrite a wiki page.",
      parametersSchema: {
        type: "object",
        properties: {
          page: { type: "string" },
          content: { type: "string" },
        },
        required: ["page", "content"],
      },
    },
    async (params): Promise<ToolResult> => {
      const page = requireStr(params, "page");
      const content = requireStr(params, "content");
      const relPath = wikiFilePath(page);
      await vaultWrite(vp(), relPath, content);
      return { content: `Written: ${relPath}` };
    },
  );

  ctx.tools.register(
    "vault_list_wiki_pages",
    {
      displayName: "Vault: List Wiki Pages",
      description: "Return wiki/index.md — the master catalog.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (): Promise<ToolResult> => {
      const content = await vaultRead(vp(), "wiki/index.md").catch(() => "(index.md not found)");
      return { content };
    },
  );

  ctx.tools.register(
    "vault_search_wiki",
    {
      displayName: "Vault: Search Wiki",
      description: "Search wiki/index.md for pages matching a keyword.",
      parametersSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    async (params): Promise<ToolResult> => {
      const query = requireStr(params, "query");
      const index = await vaultRead(vp(), "wiki/index.md").catch(() => "");
      const lower = query.toLowerCase();
      const matches = index
        .split("\n")
        .filter((line) => line.includes("[[") && line.toLowerCase().includes(lower));
      if (matches.length === 0) return { content: `No wiki pages match: ${query}` };
      return { content: matches.join("\n") };
    },
  );

  ctx.tools.register(
    "vault_update_wiki_index",
    {
      displayName: "Vault: Update Wiki Index",
      description: "Overwrite wiki/index.md.",
      parametersSchema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
    async (params): Promise<ToolResult> => {
      const content = requireStr(params, "content");
      await vaultWrite(vp(), "wiki/index.md", content);
      return { content: "wiki/index.md updated" };
    },
  );

  // ── Raw articles ──────────────────────────────────────────────────────────────

  ctx.tools.register(
    "vault_read_raw_article",
    {
      displayName: "Vault: Read Raw Article",
      description: "Read a source article from raw/articles/.",
      parametersSchema: {
        type: "object",
        properties: { filename: { type: "string" } },
        required: ["filename"],
      },
    },
    async (params): Promise<ToolResult> => {
      const filename = requireStr(params, "filename");
      try {
        const content = await vaultRead(vp(), `raw/articles/${filename}`);
        return { content };
      } catch {
        return { error: `Raw article not found: ${filename}` };
      }
    },
  );

  ctx.tools.register(
    "vault_write_raw_article",
    {
      displayName: "Vault: Write Raw Article",
      description: "Save a new (write-once) source article to raw/articles/.",
      parametersSchema: {
        type: "object",
        properties: {
          filename: { type: "string" },
          content: { type: "string" },
        },
        required: ["filename", "content"],
      },
    },
    async (params): Promise<ToolResult> => {
      const filename = requireStr(params, "filename");
      const content = requireStr(params, "content");
      const relPath = `raw/articles/${filename}`;
      if (await vaultExists(vp(), relPath)) {
        return { error: `Raw article already exists (immutable): ${filename}` };
      }
      await vaultWrite(vp(), relPath, content);
      return { content: `Saved: ${relPath}` };
    },
  );

  ctx.tools.register(
    "vault_list_raw_articles",
    {
      displayName: "Vault: List Raw Articles",
      description: "List all filenames in raw/articles/.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (): Promise<ToolResult> => {
      const files = await vaultListDir(vp(), "raw/articles");
      if (files.length === 0) return { content: "(no raw articles found)" };
      return { content: files.join("\n") };
    },
  );

  // ── Log ───────────────────────────────────────────────────────────────────────

  ctx.tools.register(
    "vault_append_log",
    {
      displayName: "Vault: Append Log",
      description: "Prepend a structured entry to log.md.",
      parametersSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["ingest", "query", "lint", "update", "delete"] },
          title: { type: "string" },
          agent_id: { type: "string" },
          issue_id: { type: "string" },
          run_id: { type: "string" },
          detail: { type: "string" },
        },
        required: ["operation", "title", "agent_id", "issue_id", "run_id", "detail"],
      },
    },
    async (params): Promise<ToolResult> => {
      const p = params as Record<string, unknown>;
      const operation = requireStr(params, "operation");
      const title = requireStr(params, "title");
      const agentId = requireStr(params, "agent_id");
      const issueId = requireStr(params, "issue_id");
      const runId = requireStr(params, "run_id");
      const detail = requireStr(params, "detail");

      const now = new Date().toISOString().replace("T", " ").slice(0, 16);
      const entry =
        `## [${now}] ${operation} | ${title}\n` +
        `- agent: ${agentId}\n` +
        `- issue: ${issueId}\n` +
        `- run: ${runId}\n` +
        `- detail: ${detail}\n\n`;

      let existing = "";
      try { existing = await vaultRead(vp(), "log.md"); } catch { /* first entry */ }
      await vaultWrite(vp(), "log.md", entry + existing);
      return { content: `Log entry prepended: ${operation} | ${title}` };
    },
  );

  ctx.tools.register(
    "vault_read_log",
    {
      displayName: "Vault: Read Log",
      description: "Read the full log.md.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (): Promise<ToolResult> => {
      const content = await vaultRead(vp(), "log.md").catch(() => "(log.md is empty)");
      return { content };
    },
  );

  // ── Agent memory ─────────────────────────────────────────────────────────────

  ctx.tools.register(
    "vault_read_agent_memory",
    {
      displayName: "Vault: Read Agent Memory",
      description: "Read agent-memory/<agentName>/<file>.",
      parametersSchema: {
        type: "object",
        properties: {
          agent_name: { type: "string" },
          file: { type: "string" },
        },
        required: ["agent_name", "file"],
      },
    },
    async (params): Promise<ToolResult> => {
      const agentName = requireStr(params, "agent_name");
      const file = requireStr(params, "file");
      try {
        const content = await vaultRead(vp(), `agent-memory/${agentName}/${file}`);
        return { content };
      } catch {
        return { error: `Agent memory not found: agent-memory/${agentName}/${file}` };
      }
    },
  );

  ctx.tools.register(
    "vault_write_agent_memory",
    {
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
    async (params): Promise<ToolResult> => {
      const agentName = requireStr(params, "agent_name");
      const file = requireStr(params, "file");
      const content = requireStr(params, "content");
      await vaultWrite(vp(), `agent-memory/${agentName}/${file}`, content);
      return { content: `Written: agent-memory/${agentName}/${file}` };
    },
  );

  ctx.tools.register(
    "vault_append_agent_memory",
    {
      displayName: "Vault: Append Agent Memory",
      description: "Append to agent-memory/<agentName>/<file>.",
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
    async (params): Promise<ToolResult> => {
      const agentName = requireStr(params, "agent_name");
      const file = requireStr(params, "file");
      const content = requireStr(params, "content");
      await vaultAppend(vp(), `agent-memory/${agentName}/${file}`, content);
      return { content: `Appended: agent-memory/${agentName}/${file}` };
    },
  );

  ctx.tools.register(
    "vault_list_agent_memory_files",
    {
      displayName: "Vault: List Agent Memory Files",
      description: "List files in agent-memory/<agentName>/.",
      parametersSchema: {
        type: "object",
        properties: { agent_name: { type: "string" } },
        required: ["agent_name"],
      },
    },
    async (params): Promise<ToolResult> => {
      const agentName = requireStr(params, "agent_name");
      const files = await vaultListDir(vp(), `agent-memory/${agentName}`);
      if (files.length === 0) return { content: `(no files in agent-memory/${agentName}/)` };
      return { content: files.join("\n") };
    },
  );

  ctx.tools.register(
    "vault_read_schema",
    {
      displayName: "Vault: Read Schema",
      description: "Read CLAUDE.md — schema and conventions. Read before any vault operation.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (): Promise<ToolResult> => {
      const content = await vaultRead(vp(), "CLAUDE.md").catch(() => "(CLAUDE.md not found)");
      return { content };
    },
  );
}

// ── Plugin ─────────────────────────────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx) {
    const vaultPath = getVaultPath(ctx);
    ctx.logger.info("obsidian-vault plugin starting", { vaultPath });

    // Register vault data endpoint for the dashboard widget
    ctx.data.register("vault_status", async () => {
      const logLines = await vaultRead(vaultPath, "log.md")
        .then((l) => l.split("\n").filter((line) => line.startsWith("## [")))
        .catch(() => []);
      const wikiFiles = await vaultListDir(vaultPath, "wiki").catch(() => []);
      const rawFiles = await vaultListDir(vaultPath, "raw/articles").catch(() => []);
      return {
        vaultPath,
        wikiPageCount: wikiFiles.length,
        rawArticleCount: rawFiles.length,
        recentLogEntries: logLines.slice(0, 5),
      };
    });

    // Register all vault tools
    registerVaultTools(ctx);

    ctx.logger.info("obsidian-vault plugin ready — 15 tools registered");
  },

  async onHealth() {
    return { status: "ok", message: "Obsidian Vault plugin worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
