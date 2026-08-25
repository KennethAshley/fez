import { describe, expect, test } from "vitest";
import type { Filter } from "nostr-tools";
import { FezClient } from "../../fez-client/dist/index.js";

/**
 * Summon authority for the starter team. The sentinel wakes agents
 * mentioned by the owner OR by owner-ATTESTED siblings (47006) — so when
 * @fez's team opener says "@researcher, introduce yourself", the guide's
 * key must carry an attestation or the mention dies in silence, which is
 * the worst kind of welcome.
 */

const OWNER = "aa".repeat(32);

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

describe("FezClient.attestAgent", () => {
  test("the owner publishes a 47006 naming the agent", async () => {
    const { wire, published } = stubWire(OWNER);
    const client = new FezClient(wire);
    client.state.describe({ owner: OWNER });
    await client.attestAgent("bb".repeat(32));
    const attestation = published.find((e) => e.kind === 47006);
    expect(attestation).toBeDefined();
    expect(attestation!.tags).toContainEqual(["p", "bb".repeat(32)]);
  });

  test("a non-owner is refused — attestation is the owner's word", async () => {
    const { wire } = stubWire(OWNER);
    const client = new FezClient(wire);
    client.state.describe({ owner: "cc".repeat(32) });
    await expect(client.attestAgent("bb".repeat(32))).rejects.toThrow(/owner/);
  });
});
