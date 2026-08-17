import { useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FezClient, setStatePersistence, type Msg, type ObserverEntry } from "@fez/client";
import { BrowserWire } from "./wire";
import Onboarding from "./Onboarding";
import "./App.css";

/**
 * fez-desktop — the GUI over the same headless brain as the TUI (#30).
 * Buzz's visual skeleton (left rail, timeline, right pane), fez's
 * client: every trust rule, thread, presence dot, unread badge, DM, and
 * observer frame below comes from @fez/client — this file only renders.
 */

const RELAY_URL =
  (import.meta as { env?: Record<string, string> }).env?.VITE_FEZ_RELAY ??
  localStorage.getItem("fez-relay") ??
  "ws://localhost:7777";
/** Keychain account — override with VITE_FEZ_ACCOUNT=demo to walk onboarding as a fresh user without touching your real identity. */
const ACCOUNT = (import.meta as { env?: Record<string, string> }).env?.VITE_FEZ_ACCOUNT ?? "default";
const KIND_TURN_METRIC = 47030;
const KIND_OBSERVER_CONTROL = 20005;

setStatePersistence({
  exists: () => localStorage.getItem("fez-state") !== null,
  read: () => localStorage.getItem("fez-state") ?? undefined,
  write: (text) => localStorage.setItem("fez-state", text),
});

type Boot =
  | { phase: "loading" }
  | { phase: "onboarding" }
  | { phase: "error"; message: string }
  | { phase: "ready"; client: FezClient; wire: BrowserWire };

type MainView = { kind: "channel" } | { kind: "dm"; convoKey: string };
type SidePane = { kind: "watch"; agent: string } | { kind: "costs" } | undefined;

function useForceRender(): () => void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  return bump;
}

/**
 * Boot is a MODULE-LEVEL singleton: React StrictMode double-mounts and
 * Fast-Refresh remounts re-run effects, and the first version of this
 * closed the live wire on every remount — a wedged socket with silent
 * send failures (found the hard way: messages typed into the dev window
 * evaporated). One wire + one client per page lifetime; remounts reuse.
 */
let bootPromise: Promise<{ client: FezClient; wire: BrowserWire }> | undefined;

function bootOnce(): Promise<{ client: FezClient; wire: BrowserWire }> {
  bootPromise ??= (async () => {
    const keyHex = await invoke<string>("get_identity", { account: ACCOUNT });
    const relayUrl = localStorage.getItem("fez-relay") ?? RELAY_URL;
    const wire = new BrowserWire(relayUrl, keyHex);
    const client = new FezClient(wire);
    await client.start();
    if (client.state.joined.size === 0) {
      for (const community of await client.listCommunities()) {
        await client.joinCommunity(community.id);
      }
      // Default scope: the LIVELIEST channel we're a member of — not map
      // order, which landed users in stale one-person rooms (found live:
      // three mentions shouted into an empty ghost town).
      let best: { communityId: string; channelId: string; members: number } | undefined;
      for (const community of client.state.communities.values()) {
        for (const channel of community.channels.values()) {
          if (!channel.members.has(client.pubkey)) continue;
          if (!best || channel.members.size > best.members) {
            best = { communityId: community.id, channelId: channel.id, members: channel.members.size };
          }
        }
      }
      if (best) client.setScope(best.communityId, best.channelId);
    }
    const scope = client.state.scope;
    if (scope) await client.loadChannelHistory(scope.channelId, scope.communityId);
    return { client, wire };
  })();
  bootPromise.catch(() => {
    bootPromise = undefined; // a failed boot may retry (e.g. after onboarding)
  });
  return bootPromise;
}

export default function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  const [connected, setConnected] = useState(true);
  const [bootNonce, setBootNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void bootOnce()
      .then(({ client, wire }) => {
        if (cancelled) return;
        wire.onStatus = setConnected;
        setBoot({ phase: "ready", client, wire });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        // No keychain identity = a NEW USER, not an error — onboarding.
        if (/no fez identity/i.test(message)) setBoot({ phase: "onboarding" });
        else setBoot({ phase: "error", message });
      });
    return () => {
      cancelled = true; // never close the singleton wire on remount
    };
  }, [bootNonce]);

  if (boot.phase === "loading") return <div className="boot">connecting…</div>;
  if (boot.phase === "onboarding") {
    return (
      <Onboarding
        onComplete={(relayUrl) => {
          localStorage.setItem("fez-relay", relayUrl);
          setBoot({ phase: "loading" });
          setBootNonce((n) => n + 1); // re-run the boot effect with the new identity
        }}
      />
    );
  }
  if (boot.phase === "error") return <div className="boot error">{boot.message}</div>;
  return <Shell client={boot.client} wire={boot.wire} connected={connected} />;
}

