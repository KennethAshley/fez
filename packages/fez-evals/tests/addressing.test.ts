import { describe, expect, test } from "vitest";
import { isAddressedTo, type AddressableEvent } from "../../fez-acp/src/addressing";

/**
 * Addressing semantics — every case here was a live incident first.
 */
const OWNER = "owner-pk";
const ME = "researcher-pk";
const OTHER_AGENT = "reviewer-pk";

const msg = (content: string, pubkey = OWNER, tags: string[][] = []): AddressableEvent => ({ pubkey, content, tags });

describe("first-mention addressing", () => {
  test("first @name is the addressee", () => {
    expect(isAddressedTo(msg("@researcher dig this up"), "researcher", ME, OWNER)).toBe(true);
  });

  test("secondary mentions do not fire (the '@coder codes early' bug)", () => {
    const event = msg("@reviewer check the docs. if good ping @researcher");
    expect(isAddressedTo(event, "researcher", ME, OWNER)).toBe(false);
    expect(isAddressedTo(event, "reviewer", "reviewer-pk", OWNER)).toBe(true);
  });

  test("case-insensitive name match", () => {
    expect(isAddressedTo(msg("@Researcher hello"), "researcher", ME, OWNER)).toBe(true);
  });

  test("possessive mid-text mention addresses that agent (first mention wins, wherever it is)", () => {
    expect(isAddressedTo(msg("@researcher's harness is looping"), "researcher", ME, OWNER)).toBe(true);
  });

  test("no mentions, no p-tag: not addressed", () => {
    expect(isAddressedTo(msg("just chatting"), "researcher", ME, OWNER)).toBe(false);
  });
});

describe("p-tag fallback is owner-only (the perpetual-motion bug)", () => {
  const pTagged = (author: string) => msg("Verified: 7 + 5 = 12 is correct.", author, [["p", ME]]);

  test("owner thread-reply with bare p-tag addresses the agent", () => {
    expect(isAddressedTo(pTagged(OWNER), "researcher", ME, OWNER)).toBe(true);
  });

  test("agent reply with bare p-tag does NOT summon (agents must @ explicitly)", () => {
    expect(isAddressedTo(pTagged(OTHER_AGENT), "researcher", ME, OWNER)).toBe(false);
  });

  test("no owner configured: bare p-tags never address", () => {
    expect(isAddressedTo(pTagged(OWNER), "researcher", ME, undefined)).toBe(false);
  });

  test("a message with SOME mention never falls through to p-tags", () => {
    const event = msg("@reviewer take this", OWNER, [["p", ME]]);
    expect(isAddressedTo(event, "researcher", ME, OWNER)).toBe(false);
  });
});
