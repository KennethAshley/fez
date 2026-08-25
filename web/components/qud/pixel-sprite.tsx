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
  frame = 'a',
}: {
  sprite: Sprite;
  scale?: number;
  /** Render every pixel in this one color — the statue-at-rest state.
   * Only the chosen familiar gets its lit palette. */
  mono?: string;
  /** Which idle frame to draw; 'b' falls back to 'a' when a sprite has
   * no alt frame. */
  frame?: 'a' | 'b';
}) {
  const rows = frame === 'b' && sprite.alt ? sprite.alt : sprite.rows;
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));
  const rects: { x: number; y: number; fill: string }[] = [];
  rows.forEach((row, y) => {
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

/**
 * Both idle frames stacked; CSS flips which is visible while the parent
 * `.sprite-hover` is hovered. Each character's motion is whatever its
 * two frames disagree about — a swinging tassel, a traveling shuttle, a
 * wandering iris — which is how the originals did it.
 */
export function AnimatedSprite({ sprite, scale = 4, mono }: { sprite: Sprite; scale?: number; mono?: string }) {
  return (
    <span className="sprite-anim inline-block">
      <span className="spr-a block">
        <PixelSprite sprite={sprite} scale={scale} mono={mono} frame="a" />
      </span>
      <span className="spr-b block">
        <PixelSprite sprite={sprite} scale={scale} mono={mono} frame="b" />
      </span>
    </span>
  );
}
