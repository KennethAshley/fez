/**
 * Identicon avatars — fez has no image profiles, and that's fine: the
 * pubkey IS the identity, so the avatar is derived from it. A 5×5
 * symmetric pixel grid (Buzz's BotIdenticon decision, GitHub's shape)
 * colored from the gruvbox accents — deterministic, offline, zero
 * bytes fetched. The same pk renders the same face on every surface.
 */

import { SPRITES } from "./sprites";

const PALETTE = ["#83a598", "#b8bb26", "#fabd2f", "#fb4934", "#d3869b", "#8ec07c", "#fe8019"];

function nibble(pk: string, index: number): number {
  return parseInt(pk[index % pk.length] ?? "0", 16) || 0;
}

export default function Avatar({ pk, size = 28, title }: { pk: string; size?: number; title?: string }) {
  // The cast wears its own face. `title` is already the display name at
  // every call site, so a persona with a sprite (fez, scout, loom, …)
  // renders as its pixel character instead of an identicon — the same
  // sprite the website's roster shows. Everyone else keeps the pk-derived
  // face; a human who happens to share a cast name shares the face too,
  // which is the name's problem, not the avatar's.
  const spriteName = title?.toLowerCase().replace(/^@/, "");
  const sprite = spriteName ? SPRITES[spriteName] : undefined;
  if (sprite) {
    const w = Math.max(...sprite.rows.map((r) => r.length));
    const h = sprite.rows.length;
    const box = Math.max(w, h);
    const ox = (box - w) / 2;
    const oy = (box - h) / 2;
    const rects: { x: number; y: number; fill: string }[] = [];
    sprite.rows.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        const fill = sprite.palette[ch];
        if (fill) rects.push({ x: x + ox, y: y + oy, fill });
      });
    });
    return (
      <svg
        className="avatar"
        width={size}
        height={size}
        viewBox={`0 0 ${box} ${box}`}
        shapeRendering="crispEdges"
        role="img"
        aria-label={title ?? "avatar"}
      >
        <title>{title ?? pk.slice(0, 8)}</title>
        {rects.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={1} height={1} fill={r.fill} />
        ))}
      </svg>
    );
  }
  const color = PALETTE[nibble(pk, 0) % PALETTE.length];
  const cells: { x: number; y: number }[] = [];
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 5; row++) {
      if (nibble(pk, 1 + col * 5 + row) % 2 === 0) continue;
      cells.push({ x: col, y: row });
      if (col < 2) cells.push({ x: 4 - col, y: row }); // mirror
    }
  }
  return (
    <svg
      className="avatar"
      width={size}
      height={size}
      viewBox="0 0 7 7"
      role="img"
      aria-label={title ?? "avatar"}
    >
      <title>{title ?? pk.slice(0, 8)}</title>
      <rect x="0" y="0" width="7" height="7" rx="1.4" fill="#32302f" />
      {cells.map((cell, index) => (
        <rect key={index} x={cell.x + 1} y={cell.y + 1} width="1" height="1" fill={color} />
      ))}
    </svg>
  );
}
