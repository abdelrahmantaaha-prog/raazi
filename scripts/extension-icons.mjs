/**
 * Draws the extension's icons: a rounded square in the accent brown with a
 * white "R" — the rail's own mark — at 16, 48 and 128 pixels. And the app's:
 * the same mark at 192 and 512 for public/, which is what lets a browser
 * install Raazi as an app window, plus a full-bleed 512 for systems that cut
 * their own shape. A tiny PNG encoder rather than a dependency, since a handful
 * of images do not justify one.
 *
 *   node scripts/extension-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "extension");

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Supersampled so the edges are smooth at 16px. `bleed` fills the whole square, for an icon the system masks. */
function draw(size, { bleed = false } = {}) {
  const S = 4;
  const bg = [0x7a, 0x4b, 0x2a];
  const inside = (x, y) => {
    if (bleed) return true;
    // Rounded square.
    const r = size * 0.22;
    const dx = Math.max(Math.abs(x - size / 2) - (size / 2 - r), 0);
    const dy = Math.max(Math.abs(y - size / 2) - (size / 2 - r), 0);
    return Math.hypot(dx, dy) <= r;
  };
  const glyph = (x, y) => {
    // An "R" drawn as strokes, in the weight the old "C" ring had: a stem, a
    // bowl on the top half, and a leg. Units are the letter's height.
    // Full bleed keeps the mark inside the circle a mask is guaranteed to show.
    const h = size * (bleed ? 0.44 : 0.56);
    const hw = (size * (bleed ? 0.1 : 0.13)) / 2 / h;
    const u = (x - (size / 2 - 0.31 * h)) / h;
    const v = (y - (size / 2 - 0.5 * h)) / h;
    const seg = (ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(u - ax - t * dx, v - ay - t * dy);
    };
    const bowl = u >= 0.3 ? Math.abs(Math.hypot(u - 0.3, v - 0.25) - 0.25) : Infinity;
    const d = Math.min(
      seg(0, 0, 0, 1),          // stem
      seg(0, 0, 0.3, 0),        // top of the bowl
      seg(0, 0.5, 0.3, 0.5),    // bottom of the bowl
      bowl,
      seg(0.26, 0.5, 0.62, 1),  // leg
    );
    return d <= hw;
  };
  return (x, y) => {
    let cover = 0;
    let ink = 0;
    for (let i = 0; i < S; i++) {
      for (let j = 0; j < S; j++) {
        const sx = x - 0.5 + (i + 0.5) / S;
        const sy = y - 0.5 + (j + 0.5) / S;
        if (inside(sx, sy)) {
          cover++;
          if (glyph(sx, sy)) ink++;
        }
      }
    }
    const a = cover / (S * S);
    if (a === 0) return [0, 0, 0, 0];
    const t = ink / Math.max(cover, 1);
    return [
      Math.round(bg[0] + (255 - bg[0]) * t),
      Math.round(bg[1] + (255 - bg[1]) * t),
      Math.round(bg[2] + (255 - bg[2]) * t),
      Math.round(a * 255),
    ];
  };
}

for (const size of [16, 48, 128]) {
  const file = path.join(out, `icon${size}.png`);
  fs.writeFileSync(file, png(size, draw(size)));
  console.log(`wrote ${path.relative(root, file)}`);
}

const pub = path.join(root, "public");
fs.mkdirSync(pub, { recursive: true });
for (const [name, size, opts] of [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["icon-maskable-512.png", 512, { bleed: true }],
]) {
  const file = path.join(pub, name);
  fs.writeFileSync(file, png(size, draw(size, opts)));
  console.log(`wrote ${path.relative(root, file)}`);
}
