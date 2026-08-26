import { describe, expect, test } from "vitest";
import { resolveChannels } from "../../fez-acp/src/service-common.js";

/**
 * The last brick of the first E2E cold start: the sentinel wakes a
 * teammate with the channel id `bootstrap-general`, and resolveChannels
 * — written when every channel id was a minted UUID — treated any
 * non-UUID spec as a NAME. The channel's name is "general", so the id
 * missed, the agent exited, and the welcome team died one step from
 * speaking. A spec that exactly equals a channel's d-tag is that
 * channel, UUID-shaped or not.
 */

const CHANNEL = {
  kind: 47101,
  tags: [["d", "bootstrap-general"]],
  content: JSON.stringify({ name: "general", visibility: "open" }),
  id: "e1",
  pubkey: "p1",
  created_at: 1,
  sig: "s",
};

const relay = { query: async () => [CHANNEL] } as never;

describe("resolveChannels", () => {
  test("an exact channel id resolves even when it isn't UUID-shaped", async () => {
    const ids = await resolveChannels(relay, ["bootstrap-general"], "ws://test");
    expect(ids).toEqual(["bootstrap-general"]);
  });

  test("a channel name still resolves, case-insensitive with optional #", async () => {
    expect(await resolveChannels(relay, ["#General"], "ws://test")).toEqual(["bootstrap-general"]);
  });
});
