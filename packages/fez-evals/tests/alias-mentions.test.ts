import { describe, expect, test } from "vitest";
import { resolveMentions, type MentionCandidate } from "../../fez-client/src/mentions.js";

/**
 * Persona aliases ("also answers to") in GUI mention resolution.
 *
 * Agents announce their aliases in kind-47000 metadata; the client
 * carries them onto MentionCandidate. A message that writes an alias
 * must p-tag the agent exactly as its name would — otherwise the alias
 * field is a knob that silently does nothing (the original bug).
 */
const ROSTER: MentionCandidate[] = [
  { pubkey: "pk-researcher", name: "researcher", isMember: true, aliases: ["research", "digger"] },
  { pubkey: "pk-reviewer", name: "reviewer", isMember: true },
];

describe("resolveMentions with aliases", () => {
  test("an alias resolves to the agent's pubkey", () => {
    const res = resolveMentions("@research find the spec", ROSTER);
    expect(res.pubkeys).toEqual(["pk-researcher"]);
    expect(res.unresolved).toEqual([]);
  });

  test("name still wins its own lookup", () => {
    expect(resolveMentions("@researcher hi", ROSTER).pubkeys).toEqual(["pk-researcher"]);
  });

  test("alias match is case-insensitive", () => {
    expect(resolveMentions("@Digger hi", ROSTER).pubkeys).toEqual(["pk-researcher"]);
  });

  test("an alias nobody carries stays unresolved", () => {
    const res = resolveMentions("@archivist hi", ROSTER);
    expect(res.pubkeys).toEqual([]);
    expect(res.unresolved).toEqual(["archivist"]);
  });

  test("an alias shared by two members reports ambiguity and tags both", () => {
    const clash: MentionCandidate[] = [
      ...ROSTER,
      { pubkey: "pk-other", name: "other", isMember: true, aliases: ["research"] },
    ];
    const res = resolveMentions("@research hi", clash);
    expect(new Set(res.pubkeys)).toEqual(new Set(["pk-researcher", "pk-other"]));
    expect(res.ambiguous).toHaveLength(1);
  });

  test("a non-member's alias never resolves", () => {
    const roster: MentionCandidate[] = [
      { pubkey: "pk-out", name: "outsider", isMember: false, aliases: ["research"] },
    ];
    expect(resolveMentions("@research hi", roster).unresolved).toEqual(["research"]);
  });
});
