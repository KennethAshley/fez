import { useEffect, useState } from "react";
import type { FezClient, WireEvent } from "@fezchat/client";
import type { BrowserWire } from "./wire";
import Avatar from "./Avatar";

const KIND_MEMORY = 47210;

interface Memory {
  id: string;
  pk: string;
  author: string;
  text: string;
  ts: number;
}

/**
 * The channel's SHARED team memory, as a side pane. It's just events
 * (kind 47210, tagged with the channel), so this reads them straight off
 * the wire — no special client state. Agents write these with
 * fez_remember (the `memory` skill); people and agents alike read them
 * here. Subscribed while open, so a memory saved mid-conversation
 * appears without reopening the pane.
 */
export default function MemoryView({
  client,
  wire,
  channelId,
  channelName,
  onClose,
}: {
  client: FezClient;
  wire: BrowserWire;
  channelId?: string;
  channelName?: string;
  onClose: () => void;
}) {
  const [memories, setMemories] = useState<Memory[]>();
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!channelId) {
      setMemories([]);
      return;
    }
    let live = true;
    const toMemory = (e: WireEvent): Memory => ({
      id: e.id,
      pk: e.pubkey,
      author: client.displayName(e.pubkey),
      text: e.content,
      ts: e.created_at,
    });
    void wire
      .query([{ kinds: [KIND_MEMORY], "#h": [channelId], limit: 500 }])
      .then((events) => {
        if (!live) return;
        setMemories(events.map(toMemory).sort((a, b) => b.ts - a.ts));
      })
      .catch(() => live && setMemories([]));
    const unsub = wire.subscribe([{ kinds: [KIND_MEMORY], "#h": [channelId], since: Math.floor(Date.now() / 1000) }], (e) => {
      setMemories((prev) => (prev?.some((m) => m.id === e.id) ? prev : [toMemory(e), ...(prev ?? [])]));
    });
    return () => {
      live = false;
      unsub();
    };
  }, [channelId, client, wire]);

  const q = filter.trim().toLowerCase();
  const shown = (memories ?? []).filter((m) => !q || m.text.toLowerCase().includes(q));

  /* Agents sometimes write a pubkey prefix where a person belongs
     ("4d9a4f80 likes basketball"). The identity is knowable, so show
     it: any hex run that prefixes a known member's pk renders as their
     @name — the same resolution mentions get, at display time only
     (the signed event is untouched). */
  const renderText = (text: string) => {
    // client.pubkey explicitly: the owner reads their own facts here, and
    // the members map doesn't always carry the reader.
    const pks = [...new Set([client.pubkey, ...client.state.workspace.members.keys(), ...client.knownNames().keys()])];
    return text.split(/\b([0-9a-f]{8,64})\b/g).map((part, i) => {
      if (i % 2 === 1) {
        const pk = pks.find((p) => p.startsWith(part));
        // Your own key reads as "you", not "@You" — mid-sentence prose.
        if (pk === client.pubkey) return <span key={i} className="mention">you</span>;
        if (pk) return <span key={i} className="mention">@{client.displayName(pk)}</span>;
      }
      return part;
    });
  };

  return (
    <aside className="pane">
      <header className="pane-head">
        <span>◈ memory{channelName ? ` · #${channelName}` : ""}</span>
        <button className="pane-close" onClick={onClose}>✕</button>
      </header>
      <div className="pane-body">
        <div className="settings-hint">
          Shared team memory — durable facts saved into this channel, visible to everyone in it. An agent with the{" "}
          <code>memory</code> skill saves one when you ask it to remember something.
        </div>
        {!channelId ? (
          <div className="pane-empty">open a channel to see its memory</div>
        ) : (
          <>
            {/* A search field over three facts is a form over nothing —
                it appears once there's enough here to actually search. */}
            {((memories?.length ?? 0) > 4 || filter) && (
              <input
                className="manage-input"
                placeholder="search memory…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            )}
            {memories === undefined ? (
              <div className="pane-empty">loading…</div>
            ) : shown.length === 0 ? (
              <div className="pane-empty">
                {q ? `nothing matches "${filter}"` : "nothing remembered yet — ask an agent to remember something and it lands here"}
              </div>
            ) : (
              shown.map((m) => (
                <div key={m.id} className="memory-row">
                  <div className="memory-text">{renderText(m.text)}</div>
                  <div className="memory-meta">
                    <Avatar pk={m.pk} size={14} title={m.author} />
                    @{m.author}
                    <span className="memory-when">
                      {new Date(m.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}
                    </span>
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </aside>
  );
}
