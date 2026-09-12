import { afterEach, describe, expect, test, vi } from "vitest";
import { finalizeEvent, getPublicKey, type Filter } from "nostr-tools";
import { FezClient, type Wire, type WireEvent } from "../../fez-client/dist/index.js";
import { fetchSaltPanel, invalidateSaltPanel } from "../../fez-desktop/src/salt-record.js";
import { RelayConnection } from "../../../src/protocol/relay.js";

const keys = [1, 2, 3, 4].map((n) => new Uint8Array(32).fill(n));
const [ME, AGENT, OWNER, STRANGER] = keys.map(getPublicKey);

function ev(kind: number, pubkey: string, tags: string[][], content = "", created_at = 100) {
  return finalizeEvent({ kind, tags, content, created_at }, keys.find((key) => getPublicKey(key) === pubkey)!);
}

function cannedWire(byKind: Record<number, WireEvent[]>): Wire {
  const unused = () => { throw new Error("unused"); };
  return {
    pubkey: ME,
    query: (filters: Filter[]) =>
      Promise.resolve(filters.flatMap((f) => (f.kinds ?? []).flatMap((k) => byKind[k] ?? []))),
    publish: () => Promise.reject(new Error("unused")),
    relayInfo: () => Promise.resolve({ pubkey: ME }),
    subscribe: unused, encrypt: unused, decrypt: unused, sendDm: unused, unwrapDm: unused,
  };
}

describe("saltPanel", () => {
  test("assembles chits and vouches; excludes household", async () => {
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
    expect(panel.ring2).toEqual([
      expect.objectContaining({ kind: "chit", signer: STRANGER, note: "merged feat-x" }),
      expect.objectContaining({ kind: "vouch", signer: STRANGER, note: "solid" }),
    ]);
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

test("desktop cached evidence is re-derived for the current viewer and circle", async () => {
  vi.spyOn(RelayConnection.prototype, "connect").mockResolvedValue();
  vi.spyOn(RelayConnection.prototype, "health").mockReturnValue([{ url: "ws://salt.test", connected: true }]);
  vi.spyOn(RelayConnection.prototype, "query").mockImplementation(async (filters) =>
    filters.some((f) => f.kinds?.includes(47008))
      ? [ev(47008, STRANGER, [["d", AGENT], ["p", AGENT]], "solid")] : []);
  const opts = { pk: AGENT, viewer: ME, relays: ["ws://salt.test"], isViewerAgent: () => false, inViewerCircle: () => false };
  expect(await fetchSaltPanel(opts)).toMatchObject({ tier: "spoken-of" });
  expect(await fetchSaltPanel({ ...opts, viewer: STRANGER })).toMatchObject({ tier: "salted" });
  expect(await fetchSaltPanel({ ...opts, inViewerCircle: (pk) => pk === STRANGER })).toMatchObject({ tier: "circle" });
});

afterEach(() => {
  vi.restoreAllMocks();
  invalidateSaltPanel(AGENT);
});

// Exercise both consumers: fixing only the headless parser left desktop
// treating prepaid leases as accepted work.
describe.each(["headless", "desktop"] as const)("%s payment evidence", (surface) => {
  async function panel(events: ReturnType<typeof ev>[]) {
    const query = async (filters: Filter[]) => events.filter((e) => filters.some((f) =>
      (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey))));
    if (surface === "headless") {
      const wire = cannedWire({});
      const client = new FezClient({ ...wire, query });
      return client.saltPanel(AGENT);
    }
    vi.spyOn(RelayConnection.prototype, "connect").mockResolvedValue();
    vi.spyOn(RelayConnection.prototype, "health").mockReturnValue([{ url: "ws://salt.test", connected: true }]);
    vi.spyOn(RelayConnection.prototype, "query").mockImplementation(query);
    const result = await fetchSaltPanel({
      pk: AGENT, viewer: ME, relays: ["ws://salt.test"],
      isViewerAgent: () => false, inViewerCircle: () => false,
    });
    if (result === "error") throw new Error("Salt fetch failed");
    return result;
  }

  const work = "ab".repeat(32);
  const chit = (workId: string | undefined = work) =>
    ev(47007, ME, [["p", AGENT], ...(workId ? [["e", workId]] : [])], "accepted research", 200);
  const payment = (payer = ME, payee = AGENT, workId: string | undefined = work) =>
    ev(47040, payer, [["p", payee], ...(workId ? [["e", workId]] : []),
      ["amount", "1000000"], ["asset", "TAO"], ["chain", "tao"], ["network", "test"], ["tx", "0x123"]], "lease", 100);

  test("a prepaid lease without acceptance cannot raise Salt", async () => {
    const result = await panel([payment(), payment(STRANGER)]);
    expect(result).toMatchObject({ tier: "nameless", ring0: [], ring1: [], ring2Signers: 0 });
  });

  test("matching payment decorates one accepted-work chit, preserving its note and date", async () => {
    const result = await panel([payment(), chit(), payment(), chit()]);
    expect(result.tier).toBe("salted");
    expect(result.ring0).toEqual([{
      signer: ME, kind: "chit", workId: work, note: "accepted research", at: 200, moneyBacked: true,
    }]);
  });

  test.each([
    ["different payer", () => payment(STRANGER)],
    ["different payee", () => payment(ME, STRANGER)],
    ["different work", () => payment(ME, AGENT, "cd".repeat(32))],
    ["unlinked payment", () => payment(ME, AGENT, "")],
    ["wrong event kind", () => ev(1, ME, [["p", AGENT], ["e", work]], "paid")],
  ] as const)("%s cannot back the chit", async (_name, receipt) => {
    const result = await panel([chit(), receipt()]);
    expect(result.ring0).toHaveLength(1);
    expect(result.ring0[0].moneyBacked).toBe(false);
    expect(result.ring2Signers).toBe(0);
  });

  test("unlinked chit and payment do not match through missing work ids", async () => {
    const result = await panel([chit(""), payment(ME, AGENT, "")]);
    expect(result.ring0).toHaveLength(1);
    expect(result.ring0[0].moneyBacked).toBe(false);
  });
});
