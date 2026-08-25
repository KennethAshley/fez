/**
 * Identicon avatars — fez has no image profiles, and that's fine: the
 * pubkey IS the identity, so the avatar is derived from it. A 5×5
 * symmetric pixel grid (Buzz's BotIdenticon decision, GitHub's shape)
 * colored from the gruvbox accents — deterministic, offline, zero
 * bytes fetched. The same pk renders the same face on every surface.
 */

import { SPRITES } from "./sprites";
import { generateSprite } from "./sprite-gen";

export default function Avatar({ pk, size = 28, title }: { pk: string; size?: number; title?: string }) {
  // Every face in fez is a character. The named cast (fez, scout, loom, …)
  // wears its hand-drawn sprite — `title` is already the display name at
  // every call site — and EVERYONE else grows a creature from their
  // pubkey (sprite-gen): same key, same familiar, on every surface. The
  // old 5×5 identicon retired here; the pk still decides the face, it
  // just decides a better one.
  const spriteName = title?.toLowerCase().replace(/^@/, "");
  const sprite = (spriteName && SPRITES[spriteName]) || generateSprite(pk);
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
