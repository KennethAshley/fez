import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BenchCase } from "./cases.js";

/**
 * The proposal ledger — how agents get better WITH the owner's hand on
 * the pen. Tuner/harvester agents PROPOSE (a description tweak, a
 * harvested bench case); the owner approves or denies; approval applies
 * the change. History is an append-only JSONL: proposals and decisions
 * are separate lines, nothing is ever rewritten — the full record of
 * what was proposed, what you decided, and why survives forever.
 */

export interface DescriptionProposal {
  type: "proposal";
  id: string;
  ts: number;
  kind: "description";
  agent: string; // persona name whose description changes
  from: string;
  to: string;
  rationale: string;
}

export interface CaseProposal {
  type: "proposal";
  id: string;
  ts: number;
  kind: "case";
  q: string;
  expect: string[];
  rationale: string;
}

export type Proposal = DescriptionProposal | CaseProposal;

export interface Decision {
  type: "decision";
  id: string;
  ts: number;
  status: "approved" | "denied";
}

export const LEDGER = path.join(os.homedir(), ".fez", "bench", "proposals.jsonl");

function readLines(): (Proposal | Decision)[] {
  try {
    return fs
      .readFileSync(LEDGER, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Proposal | Decision);
  } catch {
    return [];
  }
}

function append(entry: Proposal | Decision): void {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
}

export function propose(proposal: Omit<DescriptionProposal, "type" | "id" | "ts"> | Omit<CaseProposal, "type" | "id" | "ts">): string {
  const id = Math.random().toString(36).slice(2, 8);
  append({ type: "proposal", id, ts: Date.now(), ...proposal } as Proposal);
  return id;
}

export interface LedgerView {
  pending: Proposal[];
  decided: { proposal: Proposal; decision: Decision }[];
}

export function ledger(): LedgerView {
  const proposals = new Map<string, Proposal>();
  const decisions = new Map<string, Decision>();
  for (const entry of readLines()) {
    if (entry.type === "proposal") proposals.set(entry.id, entry);
    else decisions.set(entry.id, entry);
  }
  const pending: Proposal[] = [];
  const decided: { proposal: Proposal; decision: Decision }[] = [];
  for (const proposal of proposals.values()) {
    const decision = decisions.get(proposal.id);
    if (decision) decided.push({ proposal, decision });
    else pending.push(proposal);
  }
  return { pending, decided };
}

/** Approve: record the decision AND apply the change. */
export function approve(id: string): string {
  const { pending } = ledger();
  const proposal = pending.find((p) => p.id === id);
  if (!proposal) throw new Error(`no pending proposal ${id}`);
  if (proposal.kind === "description") applyDescription(proposal);
  append({ type: "decision", id, ts: Date.now(), status: "approved" });
  return proposal.kind === "description"
    ? `description applied to ~/.fez/personas/${proposal.agent}.md (takes effect on next spawn + announce)`
    : `case added to the harvested battery`;
}

export function deny(id: string): void {
  const { pending } = ledger();
  if (!pending.some((p) => p.id === id)) throw new Error(`no pending proposal ${id}`);
  append({ type: "decision", id, ts: Date.now(), status: "denied" });
}

function applyDescription(proposal: DescriptionProposal): void {
  const personaPath = path.join(os.homedir(), ".fez", "personas", `${proposal.agent}.md`);
  const content = fs.readFileSync(personaPath, "utf-8");
  const updated = /^description:.*$/m.test(content)
    ? content.replace(/^description:.*$/m, `description: ${proposal.to}`)
    : content.replace(/^---\n/, `---\ndescription: ${proposal.to}\n`);
  fs.writeFileSync(personaPath, updated);
}

/** Approved case proposals become part of every bench run. */
export function harvestedCases(): BenchCase[] {
  const { decided } = ledger();
  return decided
    .filter((d): d is { proposal: CaseProposal; decision: Decision } => d.proposal.kind === "case" && d.decision.status === "approved")
    .map((d) => ({ q: d.proposal.q, expect: d.proposal.expect, category: "harvested" }));
}

export function formatLedger(view: LedgerView): string {
  const lines: string[] = [];
  if (view.pending.length === 0) lines.push("no pending proposals");
  for (const p of view.pending) {
    lines.push(
      p.kind === "description"
        ? `⏳ ${p.id} [description] @${p.agent}\n     from: ${p.from}\n     to:   ${p.to}\n     why:  ${p.rationale}`
        : `⏳ ${p.id} [case] "${p.q}" → ${p.expect.join("|")}\n     why:  ${p.rationale}`
    );
  }
  const recent = view.decided.sort((a, b) => b.decision.ts - a.decision.ts).slice(0, 10);
  if (recent.length > 0) {
    lines.push("", "history (last 10):");
    for (const { proposal, decision } of recent) {
      const mark = decision.status === "approved" ? "✓" : "✗";
      const what = proposal.kind === "description" ? `@${proposal.agent} description` : `case "${proposal.q.slice(0, 50)}"`;
      lines.push(`${mark} ${proposal.id} ${what} — ${decision.status} ${new Date(decision.ts).toLocaleString()}`);
    }
  }
  return lines.join("\n");
}
