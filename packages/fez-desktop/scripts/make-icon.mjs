#!/usr/bin/env node
/**
 * The app icon, generated from a pixel map in the sprites.ts spirit.
 * The subject is the wordmark the website header wears — white mono
 * "fez" with the ember ▴ on black — so the Dock and the site read as
 * one thing.
 *
 * Emits app-icon.png (1024², Big-Sur squircle on transparent ground);
 * regenerate the full set with:  npx tauri icon app-icon.png
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const EMBER = "#FF6A00";
const WHITE = "#ffffff";
const BG = "#000000"; // the site's bg-black

// The wordmark the website header wears: white mono "fez", ember ▴.
// Pixel letters, 17×7 — w/e/z are the white glyphs, t the triangle.
const PALETTE = { w: WHITE, e: WHITE, z: WHITE, t: EMBER };
const ROWS = [
  ".ww..............",
  "w................",
  "www..ee..zzzz....",
  "w...e..e...z.....",
  "w...eeee..z......",
  "w...e....z.....t.",
  "w....eee.zzzz.ttt",
];

const SIZE = 1024;
// Apple's Big Sur template: content squircle ~824px centered on 1024.
const CARD = 824;
const RADIUS = 185;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const [bgR, bgG, bgB] = hex(BG);

const px = Buffer.alloc(SIZE * SIZE * 4); // RGBA, transparent ground

const inSquircle = (x, y) => {
  const min = (SIZE - CARD) / 2;
  const max = min + CARD - 1;
  if (x < min || x > max || y < min || y > max) return false;
  const cx = x < min + RADIUS ? min + RADIUS : x > max - RADIUS ? max - RADIUS : x;
  const cy = y < min + RADIUS ? min + RADIUS : y > max - RADIUS ? max - RADIUS : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2;
};

for (let y = 0; y < SIZE; y++)
  for (let x = 0; x < SIZE; x++) {
    if (!inSquircle(x, y)) continue;
    const i = (y * SIZE + x) * 4;
    px[i] = bgR; px[i + 1] = bgG; px[i + 2] = bgB; px[i + 3] = 255;
  }

// Sprite: nearest-neighbor, centered, sized to sit inside the squircle
// with breathing room.
const cols = ROWS[0].length;
const rows = ROWS.length;
const scale = Math.floor((CARD * 0.82) / Math.max(cols, rows));
const ox = Math.round((SIZE - cols * scale) / 2);
const oy = Math.round((SIZE - rows * scale) / 2);
for (let ry = 0; ry < rows; ry++)
  for (let rx = 0; rx < cols; rx++) {
    const c = ROWS[ry][rx];
    if (c === ".") continue;
    const [r, g, b] = hex(PALETTE[c]);
    for (let dy = 0; dy < scale; dy++)
      for (let dx = 0; dx < scale; dx++) {
        const x = ox + rx * scale + dx;
        const y = oy + ry * scale + dy;
        const i = (y * SIZE + x) * 4;
        px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
      }
  }

// ── minimal PNG writer (RGBA8, filter 0) ─────────────────────────────
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app-icon.png");
fs.writeFileSync(out, png);
console.log(`✓ ${out} (${(png.length / 1024).toFixed(0)}KB)`);
