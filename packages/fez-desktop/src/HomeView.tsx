import { useEffect, useMemo, useState } from "react";
import type { FezClient, WireEvent } from "@fez/client";
import type { BrowserWire } from "./wire";
import { OpenLoops } from "./LoopsView";

/**
 * Home — Buzz's HomeScreen/FeedSection, fez-shaped: a personal inbox of
 * everything addressed to YOU. Mentions ride as p-tags on 47103s, so one
 * relay query builds the feed across every joined channel; recent DM
 * conversations stack alongside. Rows jump straight to their channel or
 * conversation.
 */

const KIND_CHANNEL_MESSAGE = 47103;

interface MentionRow {
  id: string;
  channelId: string;
  communityId: string;
  channelName: string;
  author: string;
  snippet: string;
  ts: number;
}

export default function HomeView({
  client,
  wire,
  scan,
  onOpenChannel,
  onOpenDm,
}: {
  client: FezClient;
  wire: BrowserWire;
  /** Relay-scanned approval/choice events — see the note in App.tsx. */
  scan?: { msgs: WireEvent[]; answered: Set<string> };
  onOpenChannel: (communityId: string, channelId: string, msgId?: string) => void;
  onOpenDm: (convoKey: string) => void;
}) {
  const [mentions, setMentions] = useState<MentionRow[] | undefined>();

  const channels = useMemo(() => {
    const map = new Map<string, { name: string; communityId: string; communityName: string }>();
    for (const community of client.state.communities.values()) {
      if (!client.state.joined.has(community.id)) continue;
      for (const channel of community.channels.values()) {
        map.set(channel.id, { name: channel.name, communityId: community.id, communityName: community.name });
      }
    }
    return map;
  }, [client]);

  useEffect(() => {
    void (async () => {
      const events = await wire.query([{ kinds: [KIND_CHANNEL_MESSAGE], "#p": [client.pubkey], limit: 100 }]);
      const rows = events
        .map((event: WireEvent): MentionRow | undefined => {
          if (event.pubkey === client.pubkey) return undefined; // my own p-tags aren't news
          const channelId = event.tags.find((t) => t[0] === "h")?.[1];
          const ref = channelId ? channels.get(channelId) : undefined;
          if (!channelId || !ref) return undefined;
          if (!client.state.isMember(ref.communityId, channelId, event.pubkey)) return undefined;
          return {
            id: event.id,
            channelId,
            communityId: ref.communityId,
            channelName: ref.name,
            author: client.displayName(event.pubkey),
            snippet: event.content.replace(/\s+/g, " ").slice(0, 160),
            ts: event.created_at,
          };
        })
        .filter((row): row is MentionRow => !!row)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 50);
      setMentions(rows);
    })();
  }, [wire, client, channels]);

  const dms = [...client.dmConversations().entries()]
    .sort((a, b) => (b[1].msgs.at(-1)?.ts ?? 0) - (a[1].msgs.at(-1)?.ts ?? 0))
    .slice(0, 8);

  const when = (ts: number) => {
    const date = new Date(ts * 1000);
    const today = new Date().toDateString() === date.toDateString();
    return today
      ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  return (
    <main className="main">
      <header className="topbar">▤ inbox</header>
      <div className="timeline home">
        {/* Decisions first: everything else here can wait, these are
            blocking an agent right now. */}
        <OpenLoops client={client} scan={scan} onOpenMessage={onOpenChannel} />

        <div className="home-section">mentions</div>
        {!mentions && <div className="pane-empty">loading your inbox…</div>}
        {mentions?.length === 0 && (
          <div className="pane-empty">nothing addressed to you yet — @mentions from any joined channel land here</div>
        )}
        {mentions?.map((row) => (
          <button key={row.id} className="inbox-row" onClick={() => onOpenChannel(row.communityId, row.channelId, row.id)}>
            <span className="search-meta">
              # {row.channelName} · <span className="inbox-author">{row.author}</span> · {when(row.ts)}
            </span>
            <span className="search-snippet">{row.snippet}</span>
          </button>
        ))}

        <DraftsSection client={client} channels={channels} onOpenChannel={onOpenChannel} onOpenDm={onOpenDm} />

        {dms.length > 0 && (
          <>
            <div className="home-section">conversations</div>
            {dms.map(([key, convo]) => {
              const last = convo.msgs.at(-1);
              return (
                <button key={key} className="inbox-row" onClick={() => onOpenDm(key)}>
                  <span className="search-meta">
                    ✉ <span className="inbox-author">{client.dmTitle(key)}</span>
                    {last && <> · {when(last.ts)}</>}
                    {convo.unread > 0 && <span className="badge">{convo.unread}</span>}
                  </span>
                  {last && <span className="search-snippet">{last.text.replace(/\s+/g, " ").slice(0, 160)}</span>}
                </button>
              );
            })}
          </>
        )}
      </div>
    </main>
  );
}

/** Every unsent draft, from localStorage — click to resume where you left off. */
function DraftsSection({
  client,
  channels,
  onOpenChannel,
  onOpenDm,
}: {
  client: FezClient;
  channels: Map<string, { name: string; communityId: string; communityName: string }>;
  onOpenChannel: (communityId: string, channelId: string, msgId?: string) => void;
  onOpenDm: (convoKey: string) => void;
}) {
  const drafts: { label: string; text: string; open: () => void }[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)!;
    const text = localStorage.getItem(key) ?? "";
    if (!text) continue;
    if (key.startsWith("fez-draft-dm-")) {
      const convoKey = key.slice("fez-draft-dm-".length);
      drafts.push({ label: `✉ ${client.dmTitle(convoKey)}`, text, open: () => onOpenDm(convoKey) });
    } else if (key.startsWith("fez-draft-")) {
      const channelId = key.slice("fez-draft-".length);
      const ref = channels.get(channelId);
      if (ref) drafts.push({ label: `# ${ref.name}`, text, open: () => onOpenChannel(ref.communityId, channelId) });
    }
  }
  if (drafts.length === 0) return null;
  return (
    <>
      <div className="home-section">drafts</div>
      {drafts.map((draft) => (
        <button key={draft.label + draft.text.slice(0, 8)} className="inbox-row" onClick={draft.open}>
          <span className="search-meta">✎ {draft.label}</span>
          <span className="search-snippet">{draft.text.replace(/\s+/g, " ").slice(0, 160)}</span>
        </button>
      ))}
    </>
  );
}
