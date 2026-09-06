import { describe, expect, test } from "vitest";
import { deriveSalt, type SaltEvidence, type SaltInput } from "../../fez-client/dist/salt.js";

const A = "aa".repeat(32); // agent under evaluation
const O = "bb".repeat(32); // A's owner
const S = "cc".repeat(32); // A's sibling (same owner)
const V = "dd".repeat(32); // the viewer
const R = "ee".repeat(32); // roster member
const X = "ff".repeat(32); // stranger

function chit(signer: string, over: Partial<SaltEvidence> = {}): SaltEvidence {
  return { signer, kind: "chit", workId: "w1", note: "merged feat-x", at: 100, moneyBacked: false, ...over };
}
function base(over: Partial<SaltInput> = {}): SaltInput {
  return {
    agent: A, viewer: V, evidence: [], attestations: [{ owner: O, agent: A }, { owner: O, agent: S }],
    isViewerAgent: (pk) => pk === V,
    inViewerCircle: (pk) => pk === R,
    ...over,
  };
}

describe("deriveSalt", () => {
  test("self-dealing: agent, owner, and sibling evidence is excluded, counted", () => {
    const p = deriveSalt(base({ evidence: [chit(A), chit(O), chit(S), chit(X)] }));
    expect(p.excluded).toBe(3);
    expect(p.ring2Signers).toBe(1);
    expect(p.tier).toBe("spoken-of");
  });
  test("ring 0: viewer's own chit → salted", () => {
    const p = deriveSalt(base({ evidence: [chit(V)] }));
    expect(p.tier).toBe("salted");
    expect(p.ring0).toHaveLength(1);
  });
  test("ring 1: roster member's chit → circle", () => {
    const p = deriveSalt(base({ evidence: [chit(R)] }));
    expect(p.tier).toBe("circle");
    expect(p.ring1).toHaveLength(1);
  });
  test("nothing → nameless", () => {
    expect(deriveSalt(base()).tier).toBe("nameless");
  });
  test("dedup: one chit per (signer, work)", () => {
    const p = deriveSalt(base({ evidence: [chit(X), chit(X), chit(X, { workId: "w2" })] }));
    expect(p.ring2Signers).toBe(1); // still one distinct signer
  });
  test("money-backed sorts first within a ring", () => {
    const p = deriveSalt(base({ evidence: [chit(V, { at: 200 }), chit(V, { workId: "w2", moneyBacked: true, at: 50 })] }));
    expect(p.ring0[0]!.moneyBacked).toBe(true);
  });
  test("vouch from viewer-vouched key lands in ring 1", () => {
    const p = deriveSalt(base({
      evidence: [{ signer: X, kind: "vouch", note: "solid", at: 10, moneyBacked: false }],
      inViewerCircle: (pk) => pk === X,
    }));
    expect(p.tier).toBe("circle");
  });
});
