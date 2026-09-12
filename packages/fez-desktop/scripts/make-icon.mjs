#!/usr/bin/env node
/**
 * The app icon: the guide sprite from src/sprites.ts on the site's
 * black — the same little fez-wearer who fronts the boot splash, so
 * the Dock, the app, and the site read as one thing.
 *
 * Emits app-icon.png (1024², Big-Sur squircle on transparent ground);
 * regenerate the full set with:  npx tauri icon app-icon.png
 * Pass --tray for the transparent macOS hat template (36px / 18pt Retina).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const EMBER = "#FF6A00";
const BONE = "#e8e2d9";
const DUST = "#6d645a";
const BG = "#000000"; // the site's bg-black
const TRAY = process.argv.includes("--tray");

// The guide — the fez sprite from src/sprites.ts, the one who wears
// the hat the network is named for. KEEP IN SYNC with that file's
// `fez` entry (rows + palette) if the cast art ever changes.
const PALETTE = { r: EMBER, f: BONE, d: DUST, h: "#000000" };
const ROWS = TRAY ? [
  "..................",
  "..................",
  "..................",
  "........hhhhhh....",
  "....hhhhhhh..hh...",
  "....hhhhhhh...h...",
  "....hhhhhhhh..h...",
  "....hhhhhhhh..h...",
  "...hhhhhhhhh..hh..",
  "...hhhhhhhhh..hh..",
  "...hhhhhhhhhh.hh..",
  "...hhhhhhhhhh.....",
  "..hhhhhhhhhhh.....",
  "..hhhhhhhhhhh.....",
  "..................",
  "..................",
  "..................",
  "..................",
] : [
  "....rrrr....",
  "....rrrr.r..",
  "...ffffff.r.",
  "...f.ff.f...",
  "...ffffff...",
  "..dddddddd..",
  "..dddddddd..",
  "..ddrrrrdd..",
  "..dddddddd..",
  "...dd..dd...",
  "...dd..dd...",
];

assert(ROWS.every(row => row.length === ROWS[0].length && [...row].every(c => c === "." || PALETTE[c])));
const SIZE = TRAY ? 36 : 1024;
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
    if (TRAY || !inSquircle(x, y)) continue;
    const i = (y * SIZE + x) * 4;
    px[i] = bgR; px[i + 1] = bgG; px[i + 2] = bgB; px[i + 3] = 255;
  }

// Sprite: nearest-neighbor, centered, sized to sit inside the squircle
// with breathing room.
const cols = ROWS[0].length;
const rows = ROWS.length;
const scale = TRAY ? 2 : Math.floor((CARD * 0.72) / Math.max(cols, rows));
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

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..",
  TRAY ? "src-tauri/icons/tray-icon.png" : "app-icon.png");
fs.writeFileSync(out, png);
console.log(`✓ ${out} (${(png.length / 1024).toFixed(0)}KB)`);
