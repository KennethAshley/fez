import { describe, expect, test } from "vitest";
import { quorumDecision, tallyPoll } from "../../fez-mcp/src/vote-logic.js";

/** Voting rules are trust rules — every client must count identically. */

const MEMBERS = new Set(["alice", "bob", "carol", "owner1"]);

describe("quorumDecision", () => {
  test("owner ✅ approves alone, regardless of quorum", () => {
    expect(quorumDecision([{ pk: "owner1", content: "✅" }], { owner: "owner1", quorum: 3, members: MEMBERS, selfPk: "agent" })).toBe("approved");
  });
  test("owner ❌ denies even with quorum met", () => {
    const ballots = [
      { pk: "alice", content: "✅" },
      { pk: "bob", content: "✅" },
      { pk: "owner1", content: "❌" },
    ];
    expect(quorumDecision(ballots, { owner: "owner1", quorum: 2, members: MEMBERS, selfPk: "agent" })).toBe("denied");
  });
  test("quorum of member ✅s approves without the owner", () => {
    const ballots = [
      { pk: "alice", content: "✅" },
      { pk: "bob", content: "👍" },
    ];
    expect(quorumDecision(ballots, { owner: "owner1", quorum: 2, members: MEMBERS, selfPk: "agent" })).toBe("approved");
  });
  test("non-members never count toward quorum", () => {
    const ballots = [
      { pk: "stranger1", content: "✅" },
      { pk: "stranger2", content: "✅" },
    ];
    expect(quorumDecision(ballots, { owner: "owner1", quorum: 2, members: MEMBERS, selfPk: "agent" })).toBeUndefined();
  });
  test("the asking agent cannot approve its own gate", () => {
    const ballots = [
      { pk: "agent", content: "✅" },
      { pk: "alice", content: "✅" },
    ];
    expect(quorumDecision(ballots, { owner: "owner1", quorum: 2, members: new Set([...MEMBERS, "agent"]), selfPk: "agent" })).toBeUndefined();
  });
  test("no quorum configured = owner only", () => {
    expect(quorumDecision([{ pk: "alice", content: "✅" }], { owner: "owner1", quorum: undefined, members: MEMBERS, selfPk: "agent" })).toBeUndefined();
  });
});

describe("tallyPoll", () => {
  test("counts member votes per option and picks the winner", () => {
    const ballots = [
      { pk: "alice", content: "1️⃣" },
      { pk: "bob", content: "1️⃣" },
      { pk: "carol", content: "2️⃣" },
    ];
    const t = tallyPoll(2, ballots, MEMBERS);
    expect(t.counts).toEqual([2, 1]);
    expect(t.winner).toBe(0);
    expect(t.voters).toBe(3);
  });
  test("a key voting multiple options counts for nothing", () => {
    const ballots = [
      { pk: "alice", content: "1️⃣" },
      { pk: "alice", content: "2️⃣" },
      { pk: "bob", content: "2️⃣" },
    ];
    const t = tallyPoll(2, ballots, MEMBERS);
    expect(t.counts).toEqual([0, 1]);
    expect(t.ambiguous).toBe(1);
    expect(t.winner).toBe(1);
  });
  test("non-members are not on the voter roll", () => {
    const t = tallyPoll(2, [{ pk: "stranger", content: "1️⃣" }], MEMBERS);
    expect(t.counts).toEqual([0, 0]);
    expect(t.winner).toBeUndefined();
  });
  test("tie means no winner", () => {
    const ballots = [
      { pk: "alice", content: "1️⃣" },
      { pk: "bob", content: "2️⃣" },
    ];
    expect(tallyPoll(2, ballots, MEMBERS).winner).toBeUndefined();
  });
  test("non-option reactions (❤️ etc.) are ignored", () => {
    const t = tallyPoll(2, [{ pk: "alice", content: "❤️" }], MEMBERS);
    expect(t.voters).toBe(0);
  });
});
