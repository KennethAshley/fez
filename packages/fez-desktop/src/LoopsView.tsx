import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient, WireEvent } from "@fez/client";
import { foldLedger } from "./BenchProposals";

/**
 * Open loops — everything unfinished, in one place.
 *
 * Nothing here is a new object. A "loop" is DERIVED from events that
 * already exist: an approval request with no reaction on it, a choice
 * card nobody answered, a bench proposal with no decision, a workflow
 * run parked on approval, an agent mid-turn. The alternative — a ticket
 * you have to create and close — would put ceremony on a system whose
 * whole premise is that the conversation is the record.
 *
 * Two bands, in the order that matters: what is BLOCKED on your
 * signature, then what is merely running. Blocked items carry their
 * real buttons, because a list that makes you navigate somewhere else
 * to act is a list you stop opening.
 */

const CHOICE_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

interface Loop {
  id: string;
  kind: "approval" | "choice" | "proposal" | "workflow" | "working";
  glyph: string;
  who: string;
  where?: string;
  title: string;
  detail?: string;
  ts: number;
  /** waiting on you vs merely in flight */
  blocked: boolean;
  options?: string[];
  act?: (choice: number | boolean) => void;
  open?: () => void;
}

/** `mcp__fez__fez_ask_owner` → `fez ask owner`; leaves prose alone. */
function humanizeActivity(activity: string | undefined): string {
  const raw = (activity ?? "").trim();
  if (!raw) return "working";
  if (!/^[\w:]+$/.test(raw)) return raw; // already a sentence
  return raw.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
}

