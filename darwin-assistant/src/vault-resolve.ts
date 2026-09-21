// Vault path resolution — makes "clickable path" links honest.
//
// The cockpit linkifies anything shaped like `docs/README.md`, but JARVIS often
// cites a path INSIDE a repo, not the Obsidian vault, so the click 404s. This
// module answers "can this path be opened in the vault viewer?" and, for repo
// files, MIRRORS them into `scratch/<date>/<repo>/<path>` inside the vault so
// the click just works. `scratch/` is wiped daily (vault-scratch-wipe.timer).
//
//   resolveVaultPath('outbox/foo.md')     -> { status: 'vault',   path: 'outbox/foo.md' }
//   resolveVaultPath('docs/README.md')    -> { status: 'scratch', path: 'scratch/2026-09-21/darwin-assistant/docs/README.md', source: '/home/kevin/paperclip/darwin-assistant/docs/README.md' }
//   resolveVaultPath('/abs/path/x.md')    -> same scratch mirror if the file exists and is a text/markdown file
//   resolveVaultPath('nope/none.md')      -> { status: 'missing' }
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const VAULT_ROOT = '/home/kevin/obsidian/paperclip-wiki';
export const SCRATCH_DIR = 'scratch';

// Where JARVIS cites repo-relative paths from. Globbed one level deep where a
// trailing /* is given (projects, worktrees).
const REPO_ROOT_PATTERNS = [
  '/home/kevin/paperclip/darwin-assistant',
  '/home/kevin/paperclip/jarvis-command-center',
  '/home/kevin/paperclip',
  '/home/kevin/paperclip/*',
  '/home/kevin/paperclip-worktrees/*',
  '/home/kevin/worktrees/*',
  '/home/kevin/projects/*',
  '/home/kevin/projects/intake-worktrees/*',
  '/home/kevin/projects/mcp-host-worktrees/*',
  '/home/kevin/projects/hub1-worktrees/*',
  '/home/kevin/foundry/*',
  '/home/kevin/.jarvis-cli-workspace',
  '/home/kevin/.jarvis-cli-workspace/*',
  '/home/kevin/.claude/skills/*',
];

// Only mirror things the vault viewer can render as text.
const MIRRORABLE_EXT = /\.(md|markdown|txt|json|ya?ml|toml|csv|sql|sh|py|ts|tsx|js|mjs|php|html|css|env\.example)$/i;
const MAX_MIRROR_BYTES = 2 * 1024 * 1024;

export type VaultResolution =
  | { status: 'vault'; path: string }
  | { status: 'scratch'; path: string; source: string }
  | { status: 'missing'; path: string; reason?: string };

let rootsCache: { at: number; roots: string[] } | null = null;

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function repoRoots(): Promise<string[]> {
  if (rootsCache && Date.now() - rootsCache.at < 60_000) return rootsCache.roots;
  const roots: string[] = [];
  for (const pat of REPO_ROOT_PATTERNS) {
    if (pat.endsWith('/*')) {
      const base = pat.slice(0, -2);
      if (!(await isDir(base))) continue;
      try {
        for (const ent of await readdir(base, { withFileTypes: true })) {
          if (ent.isDirectory() && !ent.name.startsWith('.')) roots.push(join(base, ent.name));
        }
      } catch {
        /* unreadable base — skip */
      }
    } else if (await isDir(pat)) {
      roots.push(pat);
    }
  }
  rootsCache = { at: Date.now(), roots: [...new Set(roots)] };
  return rootsCache.roots;
}

function vaultRelative(abs: string): string | null {
  const rel = relative(VAULT_ROOT, abs);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return null;
  return rel.split(sep).join('/');
}

function cleanRel(p: string): string {
  return p.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\\/g, '/');
}

