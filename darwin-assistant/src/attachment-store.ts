// Chat file attachments (tree-9b58ddb7) — on-disk storage for ANY file type
// Kevin attaches to a cockpit conversation, not just images.
//
// This is the generalization of image-store.ts (DAR-744). Same transport
// (base64 inline in the JSON body — no multipart, because the cockpit's
// server-side proxy forwards JSON bodies as text, see
// jarvis-command-center/src/lib/cockpit-proxy.ts), same filename-regex guard,
// same "bytes are only ever served through an authed, ownership-checked route"
// rule. Two differences from images:
//
//   1. Layout is uploads/<conversationId>/files/<uuid>.<ext> — a `files/`
//      subdirectory so it can never collide with the flat image filenames
//      (t<turn>-<i>-<hex>.<ext>) already sitting in uploads/<conversationId>/.
//   2. Attachments are first-class rows in the `attachments` table (earmarked
//      per CONVERSATION, with an optional turn_index once sent), rather than a
//      JSON blob on a turn. That's what makes the Settings "Files" tab and
//      upload-before-send possible.
//
// Images keep going through image-store.ts and the vision path untouched; this
// module is only for the attachment pipeline.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UPLOADS_DIR } from './image-store.js';

export { UPLOADS_DIR };

/** Per-file DECODED byte cap (Kevin-approved default, decision #129). Note the
 *  wire cost: base64 inflates by 4/3, so an at-cap file arrives as a ~33.4MB
 *  JSON body — which is why express.json's limit in ui-server.ts is 40mb, not
 *  30mb. Raise one without the other and at-cap uploads 413 before any handler
 *  of ours runs. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** How much of a text-like attachment gets inlined into the model's copy of the
 *  user message. Beyond this the block is truncated with an explicit note. */
export const MAX_INLINE_TEXT_BYTES = 200 * 1024;

export type AttachmentKind = 'text' | 'binary' | 'image';

export class AttachmentValidationError extends Error {}

/**
 * Canonical mime -> extension allowlist. Anything not resolvable to an entry
 * here (directly, or via EXT_MIME below when the browser sends a useless mime)
 * is REJECTED — this is an allowlist, not a denylist, so no executable,
 * script, or archive type can slip through by omission.
 */
