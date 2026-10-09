// Dependency-free PNG writer for the toolbar icons: a filled blue disc with a
// white chat-bubble notch. Run only when the icon needs to change —
// `npm run icons` — the PNGs are committed so `load unpacked` just works.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../icons');

function png(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const c = (size - 1) / 2;
  const disc = size * 0.47;
  const bubble = size * 0.26;

  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const o = row + 1 + x * 4;
      const dx = x - c;
      const dy = y - c;
      const d = Math.hypot(dx, dy);
      const inDisc = d <= disc;
      // A rounded bubble body plus a small tail pointing bottom-left.
      const inBubble =
        Math.hypot(dx, dy + size * 0.045) <= bubble ||
        (dx > -size * 0.2 && dx < -size * 0.02 && dy > size * 0.1 && dy < size * 0.26 &&
          dy - size * 0.1 < (dx + size * 0.2) * 1.6);

      const alpha = inDisc ? 255 : 0;
      const ink = inDisc && inBubble;
      raw[o] = ink ? 255 : 47;
      raw[o + 1] = ink ? 255 : 109;
      raw[o + 2] = ink ? 255 : 246;
      raw[o + 3] = alpha;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr(size)),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ihdr(size) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(size, 0);
  b.writeUInt32BE(size, 4);
  b[8] = 8; // bit depth
  b[9] = 6; // RGBA
  return b;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// Emitted last: the CRC table above is a top-level const, so the writes have to
// come after it.
await mkdir(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  await writeFile(resolve(outDir, `icon-${size}.png`), png(size));
}
