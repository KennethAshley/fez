import Avatar from "./Avatar";
import { hasFace } from "./agent-face";

/**
 * One agent, at roster size.
 *
 * The creature is unboxed on purpose. fez's section rule is "label +
 * hairline, never a bordered card", and these sprites are high-contrast
 * pixel art that already carry their own implicit frame — a filled card
 * frames them twice and turns the roster into a grid of swatches. The
 * card is the page ground plus a hairline; the creature floats on it.
 *
 * A persona that has never spawned has no face, and that is the truth
 * rather than a gap to paper over: the sprite is generated from the
 * agent's key, and `get_identity` only READS the keychain, so no key
 * exists until the agent first wakes. An unhatched agent gets the
 * ember-marked placeholder and says so.
 *
 * The skill strip is the point of this card. Everywhere else in fez you
 * learn what an agent can do by opening it; here the roster answers
 * "who can spend money" and "which agent is broken" at a glance. That
 * is the whole reason skills became packages, rendered.
 */
export interface AgentCardSkill {
  name: string;
  /** Declared but resolves to nothing on this machine. */
  missing?: boolean;
  /** Resolves to a command inside a working directory — this machine only. */
  local?: boolean;
}

export default function AgentCard({
  name,
  pk,
  description,
  skills,
  online,
  waking,
  selected,
  record,
  onOpen,
}: {
  name: string;
  /** Absent until the agent has spawned once and minted its key. */
  pk?: string;
  description?: string;
  skills: AgentCardSkill[];
  online?: boolean;
  /** Started on this machine, not yet announced — the window between the button and the face. */
  waking?: boolean;
  selected?: boolean;
  /** Judged bazaar record, e.g. "research · 91st · 240 tasks". */
  record?: string;
  onOpen: () => void;
}) {
  // A face exists if the agent is in the hand-drawn cast (name is enough)
  // or has minted its key (pubkey seeds the generative creature). Only a
  // persona that is neither has genuinely never worn a face.
  const faced = hasFace(name, pk);
  const faceClass = ["agent-card-face", online && "online", !faced && "unhatched", waking && !online && "waking"]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      className={selected ? "agent-card selected" : "agent-card"}
      onClick={onOpen}
      aria-label={`open @${name}`}
    >
      <span className={faceClass}>
        {faced ? (
          /* `title` is how Avatar finds the hand-drawn cast — the named
             agents (fez, scout, loom, vault, chip, quill, drift, score…)
             wear their own sprite and need no key at all. Everyone else
             grows a creature from their pubkey. Passing pk alone was a
             bug: it sent the whole cast down the generative path and
             left the keyless ones with no face. */
          <Avatar pk={pk ?? ""} title={name} size={72} />
        ) : (
          <span className="agent-egg" aria-hidden>
            ◌
          </span>
        )}
      </span>
      <span className="agent-card-name">@{name}</span>
      {waking && !online && <span className="agent-card-desc">waking — announcing to the relay…</span>}
      {description ? (
        <span className="agent-card-desc">{description}</span>
      ) : (
        <span className="agent-card-desc dim">no description — orchestrators route on it</span>
      )}
      {record && <span className="agent-card-desc mention-key">{record}</span>}
      {skills.length > 0 ? (
        <span className="skill-strip">
          {skills.map((skill) => (
            <span
              key={skill.name}
              className={
                skill.missing ? "skill-chip missing" : skill.local ? "skill-chip local" : "skill-chip"
              }
              title={
                skill.missing
                  ? `${skill.name} — declared, but not installed here`
                  : skill.local
                    ? `${skill.name} — points into a local directory, so it works only on this machine`
                    : skill.name
              }
            >
              {skill.name}
            </span>
          ))}
        </span>
      ) : (
        /* An agent with no skills is a fact, not an absence to hide —
           the dash holds the strip's line so cards stay aligned. */
        <span className="skill-strip empty">—</span>
      )}
    </button>
  );
}
