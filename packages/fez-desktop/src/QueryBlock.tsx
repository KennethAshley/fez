import { useEffect, useState } from "react";
import { parseQuery, describeQuery, taskKey, type FezClient, type Query, type WireEvent } from "@fez/client";

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

interface Row {
  id: string;
  title: string;
  group: string;
  done?: boolean;
  who?: string;
  ts: number;
  meta?: string;
}

export default function QueryBlock({
  client,
  source,
  communityIds,
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
  communityIds: string[];
}) {
  const query = parseQuery(source);
  const [rows, setRows] = useState<Row[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    const run = async () => {
      try {
        const perCommunity = await Promise.all(communityIds.map((id) => gather(client, query, id)));
        const result = perCommunity.flat().sort((a, b) => b.ts - a.ts).slice(0, query.limit);
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
  }, [source, communityIds.join(",")]);

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
          {communityIds.length > 1 && ` · ${communityIds.length} communities`}
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

/** Run the query against the relay. Each source is a couple of filters. */
async function gather(client: FezClient, query: Query, communityId: string): Promise<Row[]> {
  const since = query.sinceDays ? Math.floor(Date.now() / 1000) - query.sinceDays * 86400 : undefined;
  const wire = (client as unknown as { wire: { query(filters: object[]): Promise<WireEvent[]> } }).wire;

  if (query.source === "tasks") {
    // Tasks live in two places: the checkbox LINE in a page (the text)
    // and the tick EVENT (the state). Read the pages for the items, the
    // events for what's done — an unticked task has no event at all.
    const pages = [...client.wikiDocs().values()].filter((page) => page.communityId === communityId);
    const channelDocs = [...client.docsByChannel().entries()]
      .map(([channelId, info]) => ({ channelId, info, ref: client.channelRef(channelId) }))
      .filter((doc) => doc.ref?.communityId === communityId);

    const states = new Map<string, { done: boolean; byPk: string }>();
    for (const page of pages) {
      for (const [key, state] of await client.docTasks(communityId, { slug: page.slug })) states.set(key, state);
    }
    for (const doc of channelDocs) {
      for (const [key, state] of await client.docTasks(communityId, { channelId: doc.channelId })) {
        states.set(key, state);
      }
    }

    const rows: Row[] = [];
    const collect = (content: string, where: string, ts: number) => {
      for (const line of content.split("\n")) {
        const match = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
        if (!match) continue;
        const text = match[2].trim();
        const state = states.get(taskKey(text));
        const done = state?.done ?? match[1].toLowerCase() === "x";
        if (query.open === true && done) continue;
        if (query.open === false && !done) continue;
        rows.push({
          id: `${where}:${text}`,
          title: text,
          group: where,
          done,
          who: state ? client.displayName(state.byPk) : undefined,
          ts,
        });
      }
    };
    for (const page of pages) collect(page.latestContent, page.title, page.latestTs * 1000);
    for (const doc of channelDocs) collect(doc.info.latestContent, `#${doc.ref!.name}`, doc.info.latestTs * 1000);
    return applyLimits(rows, query);
  }

  if (query.source === "approvals" || query.source === "mentions") {
    const channelIds: string[] = [];
    for (const channel of client.state.communities.get(communityId)?.channels.values() ?? []) {
      channelIds.push(channel.id);
    }
    const events = await wire.query([{ kinds: [47103], "#h": channelIds, limit: 500, ...(since ? { since } : {}) }]);
    const wanted =
      query.source === "approvals"
        ? events.filter((e) => e.content.startsWith("⛔ approval needed:") || e.content.startsWith("❓ choose:"))
        : events.filter((e) => e.tags.some((t) => t[0] === "p" && t[1] === client.pubkey));
    const answered = new Set<string>();
    if (wanted.length > 0 && query.source === "approvals") {
      for (const reaction of await wire.query([{ kinds: [7], "#e": wanted.map((e) => e.id) }])) {
        const target = reaction.tags.find((t) => t[0] === "e")?.[1];
        if (target) answered.add(target);
      }
    }
    const rows = wanted
      .filter((e) => (query.open === true ? !answered.has(e.id) : query.open === false ? answered.has(e.id) : true))
      .filter((e) => !query.who || client.displayName(e.pubkey).toLowerCase() === query.who)
      .map((event) => ({
        id: event.id,
        title: event.content.split("\n")[0].replace(/^(⛔ approval needed:|❓ choose:)\s*/, ""),
        group: client.channelRef(event.tags.find((t) => t[0] === "h")?.[1] ?? "")?.name ?? "",
        who: client.displayName(event.pubkey),
        ts: event.created_at * 1000,
        meta: answered.has(event.id) ? "answered" : "waiting",
      }));
    return applyLimits(rows, query);
  }

  if (query.source === "pages") {
    const rows = [...client.wikiDocs().values()]
      .filter((page) => page.communityId === communityId)
      .filter((page) => !since || page.latestTs >= since)
      .map((page) => ({
        id: page.slug,
        title: page.title,
        group: client.displayName(page.latestAuthor),
        who: client.displayName(page.latestAuthor),
        ts: page.latestTs * 1000,
        meta: `${page.count} version${page.count === 1 ? "" : "s"}`,
      }));
    return applyLimits(rows, query);
  }

  if (query.source === "runs") {
    const rows = [...client.workflowRuns().entries()]
      .filter(([, run]) => !since || run.ts / 1000 >= since)
      .map(([id, run]) => ({
        id,
        title: run.workflow,
        group: run.status,
        ts: run.ts,
        meta: run.status.replace(/_/g, " "),
      }));
    return applyLimits(rows, query);
  }

  // spend / comments: the events exist but need per-source shaping —
  // say so plainly rather than rendering an empty box that looks broken.
  throw new Error(`"${query.source}" isn't wired up yet — tasks, approvals, pages, mentions and runs are`);
}

function applyLimits(rows: Row[], query: Query): Row[] {
  return rows.sort((a, b) => b.ts - a.ts).slice(0, query.limit);
}
