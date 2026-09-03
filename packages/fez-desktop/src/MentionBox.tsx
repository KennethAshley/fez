import { useEffect, useMemo, useRef, useState } from "react";
import type { FezClient, MentionCandidate } from "@fezchat/client";
import { MentionList, mentionToken, rosterMatches } from "./mentions";
import { useBazaarRecords } from "./useBazaarRecords";
import { FormatBar, markdownFormatOps } from "./format-bar";

/**
 * A textarea that knows who is in the room, and how to format.
 *
 * Doc comments are a summon path — "@researcher fix this line" hands an
 * agent the line as work — so the same guarantee chat has must hold
 * here: you pick a person, and that person is who gets tagged.
 *
 * With `format`, it also gets the channel composer's markdown toolbar,
 * from the same implementation (format-bar.tsx). The two used to differ
 * only because the toolbar happened to live inside Composer: the
 * channel had bold and lists, and the other place you write prose for
 * people and agents to read had a bare box. What stays out is the rest
 * of Composer's action row — emoji grid, uploads, slash commands —
 * which is chat furniture, not authoring.
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
  format = false,
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
  /** Show the markdown toolbar on selection, like the channel composer. */
  format?: boolean;
  className?: string;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [pickIndex, setPickIndex] = useState(0);
  const [suppressed, setSuppressed] = useState(false); // esc closed it for this token
  const [hasSelection, setHasSelection] = useState(false);

  const token = useMemo(() => mentionToken(value, caret), [value, caret]);
  const records = useBazaarRecords(useMemo(() => roster.filter((r) => r.isMember).map((r) => r.pubkey), [roster]));
  const candidates = useMemo(
    () => (token ? rosterMatches(roster, token.partial, client.pubkey, 6, records) : []),
    [roster, token, client, records]
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

  const syncCaret = () => {
    const area = areaRef.current;
    setCaret(area?.selectionStart ?? 0);
    setHasSelection(!!area && area.selectionStart !== area.selectionEnd);
  };

  const ops = markdownFormatOps(areaRef, value, onChange, (range) => setHasSelection(!!range));

  return (
    <div className={format ? "mention-box formatted" : "mention-box"}>
      {open && (
        <div className="mention-pop">
          <MentionList client={client} candidates={candidates} pickIndex={pickIndex} onPick={pick} records={records} />
        </div>
      )}
      {/* Same toolbar the channel composer uses, inside the same single
          border — a doc comment is prose other people and agents read,
          so it gets the same authoring surface. It appears on selection
          rather than always, because a two-row bar over a two-row box
          is mostly chrome. */}
      {format && hasSelection && !open && <FormatBar ops={ops} className="format-tray" />}
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
        onSelect={syncCaret}
        onBlur={() => setHasSelection(false)}
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
