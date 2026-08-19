import { useState } from "react";
import type { FezClient } from "@fez/client";

/**
 * Channel/community management — Buzz's ChannelManagementSheet as a fez
 * side pane. Members with roles, creator-gated moderation (kick / ban /
 * unban), invites by @name or pubkey, plus create-channel and
 * create-community. Every action is a client method — the pane renders
 * trust rules it doesn't own: non-creators simply don't see the levers.
 */

export default function ManagePane({
  client,
  onOpenChannel,
  onClose,
}: {
  client: FezClient;
  onOpenChannel: (communityId: string, channelId: string) => void;
  onClose: () => void;
}) {
  const current = client.state.currentChannel();
  const [notice, setNotice] = useState<string>();
  const [armed, setArmed] = useState<string>(); // `${verb}:${pk}` two-click confirm

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(undefined), 5000);
  };

  const run = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
      flash(`✓ ${label}`);
    } catch (err) {
      flash(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const confirmThen = (key: string, action: () => void) => {
    if (armed !== key) {
      setArmed(key);
      setTimeout(() => setArmed((cur) => (cur === key ? undefined : cur)), 4000);
      return;
    }
    setArmed(undefined);
    action();
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
          {notice && <div className="manage-notice">{notice}</div>}
          <CreateCommunity client={client} onOpenChannel={onOpenChannel} onResult={flash} />
          <JoinByCode client={client} onOpenChannel={onOpenChannel} onResult={flash} />
        </div>
      </aside>
    );
  }

  const { community, channel } = current;
  const amCreator = community.creator === client.pubkey;
  const members = [...channel.members.entries()]
    .map(([pk, role]) => ({ pk, role, name: client.displayName(pk), online: client.isOnline(pk) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const banned = [...(community.banned ?? [])];

  return (
    <aside className="pane">
      <header className="pane-head">
        <span>⚙ #{channel.name}</span>
        <button className="pane-close" onClick={onClose}>✕</button>
      </header>
      <div className="pane-body">
        {notice && <div className="manage-notice">{notice}</div>}
        <div className="manage-sub">
          {community.name} · {members.length} member{members.length === 1 ? "" : "s"}
          {amCreator ? " · you created this community" : ""}
        </div>

        <div className="manage-section">members</div>
        {members.map((member) => (
          <div key={member.pk} className="manage-row">
            <span className={member.online ? "dot on" : "dot off"} />
            <span className="manage-name">{member.name}</span>
            <span className="role-tag">{member.role}</span>
            {amCreator && member.pk !== community.creator && (
              <span className="manage-actions">
                <button
                  className={armed === `kick:${member.pk}` ? "mini danger armed" : "mini"}
                  title="remove from this channel (history stays)"
                  onClick={() => confirmThen(`kick:${member.pk}`, () => void run(`removed ${member.name}`, () => client.kick(member.pk)))}
                >
                  {armed === `kick:${member.pk}` ? "kick?" : "×"}
                </button>
                <button
                  className={armed === `ban:${member.pk}` ? "mini danger armed" : "mini"}
                  title="ban from the whole community"
                  onClick={() => confirmThen(`ban:${member.pk}`, () => void run(`banned ${member.name}`, () => client.banUser(community.id, member.pk)))}
                >
                  {armed === `ban:${member.pk}` ? "ban?" : "⛔"}
                </button>
              </span>
            )}
          </div>
        ))}

        {amCreator && <InviteBox client={client} onResult={flash} />}

        {amCreator && banned.length > 0 && (
          <>
            <div className="manage-section">banned</div>
            {banned.map((pk) => (
              <div key={pk} className="manage-row">
                <span className="manage-name">{client.displayName(pk)}</span>
                <span className="manage-actions">
                  <button className="mini" title="unban" onClick={() => void run(`unbanned ${client.displayName(pk)}`, () => client.unbanUser(community.id, pk))}>
                    ↩
                  </button>
                </span>
              </div>
            ))}
          </>
        )}

        <div className="manage-section">invite link</div>
        <InviteCode communityId={community.id} communityName={community.name} />

        {amCreator && (
          <CreateRow
            label="new channel"
            placeholder="channel name"
            onCreate={(name) =>
              void run(`created #${name}`, async () => {
                const channelId = await client.createChannel(community.id, name);
                onOpenChannel(community.id, channelId);
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
function InviteCode({ communityId, communityName }: { communityId: string; communityName: string }) {
  const [copied, setCopied] = useState(false);
  const relays = (localStorage.getItem("fez-relay") ?? "ws://localhost:7777")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const reachable = relays.find((r) => !isLoopback(r));

  if (!reachable) {
    return (
      <div className="settings-hint">
        Your only relay is <code className="pk-code">{relays[0]}</code>, which points at whatever machine
        opens the invite — so a code made from it would send guests to themselves. Add a relay they can
        reach (a LAN or Tailscale address, or a hosted one) and the code appears here.
      </div>
    );
  }

  const code = `fez-join:${reachable}#${communityId}`;
  return (
    <>
      <code
        className="pk-code"
        title="click to copy — anyone on this relay can join with it"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? "✓ copied" : code}
      </code>
      <div className="settings-hint">Send this to someone — they paste it under "join community" (or onboard with it) and land in {communityName}.</div>
    </>
  );
}

function JoinByCode({
  client,
  onOpenChannel,
  onResult,
}: {
  client: FezClient;
  onOpenChannel: (communityId: string, channelId: string) => void;
  onResult: (text: string) => void;
}) {
  const [code, setCode] = useState("");
  const join = async () => {
    const match = /^fez-join:(.+)#([0-9a-f-]+)$/i.exec(code.trim());
    if (!match) return onResult("✗ not an invite code — expected fez-join:<relay>#<community>");
    const [, relay, communityId] = match;
    // A community on another relay is a reason to ADD that relay, not to
    // turn someone away. Refusing here was a leftover from when a client
    // could only talk to one relay — now the invite just widens the set,
    // which is the entire point of having one.
    const current = (localStorage.getItem("fez-relay") ?? "ws://localhost:7777").split(",").map((r) => r.trim());
    if (!current.includes(relay)) {
      localStorage.setItem("fez-relay", [...current, relay].join(","));
      onResult(`+ added ${relay} to your relays — reopen fez to finish joining`);
    }
    setCode("");
    const known = await client.joinCommunity(communityId);
    if (!known) return onResult("✗ joined, but the community hasn't reached this relay yet — it appears when its events do");
    const community = client.state.communities.get(communityId);
    const channel = community ? [...community.channels.values()][0] : undefined;
    if (community && channel) {
      onOpenChannel(communityId, channel.id);
      onResult(`✓ joined ${community.name}`);
    }
  };
  return (
    <>
      <div className="manage-section">join community</div>
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
  const [role, setRole] = useState<"member" | "bot">("member");

  const invite = async () => {
    const raw = who.trim().replace(/^@/, "");
    if (!raw) return;
    const pk = /^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : client.pkByName(raw);
    if (!pk) {
      onResult(`✗ nobody named "${raw}" — use a known @name or a 64-hex pubkey`);
      return;
    }
    try {
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
          placeholder="@name or pubkey hex"
          spellCheck={false}
          onChange={(e) => setWho(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void invite();
          }}
        />
        <select className="manage-select" value={role} onChange={(e) => setRole(e.target.value as "member" | "bot")}>
          <option value="member">member</option>
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
  onOpenChannel: (communityId: string, channelId: string) => void;
  onResult: (text: string) => void;
}) {
  return (
    <CreateRow
      label="new community"
      placeholder="community name"
      onCreate={(name) =>
        void (async () => {
          try {
            const { communityId, channelId } = await client.createCommunity(name);
            onOpenChannel(communityId, channelId);
            onResult(`✓ created ${name} — you're in #general`);
          } catch (err) {
            onResult(`✗ ${err instanceof Error ? err.message : String(err)}`);
          }
        })()
      }
    />
  );
}
