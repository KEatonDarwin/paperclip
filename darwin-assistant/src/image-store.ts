// DAR-744: on-disk storage for images pasted/attached to a cockpit message.
//
// Images are decoded from base64 (sent inline in the message JSON body — no
// multipart parsing needed since the cockpit's server-side proxy already
// forwards JSON bodies as text, see jarvis-command-center/src/lib/cockpit-proxy.ts)
// and written under uploads/<conversation_id>/. The conversation id that
// physically owns the bytes is embedded in each saved record so a forked/copied
// turn (DAR-743 spinoff, copyTurns) still resolves to the original files rather
// than a nonexistent directory under the new conversation's id.

import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = process.env.JARVIS_UPLOADS_DIR ?? path.join(__dirname, '..', 'uploads');

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const MAX_IMAGES_PER_MESSAGE = 3;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB decoded, per image

export class ImageValidationError extends Error {}

export interface IncomingImage {
  data: string; // base64, optionally a `data:<mime>;base64,` URL
  mime?: string;
}

// What's persisted per image in a turn's `images` column (JSON array).
export interface StoredImageRecord {
  filename: string;
  mime: string;
  conversationId: number; // where the bytes physically live on disk
}

// Same as StoredImageRecord plus the absolute disk path, for callers that need
// to hand the file to the model right after saving it (not persisted as-is).
export interface SavedImage extends StoredImageRecord {
  absPath: string;
}

function stripDataUrlPrefix(data: string): { data: string; mimeFromPrefix?: string } {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(data);
  if (m) return { data: m[2], mimeFromPrefix: m[1] };
  return { data };
}

/** Decode, validate, and persist images for one message. Throws ImageValidationError on any bad input — the caller should reject the whole request rather than save some. */
export function saveMessageImages(
  conversationId: number,
  turnIndex: number,
  images: IncomingImage[],
): SavedImage[] {
  if (images.length === 0) return [];
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new ImageValidationError(`at most ${MAX_IMAGES_PER_MESSAGE} images per message`);
  }

  const decoded = images.map((img) => {
    const { data: raw, mimeFromPrefix } = stripDataUrlPrefix(img.data ?? '');
    const mime = (img.mime || mimeFromPrefix || '').toLowerCase();
    const ext = MIME_EXT[mime];
    if (!ext) throw new ImageValidationError(`unsupported image mime type: ${mime || '(none)'}`);
    let buf: Buffer;
    try {
      buf = Buffer.from(raw, 'base64');
    } catch {
      throw new ImageValidationError('invalid base64 image data');
    }
    if (!buf.length) throw new ImageValidationError('empty image data');
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new ImageValidationError(`image exceeds max size of ${MAX_IMAGE_BYTES} bytes`);
    }
    return { buf, ext, mime };
  });

  const dir = path.join(UPLOADS_DIR, String(conversationId));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return decoded.map(({ buf, ext, mime }, i) => {
    const filename = `t${turnIndex}-${i}-${randomUUID().slice(0, 8)}.${ext}`;
    const absPath = path.join(dir, filename);
    writeFileSync(absPath, buf);
    return { filename, mime, conversationId, absPath };
  });
}

/** Absolute path on disk for a saved image, or null if it doesn't exist. */
export function resolveImagePath(conversationId: number, filename: string): string | null {
  // filename is always server-generated (see saveMessageImages), but guard
  // against path traversal in case a caller ever passes one through untrusted.
  if (!/^[A-Za-z0-9_.-]+$/.test(filename)) return null;
  const p = path.join(UPLOADS_DIR, String(conversationId), filename);
  return existsSync(p) ? p : null;
}

export function parseStoredImages(json: string | null): StoredImageRecord[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as StoredImageRecord[]) : [];
  } catch {
    return [];
  }
}


// ---- file-drop: arbitrary-file attachments, parallel to the image path above.
// Files reuse UPLOADS_DIR/<conversation_id>/ and stripDataUrlPrefix, but accept
// any mime, keep (a sanitized form of) the original name so the model and the
// claude Read tool infer the type, and allow a larger byte budget.

export const MAX_FILES_PER_MESSAGE = 5;
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB decoded, per file

export class FileValidationError extends Error {}

export interface IncomingFile {
  data: string; // base64, optionally a `data:<mime>;base64,` URL
  mime?: string;
  name?: string; // original filename from the browser; used for the on-disk name
}

// What's persisted per file in a turn's `files` column (JSON array). `name` is
// the display/original name; `filename` is the collision-safe on-disk name.
export interface StoredFileRecord {
  filename: string;
  name: string;
  mime: string;
  conversationId: number;
}

export interface SavedFile extends StoredFileRecord {
  absPath: string;
}

export function sanitizeFileBaseName(name: string | undefined): string {
  const base = (name || 'file').split(/[\\/]/).pop() || 'file';
  // keep only chars the resolveFilePath guard accepts; preserve the extension.
  const cleaned = base.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '').slice(0, 80);
  return cleaned || 'file';
}

