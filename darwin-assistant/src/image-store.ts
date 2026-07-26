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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
