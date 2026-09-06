import { describe, expect, test } from "vitest";
import type { Filter } from "nostr-tools";
import { FezClient } from "../../fez-client/dist/index.js";

const ME = "aa".repeat(32);
const AGENT = "bb".repeat(32);

function stubWire(owner: string) {
  const published: { kind: number; tags: string[][]; content: string }[] = [];
  return {
    published,
    wire: {
      pubkey: owner,
      query: (_f: Filter[]) => Promise.resolve([]),
      publish: (tmpl: { kind: number; tags: string[][]; content: string }) => {
        published.push(tmpl);
        return Promise.resolve({ ...tmpl, id: "x", pubkey: owner, created_at: 0, sig: "s" });
      },
      relayInfo: () => Promise.resolve({ pubkey: owner }),
    } as never,
  };
}

describe("salt publishing", () => {
  test("chitAgent publishes 47007 with p, e, h tags and the note", async () => {
    const { wire, published } = stubWire(ME);
    const client = new FezClient(wire);
    await client.chitAgent(AGENT, { note: "merged feat-x", workId: "ev1", channelId: "ch1" });
    const e = published.find((p) => p.kind === 47007)!;
    expect(e.tags).toContainEqual(["p", AGENT]);
    expect(e.tags).toContainEqual(["e", "ev1"]);
    expect(e.tags).toContainEqual(["h", "ch1"]);
    expect(e.content).toBe("merged feat-x");
  });
  test("saltAgent publishes addressable 47008 (d = agent pk)", async () => {
    const { wire, published } = stubWire(ME);
    const client = new FezClient(wire);
    await client.saltAgent(AGENT, "solid worker");
    const e = published.find((p) => p.kind === 47008)!;
    expect(e.tags).toContainEqual(["d", AGENT]);
    expect(e.tags).toContainEqual(["p", AGENT]);
    expect(e.content).toBe("solid worker");
  });
  test("unsaltAgent republishes the address with empty content", async () => {
    const { wire, published } = stubWire(ME);
    const client = new FezClient(wire);
    await client.unsaltAgent(AGENT);
    const e = published.find((p) => p.kind === 47008)!;
    expect(e.content).toBe("");
  });
});
