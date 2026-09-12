import { useEffect, useMemo, useState } from "react";
import type { FezClient, PendingInput, WireEvent } from "@fezchat/client";
import type { BrowserWire } from "./wire";
import { OpenLoops } from "./LoopsView";
import Avatar from "./Avatar";

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
    channelName: string;
  author: string;
  /** Who wrote it — the row wears their creature, and the face is the
   * fastest way to read "who wants me" down a list of ten. */
  pk: string;
  snippet: string;
  ts: number;
}

export default function HomeView({
  client,
  wire,
  scan,
  onOpenChannel,
  onOpenDm,
  onOpenQuestion,
}: {
  client: FezClient;
  wire: BrowserWire;
  /** Relay-scanned approval/choice events — see the note in App.tsx. */
  scan?: { msgs: WireEvent[]; answered: Set<string> };
  onOpenChannel: (channelId: string, msgId?: string) => void;
  onOpenDm: (convoKey: string) => void;
  onOpenQuestion: (request: PendingInput) => void;
}) {
  const [mentions, setMentions] = useState<MentionRow[] | undefined>();

  const channels = useMemo(() => {
    const map = new Map<string, { name: string; workspaceName: string }>();
    {
      for (const channel of client.state.workspace.channels.values()) {
        map.set(channel.id, { name: channel.name, workspaceName: client.state.workspace.name });
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
          if (!client.state.isMember(event.pubkey)) return undefined;
          return {
            id: event.id,
            channelId,
            channelName: ref.name,
            author: client.displayName(event.pubkey),
            pk: event.pubkey,
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
      <header className="topbar">
        <div className="topbar-row">▤ inbox
          {client.inputHistory().length > 0 && <button className="thread-exit" onClick={() => window.dispatchEvent(new CustomEvent("fez-show-questions", { detail: { view: "history" } }))}>Question history</button>}
        </div>
      </header>
      <div className="timeline home">
        {/* Decisions first: everything else here can wait, these are
            blocking an agent right now. */}
        <OpenLoops client={client} scan={scan} onOpenMessage={onOpenChannel} onOpenQuestion={onOpenQuestion} />

        <div className="home-section">mentions</div>
        {!mentions && <div className="pane-empty">loading your inbox…</div>}
        {mentions?.length === 0 && (
          <div className="pane-empty">nothing addressed to you yet — @mentions from any joined channel land here</div>
        )}
        {/* row.id is the MESSAGE; row.channelId is where it lives.
            Passing row.id opened a "channel" whose id was an event id —
            the header rendered its first 8 hex characters as a name and
            the room came up empty, because nothing on this path checked
            that a channel id names a channel. The second argument is
            what scrolls to and highlights the message, which is why the
            signature takes one. */}
        {mentions?.map((row) => (
          <button key={row.id} className="inbox-row" onClick={() => onOpenChannel(row.channelId, row.id)}>
            <Avatar pk={row.pk} size={22} title={row.author} quip={false} />
            <span className="inbox-main">
              <span className="search-meta">
                # {row.channelName} · <span className="inbox-author">{row.author}</span> · {when(row.ts)}
              </span>
              <span className="search-snippet">{row.snippet}</span>
            </span>
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
                  {/* A group DM has no single face; it keeps the envelope. */}
                  {key.includes("+") ? (
                    <span className="inbox-glyph">✉</span>
                  ) : (
                    <Avatar pk={key} size={22} title={client.dmTitle(key)} quip={false} />
                  )}
                  <span className="inbox-main">
                    <span className="search-meta">
                      <span className="inbox-author">{client.dmTitle(key)}</span>
                      {last && <> · {when(last.ts)}</>}
                      {convo.unread > 0 && <span className="badge">{convo.unread}</span>}
                    </span>
                    {last && <span className="search-snippet">{last.text.replace(/\s+/g, " ").slice(0, 160)}</span>}
                  </span>
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
  channels: Map<string, { name: string; workspaceName: string }>;
  onOpenChannel: (channelId: string, msgId?: string) => void;
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
      if (ref) drafts.push({ label: `# ${ref.name}`, text, open: () => onOpenChannel(channelId) });
    }
  }
  if (drafts.length === 0) return null;
  return (
    <>
      <div className="home-section">drafts</div>
      {drafts.map((draft) => (
        <button key={draft.label + draft.text.slice(0, 8)} className="inbox-row" onClick={draft.open}>
          {/* A draft has no author but you — the pencil holds the column
              so the rows still line up with the mentions above. */}
          <span className="inbox-glyph">✎</span>
          <span className="inbox-main">
            <span className="search-meta">{draft.label}</span>
            <span className="search-snippet">{draft.text.replace(/\s+/g, " ").slice(0, 160)}</span>
          </span>
        </button>
      ))}
    </>
  );
}
