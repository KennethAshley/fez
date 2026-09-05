import { useEffect, useMemo, useRef, useState } from "react";
import type { FezClient, MentionCandidate } from "@fezchat/client";
import { EMOJI, searchEmoji, type EmojiEntry } from "./emoji";
import { COMMANDS, type CommandMeta } from "./commands";
import { guiCommandMenu } from "./gui-extensions";
import { FormatBar, markdownFormatOps } from "./format-bar";
import { MentionList, rosterMatches } from "./mentions";
import { useBazaarRecords } from "./useBazaarRecords";

/**
 * The message composer, Buzz-shaped: multiline textarea (Enter sends,
 * Shift+Enter breaks), autocomplete for @mentions AND :emoji: tokens,
 * a full emoji picker, and drag-drop / paste file upload. Editing
 * affordances stay with the caller (↑-to-edit, esc-to-cancel arrive as
 * callbacks) — the composer only owns text entry.
 *
 * Mentions come from `roster` — whoever is actually in this room —
 * rather than every name the client has ever seen, and picking one
 * reports the pubkey back through `onMentionPick` so the caller can
 * pin it. Choosing a person out of a list IS the disambiguation; doing
 * a name lookup again at send time throws that answer away.
 */

export default function Composer({
  client,
  roster,
  onMentionPick,
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
  /** Who can be @mentioned here — the channel roster, or a DM's participants. */
  roster: MentionCandidate[];
  /** Fired when the sender picks someone, so the choice can be bound to a pubkey. */
  onMentionPick?: (name: string, pubkey: string) => void;
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
  // Formatting lives in ONE place. Open by default, the bar took the top
  // third of the box while Aa said the same thing below it and selecting
  // text floated the tray anyway — three controls for one job, and a
  // message field that looked like a word processor. Aa opens it and the
  // choice sticks (a returning user who turned it on keeps it on).
  const [trayOpen, setTrayOpenState] = useState(() => localStorage.getItem("fez-format-bar") === "1");
  const setTrayOpen = (open: boolean) => {
    setTrayOpenState(open);
    localStorage.setItem("fez-format-bar", open ? "1" : "0");
  };
  const fileRef = useRef<HTMLInputElement>(null);

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

  const records = useBazaarRecords(useMemo(() => roster.filter((r) => r.isMember).map((r) => r.pubkey), [roster]));
  const mentionCandidates = useMemo(
    () => (token?.type === "mention" ? rosterMatches(roster, token.partial, client.pubkey, 6, records) : []),
    [roster, client, token, records]
  );

  const emojiCandidates = useMemo(
    () => (token?.type === "emoji" ? searchEmoji(token.partial, 8) : []),
    [token]
  );

  const channelCandidates = useMemo(() => {
    if (token?.type !== "channel") return [];
    // One workspace, one flat channel list — #autocomplete never has to
    // ask which community a name came from.
    const names = new Set<string>();
    for (const channel of client.state.workspace.channels.values()) names.add(channel.name);
    const partial = token.partial.toLowerCase();
    return [...names]
      .filter((name) => name.toLowerCase().includes(partial))
      .sort((a, b) => Number(b.toLowerCase().startsWith(partial)) - Number(a.toLowerCase().startsWith(partial)) || a.localeCompare(b))
      .slice(0, 6);
  }, [client, token]);

  const commandCandidates = useMemo(
    () =>
      token?.type === "command"
        ? [...COMMANDS, ...guiCommandMenu()].filter((c) => c.name.startsWith(token.partial)).slice(0, 9)
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
      if (candidate) {
        // The pubkey is settled here, not at send.
        onMentionPick?.(candidate.name, candidate.pubkey);
        replaceToken(`@${candidate.name} `);
      }
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
  // Shared with the doc-comment box — see format-bar.tsx. These used to
  // live here, which is why only the channel had a format bar.
  const { wrapSelection, prefixLines, makeLink, codeBlock } = markdownFormatOps(
    areaRef,
    value,
    onChange,
    setSelection
  );

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
        e.stopPropagation(); // the channel view also catches drops — don't upload twice
        setDragging(false);
        const files = [...e.dataTransfer.files];
        if (files.length) onFiles(files);
      }}
    >
      <div className="composer-box">
      {(trayOpen || (selection && !popupOpen)) && (
        <FormatBar ops={{ wrapSelection, prefixLines, makeLink, codeBlock }} className={trayOpen ? "format-bar" : "format-tray"} />
      )}
      {popupOpen && (
        <div className="mention-pop">
          {token?.type === "mention" && (
            <MentionList client={client} candidates={mentionCandidates} pickIndex={pickIndex} onPick={pick} records={records} />
          )}
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
              // Auto-repeat fires keydown again while Enter is held — the
              // second landing before the cleared draft re-renders is the
              // classic double-send. Only the first press sends.
              if (!e.repeat) onSend();
            } else if (e.key === "ArrowUp" && !value && onArrowUpEmpty) {
              e.preventDefault();
              onArrowUpEmpty();
            } else if (e.key === "Escape") {
              if (gridOpen) setGridOpen(false);
              else onEscape?.();
            }
          }}
        />
      </div>
      <div className="composer-actions">
        <button className="composer-tool" title="mention someone" onMouseDown={(e) => { e.preventDefault(); insertAtCaret("@"); }}>
          @
        </button>
        {onFiles && (
          <>
            <button className="composer-tool" title="attach a file (Blossom upload)" onMouseDown={(e) => { e.preventDefault(); fileRef.current?.click(); }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "middle" }}>
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                if (files.length) onFiles(files);
                e.target.value = "";
              }}
            />
          </>
        )}
        <button className="composer-tool" title="emoji (or type :name:)" onMouseDown={(e) => { e.preventDefault(); setGridOpen(!gridOpen); }}>
          ☺
        </button>
        <button
          className={trayOpen ? "composer-tool on" : "composer-tool"}
          title="formatting (⌘B / ⌘I / ⌘E)"
          onMouseDown={(e) => { e.preventDefault(); setTrayOpen(!trayOpen); }}
        >
          Aa
        </button>
        <button className="composer-send" title="send (Enter)" disabled={disabled || !value.trim()} onClick={onSend}>
          ↑
        </button>
      </div>
      </div>
    </div>
  );
}
