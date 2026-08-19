import { useEffect, useMemo, useRef, useState } from "react";
import type { FezClient, WireEvent } from "@fez/client";
import type { BrowserWire } from "./wire";

/**
 * ⌘K search — Buzz's topbar search as a command-palette overlay. The
 * heavy lifting is fez-relay's NIP-50 (case-insensitive AND over
 * tokens); this queries messages (47103) and docs (40100) across every
 * joined channel — the same filter the TUI's /search issues. DMs never
 * appear: they're encrypted, the relay can't search them.
 */

const KIND_CHANNEL_MESSAGE = 47103;
const KIND_DOC = 40100;

interface Row {
  id: string;
  kind: number;
  channelId: string;
    channelName: string;
  author: string;
  snippet: string;
  ts: number;
}

export default function SearchOverlay({
  client,
  wire,
  initialQuery,
  onJump,
  onClose,
}: {
  client: FezClient;
  wire: BrowserWire;
  initialQuery?: string;
  onJump: (channelId: string, msgId?: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [rows, setRows] = useState<Row[] | undefined>();
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // channelId → names, for labeling hits and scoping the filter.
  const channels = useMemo(() => {
    const map = new Map<string, { name: string }>();
    for (const channel of client.state.workspace.channels.values()) {
      map.set(channel.id, { name: channel.name });
    }
    return map;
  }, [client]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setRows(undefined);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        const events = await wire.query([
          { kinds: [KIND_CHANNEL_MESSAGE, KIND_DOC], "#h": [...channels.keys()], search: trimmed, limit: 60 },
        ]);
        const mapped = events
          .map((event: WireEvent): Row | undefined => {
            const channelId = event.tags.find((t) => t[0] === "h")?.[1];
            const ref = channelId ? channels.get(channelId) : undefined;
            if (!channelId || !ref) return undefined;
            return {
              id: event.id,
              kind: event.kind,
              channelId,
              channelName: ref.name,
              author: client.displayName(event.pubkey),
              snippet: event.content.replace(/\s+/g, " ").slice(0, 140),
              ts: event.created_at,
            };
          })
          .filter((row): row is Row => !!row)
          .sort((a, b) => b.ts - a.ts);
        setRows(mapped);
        setSelected(0);
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [query, wire, channels, client]);

  const jump = (row: Row) => {
    if (row.channelId) onJump(row.channelId, row.kind === KIND_CHANNEL_MESSAGE ? row.id : undefined);
    onClose();
  };

  useEffect(() => {
    listRef.current?.querySelector(".search-row.active")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="search-box" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          placeholder="search messages and docs across your channels…"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown" && rows?.length) {
              e.preventDefault();
              setSelected((i) => (i + 1) % rows.length);
            } else if (e.key === "ArrowUp" && rows?.length) {
              e.preventDefault();
              setSelected((i) => (i - 1 + rows.length) % rows.length);
            } else if (e.key === "Enter" && rows?.[selected]) {
              jump(rows[selected]);
            }
          }}
        />
        <div className="search-results" ref={listRef}>
          {query.trim().length < 2 && <div className="pane-empty">type to search — enter jumps to the channel</div>}
          {rows?.length === 0 && <div className="pane-empty">nothing matching "{query.trim()}"</div>}
          {rows?.map((row, index) => (
            <button
              key={row.id}
              className={index === selected ? "search-row active" : "search-row"}
              onMouseEnter={() => setSelected(index)}
              onClick={() => jump(row)}
            >
              <span className="search-meta">
                {row.kind === KIND_DOC ? "≡" : "#"} {row.channelName} · {row.author} ·{" "}
                {new Date(row.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}
              </span>
              <span className="search-snippet">{row.snippet}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
