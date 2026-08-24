import { useEffect, useState } from "react";
import { parseQuery, describeQuery, type FezClient, type QueryRow as Row } from "@fezchat/client";

/**
 * ```fez:query``` — a question in a document, answered from the relay.
 *
 * Notion's databases require you to file work into them first. Here the
 * records already exist because someone did the work: a task got ticked,
 * an agent asked for approval, a turn cost money. This block only
 * gathers them. Nothing is created, nothing has to be maintained, and a
 * client that has never heard of fez still shows the question in plain
 * words — which is why the source is a sentence rather than a syntax.
 */

export default function QueryBlock({
  client,
  source,
}: {
  client: FezClient;
  source: string;
  /**
   * Which communities to search. A block inside a page asks about ITS
   * community; the ask bar with no page open asks about all of them —
   * defaulting to "the first joined" silently returned nothing when the
   * answer was one community over, which reads as "the feature is
   * broken" rather than "wrong scope".
   */
}) {
  const query = parseQuery(source);
  const [rows, setRows] = useState<Row[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    const run = async () => {
      try {
        // One workspace, one query — the relay is the scope.
        const result = (await client.runQuery(query)).sort((a, b) => b.ts - a.ts).slice(0, query.limit);
        if (live) setRows(result);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void run();
    const timer = setInterval(() => void run(), 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const grouped = new Map<string, Row[]>();
  for (const row of rows ?? []) {
    const key = query.groupBy ? row.group : "";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }

  return (
    <div className="query-block">
      <div className="query-head">
        <span className="query-count">
          {rows ? `${rows.length}` : "…"} {query.source}
        </span>
        <span className="query-desc">
          {describeQuery(query)}
        </span>
        {query.unknown.length > 0 && (
          <span className="query-unknown" title="these words were ignored">
            ⚠ ignored: {query.unknown.join(", ")}
          </span>
        )}
      </div>

      {error && <div className="query-empty">couldn&apos;t run that: {error}</div>}
      {rows && rows.length === 0 && !error && <div className="query-empty">nothing matches.</div>}

      {query.view === "board" ? (
        <div className="query-board">
          {[...grouped.entries()].map(([group, items]) => (
            <div key={group} className="query-column">
              <div className="query-column-head">{group || "all"} · {items.length}</div>
              {items.map((row) => (
                <div key={row.id} className="query-card">
                  {row.title}
                  {row.who && <span className="query-who">@{row.who}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        [...grouped.entries()].map(([group, items]) => (
          <div key={group} className="query-group">
            {group && <div className="query-group-head">{group}</div>}
            {items.map((row) => (
              <div key={row.id} className="query-row">
                {row.done !== undefined && <span className="query-mark">{row.done ? "☑" : "☐"}</span>}
                <span className={row.done ? "query-title done" : "query-title"}>{row.title}</span>
                {row.who && <span className="query-who">@{row.who}</span>}
                {row.meta && <span className="query-meta">{row.meta}</span>}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
