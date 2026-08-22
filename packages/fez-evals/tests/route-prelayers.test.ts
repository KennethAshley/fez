import { describe, expect, test } from "vitest";
import { explicitActor, scrubNames } from "../../fez-orchestrator/src/route-logic.js";

/**
 * The deterministic pre-router layers added after the first bench run
 * (name-as-content scored 2/7: roster names pull a 26M router even as
 * content). explicitActor honors a NAMED actor without the router;
 * scrubNames neutralizes remaining names so they can't pull.
 */

const NAMES = ["researcher", "reviewer", "deployer"];

describe("explicitActor", () => {
  test.each([
    ["have researcher dig up the spec", "researcher"],
    ["ask reviewer to look at this diff", "reviewer"],
    ["get deployer to ship it", "deployer"],
    ["tell researcher I need the NIP-17 history", "researcher"],
    ["researcher: find the kademlia paper", "researcher"],
    ["reviewer, poke holes in this", "reviewer"],
    ["have @deployer roll it out", "deployer"],
  ])("names the actor: %s", (text, expected) => {
    expect(explicitActor(text, NAMES)).toBe(expected);
  });

  test.each([
    "reviewer signed off, ship it",
    "find the paper researcher mentioned last week",
    "the PR researcher validated is merged — deploy it",
    "review my relay.ts changes please",
    "get me the changelog for react 19",
    "make the release happen",
  ])("no explicit actor: %s", (text) => {
    expect(explicitActor(text, NAMES)).toBeUndefined();
  });
});

describe("scrubNames", () => {
  test("neutralizes roster names as content", () => {
    expect(scrubNames("reviewer signed off, ship it", NAMES)).toBe("a teammate signed off, ship it");
    expect(scrubNames("the PR researcher validated is merged — deploy it", NAMES)).toBe(
      "the PR a teammate validated is merged — deploy it"
    );
  });
  test("handles @-prefixed and mixed case", () => {
    expect(scrubNames("@Reviewer already approved", NAMES)).toBe("a teammate already approved");
  });
  test("leaves everything else untouched", () => {
    expect(scrubNames("review my relay.ts changes please", NAMES)).toBe("review my relay.ts changes please");
  });
  test("empty roster is a no-op", () => {
    expect(scrubNames("reviewer signed off", [])).toBe("reviewer signed off");
  });
});
