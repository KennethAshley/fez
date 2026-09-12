import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { FezClient } from "@fezchat/client";
import { flash } from "./toast";
import { relaySet, setRelays } from "./relay";
import { fetchRelayInfo } from "../../../src/protocol/nip11";
import { invitePersona } from "./invite-persona";
import Avatar from "./Avatar";
import UserCard from "./UserCard";
import { resolvePubkeyInput } from "./public-key";
import { parseWorkspaceInvite, workspaceInvite } from "../../fez-client/src/workspace-invite";
import { resolveWorkspaceOwner } from "../../fez-client/src/workspace-owner";
import { pinDesktopWorkspaceOwner } from "./wire";

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
  onProfile,
  onClose,
}: {
  client: FezClient;
  onOpenChannel: (channelId: string) => void;
  onProfile: (pk: string) => void;
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

  const amCreator = client.state.isOwner(client.pubkey);
  const myRole = client.state.roleOf(client.pubkey);
  const members = [...client.state.workspace.members.entries()]
    .map(([pk, role]) => ({ pk, role, name: client.displayName(pk), online: client.isOnline(pk) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const banned = [...(client.state.workspace.banned ?? new Map()).entries()].map(([pk, until]) => ({ pk, until }));

  return (
    <aside className="pane">
      <header className="pane-head">
        <span>{current ? `⚙ #${current.name}` : "⚙ manage"}</span>
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
        {card && <UserCard pk={card.pk} at={card} client={client} onProfile={onProfile} onClose={() => setCard(null)} />}

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
        <InviteCode communityName={client.state.workspace.name} owner={client.state.workspace.owner} />

        {amCreator && (
          <CreateRow
            label="new channel"
            placeholder="channel name"
            exists={(name) => !!client.state.findChannelByName(name)}
            onCreate={async (name) => {
              const existed = !!client.state.findChannelByName(name);
              const channelId = await client.createChannel(name);
              onOpenChannel(channelId);
              flash(`✓ ${existed ? "opened" : "created"} #${name}`);
            }}
          />
        )}

        <CreateCommunity client={client} onOpenChannel={onOpenChannel} onResult={flash} />
        <JoinByCode client={client} onResult={flash} />
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
function InviteCode({ communityName, owner }: { communityName: string; owner?: string }) {
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

  if (!owner) return <p className="settings-hint">Connect to a trusted workspace before sharing an invite.</p>;
  const code = workspaceInvite(reachable, owner);
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
  onResult,
}: {
  client: FezClient;
  onResult: (text: string) => void;
}) {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const join = async () => {
    if (pending) return;
    let invitation: ReturnType<typeof parseWorkspaceInvite>;
    try { invitation = parseWorkspaceInvite(code); }
    catch (error) { return onResult(`✗ ${error instanceof Error ? error.message : String(error)}`); }
    const { relay, owner: expectedOwner } = invitation;
    // The code stays in the input until the join lands — an unreachable
    // relay used to clear it first and report nothing, so a mistyped
    // invite was simply gone.
    try {
      const url = new URL(relay);
      if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("expected a ws:// or wss:// relay URL");
      setPending(true);
      const info = await fetchRelayInfo(relay);
      if (!info) throw new Error("relay unavailable — check the invite and try again");
      if (!info.pubkey) throw new Error("this relay has no workspace owner yet");
      const known = client.state.known.find(w => w.relay === relay)?.owner;
      const owner = resolveWorkspaceOwner(known, info.pubkey, expectedOwner);
      await pinDesktopWorkspaceOwner(relay, info.pubkey, owner);
      // A workspace switch needs a fresh client and subscriptions. Merely
      // changing its state kept reading and publishing on the old relay.
      await setRelays([url.href], { requirePersistence: true });
      client.state.open(url.href, info.name, owner);
      window.location.reload();
    } catch (err) {
      onResult(`✗ couldn't open ${relay}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <div className="manage-section">join a workspace</div>
      <div className="manage-form">
        <input
          className="manage-input"
          value={code}
          disabled={pending}
          placeholder="fez-join:wss://…#…"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void join();
          }}
        />
        <button className="agent-action" disabled={pending || !code.trim()} onClick={() => void join()}>{pending ? "joining…" : "join"}</button>
      </div>
    </>
  );
}

function InviteBox({ client, onResult }: { client: FezClient; onResult: (text: string) => void }) {
  const [who, setWho] = useState("");
  const [role, setRole] = useState<"member" | "admin" | "bot">("member");
  const [pending, setPending] = useState(false);

  const invite = async () => {
    const raw = who.trim().replace(/^@/, "");
    if (!raw || pending) return;
    setPending(true);
    try {
      const pk = resolvePubkeyInput(raw, name => client.pkByName(name));
      if (!pk) {
        const result = await invitePersona(client, raw, role);
        if (result.kind === "invited") {
          setWho("");
          onResult(`✓ invited @${result.persona} as ${result.role}`);
          return;
        }
        if (result.kind === "no-key") {
          onResult(`mention @${result.persona} in a channel to create its identity and invite it`);
          return;
        }
        onResult(`✗ nobody named "${raw}" — use a known @name, npub, or hex key`);
        return;
      }
      const name = await client.invite(pk, role);
      setWho("");
      onResult(`✓ invited ${name} as ${role}`);
    } catch (err) {
      onResult(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <div className="manage-section">invite</div>
      <div className="manage-form">
        <input
          className="manage-input"
          value={who}
          disabled={pending}
          placeholder="@name, npub, or hex key"
          spellCheck={false}
          onChange={(e) => setWho(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void invite();
          }}
        />
        <select className="manage-select" disabled={pending} value={role} onChange={(e) => setRole(e.target.value as "member" | "admin" | "bot")}>
          <option value="member">member</option>
          <option value="admin">admin</option>
          <option value="bot">bot</option>
        </select>
        <button className="agent-action" disabled={pending || !who.trim()} onClick={() => void invite()}>{pending ? "inviting…" : "invite"}</button>
      </div>
    </>
  );
}

function CreateRow({
  label,
  placeholder,
  onCreate,
  exists,
}: {
  label: string;
  placeholder: string;
  onCreate: (name: string) => Promise<void>;
  exists?: (name: string) => boolean;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    try {
      await onCreate(trimmed);
      setName("");
    } catch (err) {
      flash(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <div className="manage-section">{label}</div>
      <div className="manage-form">
        <input
          className="manage-input"
          value={name}
          disabled={pending}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        <button className="agent-action" disabled={pending || !name.trim()} onClick={() => void submit()}>{pending ? "creating…" : exists?.(name.trim()) ? "Open existing channel" : "create"}</button>
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
  if (!client.state.isOwner(client.pubkey) || client.state.workspace.channels.size > 0) return null;
  return (
    <CreateRow
      label="initialize workspace"
      placeholder="first channel name"
      onCreate={async (name) => {
        const { channelId } = await client.claimWorkspace(name);
        onOpenChannel(channelId);
        onResult(`✓ created #${name}`);
      }}
    />
  );
}
