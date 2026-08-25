import type { Sprite } from './sprites';

/**
 * One sprite → one SVG of 1×1 rects, crispEdges so the pixels stay
 * pixels at any size. No canvas, no images: the art ships as markup and
 * inherits nothing from the page but its transparent ground.
 */
export function PixelSprite({
  sprite,
  scale = 4,
  mono,
}: {
  sprite: Sprite;
  scale?: number;
  /** Render every pixel in this one color — the statue-at-rest state.
   * Only the chosen familiar gets its lit palette. */
  mono?: string;
}) {
  const height = sprite.rows.length;
  const width = Math.max(...sprite.rows.map((r) => r.length));
  const rects: { x: number; y: number; fill: string }[] = [];
  sprite.rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const fill = sprite.palette[ch];
      if (fill) rects.push({ x, y, fill: mono ?? fill });
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
