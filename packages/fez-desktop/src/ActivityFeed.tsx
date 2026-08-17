import type { ObserverEntry } from "@fez/client";

/**
 * Renderer for an agent's observer frames — turn markers, tool lines,
 * dim thoughts, reply text. Shared by the watch pane and the agents
 * pane so both windows into an agent look identical.
 */
export default function ActivityFeed({ entries, emptyNote }: { entries: ObserverEntry[]; emptyNote: string }) {
  if (entries.length === 0) return <div className="pane-empty">{emptyNote}</div>;
  return (
    <>
      {entries.map((entry, index) => {
        if (entry.type === "turn") {
          return (
            <div key={index} className={`turn-marker ${entry.status ?? ""}`}>
              — turn {entry.status} —
            </div>
          );
        }
        if (entry.type === "tool") {
          return (
            <div key={index} className="tool-line">
              ⚙ {entry.title ?? "tool"} {entry.status && <span className="time">{entry.status}</span>}
            </div>
          );
        }
        if (entry.type === "thought") {
          return <div key={index} className="thought">{entry.text?.slice(-400)}</div>;
        }
        if (entry.type === "text") {
          return <div key={index} className="reply-preview">{entry.text?.slice(-400)}</div>;
        }
        return null;
      })}
    </>
  );
}
