import { describe, expect, test } from "vitest";
import { parseWake, wakeEvent, WAKE_TEXT_MAX } from "../../fez-acp/src/wake.js";
import { KIND_CHANNEL_MESSAGE } from "../../../src/protocol/kinds.js";

const CH = "1ed7db5f-b39b-46ad-8506-24899dc038db";
const ROOT = "A".repeat(64);
const REPLY = "b".repeat(64);
const good = { cmd: "wake", ts: 1, channel: CH, root: ROOT, reply: REPLY, depth: 1, text: "one sentence please" };

describe("parseWake", () => {
  test("accepts a well-formed frame and normalizes ids", () => {
    expect(parseWake(good, [CH])).toEqual({ ...good, root: ROOT.toLowerCase() });
  });

  test.each([
    ["another command", { ...good, cmd: "cancel" }, /not a wake/],
    ["a channel the agent does not watch", { ...good, channel: "other" }, /channel/],
    ["no root", { ...good, root: undefined }, /root/],
    ["a malformed reply", { ...good, reply: "xyz" }, /reply/],
    ["a negative depth", { ...good, depth: -1 }, /depth/],
    ["empty text", { ...good, text: "  " }, /text/],
    ["oversized text", { ...good, text: "x".repeat(WAKE_TEXT_MAX + 1) }, /chars/],
  ])("rejects %s", (_label, frame, pattern) => {
    expect(parseWake(frame, [CH])).toMatch(pattern);
  });
});

describe("wakeEvent", () => {
  test("is an owner message in the thread, p-tagged to me, with a fresh id", () => {
    const wake = parseWake(good, [CH]);
    if (typeof wake === "string") throw new Error(wake);
    const event = wakeEvent(wake, "o".repeat(64), "m".repeat(64));
    expect(event.kind).toBe(KIND_CHANNEL_MESSAGE);
    expect(event.pubkey).toBe("o".repeat(64));
    expect(event.content).toBe("one sentence please");
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.id).not.toBe(REPLY);
    expect(event.wake).toBe(REPLY); // rides on the event so the turn queue can't drop it
    expect(event.tags).toEqual([
      ["h", CH], ["e", ROOT.toLowerCase(), "", "root"], ["e", REPLY, "", "reply"], ["p", "m".repeat(64)], ["depth", "1"],
    ]);
  });

  test("replies to the root when no reply target is given", () => {
    const wake = parseWake({ ...good, reply: undefined, depth: undefined }, [CH]);
    if (typeof wake === "string") throw new Error(wake);
    const tags = wakeEvent(wake, "o", "m").tags;
    expect(tags.find((t) => t[3] === "reply")?.[1]).toBe(ROOT.toLowerCase());
    expect(tags.some((t) => t[0] === "depth")).toBe(false);
  });
});
