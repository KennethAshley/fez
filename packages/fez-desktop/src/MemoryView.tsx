import { useEffect, useState } from "react";
import type { FezClient } from "@fezchat/client";
import type { BrowserWire } from "./wire";

const KIND_MEMORY = 47210;

interface Memory {
  id: string;
  author: string;
  text: string;
  ts: number;
}

/**
 * The channel's SHARED team memory, as a side pane. It's just events
 * (kind 47210, tagged with the channel), so this reads them straight off
 * the wire — no special client state. Agents write these with
 * fez_remember; people and agents alike read them here.
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
    void wire
      .query([{ kinds: [KIND_MEMORY], "#h": [channelId], limit: 500 }])
      .then((events) => {
        if (!live) return;
        setMemories(
          events
            .map((e) => ({ id: e.id, author: client.displayName(e.pubkey), text: e.content, ts: e.created_at }))
            .sort((a, b) => b.ts - a.ts)
        );
      })
      .catch(() => live && setMemories([]));
    return () => {
      live = false;
    };
  }, [channelId, client, wire]);

  const q = filter.trim().toLowerCase();
  const shown = (memories ?? []).filter((m) => !q || m.text.toLowerCase().includes(q));

  return (
    <aside className="pane">
      <header className="pane-head">
        <span>🧠 memory{channelName ? ` · #${channelName}` : ""}</span>
        <button className="pane-close" onClick={onClose}>✕</button>
      </header>
      <div className="pane-body">
        <div className="settings-hint">
          Shared team memory — durable facts anyone (or any agent) in this channel saved. Agents write these with{" "}
          <code>fez_remember</code>; ask @fez to remember something and it shows up here.
        </div>
        {!channelId ? (
          <div className="pane-empty">open a channel to see its memory</div>
        ) : (
          <>
            <input
              className="env-input"
              placeholder="search memory…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            {memories === undefined ? (
              <div className="pane-empty">loading…</div>
            ) : shown.length === 0 ? (
              <div className="pane-empty">
                {q ? `nothing matches "${filter}"` : "no team memory yet — ask @fez to remember something, or an agent saves it with fez_remember"}
              </div>
            ) : (
              shown.map((m) => (
                <div key={m.id} className="memory-row">
                  <div className="memory-text">{m.text}</div>
                  <div className="memory-meta">
                    @{m.author} · {new Date(m.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}
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