/** Decode, validate, and persist files for one message. Throws FileValidationError
 *  on any bad input — the caller should reject the whole request. */
export function saveMessageFiles(
  conversationId: number,
  turnIndex: number,
  files: IncomingFile[],
): SavedFile[] {
  if (files.length === 0) return [];
  if (files.length > MAX_FILES_PER_MESSAGE) {
    throw new FileValidationError(`at most ${MAX_FILES_PER_MESSAGE} files per message`);
  }

  const decoded = files.map((f) => {
    const { data: raw, mimeFromPrefix } = stripDataUrlPrefix(f.data ?? '');
    const mime = (f.mime || mimeFromPrefix || 'application/octet-stream').toLowerCase();
    let buf: Buffer;
    try {
      buf = Buffer.from(raw, 'base64');
    } catch {
      throw new FileValidationError('invalid base64 file data');
    }
    if (!buf.length) throw new FileValidationError('empty file data');
    if (buf.length > MAX_FILE_BYTES) {
      throw new FileValidationError(`file exceeds max size of ${MAX_FILE_BYTES} bytes`);
    }
    return { buf, mime, name: sanitizeFileBaseName(f.name) };
  });

  const dir = path.join(UPLOADS_DIR, String(conversationId));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return decoded.map(({ buf, mime, name }, i) => {
    // `t<turn>-<i>-<name>` — the index prefix keeps two same-named files apart
    // and guarantees a traversal-safe, resolveFilePath-matchable filename.
    const filename = `t${turnIndex}-${i}-${name}`;
    const absPath = path.join(dir, filename);
    writeFileSync(absPath, buf);
    return { filename, name, mime, conversationId, absPath };
  });
}

/** Absolute path on disk for a saved file, or null if it doesn't exist. */
export function resolveFilePath(conversationId: number, filename: string): string | null {
  if (!/^[A-Za-z0-9_.-]+$/.test(filename)) return null;
  const p = path.join(UPLOADS_DIR, String(conversationId), filename);
  return existsSync(p) ? p : null;
}

export function parseStoredFiles(json: string | null): StoredFileRecord[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as StoredFileRecord[]) : [];
  } catch {
    return [];
  }
}


// ---- handback files: JARVIS attaches a file IT created to its OWN reply ----
// (tree-7718eb70). The bytes come from an absolute path on this box instead of
// a base64 body, and are COPIED into UPLOADS_DIR/<conversation_id>/ so the
// served file is a frozen snapshot — later edits/deletes of the source don't
// change what Kevin downloads. Served by the same /files/:turn_index route.

// Extension -> mime for handback files (uploads carry the browser's mime; a
// handback has only its path). Unknown extensions fall back to octet-stream.
const FILE_EXT_MIME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(MIME_EXT).map(([mime, ext]) => [ext, mime])),
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  sql: 'application/sql',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
};

export function mimeForFileName(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return FILE_EXT_MIME[ext] ?? 'application/octet-stream';
}

/** Validate a handback source path: absolute, an existing regular file, within
 *  MAX_FILE_BYTES. Returns its size; throws FileValidationError otherwise. Used
 *  both by the attach_file tool (fail fast, at call time) and by
 *  saveHandbackFile (the file may have changed between stage and persist). */
export function checkHandbackSource(absSourcePath: string): number {
  if (typeof absSourcePath !== 'string' || !path.isAbsolute(absSourcePath)) {
    throw new FileValidationError('path must be absolute');
  }
  let st;
  try {
    st = statSync(absSourcePath);
  } catch {
    throw new FileValidationError(`no such file: ${absSourcePath}`);
  }
  if (st.isDirectory()) throw new FileValidationError(`path is a directory, not a file: ${absSourcePath}`);
  if (!st.isFile()) throw new FileValidationError(`not a regular file: ${absSourcePath}`);
  if (st.size > MAX_FILE_BYTES) {
    throw new FileValidationError(`file exceeds max size of ${MAX_FILE_BYTES} bytes (${st.size})`);
  }
  return st.size;
}

/** Copy one file JARVIS produced into the conversation's upload dir so it can be
 *  attached to an assistant turn. Throws FileValidationError on a bad source. */
export function saveHandbackFile(
  conversationId: number,
  turnIndex: number,
  absSourcePath: string,
  displayName?: string,
): SavedFile {
  checkHandbackSource(absSourcePath);
  const name = sanitizeFileBaseName(displayName || path.basename(absSourcePath));
  const dir = path.join(UPLOADS_DIR, String(conversationId));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // `t<turn>-h<uuid8>-<name>`: the uuid keeps several handbacks with the same
  // name (or a later turn reusing one) apart; the charset matches resolveFilePath.
  const filename = `t${turnIndex}-h${randomUUID().slice(0, 8)}-${name}`;
  const absPath = path.join(dir, filename);
  copyFileSync(absSourcePath, absPath);
  return { filename, name, mime: mimeForFileName(name), conversationId, absPath };
}