const MIME_EXT: Record<string, string> = {
  // text / docs
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/html': 'html',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/xml': 'xml',
  'text/yaml': 'yaml',
  'text/x-yaml': 'yaml',
  'text/css': 'css',
  'application/json': 'json',
  'application/ld+json': 'json',
  'application/xml': 'xml',
  'application/yaml': 'yaml',
  'application/x-yaml': 'yaml',
  'application/pdf': 'pdf',
  // images (same set image-store.ts accepts, so an image can also be managed
  // as an attachment without a second concept)
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Extension -> canonical mime, used when the client sends no mime or a useless
 * one. This is the common real-world case for exactly the files Kevin asked
 * about: Windows/Chrome routinely hand up `application/octet-stream` (or '')
 * for .md and .yaml, so a mime-only allowlist would reject the headline
 * use case. Resolving by extension keeps the allowlist semantics intact — an
 * unknown extension is still rejected.
 */
const EXT_MIME: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  css: 'text/css',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * Extensions refused even when the mime looks acceptable. `text/*` covers a lot
 * of ground (text/javascript, text/x-shellscript, …) and Kevin's ask was
 * documents, not code to execute — so a .sh that announces itself as text/plain
 * is still rejected. Belt-and-braces alongside the allowlists above.
 */
const DENIED_EXT = new Set([
  'exe', 'dll', 'so', 'dylib', 'bin', 'com', 'msi', 'app', 'deb', 'rpm', 'apk', 'dmg', 'pkg',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'scr', 'jar',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'pyc', 'rb', 'pl', 'php', 'lua', 'r',
]);

const TEXT_MIMES = new Set([
  'text/plain', 'text/markdown', 'text/x-markdown', 'text/html', 'text/csv',
  'text/tab-separated-values', 'text/xml', 'text/yaml', 'text/x-yaml', 'text/css',
  'application/json', 'application/ld+json', 'application/xml',
  'application/yaml', 'application/x-yaml',
]);

export interface IncomingAttachment {
  name?: string;
  mime?: string;
  data: string; // base64, optionally a `data:<mime>;base64,` URL
}

export interface SavedAttachment {
  originalName: string;
  storedFilename: string;
  mime: string;
  bytes: number;
  kind: AttachmentKind;
  conversationId: number;
  absPath: string;
}

function stripDataUrlPrefix(data: string): { data: string; mimeFromPrefix?: string } {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(data);
  if (m) return { data: m[2], mimeFromPrefix: m[1] };
  return { data };
}

function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** True for mimes whose bytes are meaningful as utf-8 text to the model. */
export function isTextMime(mime: string): boolean {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return false;
  return TEXT_MIMES.has(m) || m.startsWith('text/');
}

export function classifyMime(mime: string): AttachmentKind {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  return isTextMime(m) ? 'text' : 'binary';
}

/**
 * Resolve a client-supplied (mime, filename) pair to the canonical mime +
 * extension we'll store under. Throws AttachmentValidationError when the type
 * isn't on the allowlist, so the caller rejects the whole request rather than
 * writing a file it can't serve back.
 */
export function resolveType(mime: string | undefined, name: string): { mime: string; ext: string } {
  const ext = extOf(name);
  if (ext && DENIED_EXT.has(ext)) {
    throw new AttachmentValidationError(`file type .${ext} is not allowed`);
  }
  const given = (mime || '').toLowerCase().split(';')[0].trim();

  // 1. A mime we know outright wins.
  const direct = MIME_EXT[given];
  if (direct) return { mime: given, ext: ext && EXT_MIME[ext] === given ? ext : direct };

  // 2. Otherwise fall back to the extension (the octet-stream-for-.md case).
  const byExt = ext ? EXT_MIME[ext] : undefined;
  if (byExt) return { mime: byExt, ext };

  // 3. A generic `text/*` with a non-denied extension is accepted as text.
  if (given.startsWith('text/')) return { mime: 'text/plain', ext: ext || 'txt' };

  throw new AttachmentValidationError(
    `unsupported file type: ${given || '(no mime)'}${ext ? ` (.${ext})` : ''}`,
  );
}

function filesDir(conversationId: number): string {
  return path.join(UPLOADS_DIR, String(conversationId), 'files');
}

/** Decode + validate base64 content against the allowlist and the byte cap. */
function decode(input: IncomingAttachment): { buf: Buffer; mime: string; ext: string; originalName: string } {
  const { data: raw, mimeFromPrefix } = stripDataUrlPrefix(input.data ?? '');
  const originalName = (input.name ?? '').trim() || 'attachment';
  if (originalName.length > 255) throw new AttachmentValidationError('file name is too long');
  const { mime, ext } = resolveType(input.mime || mimeFromPrefix, originalName);

  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new AttachmentValidationError('invalid base64 file data');
  }
  if (!buf.length) throw new AttachmentValidationError('empty file data');
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentValidationError(
      `file exceeds max size of ${MAX_ATTACHMENT_BYTES} bytes (${Math.round(MAX_ATTACHMENT_BYTES / 1048576)}MB)`,
    );
  }
  return { buf, mime, ext, originalName };
}

