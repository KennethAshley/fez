import type { Sprite } from "./sprites.js";

/**
 * pk → familiar. Every pubkey grows its own Qud-style creature,
 * deterministically: the key's bytes seed a tiny RNG that draws a BODY
 * PLAN (species, proportions, eyes, crest, belt, tassel, tendrils), and
 * a pure renderer draws both idle frames from that one plan with a
 * phase flip — so every creature also gets its own animation: bipeds
 * swap stance, beasts trot and flick their tails, blobs squash, floaters
 * sway. Same key, same creature, on every surface, forever.
 *
 * Design rules carried over from the hand-drawn cast: 12px grid, two
 * colors from a bank that weights ember, eyes punched as holes, and
 * deterministic edge-raggedness so silhouettes read organic. Validated
 * by the sheet in PROTOTYPE-creature-gen.html (proto branch).
 */

const W = 12;
const H = 12;

const BODY = ["#6fb3b8", "#9d6fcf", "#58c470", "#cfc041", "#b48e6f", "#7d8ca3", "#c64ead", "#a3a071"];
const ACCENT = ["#FF6A00", "#FF6A00", "#cfc041", "#58c470", "#6fb3b8", "#c64ead"];

type Kind = "biped" | "blob" | "floater" | "beast";

interface Plan {
  kind: Kind;
  body: string;
  accent: string;
  headW: number;
  headH: number;
  torsoW: number;
  torsoH: number;
  eyeStyle: number;
  crest: number;
  tassel: number;
  noise: boolean[];
  tendrils: number[];
  legSpread: number;
  beltRow: number;
}

function makeRng(pk: string): () => number {
  let s = 0;
  for (let i = 0; i < 8; i++) s = (s * 31 + (parseInt(pk.slice(i * 2, i * 2 + 2), 16) || 0)) >>> 0;
  if (!s) s = 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length) % xs.length];
const irange = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

function plan(pk: string): Plan {
  const r = makeRng(pk);
  return {
    kind: pick(r, ["biped", "biped", "blob", "floater", "beast"] as Kind[]),
    body: pick(r, BODY),
    accent: pick(r, ACCENT),
    headW: irange(r, 3, 5) * 2 - 2,
    headH: irange(r, 2, 3),
    torsoW: irange(r, 3, 5) * 2,
    torsoH: irange(r, 3, 4),
    eyeStyle: irange(r, 0, 2),
    crest: irange(r, 0, 3),
    tassel: irange(r, 0, 2),
    noise: Array.from({ length: 40 }, () => r() < 0.14),
    tendrils: Array.from({ length: 5 }, () => irange(r, 2, 4)),
    legSpread: irange(r, 0, 1),
    beltRow: irange(r, 0, 2),
  };
}

