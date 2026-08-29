/**
 * Identicon avatars — fez has no image profiles, and that's fine: the
 * pubkey IS the identity, so the avatar is derived from it. A 5×5
 * symmetric pixel grid (Buzz's BotIdenticon decision, GitHub's shape)
 * colored from the gruvbox accents — deterministic, offline, zero
 * bytes fetched. The same pk renders the same face on every surface.
 */

import { useEffect, useRef, useState } from "react";
import { Avatar as SpriteAvatar } from "@fezchat/ui";
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
  // The sprite itself (named cast or pk-grown familiar) lives in
  // @fezchat/ui now — this wrapper only adds the desktop's hover quip,
  // which is app-chrome, not an identity primitive.
  //
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
      ref={wrapRef}
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
      <SpriteAvatar pk={pk} name={title} size={size} />
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