/** Decode, validate, and write one attachment to disk. Throws AttachmentValidationError on bad input. */
export function saveAttachment(conversationId: number, input: IncomingAttachment): SavedAttachment {
  const { buf, mime, ext, originalName } = decode(input);
  const dir = filesDir(conversationId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Server-generated name: the original is kept only as display metadata on the
  // row, never used as a path component.
  const storedFilename = `${randomUUID()}.${ext}`;
  const absPath = path.join(dir, storedFilename);
  writeFileSync(absPath, buf);
  return {
    originalName,
    storedFilename,
    mime,
    bytes: buf.length,
    kind: classifyMime(mime),
    conversationId,
    absPath,
  };
}

/**
 * Overwrite an existing attachment's bytes in place (keeps the stored filename,
 * so any URL already handed out stays valid). Returns the new mime/bytes/kind.
 * Refuses a content swap that would change the stored extension — the filename
 * on disk must keep describing its own contents.
 */
export function replaceAttachmentContent(
  conversationId: number,
  storedFilename: string,
  input: IncomingAttachment,
): { mime: string; bytes: number; kind: AttachmentKind } {
  const absPath = resolveAttachmentPath(conversationId, storedFilename);
  if (!absPath) throw new AttachmentValidationError('attachment is no longer on disk');
  const { buf, mime, ext } = decode(input);
  if (extOf(storedFilename) !== ext) {
    throw new AttachmentValidationError(
      `replacement content is .${ext} but the stored file is .${extOf(storedFilename)}`,
    );
  }
  writeFileSync(absPath, buf);
  return { mime, bytes: buf.length, kind: classifyMime(mime) };
}

/**
 * Absolute path on disk for a stored attachment, or null if it doesn't exist.
 * Same guard as image-store's resolveImagePath: storedFilename is always
 * server-generated, but refuse anything that isn't a bare safe filename so a
 * caller that ever passes an untrusted value can't traverse out of the
 * conversation's own directory.
 */
export function resolveAttachmentPath(conversationId: number, storedFilename: string): string | null {
  if (!/^[A-Za-z0-9_.-]+$/.test(storedFilename)) return null;
  if (storedFilename === '.' || storedFilename === '..') return null;
  const p = path.join(filesDir(conversationId), storedFilename);
  return existsSync(p) ? p : null;
}

export function readAttachmentBytes(conversationId: number, storedFilename: string): Buffer | null {
  const p = resolveAttachmentPath(conversationId, storedFilename);
  if (!p) return null;
  return readFileSync(p);
}

export function attachmentBytesOnDisk(conversationId: number, storedFilename: string): number | null {
  const p = resolveAttachmentPath(conversationId, storedFilename);
  if (!p) return null;
  try { return statSync(p).size; } catch { return null; }
}

/** Remove an attachment's bytes. Best-effort: a missing file is not an error. */
export function deleteAttachmentFile(conversationId: number, storedFilename: string): void {
  const p = resolveAttachmentPath(conversationId, storedFilename);
  if (!p) return;
  try { rmSync(p); } catch { /* already gone */ }
}

/**
 * Decoded utf-8 text for a text-like attachment, capped at MAX_INLINE_TEXT_BYTES.
 * Returns null for anything that isn't text-like (binary/image) or is missing.
 */
export function extractText(
  conversationId: number,
  storedFilename: string,
  mime: string,
): { text: string; truncated: boolean; totalBytes: number } | null {
  if (!isTextMime(mime)) return null;
  const buf = readAttachmentBytes(conversationId, storedFilename);
  if (!buf) return null;
  const truncated = buf.length > MAX_INLINE_TEXT_BYTES;
  const slice = truncated ? buf.subarray(0, MAX_INLINE_TEXT_BYTES) : buf;
  return { text: slice.toString('utf8'), truncated, totalBytes: buf.length };
}

/** What buildAttachmentModelBlock needs to describe one attachment. */
export interface AttachmentForModel {
  originalName: string;
  storedFilename: string;
  mime: string;
  bytes: number;
  kind: AttachmentKind;
  conversationId: number;
}

/**
 * The "upload to you" half of Kevin's ask: render attachments into the text the
 * model actually receives. Text-like files are inlined as a fenced
 * ```file: <name>``` block (capped, with an explicit truncation note);
 * binary/image files are a one-line reference so the model knows they exist and
 * can ask for them. Returns '' when there is nothing to say.
 */
export function buildAttachmentModelBlock(attachments: AttachmentForModel[]): string {
  if (!attachments.length) return '';
  const parts: string[] = [];
  for (const a of attachments) {
    const extracted = extractText(a.conversationId, a.storedFilename, a.mime);
    if (extracted) {
      const note = extracted.truncated
        ? `\n\n[truncated — showing the first ${MAX_INLINE_TEXT_BYTES} of ${extracted.totalBytes} bytes; ask to read more of this file if you need it]`
        : '';
      parts.push(`\`\`\`file: ${a.originalName}\n${extracted.text}${note}\n\`\`\``);
    } else {
      parts.push(`attached file: ${a.originalName} (${a.mime}, ${a.bytes} bytes) — not inlined; ask if you need its contents`);
    }
  }
  return `\n\n--- attached files (${attachments.length}) ---\n\n${parts.join('\n\n')}`;
}
