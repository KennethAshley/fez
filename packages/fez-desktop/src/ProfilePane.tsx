import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import PersonaEditor from "./PersonaEditor";
import type { FezClient } from "@fezchat/client";
import Avatar from "./Avatar";

/**
 * Profile card — click any name, get the person (or agent) behind it.
 * Identity on fez IS the pubkey, so the card leads with the human name
 * and keeps the full key one click from the clipboard. Actions adapt:
 * agents get watch/cancel, strangers get DM, the community creator
 * gets invite, and your own card points at settings (where the
 * editable profile lives).
 */

export default function ProfilePane({
  client,
  pk,
  working,
  onDm,
  onWatch,
  onSettings,
  onClose,
}: {
  client: FezClient;
  pk: string;
  working: ReadonlyMap<string, { activity: string; ts: number }>;
  onDm: (pk: string) => void;
  onWatch: (agent: string) => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [localPersona, setLocalPersona] = useState<string>();
  const agentNameForFiles = client.agents().get(pk);
  useEffect(() => {
    setEditing(false);
    if (!agentNameForFiles) return setLocalPersona(undefined);
    void invoke<string[]>("list_personas")
      .then((names) => setLocalPersona(names.find((n) => n.toLowerCase() === agentNameForFiles.toLowerCase())))
      .catch(() => setLocalPersona(undefined));
  }, [pk, agentNameForFiles]);
  const self = pk === client.pubkey;
  const name = client.displayName(pk);
  const agentName = client.agents().get(pk);
  const online = client.isOnline(pk);
  const status = client.statusOf(pk);
  const busy = agentName ? working.get(agentName) : undefined;
  const live = busy && Date.now() - busy.ts < 30_000;

  const role = client.state.roleOf(pk);
  const canInvite = client.state.isOwner(client.pubkey) && !client.state.workspace.members.has(pk) && !self;
  const [inviteState, setInviteState] = useState<"idle" | "sending" | "done" | "error">("idle");

  const copyPk = () => {
    void navigator.clipboard.writeText(pk);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const invite = async () => {
    setInviteState("sending");
    try {
      await client.invite(pk, agentName ? "bot" : "member");
      setInviteState("done");
    } catch {
      setInviteState("error");
    }
  };

  if (editing && localPersona) {
    // The profile card is an inspector; the EDITOR is a workbench — same
    // wide treatment as the agents pane the moment editing starts.
    return (
      <aside className="pane pane-wide">
        <header className="pane-head">
          <button className="pane-back" onClick={() => setEditing(false)}>← profile</button>
          <button className="pane-close" onClick={onClose}>✕</button>
        </header>
        <PersonaEditor name={localPersona} client={client} onDone={() => setEditing(false)} />
      </aside>
    );
  }
  return (
    <aside className="pane">
      <header className="pane-head">
        <span>{agentName ? "@" : "~"} profile</span>
        <button className="pane-close" onClick={onClose}>✕</button>
      </header>
      <div className="pane-body">
        {/* The look card: identity gets a stage. The creature large in a
            framed slot, name beneath, chips in a quiet row, and the
            status line as the creature speaking. */}
        <div className="profile-portrait">
          <span className="portrait-slot">
            <Avatar pk={pk} size={88} title={name} />
          </span>
          <div className="portrait-name">{name}</div>
          <div className="portrait-chips">
            <span className={online ? "dot on" : "dot off"} />
            {self && <span className="profile-you">you</span>}
            {agentName && <span className="role-tag">agent</span>}
            {role && role !== "bot" && <span className="role-tag">{role}</span>}
            {live && <span className="working">⚙</span>}
          </div>
          {live && <div className="agent-headline shimmer">{busy.activity}</div>}
          {!live && status && <div className="portrait-line">“{status}”</div>}
          {!live && !status && <div className="portrait-line dim">{online ? "online" : "offline"}</div>}
        </div>

        <div className="manage-section">pubkey</div>
        <code className="pk-code" onClick={copyPk} title="click to copy">
          {copied ? "✓ copied" : pk}
        </code>
        <div className="settings-hint">This key IS the identity — names are just labels people publish for it.</div>

        <div className="agent-actions profile-actions">
          {!self && <button className="agent-action" onClick={() => onDm(pk)}>✉ dm</button>}
          {agentName && <button className="agent-action" onClick={() => onWatch(agentName)}>◉ watch live</button>}
          {canInvite && (
            <button className="agent-action" disabled={inviteState === "sending"} onClick={() => void invite()}>
              {inviteState === "idle" && `+ invite to ${client.state.workspace.name}`}
              {inviteState === "sending" && "inviting…"}
              {inviteState === "done" && "✓ invited"}
              {inviteState === "error" && "invite failed"}
            </button>
          )}
          {self && <button className="agent-action" onClick={onSettings}>✎ edit profile</button>}
          {localPersona && !self && (
            <button className="agent-action" title="name, model, prompt, channels, access" onClick={() => setEditing(true)}>
              ✎ edit persona
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
