import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import {
  buildAddressEvent,
  parseAddressEvent,
  addressFilter,
  KIND_AGENT_PAYMENT_ADDRESS,
} from "../src/address-event.js";

const sk = bytesToHex(generateSecretKey());

describe("address event", () => {
  it("round-trips chain, network and address", () => {
    const ev = buildAddressEvent({ agentSecretHex: sk, chain: "tao", network: "test", address: "5Dq6" });
    expect(ev.kind).toBe(KIND_AGENT_PAYMENT_ADDRESS);
    expect(parseAddressEvent(ev)).toEqual({ chain: "tao", network: "test", address: "5Dq6" });
  });

  it("is addressable — the d tag is chain:network so it self-replaces", () => {
    const ev = buildAddressEvent({ agentSecretHex: sk, chain: "tao", network: "test", address: "5Dq6" });
    expect(ev.tags).toContainEqual(["d", "tao:test"]);
  });

  it("rejects an event with no address", () => {
    const ev = buildAddressEvent({ agentSecretHex: sk, chain: "tao", network: "test", address: "5Dq6" });
    expect(parseAddressEvent({ ...ev, content: "  " })).toBeUndefined();
  });

  it("rejects an unknown network rather than guessing", () => {
    const ev = buildAddressEvent({ agentSecretHex: sk, chain: "tao", network: "test", address: "5Dq6" });
    const tampered = { ...ev, tags: ev.tags.map((t) => (t[0] === "network" ? ["network", "beta"] : t)) };
    expect(parseAddressEvent(tampered)).toBeUndefined();
  });

  it("rejects an event with the wrong kind", () => {
    const ev = buildAddressEvent({ agentSecretHex: sk, chain: "tao", network: "test", address: "5Dq6" });
    const wrongKind = { ...ev, kind: 1 };
    expect(parseAddressEvent(wrongKind)).toBeUndefined();
  });

  it("uses the adapter's own address, not a persona name or anything else", () => {
    const adapter = {
      chain: "tao",
      address: () => "5AdapterOwnAddress",
    };
    const ev = buildAddressEvent({
      agentSecretHex: sk,
      chain: adapter.chain,
      network: "test",
      address: adapter.address(),
    });
    expect(parseAddressEvent(ev)?.address).toBe("5AdapterOwnAddress");
  });

  it("filters by author, kind and d tag", () => {
    const pk = getPublicKey(generateSecretKey());
    expect(addressFilter([pk], "tao", "finney")).toEqual({
      kinds: [KIND_AGENT_PAYMENT_ADDRESS],
      authors: [pk],
      "#d": ["tao:finney"],
    });
  });
});
