import { useEffect, useMemo, useState } from "react";
import type { FezClient, ObserverEntry } from "@fez/client";
import type { BrowserWire } from "./wire";

/**
 * Pulse — Buzz's PulseScreen: one glance answering "what are all my
 * agents doing right now." A card per known agent: live headline while
 * mid-turn, last turn outcome, the most recent tools it ran, and 24h
 * turn stats decrypted from 47030 metrics. Cards open the live watch
 * pane. Everything renders from data the client already holds — Pulse
 * is a lens, not a pipeline.
 */

const KIND_TURN_METRIC = 47030;

interface DayStats {
  turns: number;
  failed: number;
  ms: number;
}

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
  const [stats, setStats] = useState<Map<string, DayStats>>();

  useEffect(() => {
    void (async () => {
      const events = await wire.query([{ kinds: [KIND_TURN_METRIC], "#p": [client.pubkey], limit: 500 }]);
      const dayAgo = Date.now() - 24 * 3600_000;
      const byAgent = new Map<string, DayStats>();
      for (const event of events) {
        try {
          const metric = JSON.parse(wire.decrypt(event.pubkey, event.content)) as {
            agent?: string;
            status?: string;
            durationMs?: number;
            ts?: number;
          };
          if (!metric.agent || (metric.ts ?? 0) < dayAgo) continue;
          let row = byAgent.get(metric.agent);
          if (!row) byAgent.set(metric.agent, (row = { turns: 0, failed: 0, ms: 0 }));
          row.turns++;
          if (metric.status === "failed") row.failed++;
          row.ms += metric.durationMs ?? 0;
        } catch { /* not addressed to us */ }
      }
      setStats(byAgent);
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

  return (
    <main className="main">
      <header className="topbar">◉ pulse</header>
      <div className="timeline">
        {roster.length === 0 && (
          <div className="pane-empty">no agents known yet — cards appear as their metadata reaches your relay</div>
        )}
        <div className="pulse-grid">
          {roster.map((agent) => {
            const busy = working.get(agent.name);
            const live = busy && now - busy.ts < 30_000;
            const entries = activity.get(agent.name) ?? [];
            const lastTurn = [...entries].reverse().find((e) => e.type === "turn" && e.status !== "started");
            const recentTools = entries.filter((e) => e.type === "tool" && e.title).slice(-3);
            const day = stats?.get(agent.name);
            return (
              <button key={agent.pk} className={live ? "pulse-card live" : "pulse-card"} onClick={() => onWatch(agent.name)}>
                <div className="pulse-head">
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
                <div className="pulse-stats">
                  {day
                    ? `${day.turns} turn${day.turns === 1 ? "" : "s"} · ${(day.ms / 60_000).toFixed(0)} min${day.failed ? ` · ${day.failed} failed` : ""} — 24h`
                    : stats
                      ? "quiet for 24h"
                      : "…"}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </main>
  );
}

function ago(deltaMs: number): string {
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
