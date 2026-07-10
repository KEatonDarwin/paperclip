import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, relative, join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { ToolDef } from './index.js';

const VAULT_ROOT = '/home/kevin/obsidian/paperclip-wiki';
const MEMORY_PATH = 'agent-memory/jarvis/memory.md';

function safePath(userPath: string): string {
  const resolved = resolve(VAULT_ROOT, userPath);
  const rel = relative(VAULT_ROOT, resolved);
  if (rel.startsWith('..') || resolve(VAULT_ROOT, rel) !== resolved) {
    throw new Error(`Path escapes vault root: ${userPath}`);
  }
  return resolved;
}

export const readWikiPage: ToolDef = {
  name: 'read_wiki_page',
  description:
    'Read a markdown page from the Obsidian wiki vault. Path is relative to the vault root.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Relative path within the vault, e.g. "agents/cto/README.md" or "CONVENTIONS.md"',
      },
    },
    required: ['path'],
  },
  execute: async (args) => {
    const { path } = args as { path: string };
    try {
      const abs = safePath(path);
      const content = await readFile(abs, 'utf-8');
      return { path, content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
};

export const writeWikiPage: ToolDef = {
  name: 'write_wiki_page',
  description:
    'Create or overwrite a markdown page in the Obsidian wiki vault. Parent directories are created automatically.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path within the vault, e.g. "agent-memory/jarvis/notes.md"',
      },
      content: { type: 'string', description: 'Full markdown content to write' },
    },
    required: ['path', 'content'],
  },
  execute: async (args) => {
    const { path, content } = args as { path: string; content: string };
    try {
      const abs = safePath(path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf-8');
      return { written: true, path };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
};

export const listWikiPages: ToolDef = {
  name: 'list_wiki_pages',
  description:
    'List files and directories in the Obsidian wiki vault. Optionally scope to a subdirectory.',
  parameters: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description:
          'Subdirectory to list (relative to vault root). Omit or pass "" for the vault root.',
      },
    },
    required: [],
  },
  execute: async (args) => {
    const { directory } = args as { directory?: string };
    try {
      const abs = safePath(directory || '');
      const entries = await readdir(abs, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
        }));
      return { directory: directory || '/', items };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
};

export const searchWiki: ToolDef = {
  name: 'search_wiki',
  description:
    'Search the Obsidian wiki vault for markdown files containing a keyword. Returns matching file paths and the first matching line from each.',
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: 'Search term (case-insensitive substring match)',
      },
      max_results: {
        type: 'number',
        description: 'Maximum results to return (default 20)',
      },
    },
    required: ['keyword'],
  },
  execute: async (args) => {
    const { keyword, max_results } = args as { keyword: string; max_results?: number };
    const limit = max_results ?? 20;
    const term = keyword.toLowerCase();

    try {
      const results: { path: string; matchLine: string }[] = [];

      async function walk(dir: string): Promise<void> {
        if (results.length >= limit) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= limit) return;
          if (entry.name.startsWith('.')) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.name.endsWith('.md')) {
            const content = await readFile(full, 'utf-8');
            const lower = content.toLowerCase();
            const idx = lower.indexOf(term);
            if (idx !== -1) {
              const lineStart = content.lastIndexOf('\n', idx) + 1;
              const lineEnd = content.indexOf('\n', idx);
              const matchLine = content
                .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
                .trim();
              results.push({
                path: relative(VAULT_ROOT, full),
                matchLine,
              });
            }
          }
        }
      }

      await walk(VAULT_ROOT);
      return { keyword, count: results.length, results };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
};

export const readMemory: ToolDef = {
  name: 'read_memory',
  description:
    "Read JARVIS's persistent memory file from the wiki vault. This memory persists across Slack threads.",
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async () => {
    try {
      const abs = join(VAULT_ROOT, MEMORY_PATH);
      if (!existsSync(abs)) {
        return { content: '', note: 'Memory file does not exist yet. Use write_memory to create it.' };
      }
      const content = await readFile(abs, 'utf-8');
      return { content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
};

export const writeMemory: ToolDef = {
  name: 'write_memory',
  description:
    "Write to JARVIS's persistent memory file in the wiki vault. This overwrites the entire file — read first if you need to append.",
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Full markdown content for the memory file',
      },
    },
    required: ['content'],
  },
  execute: async (args) => {
    const { content } = args as { content: string };
    try {
      const abs = join(VAULT_ROOT, MEMORY_PATH);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf-8');
      return { written: true, path: MEMORY_PATH };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
};
