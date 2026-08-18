import { useEffect, useMemo, useState } from "react";
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
  ts: number;
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
    })();
    void (async () => {
      const channels: { id: string; name: string }[] = [];
      for (const communityId of client.state.joined) {
        const community = client.state.communities.get(communityId);
        for (const channel of community?.channels.values() ?? []) channels.push({ id: channel.id, name: channel.name });
      }
      const byChannel = new Map<string, Map<string, number>>();
      const results = await wire.query(
        channels.map(({ id }) => ({ kinds: [KIND_CHANNEL_MESSAGE], "#h": [id], since, limit: 500 }))
      );
      for (const event of results) {
        const channelId = event.tags.find((t) => t[0] === "h")?.[1];
        const name = channels.find((c) => c.id === channelId)?.name;
        if (!name) continue;
        let days = byChannel.get(name);
        if (!days) byChannel.set(name, (days = new Map()));
        const key = dayKey(event.created_at * 1000);
        days.set(key, (days.get(key) ?? 0) + 1);
      }
      setChannelDays(byChannel);
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
    const weekAgo = now - 7 * DAY_MS;
    const rows: { ts: number; kind: "turn" | "artifact"; agent: string; text: string; failed?: boolean }[] = [];
    for (const t of turns ?? []) {
      if (t.ts < weekAgo) continue;
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
    for (const communityId of client.state.joined) {
      const community = client.state.communities.get(communityId);
      for (const channel of community?.channels.values() ?? []) {
        for (const artifact of client.artifacts(channel.id)) {
          if (artifact.ts < weekAgo) continue;
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
  }, [turns, client, now]);

  const maxDay = Math.max(1, ...days14.map((d) => d.ok + d.failed));
  const [hover, setHover] = useState<number>();
  const hovered = hover !== undefined ? days14[hover] : undefined;
  const agentPk = new Map(roster.map((a) => [a.name, a.pk]));

  return (
    <main className="main">
      <header className="topbar">◉ pulse</header>
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

        {/* ── timeline ── */}
        <div className="pulse-section">
          <div className="pulse-section-head"><span>what happened · last 7 days</span></div>
          {timeline.length === 0 && <div className="pane-empty">{turns ? "nothing recorded this week" : "…"}</div>}
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
  for (const community of client.state.communities.values()) {
    for (const channel of community.channels.values()) {
      if (channel.id === channelId || channel.id.startsWith(channelId)) return `#${channel.name}`;
    }
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