function rootSlug(root: string): string {
  return root.replace(/^\/home\/kevin\//, '').replace(/[^A-Za-z0-9._-]+/g, '-');
}

async function mirrorToScratch(sourceAbs: string, rel: string, root: string): Promise<VaultResolution> {
  if (!MIRRORABLE_EXT.test(sourceAbs)) return { status: 'missing', path: rel, reason: 'not a text file' };
  const st = await stat(sourceAbs);
  if (st.size > MAX_MIRROR_BYTES) return { status: 'missing', path: rel, reason: 'file too large to mirror' };
  const day = new Date().toISOString().slice(0, 10);
  const scratchRel = `${SCRATCH_DIR}/${day}/${rootSlug(root)}/${rel}`;
  const dest = resolve(VAULT_ROOT, scratchRel);
  if (!vaultRelative(dest)) return { status: 'missing', path: rel, reason: 'escapes vault' };
  // Re-copy only when the source is newer than the mirror, so repeated clicks are cheap.
  let fresh = false;
  try {
    const dst = await stat(dest);
    fresh = dst.mtimeMs >= st.mtimeMs;
  } catch {
    /* no mirror yet */
  }
  if (!fresh) {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(sourceAbs, dest);
  }
  return { status: 'scratch', path: scratchRel, source: sourceAbs };
}

/** Resolve one cited path to something the vault viewer can open. Never throws. */
export async function resolveVaultPath(input: string): Promise<VaultResolution> {
  const raw = (input ?? '').trim();
  if (!raw) return { status: 'missing', path: raw };

  // Absolute path: inside the vault → vault; elsewhere → mirror if it exists.
  if (raw.startsWith('/')) {
    const abs = resolve(raw);
    const inVault = vaultRelative(abs);
    if (inVault) {
      return (await isFile(abs)) ? { status: 'vault', path: inVault } : { status: 'missing', path: inVault };
    }
    if (!(await isFile(abs))) return { status: 'missing', path: raw };
    const roots = await repoRoots();
    const root = roots.filter((r) => abs.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0] ?? dirname(abs);
    return mirrorToScratch(abs, relative(root, abs).split(sep).join('/'), root);
  }

  const rel = cleanRel(raw);
  if (!rel || rel.includes('../')) return { status: 'missing', path: rel };

  // 1. Already in the vault (incl. an earlier scratch mirror).
  const vaultAbs = resolve(VAULT_ROOT, rel);
  if (vaultRelative(vaultAbs) && (await isFile(vaultAbs))) return { status: 'vault', path: rel };

  // 2. Repo-relative: find candidates under the known roots; prefer the most recently modified.
  const roots = await repoRoots();
  const hits: { root: string; abs: string; mtime: number }[] = [];
  await Promise.all(
    roots.map(async (root) => {
      const abs = join(root, rel);
      try {
        const st = await stat(abs);
        if (st.isFile()) hits.push({ root, abs, mtime: st.mtimeMs });
      } catch {
        /* not here */
      }
    }),
  );
  if (!hits.length) return { status: 'missing', path: rel };
  hits.sort((a, b) => b.mtime - a.mtime);
  return mirrorToScratch(hits[0].abs, rel, hits[0].root);
}

/** Batch form used by the cockpit linkifier. Order-preserving, never throws. */
export async function resolveVaultPaths(paths: string[]): Promise<Record<string, VaultResolution>> {
  const uniq = [...new Set(paths.map((p) => (p ?? '').trim()).filter(Boolean))].slice(0, 100);
  const out: Record<string, VaultResolution> = {};
  await Promise.all(
    uniq.map(async (p) => {
      try {
        out[p] = await resolveVaultPath(p);
      } catch (err) {
        out[p] = { status: 'missing', path: p, reason: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  return out;
}

/**
 * Thread-links / notifications: turn a wiki-relative citation into the cockpit
 * viewer URL so the Links bar opens it instead of treating it as a hostname.
 * Real URLs (with a scheme) pass through untouched.
 */
export function normalizeLinkTarget(raw: string): string {
  const v = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.startsWith('/settings/') || v.startsWith('/thread/')) return v;
  const looksLikeVaultPath =
    /\.(md|markdown|txt|json|ya?ml|csv|html)$/i.test(v) ||
    /^(outbox|skills|kevin|playbooks|scratch|agent-memory|daily-wraps|paperclip|wiki)\//.test(v);
  if (looksLikeVaultPath && !/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(v.split('/')[0] + '/')) {
    return `/settings/vault?file=${encodeURIComponent(cleanRel(v))}`;
  }
  return v;
}
