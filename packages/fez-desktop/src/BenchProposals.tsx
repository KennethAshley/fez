import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * fez-bench proposal review in the GUI — tuner/harvester agents file
 * proposals in the append-only ledger; this surfaces pending ones with
 * approve/deny (approve applies, same as the CLI). App.tsx polls the
 * same ledger and fires a native notification when something new lands.
 */

export interface LedgerProposal {
  id: string;
  ts: number;
  kind: "description" | "case";
  agent?: string;
  from?: string;
  to?: string;
  q?: string;
  expect?: string[];
  rationale: string;
}

export function foldLedger(raw: string): { pending: LedgerProposal[]; decidedIds: Set<string> } {
  const proposals = new Map<string, LedgerProposal>();
  const decidedIds = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type: string; id: string } & LedgerProposal;
      if (entry.type === "proposal") proposals.set(entry.id, entry);
      else if (entry.type === "decision") decidedIds.add(entry.id);
    } catch { /* skip bad line */ }
  }
  return { pending: [...proposals.values()].filter((p) => !decidedIds.has(p.id)), decidedIds };
}

export default function BenchProposals({ onChanged }: { onChanged?: () => void }) {
  const [pending, setPending] = useState<LedgerProposal[]>([]);
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    void invoke<string>("read_bench_proposals")
      .then((raw) => setPending(foldLedger(raw).pending))
      .catch(() => setPending([]));
  }, []);
  useEffect(reload, [reload]);

  const decide = (id: string, approveIt: boolean) => {
    setError(undefined);
    void invoke("decide_bench_proposal", { id, approve: approveIt })
      .then(() => {
        reload();
        onChanged?.();
      })
      .catch((err) => setError(String(err)));
  };

  if (pending.length === 0) return null;
  return (
    <>
      <div className="manage-section">bench proposals — awaiting your review</div>
      <div className="settings-hint">
        Filed by the tuner/harvester via the proposal ledger. Approving a description applies it to the persona
        (next spawn); approving a case adds it to the routing bench. Every decision is recorded forever.
      </div>
      {error && <div className="ob-error">{error}</div>}
      {pending.map((proposal) => (
        <div key={proposal.id} className="skill-row">
          <div className="skill-main">
            {proposal.kind === "description" ? (
              <>
                <span className="skill-name">@{proposal.agent} <span className="role-tag">description</span></span>
                <span className="skill-desc proposal-from">− {proposal.from || "(none)"}</span>
                <span className="skill-desc proposal-to">+ {proposal.to}</span>
              </>
            ) : (
              <>
                <span className="skill-name">bench case <span className="role-tag">case</span></span>
                <span className="skill-desc">"{proposal.q}" → {proposal.expect?.join(" | ")}</span>
              </>
            )}
            <span className="skill-env">why: {proposal.rationale}</span>
          </div>
          <div className="skill-actions">
            <button className="agent-action" onClick={() => decide(proposal.id, true)}>✓ approve</button>
            <button className="mini" onClick={() => decide(proposal.id, false)}>✗ deny</button>
          </div>
        </div>
      ))}
    </>
  );
}


/**
 * Inline proposal card — Claude-Code-style accept/deny attached to a
 * chat message. Any message mentioning "proposal <id>" gets one: the
 * timeline detects the id, this card looks it up in the ledger and
 * renders the decision buttons right where the agent asked. Decided
 * proposals show their outcome, so old messages stay honest.
 */
export function InlineProposal({ id }: { id: string }) {
  const [proposal, setProposal] = useState<LedgerProposal>();
  const [status, setStatus] = useState<"pending" | "approved" | "denied" | "unknown">("unknown");
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    void invoke<string>("read_bench_proposals")
      .then((raw) => {
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as { type: string; id: string; status?: string } & LedgerProposal;
            if (entry.id !== id) continue;
            if (entry.type === "proposal") {
              setProposal(entry);
              setStatus((prev) => (prev === "unknown" ? "pending" : prev));
            } else if (entry.type === "decision") {
              setStatus(entry.status === "approved" ? "approved" : "denied");
            }
          } catch { /* skip */ }
        }
      })
      .catch(() => {});
  }, [id]);
  useEffect(load, [load]);

  if (!proposal) return null;
  const decide = (approveIt: boolean) => {
    setError(undefined);
    void invoke("decide_bench_proposal", { id, approve: approveIt })
      .then(() => setStatus(approveIt ? "approved" : "denied"))
      .catch((err) => setError(String(err)));
  };

  return (
    <div className={`inline-proposal ${status}`}>
      <div className="inline-proposal-body">
        {proposal.kind === "description" ? (
          <>
            <span className="inline-proposal-title">@{proposal.agent} description change</span>
            <span className="proposal-from">− {proposal.from || "(none)"}</span>
            <span className="proposal-to">+ {proposal.to}</span>
          </>
        ) : (
          <>
            <span className="inline-proposal-title">bench case</span>
            <span className="skill-desc">"{proposal.q}" → {proposal.expect?.join(" | ")}</span>
          </>
        )}
        <span className="inline-proposal-why">{proposal.rationale}</span>
        {error && <span className="ob-error">{error}</span>}
      </div>
      <div className="inline-proposal-actions">
        {status === "pending" ? (
          <>
            <button className="agent-action approve-btn" onClick={() => decide(true)}>✓ approve</button>
            <button className="mini" onClick={() => decide(false)}>✗ deny</button>
          </>
        ) : (
          <span className={`role-tag ${status === "approved" ? "installed-tag" : ""}`}>{status}</span>
        )}
      </div>
    </div>
  );
}

const PROPOSAL_RE = /\bproposal[:\s]+([a-z0-9]{6})\b/gi;
export function proposalIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(PROPOSAL_RE)].map((m) => m[1].toLowerCase()))];
}
