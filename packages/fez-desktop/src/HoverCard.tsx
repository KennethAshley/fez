import { useState } from "react";
import type { FezClient } from "@fez/client";
import Avatar from "./Avatar";

/**
 * Agent/user hover card — hover any name and see who you're dealing
 * with without clicking through: what an agent announced it can do
 * (47000 about + skills via client.agentInfo), presence, and status.
 * Humans get name + status; agents get the full capability card.
 */
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
  const [open, setOpen] = useState(false);
  const name = client.knownNames().get(pk) ?? pk.slice(0, 8);
  const info = client.agentInfo(pk);
  const online = client.isOnline(pk);
  const status = client.statusOf(pk);

  return (
    <span
      className="hovercard-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open && (
        <span className={`hovercard ${align}`}>
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
