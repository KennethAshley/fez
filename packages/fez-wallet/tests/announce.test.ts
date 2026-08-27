import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { createAddressAnnouncer } from "../src/announce.js";
import { parseAddressEvent } from "../src/address-event.js";
import type { SignedNostrEvent } from "../src/consent.js";

const agentSecretHex = bytesToHex(generateSecretKey());

describe("createAddressAnnouncer", () => {
  it("announces once per process for a given chain+network", async () => {
    const published: SignedNostrEvent[] = [];
    const announce = createAddressAnnouncer();
    const a = { agentSecretHex, chain: "tao", network: "test" as const, address: "5Me", publish: async (ev: SignedNostrEvent) => { published.push(ev); } };
    expect(await announce(a)).toBe(true);
    expect(await announce(a)).toBe(false);
    expect(published).toHaveLength(1);
    expect(parseAddressEvent(published[0])).toEqual({ chain: "tao", network: "test", address: "5Me" });
  });

  it("announces again after a network flip — the stale d-tagged event is not the new network's", async () => {
    const published: SignedNostrEvent[] = [];
    const publish = async (ev: SignedNostrEvent) => { published.push(ev); };
    const announce = createAddressAnnouncer();
    await announce({ agentSecretHex, chain: "tao", network: "test", address: "5Me", publish });
    await announce({ agentSecretHex, chain: "tao", network: "finney", address: "5Me", publish });
    expect(published.map((e) => parseAddressEvent(e)?.network)).toEqual(["test", "finney"]);
    expect(published.map((e) => e.tags.find((t) => t[0] === "d")?.[1])).toEqual(["tao:test", "tao:finney"]);
  });

  it("swallows a failed publish — announcing is never a precondition for paying", async () => {
    const announce = createAddressAnnouncer();
    await expect(
      announce({
        agentSecretHex,
        chain: "tao",
        network: "test",
        address: "5Me",
        publish: async () => { throw new Error("relay down"); },
      })
    ).resolves.toBe(false);
  });
});
