/**
 * Identicon avatars — fez has no image profiles, and that's fine: the
 * pubkey IS the identity, so the avatar is derived from it. A 5×5
 * symmetric pixel grid (Buzz's BotIdenticon decision, GitHub's shape)
 * colored from the gruvbox accents — deterministic, offline, zero
 * bytes fetched. The same pk renders the same face on every surface.
 */

import { useEffect, useRef, useState } from "react";
import { SPRITES } from "./sprites";
import { generateSprite } from "./sprite-gen";
import { quipFor } from "./quips";

export default function Avatar({
  pk,
  size = 28,
  title,
  quip = true,
}: {
  pk: string;
  size?: number;
  title?: string;
  quip?: boolean;
}) {
  // Every face in fez is a character. The named cast (fez, scout, loom, …)
  // wears its hand-drawn sprite — `title` is already the display name at
  // every call site — and EVERYONE else grows a creature from their
  // pubkey (sprite-gen): same key, same familiar, on every surface. The
  // old 5×5 identicon retired here; the pk still decides the face, it
  // just decides a better one.
  const spriteName = title?.toLowerCase().replace(/^@/, "");
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
  // Hover wakes the creature. The two frames are already this key's own
  // (the body plan decides how it moves), and the TEMPO is the key's too —
  // a pk byte picks the beat, so a crowded member list doesn't tick like
  // one metronome.
  const dur = 0.45 + ((parseInt(pk.slice(8, 10), 16) || 0) % 4) * 0.08;
  // Hover long enough and the creature says its line — a fixed-position
  // bubble (HoverCard's clipping-escape trick: scroll containers clip
  // absolutely-positioned descendants, fixed coordinates walk free).
  // The delay keeps a scanned member list from chattering.
  const [bubble, setBubble] = useState<{ left: number; top: number; below: boolean }>();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  return (
    <span
      className="avatar avatar-anim"
      ref={wrapRef}
      style={{ "--spr-dur": `${dur}s` } as React.CSSProperties}
      role="img"
      aria-label={title ?? "avatar"}
      // The OS tooltip would stack under the bubble saying less.
      title={quip ? undefined : title ?? pk.slice(0, 8)}
      onMouseEnter={() => {
        if (!quip) return;
        timerRef.current = window.setTimeout(() => {
          const rect = wrapRef.current?.getBoundingClientRect();
          if (!rect) return;
          const below = rect.top < 48;
          setBubble({
            left: rect.left + rect.width / 2,
            top: below ? rect.bottom + 6 : rect.top - 6,
            below,
          });
        }, 250);
      }}
      onMouseLeave={() => {
        window.clearTimeout(timerRef.current);
        setBubble(undefined);
      }}
    >
      <span className="spr-a">{frame(sprite.rows)}</span>
      <span className="spr-b">{frame(sprite.alt ?? sprite.rows)}</span>
      {bubble && (
        <span
          className={bubble.below ? "quip-bubble below" : "quip-bubble"}
          style={{ left: bubble.left, top: bubble.top }}
        >
          {quipFor(pk, title)}
        </span>
      )}
    </span>
  );
}
