import type { Sprite } from "./sprites";

/**
 * The site's pixel-sprite renderer, worn by the desktop (classes come
 * from App.css here, not Tailwind). One sprite → one SVG of 1×1 rects,
 * crispEdges so the pixels stay pixels at any size.
 */
export function PixelSprite({
  sprite,
  scale = 4,
  frame = "a",
}: {
  sprite: Sprite;
  scale?: number;
  frame?: "a" | "b";
}) {
  const rows = frame === "b" && sprite.alt ? sprite.alt : sprite.rows;
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));
  const rects: { x: number; y: number; fill: string }[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const fill = sprite.palette[ch];
      if (fill) rects.push({ x, y, fill });
    });
  });
  return (
    <svg
      width={width * scale}
      height={height * scale}
      viewBox={`0 0 ${width} ${height}`}
      shapeRendering="crispEdges"
      aria-hidden
    >
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={1} height={1} fill={r.fill} />
      ))}
    </svg>
  );
}

/**
 * Both idle frames stacked; CSS flips which is visible (`.sprite-anim`
 * in App.css, steps(1) so the change is a jump, never a fade). Each
 * character's motion is whatever its two frames disagree about — the
 * Buzz bee's wing-flap decision, worn by ten familiars.
 */
export function AnimatedSprite({ sprite, scale = 4 }: { sprite: Sprite; scale?: number }) {
  return (
    <span className="sprite-anim">
      <span className="spr-a">
        <PixelSprite sprite={sprite} scale={scale} frame="a" />
      </span>
      <span className="spr-b">
        <PixelSprite sprite={sprite} scale={scale} frame="b" />
      </span>
    </span>
  );
}
