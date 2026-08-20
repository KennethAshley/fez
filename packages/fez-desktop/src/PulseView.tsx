import { useEffect, useMemo, useRef, useState } from "react";
import type { FezClient, ObserverEntry } from "@fez/client";
import type { BrowserWire } from "./wire";
import Avatar from "./Avatar";

/**
 * Pulse — the fleet observability surface, three altitudes on one page:
 * NOW (live cards), TRENDS (24h tiles, 14-day chart, 12-week heatmaps),
 * HISTORY (a day-grouped timeline of turns + artifacts). Everything
 * derives from data already on the wire — 47030 turn metrics (encrypted
 * to the owner), channel messages, artifacts. Tool-level detail stays
 * live-only by design (the observer stream is ephemeral); history
 * bottoms out at the turn.
 */

const KIND_TURN_METRIC = 47030;
const KIND_CHANNEL_MESSAGE = 47103;
const WEEKS = 12;
const DAY_MS = 24 * 3600_000;

interface TurnRec {
  agent: string;
  scope?: string;
  status?: string;
  durationMs?: number;
  replyChars?: number;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  /** Event id of the message that triggered this turn (newer runtimes). */
  trigger?: string;
  ts: number;
}

interface MsgRec {
  id: string;
  authorPk: string;
  ts: number;
  channelId: string;
  mentions: string[]; // p-tag pubkeys
}

interface DayStats {
  turns: number;
  failed: number;
  ms: number;
}

