import { describe, expect, test } from "vitest";
import type { MentionCandidate } from "@fezchat/client";
import { rosterMatches } from "../src/mentions.js";

/**
 * Autocomplete over "also answers to": typing an alias must surface the
 * agent that carries it, so the field the persona editor offers is
 * discoverable in the composer and not only honored at send time.
 */
const ROSTER: MentionCandidate[] = [
  { pubkey: "pk-researcher", name: "researcher", isMember: true, aliases: ["research", "digger"] },
  { pubkey: "pk-reviewer", name: "reviewer", isMember: true },
];

describe("rosterMatches with aliases", () => {
  test("typing an alias prefix surfaces the agent", () => {
    const hits = rosterMatches(ROSTER, "digg", "self-pk");
    expect(hits.map((c) => c.pubkey)).toEqual(["pk-researcher"]);
  });

  test("name matching is unchanged", () => {
    expect(rosterMatches(ROSTER, "review", "self-pk").map((c) => c.pubkey)).toEqual(["pk-reviewer"]);
  });

  test("an agent is offered once even when name and alias both match", () => {
    // "re" hits researcher, research, reviewer — each pubkey once.
    const hits = rosterMatches(ROSTER, "re", "self-pk");
    expect(hits.map((c) => c.pubkey).sort()).toEqual(["pk-researcher", "pk-reviewer"]);
  });

  test("self is still excluded", () => {
    expect(rosterMatches(ROSTER, "digg", "pk-researcher")).toEqual([]);
  });
});