function Shell({ client, wire, connected }: { client: FezClient; wire: BrowserWire; connected: boolean }) {
  const render = useForceRender();
  const [view, setView] = useState<MainView>({ kind: "channel" });
  const [pane, setPane] = useState<SidePane>();
  const [banner, setBanner] = useState<string>();
  useEffect(() => {
    wire.onError = (message) => {
      setBanner(message);
      setTimeout(() => setBanner(undefined), 6000);
    };
  }, [wire]);
  // Rolling observer activity per agent — the client emits frames; the
  // GUI keeps the last 200 per agent for the watch pane.
  const activityRef = useRef(new Map<string, ObserverEntry[]>());

  useEffect(() => {
    const events = [
      "message", "messageEdited", "messageDeleted", "metaChanged", "reaction",
      "channelsChanged", "presenceChanged", "unreadsChanged", "typingChanged",
      "dmMessage", "jobsChanged", "notice",
    ] as const;
    for (const name of events) client.on(name, render as never);
    client.on("observerFrame", ((agent: string, frame: ObserverEntry) => {
      const list = activityRef.current.get(agent) ?? [];
      list.push(frame);
      if (list.length > 200) list.splice(0, list.length - 200);
      activityRef.current.set(agent, list);
      render();
    }) as never);
  }, [client, render]);

  const scope = client.state.scope;
  const unreads = client.unreadCounts();
  const working = client.workingAgents();

  const openChannel = async (communityId: string, channelId: string) => {
    client.setScope(communityId, channelId);
    setView({ kind: "channel" });
    await client.loadChannelHistory(channelId, communityId);
    render();
  };

  const openDm = (convoKey: string) => {
    client.markDmRead(convoKey);
    setView({ kind: "dm", convoKey });
    render();
  };

  const cancelAgent = async (agentName: string) => {
    const pk = client.pkByName(agentName);
    if (!pk) return;
    await wire.publish({
      kind: KIND_OBSERVER_CONTROL,
      tags: [["p", pk]],
      content: wire.encrypt(pk, JSON.stringify({ cmd: "cancel", ts: Date.now() })),
    });
  };

  const dmConvos = [...client.dmConversations().entries()].sort(
    (a, b) => (b[1].msgs.at(-1)?.ts ?? 0) - (a[1].msgs.at(-1)?.ts ?? 0)
  );

  // Leave uses a two-click confirm (webview dialogs are ugly): first ×
  // arms it, the second click within 4s commits.
  const [armedLeave, setArmedLeave] = useState<string>();
  const leaveCommunity = (communityId: string) => {
    if (armedLeave !== communityId) {
      setArmedLeave(communityId);
      setTimeout(() => setArmedLeave((current) => (current === communityId ? undefined : current)), 4000);
      return;
    }
    setArmedLeave(undefined);
    client.leaveCommunity(communityId);
    // If we just left the room we were in, hop to the liveliest remaining.
    if (!client.state.scope) {
      let best: { communityId: string; channelId: string; members: number } | undefined;
      for (const community of client.state.communities.values()) {
        if (!client.state.joined.has(community.id)) continue;
        for (const channel of community.channels.values()) {
          if (!channel.members.has(client.pubkey)) continue;
          if (!best || channel.members.size > best.members) {
            best = { communityId: community.id, channelId: channel.id, members: channel.members.size };
          }
        }
      }
      if (best) void openChannel(best.communityId, best.channelId);
    }
    render();
  };

  return (
    <div className="shell">
      {!connected && <div className="conn-bar">relay disconnected — reconnecting…</div>}
      {banner && <div className="conn-bar error">{banner}</div>}
      <aside className="rail">
        <div className="brand">
          fez <span className={connected ? "dot on" : "dot off"} title={connected ? "relay connected" : "reconnecting…"} />
          <button className="rail-tool" title="agent costs" onClick={() => setPane(pane?.kind === "costs" ? undefined : { kind: "costs" })}>
            $
          </button>
        </div>
        {[...client.state.communities.values()]
          .filter((community) => client.state.joined.has(community.id))
          .map((community, _index, joined) => (
            <div key={community.id} className="community">
              <div className="community-name">
                {community.name}
                {joined.filter((other) => other.name === community.name).length > 1 && (
                  <span className="community-id"> ·{community.id.slice(0, 4)}</span>
                )}
                <button
                  className={armedLeave === community.id ? "leave armed" : "leave"}
                  title={armedLeave === community.id ? "click again to leave" : `leave ${community.name} (local — rejoin anytime)`}
                  onClick={() => leaveCommunity(community.id)}
                >
                  {armedLeave === community.id ? "leave?" : "×"}
                </button>
              </div>
              {[...community.channels.values()].map((channel) => {
                const active = view.kind === "channel" && scope?.channelId === channel.id;
                const unread = unreads.get(channel.id) ?? 0;
                return (
                  <button
                    key={channel.id}
                    className={active ? "channel active" : "channel"}
                    title={`${channel.members.size} member${channel.members.size === 1 ? "" : "s"}`}
                    onClick={() => void openChannel(community.id, channel.id)}
                  >
                    <span className="hash">#</span> {channel.name}
                    {channel.members.size <= 1 && <span className="ghost" title="nobody else is in this channel">∅</span>}
                    {unread > 0 && !active && <span className="badge">{unread}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        {dmConvos.length > 0 && (
          <div className="community">
            <div className="community-name">dms</div>
            {dmConvos.slice(0, 10).map(([key, convo]) => {
              const group = key.includes("+");
              const active = view.kind === "dm" && view.convoKey === key;
              return (
                <button key={key} className={active ? "channel active" : "channel"} onClick={() => openDm(key)}>
                  {group ? "👥" : <span className={client.isOnline(key) ? "dot on" : "dot off"} />} {client.dmTitle(key)}
                  {convo.unread > 0 && !active && <span className="badge">{convo.unread}</span>}
                </button>
              );
            })}
          </div>
        )}
        <MemberRail
          client={client}
          working={working}
          onWatch={(agent) => setPane(pane?.kind === "watch" && pane.agent === agent ? undefined : { kind: "watch", agent })}
        />
      </aside>

      {view.kind === "channel" && scope && <ChannelView key={scope.channelId} client={client} channelId={scope.channelId} />}
      {view.kind === "dm" && <DmView key={view.convoKey} client={client} convoKey={view.convoKey} />}
      {view.kind === "channel" && !scope && <div className="boot">no channel — pick one from the rail</div>}

      {pane?.kind === "watch" && (
        <WatchPane
          agent={pane.agent}
          entries={activityRef.current.get(pane.agent) ?? []}
          working={working.has(pane.agent)}
          onCancel={() => void cancelAgent(pane.agent)}
          onClose={() => setPane(undefined)}
        />
      )}
      {pane?.kind === "costs" && <CostsPane client={client} wire={wire} onClose={() => setPane(undefined)} />}
    </div>
  );
}

function MemberRail({
  client,
  working,
  onWatch,
}: {
  client: FezClient;
  working: ReadonlyMap<string, { activity: string; ts: number }>;
  onWatch: (agent: string) => void;
}) {
  const current = client.state.currentChannel();
  if (!current) return null;
  const members = [...current.channel.members.keys()]
    .filter((pk) => pk !== client.pubkey)
    .map((pk) => ({ pk, name: client.displayName(pk), online: client.isOnline(pk) }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  if (members.length === 0) return null;
  return (
    <div className="community">
      <div className="community-name">members</div>
      {members.map((member) => {
        const activity = working.get(member.name);
        const busy = activity && Date.now() - activity.ts < 30_000;
        return (
          <button key={member.pk} className="channel member-row" title={busy ? activity.activity : "open live activity"} onClick={() => onWatch(member.name)}>
            <span className={member.online ? "dot on" : "dot off"} /> {member.name}
            {busy && <span className="working">⚙</span>}
            {client.statusOf(member.pk) && <span className="status">{client.statusOf(member.pk)}</span>}
          </button>
        );
      })}
    </div>
  );
}

function ChannelView({ client, channelId }: { client: FezClient; channelId: string }) {
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
          <button className="thread-exit" onClick={() => setThreadRoot(undefined)}>← back to channel</button>
        )}
      </header>
      <div className="timeline">
        {(client.state.currentChannel()?.channel.members.size ?? 0) <= 1 && (
          <div className="empty-room">
            Nobody else is in this channel — agents can't hear you here. Pick a channel without the ∅ mark, or /invite members from the TUI.
          </div>
        )}
        {shown.map((msg) => (
          <Bubble key={msg.id} client={client} channelId={channelId} msg={msg} inThread={!!threadRoot} onOpenThread={() => setThreadRoot(msg.rootId ?? msg.id)} />
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

function DmView({ client, convoKey }: { client: FezClient; convoKey: string }) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const convo = client.dmConversations().get(convoKey);
  const group = convoKey.includes("+");
  const peers = client.dmPeers(convoKey);

  useEffect(() => {
    client.markDmRead(convoKey);
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  });

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (group) await client.sendGroupDm(peers, text);
    else await client.sendDm(convoKey, text);
  };

  return (
    <main className="main">
      <header className="topbar">
        ✉ {group && "👥 "}
        {client.dmTitle(convoKey)}
        <span className="dm-note">end-to-end encrypted{group ? " · every participant sees every message" : ""}</span>
      </header>
      <div className="timeline">
        {(convo?.msgs ?? []).map((msg) => {
          const mine = msg.senderPk === client.pubkey;
          return (
            <div key={msg.id} className={mine ? "bubble mine" : "bubble"}>
              <div className="bubble-head">
                <span className="author">{client.displayName(msg.senderPk)}</span>
                <span className="time">{new Date(msg.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <div className="bubble-body">{renderMentions(msg.text)}</div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <div className="composer">
        <input
          value={draft}
          placeholder={`message ${client.dmTitle(convoKey)} — encrypted`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) void send();
          }}
        />
      </div>
    </main>
  );
}

function WatchPane({
  agent,
  entries,
  working,
  onCancel,
  onClose,
}: {
  agent: string;
  entries: ObserverEntry[];
  working: boolean;
  onCancel: () => void;
  onClose: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  });
  return (
    <aside className="pane">
      <header className="pane-head">
        <span>⚙ watching @{agent}</span>
        <div className="pane-actions">
          {working && (
            <button className="cancel" title="abort the in-flight turn (owner-signed)" onClick={onCancel}>⏹ cancel turn</button>
          )}
          <button className="pane-close" onClick={onClose}>✕</button>
        </div>
      </header>
      <div className="pane-body">
        {entries.length === 0 && <div className="pane-empty">no activity yet — frames stream here while @{agent} works (encrypted to you)</div>}
        {entries.map((entry, index) => {
          if (entry.type === "turn") {
            return <div key={index} className={`turn-marker ${entry.status ?? ""}`}>— turn {entry.status} —</div>;
          }
          if (entry.type === "tool") {
            return (
              <div key={index} className="tool-line">
                ⚙ {entry.title ?? "tool"} {entry.status && <span className="time">{entry.status}</span>}
              </div>
            );
          }
          if (entry.type === "thought") {
            return <div key={index} className="thought">{entry.text?.slice(-400)}</div>;
          }
          if (entry.type === "text") {
            return <div key={index} className="reply-preview">{entry.text?.slice(-400)}</div>;
          }
          return null;
        })}
        <div ref={bottomRef} />
      </div>
    </aside>
  );
}

interface MetricRow {
  agent: string;
  turns: number;
  done: number;
  failed: number;
  cancelled: number;
  ms: number;
  recent: number;
}

function CostsPane({ client, wire, onClose }: { client: FezClient; wire: BrowserWire; onClose: () => void }) {
  const [rows, setRows] = useState<MetricRow[] | undefined>();

  useEffect(() => {
    void (async () => {
      const events = await wire.query([{ kinds: [KIND_TURN_METRIC], "#p": [client.pubkey], limit: 500 }]);
      const byAgent = new Map<string, MetricRow>();
      const dayAgo = Date.now() - 24 * 3600_000;
      for (const event of events) {
        try {
          const metric = JSON.parse(wire.decrypt(event.pubkey, event.content)) as {
            agent?: string;
            status?: string;
            durationMs?: number;
            ts?: number;
          };
          const agent = metric.agent ?? "?";
          let row = byAgent.get(agent);
          if (!row) byAgent.set(agent, (row = { agent, turns: 0, done: 0, failed: 0, cancelled: 0, ms: 0, recent: 0 }));
          row.turns++;
          if (metric.status === "done") row.done++;
          else if (metric.status === "failed") row.failed++;
          else if (metric.status === "cancelled") row.cancelled++;
          row.ms += metric.durationMs ?? 0;
          if ((metric.ts ?? 0) >= dayAgo) row.recent++;
        } catch { /* not addressed to us */ }
      }
      setRows([...byAgent.values()].sort((a, b) => b.turns - a.turns));
    })();
  }, [client, wire]);

  return (
    <aside className="pane">
      <header className="pane-head">
        <span>$ turn costs</span>
        <button className="pane-close" onClick={onClose}>✕</button>
      </header>
      <div className="pane-body">
        {!rows && <div className="pane-empty">decrypting…</div>}
        {rows?.length === 0 && <div className="pane-empty">no turn metrics yet — they accrue as your agents run</div>}
        {rows?.map((row) => (
          <div key={row.agent} className="cost-row">
            <div className="cost-agent">@{row.agent}</div>
            <div className="cost-detail">{row.turns} turns · {row.done} ok · {row.failed} failed · {row.cancelled} cancelled</div>
            <div className="cost-detail">{(row.ms / 60_000).toFixed(1)} min compute · {row.recent} in last 24h</div>
          </div>
        ))}
      </div>
    </aside>
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
