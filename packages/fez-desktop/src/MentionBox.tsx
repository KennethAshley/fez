import { useEffect, useMemo, useRef, useState } from "react";
import type { FezClient, MentionCandidate } from "@fez/client";
import { MentionList, mentionToken, rosterMatches } from "./mentions";

/**
 * A plain textarea that knows who is in the room.
 *
 * Doc comments are a summon path — "@researcher fix this line" hands an
 * agent the line as work — so the same guarantee chat has must hold
 * here: you pick a person, and that person is who gets tagged. The full
 * Composer would drag a format bar, emoji grid and upload button into a
 * two-row comment box, so this is the mention half on its own.
 */

export default function MentionBox({
  client,
  roster,
  value,
  onChange,
  onMentionPick,
  onSubmit,
  onEscape,
  placeholder,
  autoFocus,
  rows = 2,
  className = "manage-input comment-input",
}: {
  client: FezClient;
  /** Who can be mentioned here — the roster of the doc's channel. */
  roster: MentionCandidate[];
  value: string;
  onChange: (next: string) => void;
  /** The sender chose someone: bind this name to this pubkey. */
  onMentionPick?: (name: string, pubkey: string) => void;
  onSubmit: () => void;
  onEscape?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  rows?: number;
  className?: string;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [pickIndex, setPickIndex] = useState(0);
  const [suppressed, setSuppressed] = useState(false); // esc closed it for this token

  const token = useMemo(() => mentionToken(value, caret), [value, caret]);
  const candidates = useMemo(
    () => (token ? rosterMatches(roster, token.partial, client.pubkey) : []),
    [roster, token, client]
  );

  useEffect(() => {
    setPickIndex(0);
    setSuppressed(false);
  }, [token?.partial]);

  const open = !!token && candidates.length > 0 && !suppressed;

  const pick = (index: number) => {
    const candidate = candidates[index];
    if (!token || !candidate) return;
    onMentionPick?.(candidate.name, candidate.pubkey);
    const next = `${value.slice(0, token.start)}@${candidate.name} `;
    onChange(next + value.slice(caret));
    requestAnimationFrame(() => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.selectionStart = area.selectionEnd = next.length;
      setCaret(next.length);
    });
  };

  const syncCaret = () => setCaret(areaRef.current?.selectionStart ?? 0);

  return (
    <div className="mention-box">
      {open && (
        <div className="mention-pop">
          <MentionList client={client} candidates={candidates} pickIndex={pickIndex} onPick={pick} />
        </div>
      )}
      <textarea
        ref={areaRef}
        className={className}
        value={value}
        rows={rows}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? 0);
        }}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onKeyDown={(e) => {
          if (open) {
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
              pick(pickIndex);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setSuppressed(true); // close the popup, keep the comment
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "Escape") {
            onEscape?.();
          }
        }}
      />
    </div>
  );
}
