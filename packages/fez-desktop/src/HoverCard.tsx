import { useRef, useState } from "react";
import type { FezClient } from "@fez/client";
import Avatar from "./Avatar";

/**
 * Agent/user hover card — hover any name and see who you're dealing
 * with without clicking through: what an agent announced it can do
 * (47000 about + skills via client.agentInfo), presence, and status.
 * Humans get name + status; agents get the full capability card.
 *
 * Positioned FIXED, from the trigger's rect. It used to be absolute
 * inside the message, which meant the timeline's `overflow-y: auto`
 * clipped it — the card for the first message in a channel had its top
 * sliced off by the header. No z-index can fix that: a scroll container
 * clips its absolutely-positioned descendants whatever they paint at.
 * Fixed coordinates escape the scroller, which is the same trick the
 * message and reaction menus already use.
 */
/** Tallest the card gets — decides whether it opens up or down. */
const CARD_MAX_H = 200;

export default function HoverCard({
  client,
  pk,
  children,
  align = "left",
}: {
  client: FezClient;
  pk: string;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  const [at, setAt] = useState<{ left: number; top: number; flip: boolean }>();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const open = !!at;
  const name = client.knownNames().get(pk) ?? pk.slice(0, 8);
  const info = client.agentInfo(pk);
  const online = client.isOnline(pk);
  const status = client.statusOf(pk);

  return (
    <span
      className="hovercard-wrap"
      ref={wrapRef}
      onMouseEnter={() => {
        const rect = wrapRef.current?.getBoundingClientRect();
        if (!rect) return;
        // Open upward by default; flip below when the top of the
        // viewport is closer than the card is tall.
        const flip = rect.top < CARD_MAX_H + 12;
        setAt({
          left: align === "right" ? rect.right : rect.left,
          top: flip ? rect.bottom + 6 : rect.top - 6,
          flip,
        });
      }}
      onMouseLeave={() => setAt(undefined)}
    >
      {children}
      {open && (
        <span
          className={`hovercard ${align}${at.flip ? " below" : ""}`}
          style={{
            left: align === "right" ? undefined : at.left,
            right: align === "right" ? `calc(100vw - ${at.left}px)` : undefined,
            top: at.flip ? at.top : undefined,
            bottom: at.flip ? undefined : `calc(100vh - ${at.top}px)`,
          }}
        >
          <span className="hovercard-head">
            <Avatar pk={pk} size={26} title={name} />
            <span className="hovercard-id">
              <span className="hovercard-name">
                {info ? "@" : ""}
                {name}
              </span>
              <span className="hovercard-presence">
                <span className={online ? "dot on" : "dot off"} /> {status ?? (online ? "online" : "offline")}
              </span>
            </span>
          </span>
          {info?.about && <span className="hovercard-about">{info.about}</span>}
          {info?.skills && info.skills.length > 0 && (
            <span className="hovercard-skills">
              {info.skills.map((skill) => (
                <span key={skill} className="hovercard-skill">{skill}</span>
              ))}
            </span>
          )}
          {info && !info.about && (!info.skills || info.skills.length === 0) && (
            <span className="hovercard-about dim">an agent — no description announced</span>
          )}
        </span>
      )}
    </span>
  );
}
