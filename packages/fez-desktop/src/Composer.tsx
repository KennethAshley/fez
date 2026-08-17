import { useEffect, useMemo, useRef, useState } from "react";
import type { FezClient } from "@fez/client";

/**
 * The message composer, Buzz-shaped: multiline textarea (Enter sends,
 * Shift+Enter breaks), @mention autocomplete over everyone the client
 * can name, and drag-drop / paste file upload. Editing affordances stay
 * with the caller (↑-to-edit, esc-to-cancel arrive as callbacks) — the
 * composer only owns text entry.
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
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [pickIndex, setPickIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [suppressed, setSuppressed] = useState(false); // esc closed the popup for this token

  // Auto-grow: content height up to ~6 lines, then scroll.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 140)}px`;
  }, [value]);

  // The @token under the caret (if any) drives the mention popup.
  const mention = useMemo(() => {
    const upto = value.slice(0, caret);
    const match = /(^|\s)@([\w-]*)$/.exec(upto);
    if (!match) return undefined;
    return { partial: match[2], start: upto.length - match[2].length - 1 };
  }, [value, caret]);

  const candidates = useMemo(() => {
    if (!mention) return [];
    const seen = new Set<string>();
    const all: MentionCandidate[] = [];
    for (const [pk, name] of client.knownNames()) {
      if (pk === client.pubkey) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({ name, pk });
    }
    const partial = mention.partial.toLowerCase();
    return all
      .filter((c) => c.name.toLowerCase().includes(partial))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(partial) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(partial) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name);
      })
      .slice(0, 6);
  }, [client, mention]);

  useEffect(() => {
    setPickIndex(0);
    setSuppressed(false);
  }, [mention?.partial]);
  const popupOpen = !!mention && candidates.length > 0 && !suppressed;

  const pick = (candidate: MentionCandidate) => {
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(caret);
    const inserted = `${before}@${candidate.name} `;
    onChange(inserted + after);
    requestAnimationFrame(() => {
      const area = areaRef.current;
      if (area) {
        area.focus();
        area.selectionStart = area.selectionEnd = inserted.length;
        setCaret(inserted.length);
      }
    });
  };

  const syncCaret = () => setCaret(areaRef.current?.selectionStart ?? 0);

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
      {popupOpen && (
        <div className="mention-pop">
          {candidates.map((candidate, index) => (
            <button
              key={candidate.pk}
              className={index === pickIndex ? "mention-item active" : "mention-item"}
              onMouseDown={(e) => {
                e.preventDefault(); // keep textarea focus
                pick(candidate);
              }}
            >
              @{candidate.name}
              {client.isOnline(candidate.pk) && <span className="dot on" />}
            </button>
          ))}
        </div>
      )}
      {dragging && <div className="drop-hint">drop to upload</div>}
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
              setPickIndex((i) => (i + 1) % candidates.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setPickIndex((i) => (i - 1 + candidates.length) % candidates.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(candidates[pickIndex]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setSuppressed(true);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          } else if (e.key === "ArrowUp" && !value && onArrowUpEmpty) {
            e.preventDefault();
            onArrowUpEmpty();
          } else if (e.key === "Escape" && onEscape) {
            onEscape();
          }
        }}
      />
    </div>
  );
}
