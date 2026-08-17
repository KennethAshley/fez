import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FezClient, setStatePersistence, type Msg } from "@fez/client";
import { BrowserWire } from "./wire";
import "./App.css";

/**
 * fez-desktop — the GUI over the same headless brain as the TUI (#30).
 * Buzz's visual skeleton (left rail, timeline, composer), fez's client:
 * every trust rule, thread, presence dot, and unread badge below comes
 * from @fez/client events — this file only renders.
 */

const RELAY_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_FEZ_RELAY ?? "ws://localhost:7777";

// Browser persistence for joined/scope — the seam's localStorage impl.
setStatePersistence({
  exists: () => localStorage.getItem("fez-state") !== null,
  read: () => localStorage.getItem("fez-state") ?? undefined,
  write: (text) => localStorage.setItem("fez-state", text),
});

type Boot =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; client: FezClient; wire: BrowserWire };

function useForceRender(): () => void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  return bump;
}

export default function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    let wire: BrowserWire | undefined;
    (async () => {
      try {
        const keyHex = await invoke<string>("get_identity", {});
        wire = new BrowserWire(RELAY_URL, keyHex);
        wire.onStatus = setConnected;
        const client = new FezClient(wire);
        await client.start();
        // First run in the webview: adopt every community on the relay
        // (it's the user's own relay; the TUI's Home included). Real
        // multi-tenant onboarding comes later.
        if (client.state.joined.size === 0) {
          for (const community of await client.listCommunities()) {
            await client.joinCommunity(community.id);
          }
          const first = [...client.state.communities.values()][0];
          const channel = first ? [...first.channels.values()][0] : undefined;
          if (first && channel) client.setScope(first.id, channel.id);
        }
        const scope = client.state.scope;
        if (scope) await client.loadChannelHistory(scope.channelId, scope.communityId);
        setBoot({ phase: "ready", client, wire });
      } catch (err) {
        setBoot({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => wire?.close();
  }, []);

  if (boot.phase === "loading") return <div className="boot">connecting…</div>;
  if (boot.phase === "error") return <div className="boot error">{boot.message}</div>;
  return <Shell client={boot.client} connected={connected} />;
}

function Shell({ client, connected }: { client: FezClient; connected: boolean }) {
  const render = useForceRender();

  useEffect(() => {
    const events = [
      "message",
      "messageEdited",
      "messageDeleted",
      "metaChanged",
      "reaction",
      "channelsChanged",
      "presenceChanged",
      "unreadsChanged",
      "typingChanged",
      "notice",
    ] as const;
    for (const name of events) client.on(name, render as never);
    // FezClient listeners have no off() yet — the Shell lives for the
    // window's lifetime, so leaking on unmount is acceptable v1.
  }, [client, render]);

  const scope = client.state.scope;
  const unreads = client.unreadCounts();

  const openChannel = async (communityId: string, channelId: string) => {
    client.setScope(communityId, channelId);
    await client.loadChannelHistory(channelId, communityId);
    render();
  };

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          fez <span className={connected ? "dot on" : "dot off"} title={connected ? "relay connected" : "reconnecting…"} />
        </div>
        {[...client.state.communities.values()]
          .filter((community) => client.state.joined.has(community.id))
          .map((community) => (
            <div key={community.id} className="community">
              <div className="community-name">{community.name}</div>
              {[...community.channels.values()].map((channel) => {
                const active = scope?.channelId === channel.id;
                const unread = unreads.get(channel.id) ?? 0;
                return (
                  <button
                    key={channel.id}
                    className={active ? "channel active" : "channel"}
                    onClick={() => void openChannel(community.id, channel.id)}
                  >
                    <span className="hash">#</span> {channel.name}
                    {unread > 0 && !active && <span className="badge">{unread}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        <AgentRail client={client} />
      </aside>
      {scope ? <Timeline key={scope.channelId} client={client} channelId={scope.channelId} communityId={scope.communityId} /> : <div className="boot">no channel — join one from the rail</div>}
    </div>
  );
}

function AgentRail({ client }: { client: FezClient }) {
  const agents = useMemo(() => {
    const current = client.state.currentChannel();
    if (!current) return [] as { pk: string; name: string; online: boolean }[];
    return [...current.channel.members.keys()]
      .filter((pk) => pk !== client.pubkey)
      .map((pk) => ({ pk, name: client.displayName(pk), online: client.isOnline(pk) }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    // presenceChanged re-renders the parent, recomputing this
  }, [client, client.state.scope?.channelId, client.unreadCounts()]);

  if (agents.length === 0) return null;
  return (
    <div className="community">
      <div className="community-name">members</div>
      {agents.map((agent) => (
        <div key={agent.pk} className="member">
          <span className={agent.online ? "dot on" : "dot off"} /> {agent.name}
          {client.statusOf(agent.pk) && <span className="status">— {client.statusOf(agent.pk)}</span>}
        </div>
      ))}
    </div>
  );
}

function Timeline({ client, channelId }: { client: FezClient; channelId: string; communityId: string }) {
  const [draft, setDraft] = useState("");
  const [threadRoot, setThreadRoot] = useState<string | undefined>();
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = client.messages(channelId);
  const shown = threadRoot ? messages.filter((m) => m.id === threadRoot || m.rootId === threadRoot) : messages.filter((m) => !m.parentId);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  });

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    // @names → p tags so mentions summon agents, same as the TUI.
    const mentionPks = [...text.matchAll(/@([\w-]+)/g)]
      .map((match) => client.pkByName(match[1]))
      .filter((pk): pk is string => !!pk);
    await client.sendChannelMessage(text, { threadRootId: threadRoot, mentionPks });
  };

  const channelName = client.channelRef(channelId)?.name ?? channelId.slice(0, 8);
  const typing = client.typingWho();

  return (
    <main className="main">
      <header className="topbar">
        <span className="hash">#</span> {channelName}
        {threadRoot && (
          <button className="thread-exit" onClick={() => setThreadRoot(undefined)}>
            ← thread · back to channel
          </button>
        )}
      </header>
      <div className="timeline">
        {shown.map((msg) => (
          <Bubble
            key={msg.id}
            client={client}
            channelId={channelId}
            msg={msg}
            inThread={!!threadRoot}
            onOpenThread={() => setThreadRoot(msg.rootId ?? msg.id)}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      {typing.length > 0 && <div className="typing">{typing.join(", ")} typing…</div>}
      <div className="composer">
        <input
          value={draft}
          placeholder={threadRoot ? "reply in thread…" : `message #${channelName} — @name summons an agent`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) void send();
          }}
        />
      </div>
    </main>
  );
}

function Bubble({
  client,
  channelId,
  msg,
  inThread,
  onOpenThread,
}: {
  client: FezClient;
  channelId: string;
  msg: Msg;
  inThread: boolean;
  onOpenThread: () => void;
}) {
  const mine = msg.authorPk === client.pubkey;
  const replies = client.threadReplyCount(channelId, msg.id);
  const reactions = client.reactions(msg.id);
  const time = new Date(msg.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className={mine ? "bubble mine" : "bubble"}>
      <div className="bubble-head">
        <span className="author">{msg.authorName}</span>
        <span className="time">{time}</span>
        {msg.edited && <span className="time">edited</span>}
      </div>
      {msg.deletedBy ? (
        <div className="tombstone">⌫ removed by {msg.deletedBy === "moderator" ? "a moderator" : "its author"}</div>
      ) : (
        <div className="bubble-body">{renderMentions(msg.content)}</div>
      )}
      <div className="bubble-foot">
        {reactions &&
          [...reactions.entries()].map(([emoji, who]) => (
            <span key={emoji} className="pill" title={[...who].join(", ")}>
              {emoji} {who.size}
            </span>
          ))}
        {!inThread && replies > 0 && (
          <button className="thread-link" onClick={onOpenThread}>
            {replies} repl{replies === 1 ? "y" : "ies"} →
          </button>
        )}
        {!inThread && replies === 0 && !msg.deletedBy && (
          <button className="thread-link quiet" onClick={onOpenThread}>
            reply in thread
          </button>
        )}
      </div>
    </div>
  );
}

function renderMentions(text: string) {
  return text.split(/(@[\w-]+)/g).map((part, index) =>
    part.startsWith("@") ? (
      <span key={index} className="mention">
        {part}
      </span>
    ) : (
      <span key={index}>{part}</span>
    )
  );
}
