import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { FezClient } from "@fezchat/client";
import { flash } from "./toast";
import { relaySet } from "./relay";
import Avatar from "./Avatar";
import UserCard from "./UserCard";
import { resolvePubkeyInput } from "./public-key";

/**
 * Channel/workspace management — Buzz's ChannelManagementSheet as a fez
 * side pane. Members with roles, creator-gated moderation (kick / ban /
 * unban), invites by @name or pubkey, plus create-channel and
 * create-workspace. Every action is a client method — the pane renders
 * trust rules it doesn't own: non-creators simply don't see the levers.
 */

export default function ManagePane({
  client,
  onOpenChannel,
  onClose,
}: {
  client: FezClient;
  onOpenChannel: (channelId: string) => void;
  onClose: () => void;
}) {
  const current = client.state.currentChannel();
  const [card, setCard] = useState<{ pk: string; x: number; y: number } | null>(null);

  const run = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
      flash(`✓ ${label}`);
    } catch (err) {
      flash(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (!current) {
    return (
      <aside className="pane">
        <header className="pane-head">
          <span>⚙ manage</span>
          <button className="pane-close" onClick={onClose}>✕</button>
        </header>
        <div className="pane-body">
          <div className="pane-empty">no channel scope — pick a channel first</div>
          <CreateCommunity client={client} onOpenChannel={onOpenChannel} onResult={flash} />
          <JoinByCode client={client} onOpenChannel={onOpenChannel} onResult={flash} />
        </div>
      </aside>
    );
  }

  const channel = current;

  const amCreator = client.state.isOwner(client.pubkey);
  const myRole = client.state.roleOf(client.pubkey);
  const members = [...client.state.workspace.members.entries()]
    .map(([pk, role]) => ({ pk, role, name: client.displayName(pk), online: client.isOnline(pk) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const banned = [...(client.state.workspace.banned ?? new Map()).entries()].map(([pk, until]) => ({ pk, until }));

  return (
    <aside className="pane">
      <header className="pane-head">
        <span>⚙ #{channel.name}</span>
        <button className="pane-close" onClick={onClose}>✕</button>
      </header>
      <div className="pane-body">
        <div className="manage-sub">
          {client.state.workspace.name} · {members.length} member{members.length === 1 ? "" : "s"}
          {amCreator ? " · you created this workspace" : ""}
        </div>

        <div className="manage-section">members</div>
        {members.map((member) => (
          <div key={member.pk} className={member.online ? "manage-row" : "manage-row away"}>
            {/* Faces here too — the party roster next door has them, and
                a name with no creature is the odd one out now. */}
            <span className="manage-face">
              <Avatar pk={member.pk} size={20} title={member.name} quip={false} />
              <span className={member.online ? "self-presence on" : "self-presence off"} />
            </span>
            <span className="manage-name">{member.name}</span>
            {/* "bot" is the protocol's word; the app's word is agent. */}
            <span className="role-tag">{member.role === "bot" ? "agent" : member.role}</span>
            {member.pk !== client.pubkey && (
              <span className="manage-actions">
                <button
                  className="mini"
                  title="actions"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setCard({ pk: member.pk, x: r.left - 244, y: r.top });
                  }}
                >
                  ⋯
                </button>
              </span>
            )}
          </div>
        ))}
        {card && <UserCard pk={card.pk} at={card} client={client} onClose={() => setCard(null)} />}

        {amCreator && <InviteBox client={client} onResult={flash} />}

        {(amCreator || myRole === "admin") && banned.length > 0 && (
          <>
            <div className="manage-section">banned</div>
            {banned.map(({ pk, until }) => (
              <div key={pk} className="manage-row">
                <span className="manage-name">{client.displayName(pk)}</span>
                {until && <span className="role-tag">until {new Date(until * 1000).toLocaleString()}</span>}
                {client.state.banReason(pk) && <span className="role-tag">{client.state.banReason(pk)}</span>}
                <span className="manage-actions">
                  <button className="mini" title="unban" onClick={() => void run(`unbanned ${client.displayName(pk)}`, () => client.unbanUser(pk))}>
                    ↩
                  </button>
                </span>
              </div>
            ))}
          </>
        )}

        <div className="manage-section">invite link</div>
        <InviteCode communityName={client.state.workspace.name} />

        {amCreator && (
          <CreateRow
            label="new channel"
            placeholder="channel name"
            onCreate={(name) =>
              void run(`created #${name}`, async () => {
                const channelId = await client.createChannel(name);
                onOpenChannel(channelId);
              })
            }
          />
        )}

        <CreateCommunity client={client} onOpenChannel={onOpenChannel} onResult={flash} />
        <JoinByCode client={client} onOpenChannel={onOpenChannel} onResult={flash} />
      </div>
    </aside>
  );
}

/** A relay only this machine can reach — useless in an invite. */
function isLoopback(url: string): boolean {
  return /^wss?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)(:|\/|$)/i.test(url.trim());
}

/**
 * A fez invite is a URI, not a hosted link — there's no server to host one.
 *
 * It names ONE relay for the guest to look at, and that relay has to be
 * one THEY can reach. Handing out `ws://localhost:7777` — the first
 * entry in most developers' relay sets — sends the guest to their own
 * machine, where they find nothing and get no error, because an empty
 * relay and a wrong relay look identical. So loopback addresses are
 * skipped, and when every relay is loopback we say so instead of
 * producing a code that cannot work.
 */
function InviteCode({ communityName }: { communityName: string }) {
  const [copied, setCopied] = useState(false);
  const relays = relaySet();
  const reachable = relays.find((r) => !isLoopback(r));

  if (!reachable) {
    return (
      // A code block dropped mid-sentence broke the paragraph in two and
      // made the relay hard to read. Statement, then the relay on its
      // own line, then what to do about it.
      <div className="settings-hint">
        <p>No invite code yet — your only relay is local:</p>
        <code className="pk-code">{relays[0]}</code>
        <p>
          It points at whatever machine opens the invite, so a code made from it would send guests to
          themselves. Add a relay they can reach — a LAN or Tailscale address, or a hosted one — and the
          code appears here.{" "}
          <button className="skill-link" onClick={() => void openUrl("https://fez.chat/docs/self-hosting")}>
            self-hosting guide ↗
          </button>
        </p>
      </div>
    );
  }

  // The workspace IS the relay — an invite is its URL, nothing more.
  const code = `fez-join:${reachable}`;
  return (
    <>
      <code
        className="pk-code"
        title="click to copy — gets them connected; inviting their key is what lets them in"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? "✓ copied" : code}
      </code>
      <div className="settings-hint">
        Send this to someone — they paste it under "join a workspace" (or onboard with it). Connecting
        gets them to the door; inviting their key above is what lets them into {communityName}.
      </div>
    </>
  );
}

