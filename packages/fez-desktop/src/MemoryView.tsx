import { useEffect, useState } from "react";
import { K, readTeamMemory, teamMemoryHeads, type FezClient } from "@fezchat/client";
import type { BrowserWire } from "./wire";
import Avatar from "./Avatar";

interface Memory {
  id: string;
  pk: string;
  author: string;
  text: string;
  ts: number;
}

/**
 * The channel's shared memory, using the same trust and correction fold
 * as the agent tools. Live memory and governance events refresh the pane
 * so corrections, bans, and moderator removals appear while it is open.
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
  const [error, setError] = useState<string>();
  const [windowed, setWindowed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setMemories(undefined);
    setError(undefined);
    setWindowed(false);
    if (!channelId) {
      setMemories([]);
      return;
    }
    let live = true;
    let generation = 0;
    const load = async () => {
      const request = ++generation;
      try {
        const context = await readTeamMemory(wire, client.state.workspace.owner, channelId, client.pubkey);
        if (!live || request !== generation) return;
        setMemories([...teamMemoryHeads(context.events, channelId, context.state)]
          .filter(([, e]) => e.content.trim())
          .map(([id, e]) => ({ id, pk: e.pubkey, author: client.displayName(e.pubkey), text: e.content, ts: e.created_at }))
          .sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id)));
        setWindowed(context.windowed);
        setError(undefined);
      } catch (err) {
        if (!live || request !== generation) return;
        setMemories(undefined);
        setError(err instanceof Error ? err.message : "Could not load team memory. Retry.");
      }
    };
    const unsub = wire.subscribe([
      { kinds: [K.MEMORY, K.MEMORY_UPDATE], "#h": [channelId], since: Math.floor(Date.now() / 1000) },
      { kinds: [K.MEMBERSHIP, K.BAN_LIST, K.CHANNEL], since: Math.floor(Date.now() / 1000) },
    ], () => { void load(); });
    void load();
    return () => {
      live = false;
      unsub();
    };
  }, [channelId, client, wire, retry]);

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
        <button className="pane-close" aria-label="Close memory" onClick={onClose}>✕</button>
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
                aria-label="Search memory"
                placeholder="search memory…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            )}
            {windowed && <div className="settings-hint">Showing the newest 500 memory events per relay. Older facts may exist.</div>}
            {error ? (
              <div role="alert" className="pane-empty">{error} <button className="agent-action" onClick={() => setRetry(n => n + 1)}>Retry</button></div>
            ) : memories === undefined ? (
              <div className="pane-empty">loading…</div>
            ) : shown.length === 0 ? (
              <div className="pane-empty">
                {q ? `nothing matches "${filter}" in the loaded memory` : "no current facts in the loaded memory — ask an agent to remember something"}
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