const ago = (ts: number) => {
  const m = Math.floor((Date.now() - ts) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

export function OpenLoops({
  client,
  scan,
  onOpenMessage,
}: {
  client: FezClient;
  /** Relay-scanned approval/choice messages — see the note in App.tsx. */
  scan?: { msgs: WireEvent[]; answered: Set<string> };
  onOpenMessage: (channelId: string, msgId: string) => void;
}) {
  const [proposals, setProposals] = useState<ReturnType<typeof foldLedger>>();
  const [, bump] = useState(0);

  const loadProposals = useCallback(() => {
    void invoke<string>("read_bench_proposals")
      .then((raw) => setProposals(foldLedger(raw)))
      .catch(() => setProposals(undefined));
  }, []);

  useEffect(() => {
    loadProposals();
    const timer = setInterval(() => bump((n) => n + 1), 20_000); // freshen the clocks
    return () => clearInterval(timer);
  }, [loadProposals]);

  const loops: Loop[] = [];

  // ── approvals and choices with no answer (from the relay scan) ────
  const nameOf = (channelId: string) => client.channelRef(channelId);
  for (const event of scan?.msgs ?? []) {
    if (scan?.answered.has(event.id)) continue;
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId) continue;
    const who = client.displayName(event.pubkey);
    const where = nameOf(channelId)?.name;

    if (event.content.startsWith("⛔ approval needed:")) {
      const [head, ...rest] = event.content.replace(/^⛔ approval needed:\s*/, "").split("\n");
      loops.push({
        id: event.id,
        kind: "approval",
        glyph: "⛔",
        who,
        where,
        title: head,
        detail: rest.join(" ").replace(/^\(|\)$/g, "") || undefined,
        ts: event.created_at * 1000,
        blocked: true,
        act: (approve) => void client.toggleReaction(channelId, event.id, approve ? "✅" : "❌"),
        open: () => onOpenMessage(channelId, event.id),
      });
      continue;
    }

    const lines = event.content.split("\n");
    const options: string[] = [];
    for (const line of lines.slice(1)) {
      const index = CHOICE_EMOJI.findIndex((e) => line.startsWith(e));
      if (index === options.length) {
        options.push(line.slice(CHOICE_EMOJI[index].length).trim().replace(/ \(recommended\)$/, " ★"));
      }
    }
    if (options.length < 2) continue;
    loops.push({
      id: event.id,
      kind: "choice",
      glyph: "❓",
      who,
      where,
      title: lines[0].replace(/^❓ choose:\s*/, ""),
      ts: event.created_at * 1000,
      blocked: true,
      options,
      act: (index) => void client.toggleReaction(channelId, event.id, CHOICE_EMOJI[index as number]),
      open: () => onOpenMessage(channelId, event.id),
    });
  }

  // ── bench proposals awaiting a decision ────────────────────────────
  for (const proposal of proposals?.pending ?? []) {
    loops.push({
      id: proposal.id,
      kind: "proposal",
      glyph: "📋",
      who: "bench",
      title: `${proposal.agent}: ${proposal.kind === "description" ? "description change" : "new case"}`,
      detail: proposal.to?.slice(0, 120) ?? proposal.q,
      ts: proposal.ts,
      blocked: true,
      act: (approve) => {
        void invoke("decide_bench_proposal", { id: proposal.id, approve: !!approve })
          .then(loadProposals)
          .catch(loadProposals);
      },
    });
  }

  // ── workflow runs: parked on approval = blocked, else in flight ────
  for (const [runId, run] of client.workflowRuns()) {
    if (run.status === "done" || run.status === "failed" || run.status === "denied") continue;
    const waiting = run.status === "waiting_approval";
    loops.push({
      id: runId,
      kind: "workflow",
      glyph: "»",
      who: run.workflow,
      title: waiting ? "waiting for approval" : `step ${run.step ?? "?"} · ${run.status.replace(/_/g, " ")}`,
      ts: run.ts,
      blocked: waiting,
    });
  }

  // ── agents mid-turn right now ──────────────────────────────────────
  const now = Date.now();
  for (const [agent, work] of client.workingAgents()) {
    if (now - work.ts > 30_000) continue;
    loops.push({
      id: `working:${agent}`,
      kind: "working",
      glyph: "⚙",
      who: agent,
      // Observer activity is often a raw tool id (mcp__fez__fez_ask_owner)
      // — readable to me, noise to a person scanning a list.
      title: humanizeActivity(work.activity),
      ts: work.ts,
      blocked: false,
    });
  }

  const blocked = loops.filter((l) => l.blocked).sort((a, b) => a.ts - b.ts);
  const inFlight = loops.filter((l) => !l.blocked).sort((a, b) => b.ts - a.ts);

  if (blocked.length === 0 && inFlight.length === 0) return null;

  return (
    <>

        {blocked.length > 0 && (
          <div className="loops-band">
            <div className="loops-band-head">
              <span>waiting on you</span>
              <span className="loops-count">{blocked.length}</span>
            </div>
            {blocked.map((loop) => (
              <div key={loop.id} className="loop blocked">
                <div className="loop-line">
                  <span className="loop-glyph">{loop.glyph}</span>
                  <button className="loop-who" onClick={loop.open} disabled={!loop.open}>
                    {loop.kind === "proposal" ? loop.who : `@${loop.who}`}
                  </button>
                  {loop.where && <span className="loop-where">#{loop.where}</span>}
                  <span className="loop-ago">{ago(loop.ts)}</span>
                </div>
                <div className="loop-title">{loop.title}</div>
                {loop.detail && <div className="loop-detail">{loop.detail}</div>}
                {loop.options ? (
                  <div className="loop-actions">
                    {loop.options.map((option, index) => (
                      <button key={index} className="agent-action" onClick={() => loop.act?.(index)}>
                        {index + 1} {option}
                      </button>
                    ))}
                  </div>
                ) : loop.act ? (
                  <div className="loop-actions">
                    <button className="agent-action approve-btn" onClick={() => loop.act?.(true)}>✓ approve</button>
                    <button className="agent-action danger" onClick={() => loop.act?.(false)}>✕ deny</button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {inFlight.length > 0 && (
          <div className="loops-band">
            <div className="loops-band-head">
              <span>in flight</span>
              <span className="loops-count">{inFlight.length}</span>
            </div>
            {inFlight.map((loop) => (
              <div key={loop.id} className="loop">
                <span className="loop-glyph">{loop.glyph}</span>
                <span className="loop-who plain">{loop.kind === "workflow" ? loop.who : `@${loop.who}`}</span>
                <span className="loop-flight-title">{loop.title}</span>
                <span className="loop-ago">{ago(loop.ts)}</span>
              </div>
            ))}
          </div>
        )}

    </>
  );
}
