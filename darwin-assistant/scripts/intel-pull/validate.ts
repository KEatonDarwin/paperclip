// INTEL DESK — validation/sanitization for lane output coming back from the
// local claude CLI. Web-fetched content is untrusted input: everything here
// is defensive (length caps, enum checks, URL scheme checks, control-char
// stripping) per docs/intel-desk/CONTRACT.md "Sanitization And Safety".

import type { IntelLane, IntelSourceKind, IntelVerdict, NewIntelItem } from './store.js';

const VALID_VERDICTS: IntelVerdict[] = ['act', 'watch', 'fyi'];
const VALID_SOURCE_KINDS: IntelSourceKind[] = [
  'official_docs', 'pricing', 'release_notes', 'blog', 'github',
  'reddit', 'x', 'youtube', 'paper', 'other',
];

const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function sanitizeText(input: unknown, maxLen: number): string {
  if (typeof input !== 'string') return '';
  return input.replace(CONTROL_CHARS_RE, '').trim().slice(0, maxLen);
}

function sanitizeUrl(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function sanitizeSourceKind(input: unknown): IntelSourceKind {
  return typeof input === 'string' && (VALID_SOURCE_KINDS as string[]).includes(input)
    ? (input as IntelSourceKind)
    : 'other';
}

function sanitizeVerdict(input: unknown): IntelVerdict | null {
  return typeof input === 'string' && (VALID_VERDICTS as string[]).includes(input)
    ? (input as IntelVerdict)
    : null;
}

function sanitizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const slug = raw
      .toLowerCase()
      .replace(CONTROL_CHARS_RE, '')
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug) out.push(slug);
    if (out.length >= 8) break;
  }
  return out;
}

export interface ValidatedLane {
  digest: string;
  items: NewIntelItem[];
}

/** Validate + sanitize one lane's raw claude output against the contract's
 *  IntelLaneOutput shape. Throws only on a hard structural mismatch (wrong
 *  lane, missing items array) — individual malformed items are dropped, not
 *  fatal, since a partial lane result is still useful. */
export function validateLaneOutput(lane: IntelLane, raw: unknown): ValidatedLane {
  if (!raw || typeof raw !== 'object') {
    throw new Error('lane output was not an object');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.lane === 'string' && obj.lane !== lane) {
    throw new Error(`lane mismatch: requested ${lane}, got ${obj.lane}`);
  }
  if (!Array.isArray(obj.items)) {
    throw new Error('lane output missing items array');
  }

  const digest = sanitizeText(obj.digest, 240) || `(${lane}: no digest provided)`;

  const seen = new Set<string>();
  const items: NewIntelItem[] = [];

  for (const rawItem of obj.items) {
    if (items.length >= 8) break;
    if (!rawItem || typeof rawItem !== 'object') continue;
    const it = rawItem as Record<string, unknown>;

    const verdict = sanitizeVerdict(it.verdict);
    const title = sanitizeText(it.title, 160);
    const summary = sanitizeText(it.summary, 700);
    const whyItMatters = sanitizeText(it.why_it_matters, 700);

    // Drop malformed items rather than failing the whole lane.
    if (!verdict || !title || !summary || !whyItMatters) continue;

    const sourceUrl = sanitizeUrl(it.source_url);
    const sourceKind = sanitizeSourceKind(it.source_kind);
    const tags = sanitizeTags(it.tags);

    const dedupeKey = `${(sourceUrl ?? '').toLowerCase()}|${title.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    items.push({
      lane,
      title,
      summary,
      why_it_matters: whyItMatters,
      verdict,
      source_url: sourceUrl,
      source_kind: sourceKind,
      tags,
    });
  }

  return { digest, items };
}
