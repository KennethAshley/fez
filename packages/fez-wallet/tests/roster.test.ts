import { describe, it, expect } from "vitest";
import { rosterFilter, rosterFromEvents, ROSTER_WINDOW_S } from "../src/roster.js";
import { resolveRecipient } from "../src/resolve.js";
import { KIND_AGENT_METADATA } from "../src/consent.js";
import type { SignedNostrEvent } from "../src/consent.js";

/** A 47000 announce as fez-acp actually publishes it: NO tags at all. */
function announce(pubkey: string, name: string, created_at: number): SignedNostrEvent {
  return {
    id: `${pubkey}-${created_at}`,
    kind: KIND_AGENT_METADATA,
    pubkey,
    created_at,
    tags: [],
    content: JSON.stringify({ name, supported_tasks: ["channel-chat"] }),
    sig: "00",
  };
}

describe("rosterFilter", () => {
  it("is unscoped — a channel filter would match nothing, since 47000 carries no tags", () => {
    const f = rosterFilter(1_700_000_000_000);
    expect(f.kinds).toEqual([KIND_AGENT_METADATA]);
    expect(f["#h"]).toBeUndefined();
    expect(Object.keys(f).sort()).toEqual(["kinds", "since"]);
  });

  it("asks for a week, like the client's own roster subscription", () => {
    expect(rosterFilter(1_700_000_000_000).since).toBe(1_700_000_000 - ROSTER_WINDOW_S);
  });
});

describe("rosterFromEvents", () => {
  it("returns one entry per agent even after many restarts", () => {
    const pk = "a".repeat(64);
    const roster = rosterFromEvents([announce(pk, "chip", 10), announce(pk, "chip", 20), announce(pk, "chip", 30)]);
    expect(roster).toEqual([{ name: "chip", pubkey: pk }]);
  });

  it("the newest announce names the agent", () => {
    const pk = "b".repeat(64);
    // Out of order on purpose: relays do not promise ordering.
    const roster = rosterFromEvents([announce(pk, "old-name", 10), announce(pk, "new-name", 99), announce(pk, "older", 5)]);
    expect(roster).toEqual([{ name: "new-name", pubkey: pk }]);
  });

  it("keeps two different agents that share a name — a name is not an identity", () => {
    const a = "c".repeat(64);
    const b = "d".repeat(64);
    expect(rosterFromEvents([announce(a, "chip", 1), announce(b, "chip", 2)])).toHaveLength(2);
  });

  it("skips junk content, nameless announces and foreign kinds", () => {
    const pk = "e".repeat(64);
    const bad: SignedNostrEvent = { ...announce(pk, "x", 1), content: "{not json" };
    const nameless: SignedNostrEvent = { ...announce("f".repeat(64), "x", 1), content: "{}" };
    const otherKind: SignedNostrEvent = { ...announce("0".repeat(64), "who", 1), kind: 1 };
    expect(rosterFromEvents([bad, nameless, otherKind])).toEqual([]);
  });
});

describe("roster → resolveRecipient (the wiring the deps() bug lived in)", () => {
  const pk = "9".repeat(64);
  // Three restarts of one agent — the shape that made a live "@chip"
  // throw "matches more than one agent" listing the same npub twice.
  const events = [announce(pk, "chip", 100), announce(pk, "chip", 200)];

  it("a restarted agent resolves instead of reading as ambiguous", async () => {
    const r = await resolveRecipient("@chip", {
      chain: "tao",
      network: "test",
      roster: async () => rosterFromEvents(events),
      addressEvents: async () => [
        {
          id: "addr",
          kind: 30175,
          pubkey: pk,
          created_at: 500,
          tags: [["d", "tao:test"], ["chain", "tao"], ["network", "test"]],
          content: "5Chip",
          sig: "00",
        },
      ],
      localAddress: () => undefined,
    });
    expect(r).toEqual({ address: "5Chip", network: "test", via: "agent", payeePubkey: pk });
  });
});
