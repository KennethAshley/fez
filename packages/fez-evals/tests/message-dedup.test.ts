import { describe, expect, test } from "vitest";
import { FezClient } from "../../fez-client/dist/index.js";

/**
 * The double-render bug (found live, 2026-09-04): the sender's optimistic
 * cache races the relay's echo of the SAME event through the live
 * subscription — the echo can land before publish() resolves, so both
 * paths cached the message and one send rendered twice (identical
 * reactions on each copy, since both rows shared the event id).
 * cacheMessage is now idempotent by id; this pins it at the public
 * surface: caching the same signed event twice yields ONE message.
 */

const CHANNEL = "chan-dedup";
const signed = {
  id: "ab".repeat(32),
  pubkey: "cd".repeat(32),
  kind: 9,
  created_at: 1_700_000_000,
  tags: [["h", CHANNEL]],
  content: "hello once",
  sig: "ef".repeat(64),
};

// The wire seam, minus sockets: publish "succeeds" by returning the same
// signed event every time — exactly what a double-cache path sees.
const wire = {
  pubkey: signed.pubkey,
  publish: () => Promise.resolve(signed),
  query: () => Promise.resolve([]),
} as never;

describe("one event, one message", () => {
  test("sending twice-cached event does not duplicate the channel list", async () => {
    const client = new FezClient(wire);
    client.state.workspace.channels.set(CHANNEL, { id: CHANNEL, name: "general" } as never);
    // First cache: the optimistic send path.
    await client.sendChannelMessage("hello once", { channelId: CHANNEL });
    // Second cache of the SAME event: the subscription echo path (the
    // race's other arm) — publish returns the identical signed event.
    await client.sendChannelMessage("hello once", { channelId: CHANNEL });
    const msgs = client.messages(CHANNEL);
    expect(msgs.length).toBe(1);
    expect(msgs[0].id).toBe(signed.id);
  });
});
