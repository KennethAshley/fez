import type { WireEvent } from "./index.js";

/**
 * Salt — client-side reputation derivation. Pure: no I/O, no clock.
 * No scalar score is ever computed; the output is evidence, bucketed by
 * the VIEWER's vantage. Spec: docs/superpowers/specs/2026-09-05-salt-reputation-design.md
 */
export type Tier = "salted" | "circle" | "spoken-of" | "nameless";

export interface SaltEvidence {
  signer: string;
  kind: "chit" | "vouch";
  workId?: string;
  note: string;
  at: number;
  /** Matching signed payment claim; chain settlement is checked separately. */
  moneyBacked: boolean;
}

type SaltEvent = Pick<WireEvent, "kind" | "pubkey" | "tags" | "content" | "created_at">;

/**
 * Build accepted-work evidence from signature-verified events. A receipt
 * only backs a chit by the same hirer for the same agent and explicit work
 * id; paying for a lease never attests that the work succeeded.
 */
export function chitEvidence(agent: string, events: readonly SaltEvent[]): SaltEvidence[] {
  const tag = (e: SaltEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1];
  const payments = new Set<string>();
  for (const e of events) {
    const workId = tag(e, "e");
    if (e.kind === 47040 && tag(e, "p") === agent && workId) {
      payments.add(`${e.pubkey}:${workId}`);
    }
  }
  return events.filter((e) => e.kind === 47007 && tag(e, "p") === agent).map((e) => {
    const workId = tag(e, "e");
    return {
      signer: e.pubkey, kind: "chit", workId, note: e.content, at: e.created_at,
      moneyBacked: !!workId && payments.has(`${e.pubkey}:${workId}`),
    };
  });
}

export interface SaltInput {
  agent: string;
  viewer: string;
  evidence: SaltEvidence[];
  attestations: { owner: string; agent: string }[];
  isViewerAgent(pk: string): boolean;
  inViewerCircle(pk: string): boolean;
}

export interface SaltPanel {
  tier: Tier;
  ring0: SaltEvidence[];
  ring1: SaltEvidence[];
  /** Public evidence outside the viewer's circle; never implies trust. */
  ring2: SaltEvidence[];
  ring2Signers: number;
  excluded: number;
}

export function deriveSalt(input: SaltInput): SaltPanel {
  // Household: the agent, everyone who attested it (owners), and every
  // agent those owners attested (siblings). You can't write your own
  // reference letters — excluded, never down-weighted.
  const owners = new Set(input.attestations.filter((a) => a.agent === input.agent).map((a) => a.owner));
  const household = new Set<string>([input.agent, ...owners]);
  for (const a of input.attestations) if (owners.has(a.owner)) household.add(a.agent);

  const seen = new Set<string>();
  const kept: SaltEvidence[] = [];
  let excluded = 0;
  for (const e of input.evidence) {
    const key = `${e.signer}:${e.kind}:${e.workId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (household.has(e.signer)) { excluded++; continue; }
    kept.push(e);
  }

  const ring0 = kept.filter((e) => e.signer === input.viewer || input.isViewerAgent(e.signer));
  const r0 = new Set(ring0);
  const ring1 = kept.filter((e) => !r0.has(e) && input.inViewerCircle(e.signer));
  const r1 = new Set(ring1);
  const ring2 = kept.filter((e) => !r0.has(e) && !r1.has(e));
  const ring2Signers = new Set(ring2.map((e) => e.signer)).size;

  const tier: Tier = ring0.length ? "salted" : ring1.length ? "circle" : ring2Signers ? "spoken-of" : "nameless";
  const byMoneyThenNewest = (a: SaltEvidence, b: SaltEvidence) =>
    Number(b.moneyBacked) - Number(a.moneyBacked) || b.at - a.at;
  return { tier, ring0: ring0.sort(byMoneyThenNewest), ring1: ring1.sort(byMoneyThenNewest), ring2: ring2.sort(byMoneyThenNewest), ring2Signers, excluded };
}
