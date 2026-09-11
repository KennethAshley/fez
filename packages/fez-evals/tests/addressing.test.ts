import { describe, expect, test } from "vitest";
import { isAddressedTo, type AddressableEvent } from "../../fez-acp/src/addressing.js";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

/**
 * Addressing semantics — every case here was a live incident first.
 */
const OWNER = "owner-pk";
const ME = "researcher-pk";
const OTHER_AGENT = "reviewer-pk";

const msg = (content: string, pubkey = OWNER, tags: string[][] = []): AddressableEvent => ({ pubkey, content, tags });

test("a signed explicit task addresses its worker without relying on narration mentions", () => {
  const coordinatorKey = new Uint8Array(32).fill(31);
  const speaker = getPublicKey(new Uint8Array(32).fill(32));
  const assignment = finalizeEvent({ kind: 47103, created_at: 100, content: "Narrate exactly: Every agent has an identity.",
    tags: [["h", "speech"], ["p", speaker], ["task", speaker]] }, coordinatorKey);
  expect(isAddressedTo(assignment, "speaker", speaker, OWNER)).toBe(true);
  expect(isAddressedTo(assignment, "researcher", ME, OWNER)).toBe(false);
});

describe("first-mention addressing", () => {
  test.each([
    'Example: "@researcher do this"',
    "Example: `@researcher do this`",
    "Example: “@researcher do this”",
    "```\n@researcher do this\n```",
    "Email ken@researcher.example",
    "SSH user@researcher",
    "path/@researcher",
    "@@researcher",
  ])("examples and non-mentions never address through automatic p-tags: %s", (content) => {
    expect(isAddressedTo(msg(content, OWNER, [["p", ME]]), "researcher", ME, OWNER)).toBe(false);
  });

  test.each([
    'Example: "@reviewer do this"; now @researcher take over',
    "Email ken@reviewer.example, then @researcher take over",
  ])("the first real prose mention still addresses: %s", (content) => {
    expect(isAddressedTo(msg(content), "researcher", ME, OWNER)).toBe(true);
  });

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
    expect(isAddressedTo(msg("The price is @ $5", OWNER, [["p", ME]]), "researcher", ME, OWNER)).toBe(true);
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

describe("segment-start fan-out (comms battery: one message, many tasks)", () => {
  const FAN = "T1: @researcher what year? @reviewer is x == NaN ever true? @pilot compute 17 * 23.";
  test("every segment-opening mention is an addressee", () => {
    expect(isAddressedTo(msg(FAN), "researcher", ME, OWNER)).toBe(true);
    expect(isAddressedTo(msg(FAN), "reviewer", ME, OWNER)).toBe(true);
    expect(isAddressedTo(msg(FAN), "pilot", ME, OWNER)).toBe(true);
  });
  test("mid-sentence mentions stay downstream handoffs, not addressees", () => {
    const handoff = "@reviewer check it, if good ping @coder";
    expect(isAddressedTo(msg(handoff), "reviewer", ME, OWNER)).toBe(true);
    expect(isAddressedTo(msg(handoff), "coder", ME, OWNER)).toBe(false);
  });
  test("newline opens a segment", () => {
    const lines = "@researcher find it\n@pilot verify it";
    expect(isAddressedTo(msg(lines), "pilot", ME, OWNER)).toBe(true);
  });
  test("quoted sentence end still opens a segment", () => {
    expect(isAddressedTo(msg('@a say "done." @b then archive it'), "b", ME, OWNER)).toBe(true);
  });
  test("ignoring quoted mentions preserves the surrounding segment", () => {
    const event = msg('@reviewer explain "ask @researcher?" before pinging @pilot');
    expect(isAddressedTo(event, "reviewer", ME, OWNER)).toBe(true);
    expect(isAddressedTo(event, "researcher", ME, OWNER)).toBe(false);
    expect(isAddressedTo(event, "pilot", ME, OWNER)).toBe(false);
  });
});

describe("aliases (the persona editor's 'also answers to')", () => {
  test("an alias addresses the agent like its name does", () => {
    expect(isAddressedTo(msg("@research dig this up"), "researcher", ME, OWNER, ["research"])).toBe(true);
  });

  test("alias match is case-insensitive both ways", () => {
    expect(isAddressedTo(msg("@Research hello"), "researcher", ME, OWNER, ["research"])).toBe(true);
    expect(isAddressedTo(msg("@research hello"), "researcher", ME, OWNER, ["Research"])).toBe(true);
  });

  test("an alias does not leak onto an agent that doesn't carry it", () => {
    expect(isAddressedTo(msg("@research dig this up"), "reviewer", OTHER_AGENT, OWNER, ["deputy"])).toBe(false);
  });

  test("a mid-sentence alias stays a downstream handoff", () => {
    expect(isAddressedTo(msg("@reviewer check it, then ping @research"), "researcher", ME, OWNER, ["research"])).toBe(false);
  });

  test("no aliases given behaves exactly as before", () => {
    expect(isAddressedTo(msg("@researcher hi"), "researcher", ME, OWNER)).toBe(true);
    expect(isAddressedTo(msg("@research hi"), "researcher", ME, OWNER)).toBe(false);
  });
});