const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function PulseView({
  client,
  wire,
  activity,
  working,
  onWatch,
}: {
  client: FezClient;
  wire: BrowserWire;
  activity: ReadonlyMap<string, ObserverEntry[]>;
  working: ReadonlyMap<string, { activity: string; ts: number }>;
  onWatch: (agent: string) => void;
}) {
  const [turns, setTurns] = useState<TurnRec[]>();
  const [channelDays, setChannelDays] = useState<Map<string, Map<string, number>>>();
  const [messages, setMessages] = useState<MsgRec[]>();

  useEffect(() => {
    const since = Math.floor((Date.now() - WEEKS * 7 * DAY_MS) / 1000);
    void (async () => {
      const events = await wire.query([{ kinds: [KIND_TURN_METRIC], "#p": [client.pubkey], since, limit: 5000 }]);
      const records: TurnRec[] = [];
      for (const event of events) {
        try {
          const metric = JSON.parse(wire.decrypt(event.pubkey, event.content)) as TurnRec;
          if (metric.agent && metric.ts) records.push(metric);
        } catch { /* not addressed to us */ }
      }
      records.sort((a, b) => a.ts - b.ts);
      setTurns(records);

      const channels: { id: string; name: string }[] = [...client.state.workspace.channels.values()]
        .map((channel) => ({ id: channel.id, name: channel.name }));
      // agents may work in channels this client hasn't joined (TUI-made agent
      // channels) — include their scopes so summons/edges still reconstruct
      for (const record of records) {
        if (!record.scope?.startsWith("ch:")) continue;
        const id = record.scope.slice(3);
        if (!channels.some((c) => c.id === id)) channels.push({ id, name: id.slice(0, 8) });
      }
      const byChannel = new Map<string, Map<string, number>>();
      const results = await wire.query(
        channels.map(({ id }) => ({ kinds: [KIND_CHANNEL_MESSAGE], "#h": [id], since, limit: 500 }))
      );
      const msgs: MsgRec[] = [];
      for (const event of results) {
        const channelId = event.tags.find((t) => t[0] === "h")?.[1];
        const name = channels.find((c) => c.id === channelId)?.name;
        if (!name || !channelId) continue;
        let days = byChannel.get(name);
        if (!days) byChannel.set(name, (days = new Map()));
        const key = dayKey(event.created_at * 1000);
        days.set(key, (days.get(key) ?? 0) + 1);
        msgs.push({
          id: event.id,
          authorPk: event.pubkey,
          ts: event.created_at * 1000,
          channelId,
          mentions: event.tags.filter((t) => t[0] === "p").map((t) => t[1]),
        });
      }
      setChannelDays(byChannel);
      setMessages(msgs);
    })();
  }, [wire, client]);

  const roster = useMemo(
    () =>
      [...client.agents().entries()]
        .map(([pk, name]) => ({ pk, name, online: client.isOnline(pk) }))
        .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    [client]
  );

  const now = Date.now();
  const dayAgo = now - DAY_MS;

  // shared filters: the graph and the flat timeline read the same window
  const [range, setRange] = useState<RangeKey>("24h");
  const [channelFilter, setChannelFilter] = useState("all");
  const rangeMs = RANGES.find((r) => r.key === range)?.ms ?? DAY_MS;
  const channels = useMemo(() => {
    const out: { id: string; name: string }[] = [];
    {
      for (const channel of client.state.workspace.channels.values()) out.push({ id: channel.id, name: channel.name });
    }
    for (const record of turns ?? []) {
      if (!record.scope?.startsWith("ch:")) continue;
      const id = record.scope.slice(3);
      if (!out.some((c) => c.id === id)) out.push({ id, name: id.slice(0, 8) });
    }
    return out;
  }, [client, turns]);
  const inScope = (channelId: string | undefined) => channelFilter === "all" || channelId === channelFilter;
  const filterControls = (
    <>
      <select className="graph-filter" value={range} onChange={(e) => setRange(e.target.value as RangeKey)}>
        {RANGES.map((r) => (
          <option key={r.key} value={r.key}>{r.key}</option>
        ))}
      </select>
      <select className="graph-filter" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}>
        <option value="all">all channels</option>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>#{c.name}</option>
        ))}
      </select>
    </>
  );

  // ── derived aggregates ────────────────────────────────────────────
  const stats24 = useMemo(() => {
    const byAgent = new Map<string, DayStats>();
    for (const t of turns ?? []) {
      if (t.ts < dayAgo) continue;
      let row = byAgent.get(t.agent);
      if (!row) byAgent.set(t.agent, (row = { turns: 0, failed: 0, ms: 0 }));
      row.turns++;
      if (t.status === "failed") row.failed++;
      row.ms += t.durationMs ?? 0;
    }
    return byAgent;
  }, [turns, dayAgo]);

  const tiles = useMemo(() => {
    let count = 0, failed = 0, cost = 0, tokens = 0, hasCost = false;
    for (const t of turns ?? []) {
      if (t.ts < dayAgo) continue;
      count++;
      if (t.status === "failed") failed++;
      if (t.usage?.costUsd != null) { cost += t.usage.costUsd; hasCost = true; }
      tokens += (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0);
    }
    const activeNow = [...working.values()].filter((w) => now - w.ts < 30_000).length;
    return { count, failed, cost: hasCost ? cost : undefined, tokens, activeNow };
  }, [turns, working, dayAgo, now]);

  const days14 = useMemo(() => {
    const out: { key: string; label: string; ok: number; failed: number; cost: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now - i * DAY_MS);
      out.push({ key: dayKey(d.getTime()), label: `${d.getMonth() + 1}/${d.getDate()}`, ok: 0, failed: 0, cost: 0 });
    }
    const index = new Map(out.map((d, i) => [d.key, i]));
    for (const t of turns ?? []) {
      const i = index.get(dayKey(t.ts));
      if (i === undefined) continue;
      if (t.status === "failed") out[i].failed++;
      else out[i].ok++;
      out[i].cost += t.usage?.costUsd ?? 0;
    }
    return out;
  }, [turns, now]);

  const sparkByAgent = useMemo(() => {
    const map = new Map<string, number[]>();
    const index = new Map(days14.map((d, i) => [d.key, i]));
    for (const t of turns ?? []) {
      const i = index.get(dayKey(t.ts));
      if (i === undefined) continue;
      let row = map.get(t.agent);
      if (!row) map.set(t.agent, (row = new Array(14).fill(0)));
      row[i]++;
    }
    return map;
  }, [turns, days14]);

  const agentDays = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const t of turns ?? []) {
      let days = map.get(t.agent);
      if (!days) map.set(t.agent, (days = new Map()));
      const key = dayKey(t.ts);
      days.set(key, (days.get(key) ?? 0) + 1);
    }
    return map;
  }, [turns]);

  const timeline = useMemo(() => {
    const windowStart = now - rangeMs;
    const rows: { ts: number; kind: "turn" | "artifact"; agent: string; text: string; failed?: boolean }[] = [];
    for (const t of turns ?? []) {
      if (t.ts < windowStart) continue;
      if (t.scope?.startsWith("ch:") && !inScope(t.scope.slice(3))) continue;
      const bits = [t.status ?? "ok"];
      if (t.durationMs) bits.push(t.durationMs > 90_000 ? `${(t.durationMs / 60_000).toFixed(1)}m` : `${(t.durationMs / 1000).toFixed(0)}s`);
      if (t.usage?.costUsd != null) bits.push(`$${t.usage.costUsd.toFixed(3)}`);
      rows.push({
        ts: t.ts,
        kind: "turn",
        agent: t.agent,
        text: `turn${t.scope ? ` in ${channelLabel(client, t.scope)}` : ""} — ${bits.join(" · ")}`,
        failed: t.status === "failed",
      });
    }
    {
      for (const channel of client.state.workspace.channels.values()) {
        if (!inScope(channel.id)) continue;
        for (const artifact of client.artifacts(channel.id)) {
          if (artifact.ts < windowStart) continue;
          rows.push({
            ts: artifact.ts,
            kind: "artifact",
            agent: artifact.authorName,
            text: `published ${artifact.type}${artifact.title ? ` "${artifact.title}"` : ""} in #${channel.name}`,
          });
        }
      }
    }
    rows.sort((a, b) => b.ts - a.ts);
    return rows.slice(0, 300);
  }, [turns, client, now, rangeMs, channelFilter]);

  // live feed: merge every agent's observer entries into one ticker.
  // No useMemo — the activity Map is mutated in place upstream, so its
  // identity never changes; memoizing on it would freeze the feed.
  const liveFeed = (() => {
    const rows: { agent: string; entry: ObserverEntry }[] = [];
    for (const [agent, entries] of activity) {
      for (const entry of entries) {
        if (entry.type === "thought" || entry.type === "tool" || entry.type === "turn") rows.push({ agent, entry });
      }
    }
    rows.sort((a, b) => (b.entry.ts ?? 0) - (a.entry.ts ?? 0));
    return rows.slice(0, 50);
  })();

  const maxDay = Math.max(1, ...days14.map((d) => d.ok + d.failed));
  const [hover, setHover] = useState<number>();
  const hovered = hover !== undefined ? days14[hover] : undefined;
  const agentPk = new Map(roster.map((a) => [a.name, a.pk]));

  return (
    <main className="main">
      <header className="topbar">
        <div className="topbar-row">◉ pulse</div>
      </header>
      <div className="timeline pulse-scroll">
        {roster.length === 0 && (
          <div className="pane-empty">no agents known yet — cards appear as their metadata reaches your relay</div>
        )}

        {/* ── 24h stat tiles ── */}
        <div className="pulse-tiles">
          <StatTile label="turns · 24h" value={turns ? String(tiles.count) : "…"} />
          <StatTile label="failed" value={turns ? String(tiles.failed) : "…"} alert={tiles.failed > 0} />
          <StatTile label="spend · 24h" value={turns ? (tiles.cost !== undefined ? `$${tiles.cost.toFixed(2)}` : "—") : "…"} />
          <StatTile label="tokens · 24h" value={turns ? (tiles.tokens ? compact(tiles.tokens) : "—") : "…"} />
          <StatTile label="active now" value={String(tiles.activeNow)} />
        </div>

        {/* ── live feed: the fleet's console, tailing itself ── */}
        <div className="pulse-section">
          <div className="pulse-section-head">
            <span>live</span>
            {tiles.activeNow > 0 && <span className="live-dot" title="agents working now" />}
          </div>
          {liveFeed.length === 0 ? (
            <div className="pane-empty">quiet — this fills as agents think, run tools, and finish turns</div>
          ) : (
            <div className="live-feed">
              {liveFeed.map(({ agent, entry }, i) => (
                <div key={i} className={`live-row ${entry.type}${entry.status === "failed" ? " failed" : ""}`}>
                  <span className="pulse-time">
                    {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  {agentPk.get(agent) && <Avatar pk={agentPk.get(agent)!} size={14} title={agent} />}
                  <span className="pulse-event-agent">@{agent}</span>
                  <span className="pulse-event-text">
                    {entry.type === "tool" && `⚙ ${entry.title ?? entry.kind ?? "tool"}${entry.path ? ` — ${entry.path}` : ""}${entry.status ? ` · ${entry.status}` : ""}`}
                    {entry.type === "thought" && (entry.text ?? "").replace(/\s+/g, " ").slice(-160)}
                    {entry.type === "turn" && `turn ${entry.status ?? ""}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── 14-day fleet chart ── */}
        <div className="pulse-section">
          <div className="pulse-section-head">
            <span>turns · last 14 days</span>
            <span className="pulse-readout">
              {hovered
                ? `${hovered.label} — ${hovered.ok + hovered.failed} turns${hovered.failed ? ` · ${hovered.failed} failed` : ""}${hovered.cost ? ` · $${hovered.cost.toFixed(2)}` : ""}`
                : ""}
            </span>
            <span className="pulse-legend">
              <span className="viz-swatch ok" /> ok <span className="viz-swatch fail" /> failed
            </span>
          </div>
          <div className="pulse-chart" onMouseLeave={() => setHover(undefined)}>
            {days14.map((d, i) => (
              <div
                key={d.key}
                className={`pulse-col${hover === i ? " hover" : ""}`}
                onMouseEnter={() => setHover(i)}
                title={`${d.label}: ${d.ok + d.failed} turns${d.failed ? `, ${d.failed} failed` : ""}`}
              >
                <div className="pulse-col-bars">
                  {d.failed > 0 && <div className="pulse-bar fail" style={{ height: `${(d.failed / maxDay) * 100}%` }} />}
                  {d.ok > 0 && <div className="pulse-bar ok" style={{ height: `${(d.ok / maxDay) * 100}%` }} />}
                </div>
                <div className="pulse-col-label">{i % 2 === 0 ? d.label : ""}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── live agent cards ── */}
        <div className="pulse-grid">
          {roster.map((agent) => {
            const busy = working.get(agent.name);
            const live = busy && now - busy.ts < 30_000;
            const entries = activity.get(agent.name) ?? [];
            const lastTurn = [...entries].reverse().find((e) => e.type === "turn" && e.status !== "started");
            const recentTools = entries.filter((e) => e.type === "tool" && e.title).slice(-3);
            const day = stats24.get(agent.name);
            const spark = sparkByAgent.get(agent.name);
            const sparkMax = Math.max(1, ...(spark ?? [1]));
            return (
              <button key={agent.pk} className={live ? "pulse-card live" : "pulse-card"} onClick={() => onWatch(agent.name)}>
                <div className="pulse-head">
                  <Avatar pk={agent.pk} size={22} title={agent.name} />
                  <span className={agent.online ? "dot on" : "dot off"} />
                  <span className="pulse-name">@{agent.name}</span>
                  {live && <span className="working">⚙</span>}
                </div>
                {live ? (
                  <div className="pulse-headline shimmer">{busy.activity}</div>
                ) : (
                  <div className="pulse-headline dim">
                    {lastTurn
                      ? `last turn ${lastTurn.status} · ${ago(now - (lastTurn.ts ?? now))}`
                      : client.statusOf(agent.pk) ?? (agent.online ? "idle" : "offline")}
                  </div>
                )}
                {recentTools.length > 0 && (
                  <div className="pulse-tools">
                    {recentTools.map((tool, index) => (
                      <div key={index} className="pulse-tool">⚙ {tool.title}</div>
                    ))}
                  </div>
                )}
                {spark && (
                  <div className="pulse-spark" title="turns per day, last 14 days">
                    {spark.map((v, i) => (
                      <span key={i} className="pulse-spark-bar" style={{ height: `${Math.max(v > 0 ? 15 : 4, (v / sparkMax) * 100)}%`, opacity: v > 0 ? 1 : 0.35 }} />
                    ))}
                  </div>
                )}
                <div className="pulse-stats">
                  {day
                    ? `${day.turns} turn${day.turns === 1 ? "" : "s"} · ${(day.ms / 60_000).toFixed(0)} min${day.failed ? ` · ${day.failed} failed` : ""} — 24h`
                    : turns
                      ? "quiet for 24h"
                      : "…"}
                </div>
              </button>
            );
          })}
        </div>

        {/* ── orchestration graph ── */}
        <GraphSection client={client} turns={turns} messages={messages} roster={roster} now={now} range={range} channelFilter={channelFilter} channels={channels} filterControls={filterControls} />

        {/* ── contribution heatmaps ── */}
        {(agentDays.size > 0 || (channelDays?.size ?? 0) > 0) && (
          <div className="pulse-section">
            <div className="pulse-section-head"><span>activity · last {WEEKS} weeks</span></div>
            {[...agentDays.entries()].map(([name, days]) => (
              <HeatRow key={`a:${name}`} label={`@${name}`} days={days} unit="turns" now={now} />
            ))}
            {[...(channelDays ?? new Map<string, Map<string, number>>()).entries()].map(([name, days]) => (
              <HeatRow key={`c:${name}`} label={`#${name}`} days={days} unit="messages" now={now} />
            ))}
          </div>
        )}

        {/* ── flat timeline (the graph's degenerate cousin, kept for scanning) ── */}
        <div className="pulse-section">
          <div className="pulse-section-head">
            <span>what happened</span>
            <span className="pulse-readout" />
            {filterControls}
          </div>
          {timeline.length === 0 && <div className="pane-empty">{turns ? "nothing in this window" : "…"}</div>}
          {groupByDay(timeline).map(([day, rows]) => (
            <div key={day}>
              <div className="pulse-day">{day}</div>
              {rows.map((row, index) => (
                <div key={index} className={row.failed ? "pulse-event failed" : "pulse-event"}>
                  <span className="pulse-time">
                    {new Date(row.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  {agentPk.get(row.agent) ? <Avatar pk={agentPk.get(row.agent)!} size={16} title={row.agent} /> : <span className="pulse-mark">{row.kind === "artifact" ? "📦" : "·"}</span>}
                  <span className="pulse-event-agent">@{row.agent}</span>
                  <span className="pulse-event-text">{row.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

/**
 * The orchestration graph — git-log --graph for the fleet. Lanes are
 * participants (you + agents), commit-dots are turns / summons /
 * artifacts, and edges are causality: a mention forks work onto another
 * lane, a callback merges it home. Edges prefer the metric's exact
 * `trigger` id (newer runtimes record which message caused the turn)
 * and fall back to nearest-prior-mention inference for older records.
 */
const LANE_H = 30;
const NODE_STEP = 24;
const EDGE_WINDOW_MS = 30 * 60_000;

interface GraphNode {
  lane: number;
  ts: number;
  msgId?: string;
  kind: "turn" | "summon" | "artifact";
  failed?: boolean;
  label: string;
  who: string;
  pk?: string;
}

const RANGES = [
  { key: "24h", ms: DAY_MS },
  { key: "3d", ms: 3 * DAY_MS },
  { key: "7d", ms: 7 * DAY_MS },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

function GraphSection({
  client,
  turns,
  messages,
  roster,
  now,
  range,
  channelFilter,
  channels,
  filterControls,
}: {
  client: FezClient;
  turns: TurnRec[] | undefined;
  messages: MsgRec[] | undefined;
  roster: { pk: string; name: string }[];
  now: number;
  range: RangeKey;
  channelFilter: string;
  channels: { id: string; name: string }[];
  filterControls: React.ReactNode;
}) {
  const [hover, setHover] = useState<GraphNode>();
  const scrollRef = useRef<HTMLDivElement>(null);

  const graph = useMemo(() => {
    const windowStart = now - (RANGES.find((r) => r.key === range)?.ms ?? DAY_MS);
    const nameByPk = new Map(roster.map((a) => [a.pk, a.name]));
    const pkByName = new Map(roster.map((a) => [a.name, a.pk]));
    const inScope = (channelId: string | undefined) => channelFilter === "all" || channelId === channelFilter;

    const laneOf = new Map<string, number>();
    const laneNames: string[] = [];
    const lane = (key: string) => {
      let i = laneOf.get(key);
      if (i === undefined) {
        i = laneNames.length;
        laneOf.set(key, i);
        laneNames.push(key);
      }
      return i;
    };
    lane("you");

    const nodes: GraphNode[] = [];
    const msgs = (messages ?? []).filter((m) => m.ts >= windowStart && inScope(m.channelId));
    const msgById = new Map(msgs.map((m) => [m.id, m]));

    for (const m of msgs) {
      if (nameByPk.has(m.authorPk)) continue; // agent-authored — its turn is the node
      const mentioned = m.mentions.filter((pk) => nameByPk.has(pk));
      if (mentioned.length === 0) continue;
      const who = m.authorPk === client.pubkey ? "you" : (client.knownNames().get(m.authorPk) ?? m.authorPk.slice(0, 8));
      nodes.push({
        lane: lane(m.authorPk === client.pubkey ? "you" : who),
        ts: m.ts,
        msgId: m.id,
        kind: "summon",
        label: `summons ${mentioned.map((pk) => `@${nameByPk.get(pk)}`).join(" ")}`,
        who,
        pk: m.authorPk,
      });
    }
    for (const t of turns ?? []) {
      if (t.ts < windowStart || !t.scope?.startsWith("ch:")) continue;
      if (!inScope(t.scope.slice(3))) continue;
      const bits = [t.status ?? "ok"];
      if (t.durationMs) bits.push(t.durationMs > 90_000 ? `${(t.durationMs / 60_000).toFixed(1)}m` : `${(t.durationMs / 1000).toFixed(0)}s`);
      if (t.usage?.costUsd != null) bits.push(`$${t.usage.costUsd.toFixed(3)}`);
      nodes.push({
        lane: lane(t.agent),
        ts: t.ts,
        kind: "turn",
        failed: t.status === "failed",
        label: `turn — ${bits.join(" · ")}${channelFilter === "all" ? ` · ${channelLabel(client, t.scope)}` : ""}`,
        who: `@${t.agent}`,
        pk: pkByName.get(t.agent),
      });
    }
    for (const { id: channelId, name } of channels) {
      if (!inScope(channelId)) continue;
      for (const artifact of client.artifacts(channelId)) {
        if (artifact.ts < windowStart) continue;
        nodes.push({
          lane: lane(artifact.authorName),
          ts: artifact.ts,
          kind: "artifact",
          label: `📦 ${artifact.type}${artifact.title ? ` "${artifact.title}"` : ""}${channelFilter === "all" ? ` · #${name}` : ""}`,
          who: `@${artifact.authorName}`,
          pk: artifact.authorPk,
        });
      }
    }

    nodes.sort((a, b) => a.ts - b.ts); // oldest left, newest right
    const cols = nodes.slice(-300);

    const edges: { from: number; to: number }[] = [];
    const seen = new Set<string>();
    const link = (from: number, to: number) => {
      if (from < 0 || to < 0 || from === to) return;
      const key = `${from}>${to}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from, to });
    };
    const anchorForMsg = (msgId: string): number => {
      const m = msgById.get(msgId);
      if (!m) return -1;
      const summonCol = cols.findIndex((n) => n.msgId === msgId);
      if (summonCol >= 0) return summonCol;
      // agent-authored trigger: anchor on that agent's latest turn at-or-before the message
      const author = nameByPk.get(m.authorPk);
      if (!author) return -1;
      for (let i = cols.length - 1; i >= 0; i--) {
        const n = cols[i];
        if (n.kind === "turn" && n.who === `@${author}` && n.ts <= m.ts + 5000) return i;
      }
      return -1;
    };

    cols.forEach((node, i) => {
      if (node.kind !== "turn") return;
      const turn = (turns ?? []).find((t) => t.ts === node.ts && `@${t.agent}` === node.who);
      if (turn?.trigger) {
        const src = anchorForMsg(turn.trigger);
        if (src >= 0) return link(src, i);
      }
      const prior = msgs
        .filter((m) => node.pk && m.mentions.includes(node.pk) && m.ts <= node.ts && node.ts - m.ts < EDGE_WINDOW_MS)
        .sort((a, b) => b.ts - a.ts)[0];
      if (prior) link(anchorForMsg(prior.id), i);
    });

    return { cols, edges, laneNames };
  }, [turns, messages, roster, client, channels, channelFilter, range, now]);

  const { cols, edges, laneNames } = graph;
  const width = cols.length * NODE_STEP + 30;
  const height = laneNames.length * LANE_H + 24;
  const colX = (i: number) => 16 + i * NODE_STEP;
  const laneY = (i: number) => 16 + i * LANE_H;

  // day boundaries for sparse date labels along the bottom
  const dayMarks = cols
    .map((n, i) => ({ i, key: dayKey(n.ts), ts: n.ts }))
    .filter((m, idx, arr) => idx === 0 || m.key !== arr[idx - 1].key);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth; // land on the newest
  }, [cols.length, range, channelFilter]);

  return (
    <div className="pulse-section">
      <div className="pulse-section-head">
        <span>orchestration graph</span>
        <span className="pulse-readout">
          {hover
            ? `${new Date(hover.ts).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} — ${hover.who} ${hover.label}`
            : ""}
        </span>
        {filterControls}
      </div>
      {cols.length === 0 ? (
        <div className="pane-empty">{turns && messages ? "nothing in this window" : "…"}</div>
      ) : (
        <div className="graph-wrap">
          <div className="graph-lane-col" style={{ height }}>
            {laneNames.map((name, i) => (
              <span key={name} className="graph-lane-label" style={{ top: laneY(i) - 8 }}>
                {name === "you" ? "you" : `@${name}`}
              </span>
            ))}
          </div>
          <div className="graph-scroll" ref={scrollRef}>
            <svg width={width} height={height} onMouseLeave={() => setHover(undefined)}>
              {laneNames.map((_, i) => (
                <line key={i} x1={0} y1={laneY(i)} x2={width} y2={laneY(i)} className="graph-lane-line" />
              ))}
              {dayMarks.map((m) => (
                <g key={m.i}>
                  <line x1={colX(m.i) - NODE_STEP / 2} y1={4} x2={colX(m.i) - NODE_STEP / 2} y2={height - 20} className="graph-day-line" />
                  <text x={colX(m.i) - NODE_STEP / 2 + 4} y={height - 6} className="graph-day-label">
                    {new Date(m.ts).toLocaleDateString([], { month: "numeric", day: "numeric" })}
                  </text>
                </g>
              ))}
              {edges.map((edge, i) => {
                const x1 = colX(edge.from), y1 = laneY(cols[edge.from].lane);
                const x2 = colX(edge.to), y2 = laneY(cols[edge.to].lane);
                const midX = (x1 + x2) / 2;
                return <path key={i} d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`} className="graph-edge" />;
              })}
              {cols.map((node, i) => (
                <circle
                  key={i}
                  cx={colX(i)}
                  cy={laneY(node.lane)}
                  r={hover === node ? 6 : 4.5}
                  className={`graph-dot ${node.kind}${node.failed ? " failed" : ""}`}
                  onMouseEnter={() => setHover(node)}
                >
                  <title>{`${new Date(node.ts).toLocaleString()} — ${node.who} ${node.label}`}</title>
                </circle>
              ))}
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="stat-tile">
      <div className={alert ? "stat-value alert" : "stat-value"}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** GitHub-style contribution row: WEEKS×7 cells, sequential single-hue ramp. */
function HeatRow({ label, days, unit, now }: { label: string; days: Map<string, number>; unit: string; now: number }) {
  const max = Math.max(1, ...days.values());
  const start = new Date(now - (WEEKS * 7 - 1) * DAY_MS);
  start.setDate(start.getDate() - start.getDay()); // align to week start
  const cells: { key: string; count: number; date: string }[] = [];
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = new Date(start.getTime() + i * DAY_MS);
    if (d.getTime() > now) break;
    const key = dayKey(d.getTime());
    cells.push({ key, count: days.get(key) ?? 0, date: d.toLocaleDateString() });
  }
  const level = (count: number) => (count === 0 ? 0 : Math.min(4, 1 + Math.floor((count / max) * 3.999)));
  return (
    <div className="heat-row">
      <span className="heat-label">{label}</span>
      <span className="heat-grid">
        {cells.map((cell) => (
          <span key={cell.key} className={`heat-cell l${level(cell.count)}`} title={`${cell.count} ${unit} — ${cell.date}`} />
        ))}
      </span>
      <span className="heat-total">{[...days.values()].reduce((a, b) => a + b, 0)}</span>
    </div>
  );
}

/** Metric scopes are "ch:<channelId>" / "dm:<convoKey>" (fez-acp's queue keys). */
function channelLabel(client: FezClient, scope: string): string {
  if (scope.startsWith("dm:")) return "a DM";
  const channelId = scope.startsWith("ch:") ? scope.slice(3) : scope;
  for (const channel of client.state.workspace.channels.values()) {
    if (channel.id === channelId || channel.id.startsWith(channelId)) return `#${channel.name}`;
  }
  return `#${channelId.slice(0, 8)}`;
}

function groupByDay<T extends { ts: number }>(rows: T[]): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const d = new Date(row.ts);
    const label = d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
    let bucket = out.get(label);
    if (!bucket) out.set(label, (bucket = []));
    bucket.push(row);
  }
  return [...out.entries()];
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function ago(deltaMs: number): string {
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
