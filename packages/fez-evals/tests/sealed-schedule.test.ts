import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { parseSealed } from "../../../src/protocol/intents.js";
import { FezClient, type Wire } from "../../fez-client/dist/index.js";

const sk = generateSecretKey();
const pk = getPublicKey(sk);

function fakeWire(withSign: boolean) {
  const published: { kind: number; tags: string[][]; content: string; created_at?: number }[] = [];
  const wire = {
    pubkey: pk,
    publish: async (tmpl: never) => {
      published.push(tmpl);
      return finalizeEvent({ ...(tmpl as object), created_at: Math.floor(Date.now() / 1000) } as never, sk);
    },
    ...(withSign
      ? { signEvent: (tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }) =>
            finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...tmpl } as never, sk) }
      : {}),
    subscribe: () => () => {},
    query: async () => [],
    encrypt: (_p: string, t: string) => t,
    decrypt: (_p: string, t: string) => t,
    sendDm: async () => "",
    unwrapDm: () => undefined,
    relays: ["ws://test"],
    relayInfo: async () => undefined,
  } as unknown as Wire;
  return { wire, published };
}

describe("sealed scheduleMessage", () => {
  it("seals when the wire can sign: embedded 47103 with created_at = sendAt", async () => {
    const { wire, published } = fakeWire(true);
    const client = new FezClient(wire);
    const sendAt = Math.floor(Date.now() / 1000) + 3600;
    await client.scheduleMessage("chan1", sendAt, "later!");
    expect(published).toHaveLength(1);
    const intent = published[0];
    expect(intent.kind).toBe(40006);
    expect(intent.tags).toContainEqual(["send_at", String(sendAt)]);
    const inner = parseSealed(intent.content)!;
    expect(inner.kind).toBe(47103);
    expect(inner.created_at).toBe(sendAt);
    expect(inner.content).toBe("later!");
    expect(inner.tags).toContainEqual(["h", "chan1"]);
  });

  it("falls back to legacy plaintext when the wire cannot sign", async () => {
    const { wire, published } = fakeWire(false);
    const client = new FezClient(wire);
    await client.scheduleMessage("chan1", 123, "later!");
    expect(published[0].content).toBe("later!");
    expect(parseSealed(published[0].content)).toBeUndefined();
  });
});
