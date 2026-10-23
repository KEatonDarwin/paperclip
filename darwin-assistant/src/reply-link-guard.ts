// Reply-side link guard (chat-path-links).
//
// OBSERVABILITY ONLY — it NEVER blocks, mutates, or delays a reply. It runs as a
// single synchronous regex pass when an assistant reply is persisted and records
// markdown link/image forms the cockpit renderer may still fail to turn into a
// working link: a relative image src, or a bare non-.md file path cited outside
// a real markdown link. It touches disk only when it actually finds something,
// so a clean reply costs one regex pass and zero I/O. The caller treats it as
// best-effort; this module also swallows its own errors so a guard can never
// break the reply path.
//
// Why it exists: the renderer fix (an `img` component + non-.md linkify) closes
// the known ~20% broken-link rate. This is the standing meter that catches the
// NEXT form we don't handle yet — instead of Kevin being the one who notices a
// broken link.

import { appendFileSync } from 'node:fs';

// Where the meter writes. One JSON line per reply that had at least one
// unhandled form. Append-only; read it to see the broken-link rate over time.
export const REPLY_LINK_GUARD_LOG =
  process.env.REPLY_LINK_GUARD_LOG ?? '/home/kevin/jarvis-reply-link-guard.log';

// A target the renderer/browser already handles or deliberately leaves alone:
// any URI scheme (http:, https:, data:, mailto:, the synthetic vault-file:),
// protocol-relative //, an absolute same-origin /path, or an in-page #anchor.
function isExternalOrHandled(url: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(url) ||
    url.startsWith('//') ||
    url.startsWith('/') ||
    url.startsWith('#')
  );
}

// ![alt](src)  and  [text](href) — the href/src is group 1. An optional
// "title" after the URL is tolerated and ignored.
const IMG_MD_RE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
// A file-shaped token (has an extension) cited bare or inside a `code span`.
const BARE_PATH_RE = /(?:^|[\s(`])([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]{1,8})(?=[\s).,;:!?`]|$)/g;
// Bare hostname (not a path) — excluded so "darwinhub.com" isn't flagged.
const BARE_DOMAIN_RE = /^[a-z0-9.-]+\.(com|net|org|io|dev|co|ai|sh|app|gg|xyz)$/i;

export type ReplyLinkIssueKind = 'relative_image' | 'bare_non_md_path';
export interface ReplyLinkIssue {
  kind: ReplyLinkIssueKind;
  value: string;
}

/** Pure, cheap, never throws on normal text. Returns the unhandled forms found. */
export function scanReplyLinks(text: string): ReplyLinkIssue[] {
  if (!text) return [];
  const issues: ReplyLinkIssue[] = [];

  // 1. Relative image srcs. The browser resolves these against the cockpit page
  //    URL and 404s unless the img component rewrites them to the raw endpoint.
  for (const m of text.matchAll(IMG_MD_RE)) {
    const src = m[1];
    if (!isExternalOrHandled(src)) issues.push({ kind: 'relative_image', value: src });
  }

  // 2. Bare non-.md file paths cited OUTSIDE a real markdown link. Before the
  //    linkify fix only `.md` became a link; a bare/code-span .html/.csv/.sql/
  //    .png rendered as dead plain text. Strip fenced code + real links + images
  //    first so we never double-count what the forms above already cover.
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ');
  for (const m of stripped.matchAll(BARE_PATH_RE)) {
    const p = m[1];
    if (/\.md$/i.test(p)) continue; // .md was already linkified before this fix
    if (isExternalOrHandled(p)) continue;
    if (!p.includes('/')) continue; // require a path separator — kills "index.js"/"v1.2" noise
    if (BARE_DOMAIN_RE.test(p)) continue;
    issues.push({ kind: 'bare_non_md_path', value: p });
  }

  return issues;
}

/**
 * Called from the reply persistence path. MUST NOT throw and MUST NOT block.
 * Logs (console + append-only file) only when it finds an unhandled form.
 * Returns the issues for callers/tests; the reply path ignores the return.
 */
export function recordReplyLinkIssues(
  conversationId: number,
  turnIndex: number,
  text: string | null | undefined,
): ReplyLinkIssue[] {
  try {
    const issues = scanReplyLinks(text ?? '');
    if (!issues.length) return issues;
    console.warn(
      `[reply-link-guard] conv ${conversationId} turn ${turnIndex}: ${issues.length} unhandled link form(s) ` +
        issues.map((i) => `${i.kind}=${i.value}`).join(' '),
    );
    try {
      appendFileSync(
        REPLY_LINK_GUARD_LOG,
        JSON.stringify({ at: new Date().toISOString(), conversationId, turnIndex, issues }) + '\n',
      );
    } catch {
      /* a log/disk failure must never touch a reply */
    }
    return issues;
  } catch {
    /* a guard can never break the reply path */
    return [];
  }
}