function render(p: Plan, phase: 0 | 1): string[] {
  const g: string[][] = Array.from({ length: H }, () => Array<string>(W).fill("."));
  const cx = W / 2;
  let ni = 0;
  const noisy = () => p.noise[ni++ % p.noise.length];
  const putRow = (y: number, w: number, ch: string, center = cx, ragged = false) => {
    let x0 = Math.floor(center - w / 2);
    let x1 = Math.ceil(center + w / 2) - 1;
    if (ragged && w > 3 && noisy()) {
      if (noisy()) x0++;
      else x1--;
    }
    for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) if (y >= 0 && y < H) g[y][x] = ch;
  };

  if (p.kind === "biped") {
    const headTop = 1 + (p.crest ? 1 : 0);
    for (let y = 0; y < p.headH; y++) putRow(headTop + y, p.headW, "b");
    const torsoTop = headTop + p.headH;
    for (let y = 0; y < p.torsoH; y++) putRow(torsoTop + y, p.torsoW, "b", cx, true);
    putRow(torsoTop + (p.beltRow % p.torsoH), p.torsoW - 2, "a");
    const legY = torsoTop + p.torsoH;
    const spread = (p.legSpread + phase) % 2 === 0 ? 1 : 2;
    for (let y = legY; y < Math.min(H, legY + 2); y++) {
      g[y][Math.floor(cx - spread - 1)] = "b";
      g[y][Math.floor(cx - spread)] = "b";
      g[y][Math.floor(cx + spread - 1)] = "b";
      g[y][Math.floor(cx + spread)] = "b";
    }
    const eyeY = headTop + 1;
    if (p.eyeStyle === 2) g[eyeY][Math.floor(cx) - phase] = ".";
    else {
      const off = p.eyeStyle === 0 ? 1 : 2;
      g[eyeY][Math.floor(cx - off - 1)] = ".";
      g[eyeY][Math.floor(cx + off)] = ".";
    }
    if (p.crest === 1) g[headTop - 1][Math.floor(cx) - 1] = "a";
    if (p.crest === 2) {
      g[headTop - 1][Math.floor(cx - p.headW / 2)] = "a";
      g[headTop - 1][Math.floor(cx + p.headW / 2) - 1] = "a";
    }
    if (p.crest === 3) putRow(headTop - 1, p.headW - 2, "a");
    if (p.tassel) {
      const side = p.tassel === 1 ? -1 : 1;
      const x = Math.floor(cx + side * (p.headW / 2 + (phase ? 0 : 1)) - (side < 0 ? 1 : 0));
      if (x >= 0 && x < W) {
        g[headTop][x] = "a";
        g[headTop + 1][x] = "a";
      }
    }
  } else if (p.kind === "beast") {
    const bodyTop = 5;
    for (let y = 0; y < 3; y++) putRow(bodyTop + y, 9, "b", cx + 1, true);
    for (let y = 0; y < 2; y++) putRow(3 + y, 4, "b", 3);
    g[4][2] = ".";
    putRow(bodyTop + 1, 7, "a", cx + 1);
    g[bodyTop - 1][phase ? 11 : 10] = "a";
    for (const [i, x] of [3, 5, 8, 10].entries()) {
      const lift = (i + phase) % 2 === 0 ? 0 : 1;
      for (let y = bodyTop + 3; y < bodyTop + 5 - lift; y++) g[y][x] = "b";
    }
    if (p.crest) g[2][3] = "a";
  } else if (p.kind === "blob") {
    const top = 3 + phase;
    const rows = 7 - phase;
    for (let y = 0; y < rows; y++) {
      const t = (2 * y) / (rows - 1) - 1;
      const w = Math.max(3, Math.round((p.torsoW + phase) * Math.sqrt(Math.max(0.12, 1 - t * t))));
      putRow(top + y, w, "b", cx, true);
    }
    const eyeY = top + 2;
    const off = p.eyeStyle === 0 ? 1 : 2;
    if (p.eyeStyle === 2) g[eyeY][Math.floor(cx)] = ".";
    else {
      g[eyeY][Math.floor(cx - off)] = ".";
      g[eyeY][Math.floor(cx + off - 1)] = ".";
    }
    if (p.crest) {
      g[top - 1][Math.floor(cx) - 1] = "a";
      if (p.crest > 1) g[top - 1][Math.floor(cx)] = "a";
    }
  } else {
    for (let y = 0; y < 4; y++) {
      const w = [p.torsoW - 2, p.torsoW, p.torsoW, p.torsoW - 2][y];
      putRow(2 + y, w, "b");
    }
    g[4][Math.floor(cx - 2)] = ".";
    g[4][Math.floor(cx + 1)] = ".";
    const xs = [-2, -1, 0, 1].map((dx) => Math.floor(cx + dx));
    xs.forEach((x, i) => {
      const len = p.tendrils[i] + ((i + phase) % 2 === 0 ? 0 : -1);
      for (let y = 6; y < 6 + len && y < H; y++) if ((y + i) % 2 === 0 || y === 6) g[y][x] = "b";
    });
    if (p.crest) g[1][Math.floor(cx) - phase] = "a";
  }
  return g.map((row) => row.join(""));
}

const cache = new Map<string, Sprite>();

/** The generated familiar for a pubkey — memoized; pks recur constantly. */
export function generateSprite(pk: string): Sprite {
  const hit = cache.get(pk);
  if (hit) return hit;
  const p = plan(pk);
  const sprite: Sprite = {
    rows: render(p, 0),
    alt: render(p, 1),
    palette: { b: p.body, a: p.accent },
  };
  cache.set(pk, sprite);
  return sprite;
}
