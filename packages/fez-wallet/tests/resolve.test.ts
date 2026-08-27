import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { buildAddressEvent } from "../src/address-event.js";
import { resolveRecipient, type ResolveDeps } from "../src/resolve.js";

const chipSk = bytesToHex(generateSecretKey());
const chipPk = getPublicKey(Buffer.from(chipSk, "hex"));

function deps(over: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    chain: "tao",
    network: "test",
    roster: async () => [{ name: "chip", pubkey: chipPk }],
    addressEvents: async () => [
      buildAddressEvent({ agentSecretHex: chipSk, chain: "tao", network: "test", address: "5Chip" }),
    ],
    localAddress: () => undefined,
    ...over,
  };
}

describe("resolveRecipient", () => {
  it("prefers a local persona", async () => {
    const r = await resolveRecipient("chip", deps({ localAddress: (n) => (n === "chip" ? "5Local" : undefined) }));
    expect(r).toEqual({ address: "5Local", via: "local" });
  });

  it("resolves a roster name to its published address", async () => {
    expect(await resolveRecipient("@chip", deps())).toEqual({
      address: "5Chip",
      network: "test",
      via: "agent",
      payeePubkey: chipPk,
    });
  });

  it("strips a leading @ for local names too", async () => {
    const r = await resolveRecipient("@chip", deps({ localAddress: (n) => (n === "chip" ? "5Local" : undefined) }));
    expect(r.via).toBe("local");
  });

  it("passes an unknown name through as a raw address", async () => {
    expect(await resolveRecipient("5F3sa2Whatever", deps())).toEqual({
      address: "5F3sa2Whatever",
      via: "raw",
    });
  });

  it("errors on an ambiguous name instead of picking", async () => {
    const otherPk = getPublicKey(generateSecretKey());
    await expect(
      resolveRecipient(
        "@chip",
        deps({ roster: async () => [{ name: "chip", pubkey: chipPk }, { name: "chip", pubkey: otherPk }] })
      )
    ).rejects.toThrow(/more than one/i);
  });

  it("says so when a known agent has published no address", async () => {
    await expect(resolveRecipient("@chip", deps({ addressEvents: async () => [] }))).rejects.toThrow(
      /chip hasn't published/i
    );
  });

  it("reports the payee's network so the caller can guard on it", async () => {
    const r = await resolveRecipient(
      "@chip",
      deps({
        network: "finney",
        addressEvents: async () => [
          buildAddressEvent({ agentSecretHex: chipSk, chain: "tao", network: "finney", address: "5Real" }),
        ],
      })
    );
    expect(r.network).toBe("finney");
  });
});
