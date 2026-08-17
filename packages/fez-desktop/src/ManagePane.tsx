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
          <CreateCommunity client={client} onOpenChannel={onOpenChannel} onResult={flash} />
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
      </div>
    </aside>
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
