// SHARED CONTEXT v0 — adversarial-review fix (tree-f6da9dbf node #488).
//
// WHY THIS EXISTS: §1 (the Shared Now digest) and §2 (recall) both lift raw
// text out of places Kevin has pasted real credentials into — `turns.content`,
// hopper node results, wiki pages, auto-memory — and re-emit it as PROMPT TEXT
// in a DIFFERENT thread, on ANY provider (codex / auggie / devin included).
// Verified on the live DB 2026-09-20: `recall("BROWSERBASE_API_KEY")` returned
// a plaintext `bb_live_…` key and `recall("CHIP_RUNNER_API_KEY")` returned a
// plaintext `crk_…` bearer token, both out of old Slack threads. Before this
// branch those strings were reachable only by opening that one thread; after
// it they were quotable from everywhere. So every snippet/bullet that leaves
// these two modules goes through redactSecrets() first.
//
// Deliberately dependency-free (no imports) so both shared-context.ts and
// recall.ts can use it without creating an import cycle.

type Rule = [RegExp, string | ((...m: string[]) => string)];

const REDACTED = '[redacted]';

// Ordered: structural blocks first, then prefixed tokens, then assignments.
const RULES: Rule[] = [
  // PEM private keys
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted:private-key]'],
  // Provider-prefixed API keys / tokens (the shapes that actually appear in this DB)
  [
    /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|jrv_[A-Za-z0-9_-]{8,}|crk_[A-Za-z0-9_-]{8,}|bb_live_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|devin-[A-Za-z0-9_-]{16,}|glpat-[A-Za-z0-9_-]{12,})/g,
    REDACTED,
  ],
  // JWTs / Supabase service keys (three base64url segments)
  [/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, REDACTED],
  // NAME_KEY=value / NAME_TOKEN: "value" — the .env-paste shape
  [
    /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|DSN))S?\s*[:=]\s*["']?([A-Za-z0-9._/+-]{12,})["']?/g,
    (_m: string, name: string) => `${name}=${REDACTED}`,
  ],
  // Authorization: Bearer <token> / Basic <token> — only when it is a real
  // token, not the documentation placeholder `Bearer <key from ...>`.
  [/\b(Bearer|Basic)\s+([A-Za-z0-9._~+/-]{16,}=*)/g, (_m: string, scheme: string) => `${scheme} ${REDACTED}`],
  // URLs with inline credentials (postgres://user:pass@host, https://u:p@h)
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):([^\s@/]{4,})@/g, (_m: string, head: string) => `${head}:${REDACTED}@`],
];

/**
 * Best-effort credential scrub for text that is about to be handed to a model
 * in a thread other than the one it was written in. Never lengthens the input
 * (every replacement is shorter than the shortest text it can match), so
 * callers can redact before applying a character budget.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, rep] of RULES) {
    out = typeof rep === 'string' ? out.replace(re, rep) : out.replace(re, rep as (...m: string[]) => string);
  }
  return out;
}
