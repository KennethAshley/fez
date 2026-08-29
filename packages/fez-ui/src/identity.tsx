import type { CSSProperties } from "react";
import { SPRITES } from "./sprites.js";
import { generateSprite } from "./sprite-gen.js";

/**
 * Identity avatars — fez has no image profiles: the pubkey IS the
 * identity, so the avatar is grown from it (see sprite-gen.ts). The
 * named cast (fez, scout, loom, …) wears its hand-drawn sprite when
 * `name` matches; everyone else gets their generated familiar. Hover
 * quips are app-chrome, not an identity primitive — they stay in the
 * desktop's own thin wrapper around this component.
 */
export function Avatar({
  pk,
  name,
  size = 28,
}: {
  pk: string;
  name?: string;
  size?: number;
}) {
  const spriteName = name?.toLowerCase().replace(/^@/, "");
  const sprite = (spriteName && SPRITES[spriteName]) || generateSprite(pk);
  const frame = (rows: string[]) => {
    const w = Math.max(...rows.map((r) => r.length));
    const h = rows.length;
    const box = Math.max(w, h);
    const ox = (box - w) / 2;
    const oy = (box - h) / 2;
    const rects: { x: number; y: number; fill: string }[] = [];
    rows.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        const fill = sprite.palette[ch];
        if (fill) rects.push({ x: x + ox, y: y + oy, fill });
      });
    });
    return (
      <svg width={size} height={size} viewBox={`0 0 ${box} ${box}`} shapeRendering="crispEdges" aria-hidden>
        {rects.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={1} height={1} fill={r.fill} />
        ))}
      </svg>
    );
  };
  // The hover-flap tempo is the key's own, so a crowded member list
  // doesn't tick like one metronome (CSS reads --spr-dur on :hover).
  const dur = 0.45 + ((parseInt(pk.slice(8, 10), 16) || 0) % 4) * 0.08;
  return (
    <span
      className="avatar avatar-anim"
      style={{ "--spr-dur": `${dur}s` } as CSSProperties}
      role="img"
      aria-label={name ?? "avatar"}
    >
      <span className="spr-a">{frame(sprite.rows)}</span>
      <span className="spr-b">{frame(sprite.alt ?? sprite.rows)}</span>
    </span>
  );
}
