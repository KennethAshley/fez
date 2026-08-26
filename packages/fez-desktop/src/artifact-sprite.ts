import type { Sprite } from "./sprites";

/**
 * name → relic. Extensions get the artifact cousin of the pubkey
 * familiars: a deterministic 12px sprite grown from the package name.
 * Where creatures are drawn ragged (grown things), relics are perfectly
 * mirror-symmetric (made things), in four families — idol, blade, ring,
 * shard — each with a punched socket where a creature would have eyes.
 * The two idle frames disagree about where the glint sits, so a woken
 * relic shimmers instead of walking.
 *
 * Bodies come from a mineral bank (the creature bank is organic pastel);
 * accents keep the creature rule: ember weighted first.
 */

const W = 12;
const H = 12;

const BODY = ["#8fa1b3", "#c9a26a", "#9c8f7f", "#7fa88f", "#a88fb8", "#b3766a"];
const ACCENT = ["#FF6A00", "#FF6A00", "#fabd2f", "#cfc041", "#6fb3b8"];

type Family = "idol" | "blade" | "ring" | "shard";

function makeRng(name: string): () => number {
  let s = 0x811c9dc5;
  for (const ch of name) {
    s ^= ch.codePointAt(0) ?? 0;
    s = Math.imul(s, 0x01000193) >>> 0;
  }
  if (!s) s = 0x9e3779b9;
  const nx = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
  // Warm up: catalog names share a long @fezchat/ prefix, and the first
  // draws off nearby seeds correlate — every relic came out an idol.
  nx();
  nx();
  nx();
  return nx;
}

const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length) % xs.length];
const irange = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

function render(name: string, phase: 0 | 1): string[] {
  const r = makeRng(name);
  const fam = pick(r, ["idol", "blade", "ring", "shard"] as Family[]);
  const g: string[][] = Array.from({ length: H }, () => Array<string>(W).fill("."));
  const cx = W / 2;
  const put = (y: number, half: number, ch = "b") => {
    for (let dx = 0; dx < half; dx++) {
      g[y][cx - 1 - dx] = ch;
      g[y][cx + dx] = ch;
    }
  };
  const hole = (y: number, half: number) => {
    for (let dx = 0; dx < half; dx++) {
      g[y][cx - 1 - dx] = ".";
      g[y][cx + dx] = ".";
    }
  };
  let glintY = 0;

  if (fam === "idol") {
    const headHalf = irange(r, 3, 4);
    const headH = irange(r, 3, 4);
    for (let y = 0; y < headH; y++) put(1 + y, headHalf);
    hole(2, irange(r, 1, 2));
    const neckY = 1 + headH;
    put(neckY, 1);
    for (let y = neckY + 1; y < 10; y++) put(y, 2);
    put(10, irange(r, 2, 3));
    glintY = neckY + 1 + irange(r, 0, 1);
    put(glintY, 2, "a");
    if (r() < 0.7) {
      g[0][cx - headHalf] = "a";
      g[0][cx + headHalf - 1] = "a";
    }
  } else if (fam === "blade") {
    put(1, 1);
    const halves: number[] = [];
    for (let y = 2; y < 8; y++) {
      halves[y] = irange(r, 1, 2);
      put(y, halves[y]);
    }
    // Fuller hole only where the blade is wide enough to survive it — a
    // hole in a 2px-wide row severs the silhouette.
    const wideRows = [3, 4, 5].filter((y) => halves[y] === 2);
    if (wideRows.length) hole(pick(r, wideRows), 1);
    put(8, irange(r, 3, 4), "a");
    put(9, 1);
    put(10, 1);
    glintY = 10;
    put(glintY, irange(r, 1, 2), "a");
  } else if (fam === "ring") {
    const rad = irange(r, 3, 4);
    const cy = 5;
    for (let y = cy - rad; y <= cy + rad; y++) {
      const t = Math.abs(y - cy) / rad;
      put(y, Math.max(1, Math.round(rad * Math.sqrt(Math.max(0, 1 - t * t))) + 1));
    }
    for (let y = cy - rad + 2; y <= cy + rad - 2; y++) hole(y, Math.max(1, rad - 2));
    put(cy + rad + 1, 1, "a");
    if (cy + rad + 2 < H) put(cy + rad + 2, 1, "a");
    glintY = cy - rad;
    put(glintY, 1, "a");
  } else {
    const top = irange(r, 0, 1);
    const bot = 10;
    const mid = irange(r, 4, 6);
    const girth = irange(r, 2, 3);
    for (let y = top; y <= bot; y++) {
      const t = y < mid ? (y - top) / Math.max(1, mid - top) : (bot - y) / Math.max(1, bot - mid);
      put(y, Math.max(1, Math.round(1 + t * girth)));
    }
    // Heart socket, only if the waist is wide enough to keep its edges.
    if (girth >= 2) hole(mid, 1);
    glintY = mid - 2;
    put(glintY, 1, "a");
    if (r() < 0.5) put(mid + 2, 2, "a");
  }

  // The glint flip: frame b moves the marked accent one row, so hovering
  // reads as light traveling over the relic.
  if (phase === 1) {
    g[glintY] = g[glintY].map((c) => (c === "a" ? "b" : c));
    const y2 = glintY > 5 ? glintY - 1 : glintY + 1;
    for (const x of [cx - 1, cx]) if (g[y2][x] === "b") g[y2][x] = "a";
  }
  return g.map((row) => row.join(""));
}

const cache = new Map<string, Sprite>();

/** The relic for an extension package name — memoized, deterministic. */
export function generateArtifact(name: string): Sprite {
  const hit = cache.get(name);
  if (hit) return hit;
  const sprite: Sprite = {
    rows: render(name, 0),
    alt: render(name, 1),
    palette: { b: pickBody(name), a: pickAccent(name) },
  };
  cache.set(name, sprite);
  return sprite;
}

// Body/accent draw from their own rng stream so silhouette edits never
// re-dye every relic in the bazaar.
function pickBody(name: string): string {
  return pick(makeRng(name + "/body"), BODY);
}
function pickAccent(name: string): string {
  return pick(makeRng(name + "/accent"), ACCENT);
}