function JoinByCode({
  client,
  onOpenChannel,
  onResult,
}: {
  client: FezClient;
  onOpenChannel: (channelId: string) => void;
  onResult: (text: string) => void;
}) {
  const [code, setCode] = useState("");
  const join = async () => {
    // An invite is just a relay now. The workspace IS the relay, so
    // there is no community id to carry and nothing to look up — the
    // old fez-join:<relay>#<community> form is still accepted, with the
    // trailing id ignored, so codes already in circulation keep working.
    const match = /^fez-join:([^#]+)(?:#.*)?$/i.exec(code.trim());
    if (!match) return onResult("✗ not an invite code — expected fez-join:<relay>");
    const relay = match[1].trim();
    // The code stays in the input until the join lands — an unreachable
    // relay used to clear it first and report nothing, so a mistyped
    // invite was simply gone.
    try {
      const claimed = await client.openWorkspace(relay);
      setCode("");
      if (!claimed) {
        return onResult(`+ added ${relay}, but it has no owner yet — it's an unclaimed workspace`);
      }
      const first = [...client.state.workspace.channels.values()][0];
      if (first) onOpenChannel(first.id);
      onResult(
        client.state.isMember(client.pubkey)
          ? `✓ joined ${client.state.workspace.name}`
          : `+ added ${client.state.workspace.name} — ask its owner to invite ${client.pubkey.slice(0, 12)}…`
      );
    } catch (err) {
      onResult(`✗ couldn't open ${relay}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return (
    <>
      <div className="manage-section">join a workspace</div>
      <div className="manage-form">
        <input
          className="manage-input"
          value={code}
          placeholder="fez-join:wss://…#…"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void join();
          }}
        />
        <button className="agent-action" onClick={() => void join()}>join</button>
      </div>
    </>
  );
}

function InviteBox({ client, onResult }: { client: FezClient; onResult: (text: string) => void }) {
  const [who, setWho] = useState("");
  const [role, setRole] = useState<"member" | "admin" | "bot">("member");

  const invite = async () => {
    const raw = who.trim().replace(/^@/, "");
    if (!raw) return;
    try {
      const pk = resolvePubkeyInput(raw, name => client.pkByName(name));
      if (!pk) {
        onResult(`✗ nobody named "${raw}" — use a known @name, npub, or hex key`);
        return;
      }
      const name = await client.invite(pk, role);
      setWho("");
      onResult(`✓ invited ${name} as ${role}`);
    } catch (err) {
      onResult(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <>
      <div className="manage-section">invite</div>
      <div className="manage-form">
        <input
          className="manage-input"
          value={who}
          placeholder="@name, npub, or hex key"
          spellCheck={false}
          onChange={(e) => setWho(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void invite();
          }}
        />
        <select className="manage-select" value={role} onChange={(e) => setRole(e.target.value as "member" | "admin" | "bot")}>
          <option value="member">member</option>
          <option value="admin">admin</option>
          <option value="bot">bot</option>
        </select>
        <button className="agent-action" onClick={() => void invite()}>invite</button>
      </div>
    </>
  );
}

function CreateRow({
  label,
  placeholder,
  onCreate,
}: {
  label: string;
  placeholder: string;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setName("");
    onCreate(trimmed);
  };
  return (
    <>
      <div className="manage-section">{label}</div>
      <div className="manage-form">
        <input
          className="manage-input"
          value={name}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button className="agent-action" onClick={submit}>create</button>
      </div>
    </>
  );
}

function CreateCommunity({
  client,
  onOpenChannel,
  onResult,
}: {
  client: FezClient;
  onOpenChannel: (channelId: string) => void;
  onResult: (text: string) => void;
}) {
  return (
    <CreateRow
      label="new workspace"
      placeholder="workspace name"
      onCreate={(name) =>
        void (async () => {
          try {
            const { channelId } = await client.claimWorkspace(name);
            onOpenChannel(channelId);
            onResult(`✓ created #${name}`);
          } catch (err) {
            onResult(`✗ ${err instanceof Error ? err.message : String(err)}`);
          }
        })()
      }
    />
  );
}
