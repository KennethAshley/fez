import type { FezClient, MentionCandidate } from "@fezchat/client";
import { bestRow, recordScore, type RecordRow } from "./bazaar-record";

/**
 * The @mention autocomplete, shared by every place you can type one.
 *
 * It exists as its own module because there is more than one composer —
 * chat, doc comments, thread replies — and a mention that behaves
 * differently depending on which box you typed it in is a bug waiting
 * to happen. The rules live here once: offer only people in this room,
 * show the key when two of them share a name, and report the pubkey
 * back so the caller can bind it rather than look the name up again at
 * send time.
 */

export interface MentionToken {
  partial: string;
  /** Index of the "@" — where a replacement starts. */
  start: number;
}

/** The @name being typed at the caret, if that's what's under it. */
export function mentionToken(value: string, caret: number): MentionToken | undefined {
  const upto = value.slice(0, caret);
  const match = /(^|\s)@([\w-]*)$/.exec(upto);
  if (!match) return undefined;
  return { partial: match[2], start: upto.length - match[2].length - 1 };
}

/**
 * Who in the room matches what's been typed. Namesakes are all kept:
 * picking between them is the point, so collapsing them here would
 * silently make the choice for the sender.
 */
export function rosterMatches(
  roster: readonly MentionCandidate[],
  partial: string,
  selfPk: string,
  limit = 6,
  records?: Map<string, RecordRow[]>
): MentionCandidate[] {
  const wanted = partial.toLowerCase();
  // The record routes the work: judged agents rank above blank ones,
  // better records rank higher. No records loaded → plain alphabetical.
  const score = (c: MentionCandidate) => (records ? recordScore(records.get(c.pubkey) ?? []) : 0);
  return roster
    .filter((c) => c.isMember && c.pubkey !== selfPk && c.name.toLowerCase().includes(wanted))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(wanted) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(wanted) ? 0 : 1;
      return aStarts - bStarts || score(b) - score(a) || a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

/** How many candidates in view share each name — >1 means show the key. */
export function nameCounts(candidates: readonly MentionCandidate[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const key = c.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The popup rows. Rendered identically everywhere, deliberately. */
export function MentionList({
  client,
  candidates,
  pickIndex,
  onPick,
  records,
}: {
  client: FezClient;
  candidates: readonly MentionCandidate[];
  pickIndex: number;
  onPick: (index: number) => void;
  records?: Map<string, RecordRow[]>;
}) {
  const counts = nameCounts(candidates);
  return (
    <>
      {candidates.map((candidate, index) => (
        <button
          key={candidate.pubkey}
          className={index === pickIndex ? "mention-item active" : "mention-item"}
          onMouseDown={(e) => {
            e.preventDefault(); // keep textarea focus
            onPick(index);
          }}
        >
          @{candidate.name}
          {(counts.get(candidate.name.toLowerCase()) ?? 0) > 1 && (
            <span className="mention-key">{candidate.pubkey.slice(0, 8)}</span>
          )}
          {(() => {
            const top = records && bestRow(records.get(candidate.pubkey) ?? []);
            return top ? (
              <span className="mention-key">
                {top.taskType}{top.percentile !== undefined ? ` · ${top.percentile}th` : ""} · {top.count} task{top.count === 1 ? "" : "s"}
              </span>
            ) : null;
          })()}
          {client.isOnline(candidate.pubkey) && <span className="dot on" />}
        </button>
      ))}
    </>
  );
}
