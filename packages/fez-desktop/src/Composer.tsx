import { useEffect, useMemo, useRef, useState } from "react";
import type { FezClient } from "@fez/client";
import { EMOJI, searchEmoji, type EmojiEntry } from "./emoji";
import { COMMANDS, type CommandMeta } from "./commands";

/**
 * The message composer, Buzz-shaped: multiline textarea (Enter sends,
 * Shift+Enter breaks), autocomplete for @mentions AND :emoji: tokens,
 * a full emoji picker, and drag-drop / paste file upload. Editing
 * affordances stay with the caller (↑-to-edit, esc-to-cancel arrive as
 * callbacks) — the composer only owns text entry.
 */

export interface MentionCandidate {
  name: string;
  pk: string;
}

export default function Composer({
  client,
  value,
  onChange,
  onSend,
  placeholder,
  editing,
  onArrowUpEmpty,
  onEscape,
  onFiles,
  disabled,
  commandsEnabled,
}: {
  client: FezClient;
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  placeholder: string;
  editing?: boolean;
  onArrowUpEmpty?: () => void;
  onEscape?: () => void;
  onFiles?: (files: File[]) => void;
  disabled?: boolean;
  commandsEnabled?: boolean;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [pickIndex, setPickIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [suppressed, setSuppressed] = useState(false); // esc closed the popup for this token
  const [gridOpen, setGridOpen] = useState(false);
  const [gridQuery, setGridQuery] = useState("");
  const [selection, setSelection] = useState<{ start: number; end: number }>();

  // Auto-grow: content height up to ~6 lines, then scroll.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 140)}px`;
  }, [value]);

  // The token under the caret drives the popup: /command (only at the
  // very start), @name, or :emoji:.
  const token = useMemo(() => {
    const upto = value.slice(0, caret);
    const command = /^\/([a-z]*)$/.exec(upto);
    if (command && commandsEnabled) return { type: "command" as const, partial: command[1], start: 0 };
    const mention = /(^|\s)@([\w-]*)$/.exec(upto);
    if (mention) return { type: "mention" as const, partial: mention[2], start: upto.length - mention[2].length - 1 };
    const channel = /(^|\s)#([\w-]*)$/.exec(upto);
    if (channel) return { type: "channel" as const, partial: channel[2], start: upto.length - channel[2].length - 1 };
    const emoji = /(^|\s):([a-z0-9_+-]{2,})$/.exec(upto);
    if (emoji) return { type: "emoji" as const, partial: emoji[2], start: upto.length - emoji[2].length - 1 };
    return undefined;
  }, [value, caret, commandsEnabled]);

  const mentionCandidates = useMemo(() => {
    if (token?.type !== "mention") return [];
    const seen = new Set<string>();
    const all: MentionCandidate[] = [];
    for (const [pk, name] of client.knownNames()) {
      if (pk === client.pubkey) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({ name, pk });
    }
    const partial = token.partial.toLowerCase();
    return all
      .filter((c) => c.name.toLowerCase().includes(partial))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(partial) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(partial) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name);
      })
      .slice(0, 6);
  }, [client, token]);

  const emojiCandidates = useMemo(
    () => (token?.type === "emoji" ? searchEmoji(token.partial, 8) : []),
    [token]
  );

  const channelCandidates = useMemo(() => {
    if (token?.type !== "channel") return [];
    const names = new Set<string>();
    for (const communityId of client.state.joined) {
      const community = client.state.communities.get(communityId);
      for (const channel of community?.channels.values() ?? []) names.add(channel.name);
    }
    const partial = token.partial.toLowerCase();
    return [...names]
      .filter((name) => name.toLowerCase().includes(partial))
      .sort((a, b) => Number(b.toLowerCase().startsWith(partial)) - Number(a.toLowerCase().startsWith(partial)) || a.localeCompare(b))
      .slice(0, 6);
  }, [client, token]);

  const commandCandidates = useMemo(
    () =>
      token?.type === "command"
        ? COMMANDS.filter((c) => c.name.startsWith(token.partial)).slice(0, 9)
        : [],
    [token]
  );

  const popupSize =
    token?.type === "mention"
      ? mentionCandidates.length
      : token?.type === "emoji"
        ? emojiCandidates.length
        : token?.type === "channel"
          ? channelCandidates.length
          : commandCandidates.length;

  useEffect(() => {
    setPickIndex(0);
    setSuppressed(false);
  }, [token?.partial, token?.type]);
  const popupOpen = !!token && popupSize > 0 && !suppressed;

  const replaceToken = (inserted: string) => {
    if (!token) return;
    const before = value.slice(0, token.start);
    const after = value.slice(caret);
    const next = `${before}${inserted}`;
    onChange(next + after);
    requestAnimationFrame(() => {
      const area = areaRef.current;
      if (area) {
        area.focus();
        area.selectionStart = area.selectionEnd = next.length;
        setCaret(next.length);
      }
    });
  };

  const pick = (index: number) => {
    if (token?.type === "mention") {
      const candidate = mentionCandidates[index];
      if (candidate) replaceToken(`@${candidate.name} `);
    } else if (token?.type === "emoji") {
      const candidate = emojiCandidates[index];
      if (candidate) replaceToken(candidate.char);
    } else if (token?.type === "command") {
      const candidate = commandCandidates[index];
      if (candidate) replaceToken(candidate.args ? `/${candidate.name} ` : `/${candidate.name}`);
    } else if (token?.type === "channel") {
      const candidate = channelCandidates[index];
      if (candidate) replaceToken(`#${candidate} `);
    }
  };

  /** Wrap the current selection in markdown marks (⌘B/⌘I/⌘E + the tray). */
  const wrapSelection = (mark: string) => {
    const area = areaRef.current;
    if (!area) return;
    const { selectionStart: start, selectionEnd: end } = area;
    if (start === end) return;
    const inner = value.slice(start, end);
    const already = value.slice(start - mark.length, start) === mark && value.slice(end, end + mark.length) === mark;
    const next = already
      ? value.slice(0, start - mark.length) + inner + value.slice(end + mark.length)
      : value.slice(0, start) + mark + inner + mark + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      area.focus();
      const delta = already ? -mark.length : mark.length;
      area.selectionStart = start + delta;
      area.selectionEnd = end + delta;
      setSelection({ start: start + delta, end: end + delta });
    });
  };

  const insertAtCaret = (text: string) => {
    const area = areaRef.current;
    const at = area?.selectionStart ?? value.length;
    const next = value.slice(0, at) + text;
    onChange(next + value.slice(at));
    requestAnimationFrame(() => {
      if (area) {
        area.focus();
        area.selectionStart = area.selectionEnd = next.length;
        setCaret(next.length);
      }
    });
  };

  const syncCaret = () => {
    const area = areaRef.current;
    setCaret(area?.selectionStart ?? 0);
    if (area && area.selectionStart !== area.selectionEnd) {
      setSelection({ start: area.selectionStart, end: area.selectionEnd });
    } else {
      setSelection(undefined);
    }
  };
  const gridResults = gridQuery.trim() ? searchEmoji(gridQuery.trim(), 96) : EMOJI.slice(0, 96);

  return (
    <div
      className={dragging ? "composer dragging" : "composer"}
      onDragOver={(e) => {
        if (!onFiles) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!onFiles) return;
        e.preventDefault();
        setDragging(false);
        const files = [...e.dataTransfer.files];
        if (files.length) onFiles(files);
      }}
    >
      {selection && !popupOpen && (
        <div className="format-tray">
          <button title="bold (⌘B)" onMouseDown={(e) => { e.preventDefault(); wrapSelection("**"); }}><b>B</b></button>
          <button title="italic (⌘I)" onMouseDown={(e) => { e.preventDefault(); wrapSelection("*"); }}><i>I</i></button>
          <button title="code (⌘E)" onMouseDown={(e) => { e.preventDefault(); wrapSelection("`"); }}>{"</>"}</button>
          <button title="strikethrough" onMouseDown={(e) => { e.preventDefault(); wrapSelection("~~"); }}><s>S</s></button>
        </div>
      )}
      {popupOpen && (
        <div className="mention-pop">
          {token?.type === "mention" &&
            mentionCandidates.map((candidate, index) => (
              <button
                key={candidate.pk}
                className={index === pickIndex ? "mention-item active" : "mention-item"}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep textarea focus
                  pick(index);
                }}
              >
                @{candidate.name}
                {client.isOnline(candidate.pk) && <span className="dot on" />}
              </button>
            ))}
          {token?.type === "channel" &&
            channelCandidates.map((candidate, index) => (
              <button
                key={candidate}
                className={index === pickIndex ? "mention-item active" : "mention-item"}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(index);
                }}
              >
                <span className="hash">#</span>{candidate}
              </button>
            ))}
          {token?.type === "command" &&
            commandCandidates.map((candidate: CommandMeta, index) => (
              <button
                key={candidate.name}
                className={index === pickIndex ? "mention-item cmd-item active" : "mention-item cmd-item"}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(index);
                }}
              >
                <span className="cmd-name">/{candidate.name}</span>
                {candidate.args && <span className="cmd-args">{candidate.args}</span>}
                <span className="cmd-desc">{candidate.description}</span>
              </button>
            ))}
          {token?.type === "emoji" &&
            emojiCandidates.map((candidate, index) => (
              <button
                key={candidate.name}
                className={index === pickIndex ? "mention-item active" : "mention-item"}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(index);
                }}
              >
                <span className="emoji-char">{candidate.char}</span> :{candidate.name}:
              </button>
            ))}
        </div>
      )}
      {gridOpen && (
        <div className="emoji-grid-pop">
          <input
            className="emoji-grid-search"
            value={gridQuery}
            autoFocus
            placeholder="search emoji…"
            onChange={(e) => setGridQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setGridOpen(false);
              if (e.key === "Enter" && gridResults[0]) {
                insertAtCaret(gridResults[0].char);
                setGridOpen(false);
                setGridQuery("");
              }
            }}
          />
          <div className="emoji-grid">
            {gridResults.map((entry: EmojiEntry) => (
              <button
                key={entry.name}
                title={`:${entry.name}:`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertAtCaret(entry.char);
                  setGridOpen(false);
                  setGridQuery("");
                }}
              >
                {entry.char}
              </button>
            ))}
          </div>
        </div>
      )}
      {dragging && <div className="drop-hint">drop to upload</div>}
      <div className="composer-row">
        <textarea
          ref={areaRef}
          rows={1}
          value={value}
          disabled={disabled}
          className={editing ? "editing" : undefined}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? 0);
          }}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onPaste={(e) => {
            if (!onFiles) return;
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              onFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (popupOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setPickIndex((i) => (i + 1) % popupSize);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setPickIndex((i) => (i - 1 + popupSize) % popupSize);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pick(pickIndex);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSuppressed(true);
                return;
              }
            }
            if ((e.metaKey || e.ctrlKey) && ["b", "i", "e"].includes(e.key.toLowerCase())) {
              e.preventDefault();
              wrapSelection(e.key.toLowerCase() === "b" ? "**" : e.key.toLowerCase() === "i" ? "*" : "`");
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            } else if (e.key === "ArrowUp" && !value && onArrowUpEmpty) {
              e.preventDefault();
              onArrowUpEmpty();
            } else if (e.key === "Escape") {
              if (gridOpen) setGridOpen(false);
              else onEscape?.();
            }
          }}
        />
        <button
          className="composer-tool"
          title="emoji (or type :name:)"
          onMouseDown={(e) => {
            e.preventDefault();
            setGridOpen(!gridOpen);
          }}
        >
          ☺
        </button>
      </div>
    </div>
  );
}
