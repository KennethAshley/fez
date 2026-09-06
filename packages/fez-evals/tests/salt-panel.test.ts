import { describe, expect, test } from "vitest";
import type { Filter } from "nostr-tools";
import { FezClient } from "../../fez-client/dist/index.js";

const ME = "aa".repeat(32);
const AGENT = "bb".repeat(32);
const OWNER = "cc".repeat(32);
const STRANGER = "dd".repeat(32);

function ev(kind: number, pubkey: string, tags: string[][], content = "", created_at = 100) {
  return { kind, pubkey, tags, content, created_at, id: Math.random().toString(36).slice(2), sig: "s" };
}

function cannedWire(byKind: Record<number, unknown[]>) {
  return {
    pubkey: ME,
    query: (filters: Filter[]) =>
      Promise.resolve(filters.flatMap((f) => (f.kinds ?? []).flatMap((k) => (byKind[k] as never[]) ?? []))),
    publish: () => Promise.reject(new Error("unused")),
    relayInfo: () => Promise.resolve({ pubkey: ME }),
  } as never;
}

describe("saltPanel", () => {
  test("assembles chits, money-backed 47040s, vouches; excludes household", async () => {
    const client = new FezClient(cannedWire({
      47007: [ev(47007, STRANGER, [["p", AGENT], ["e", "w1"]], "merged feat-x"),
              ev(47007, OWNER, [["p", AGENT], ["e", "w2"]], "self-praise")],
      47040: [ev(47040, STRANGER, [["p", AGENT], ["e", "w3"]], "paid")],
      47008: [ev(47008, STRANGER, [["d", AGENT], ["p", AGENT]], "solid")],
      47006: [ev(47006, OWNER, [["p", AGENT]])],
    }));
    const panel = await client.saltPanel(AGENT);
    expect(panel.excluded).toBe(1);            // the owner's chit
    expect(panel.tier).toBe("spoken-of");      // stranger only, outside my rings
    expect(panel.ring2Signers).toBe(1);
  });
  test("revoked vouch (empty content, newest) drops the vouch", async () => {
    const client = new FezClient(cannedWire({
      47007: [], 47040: [], 47006: [],
      47008: [ev(47008, STRANGER, [["d", AGENT], ["p", AGENT]], "solid", 100),
              ev(47008, STRANGER, [["d", AGENT], ["p", AGENT]], "", 200)],
    }));
    const panel = await client.saltPanel(AGENT);
    expect(panel.tier).toBe("nameless");
  });
});
