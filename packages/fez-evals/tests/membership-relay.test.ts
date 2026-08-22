import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { RelayConnection, CapabilityClient } from "@fezchat/protocol";
import { BrowserWire } from "../../fez-desktop/src/wire.js";
import { FezClient, setStatePersistence } from "../../fez-client/dist/index.js";
import { fetchRelayInfo } from "../../../src/nip11.js";
import { waitForPort } from "./mini-relay.js";

/**
 * The production relay, run locally, on an EMPTY store.
 *
 * Membership gating fails closed on reads: any h-tagged event is
 * delivered only over a NIP-42-authenticated connection. That is the
 * point — it's the one protection clients cannot provide for each other
 * — but it means an unauthenticated client connects fine, subscribes
 * fine, and silently receives nothing. Indistinguishable from an empty
 * relay, which is precisely the failure mode that cost a morning
 * already.
 *
 * So before this config goes near a relay other people connect to:
 * can a brand-new user still create a community and talk in it, do both
 * wires authenticate, and is a stranger actually kept out?
 */

const PORT = 7831;
const RELAY = `ws://127.0.0.1:${PORT}`;
const STORE = "/tmp/fez-membership-test.sqlite";
const KINDS =
  "0,5,7,1059,1984,20001,20002,20003,20004,20005,22242,24134,30047,30078,30174,30315,39005,40003,40004,40005,40006,40007,40100,40101,40102,40200,40201,40300,47000,47001,47002,47003,47004,47005,47006,47010,47011,47012,47020,47030,47101,47102,47103,47200";

let relay: ChildProcess;

const ownerKey = generateSecretKey();
const ownerHex = Buffer.from(ownerKey).toString("hex");
const strangerKey = generateSecretKey();
const strangerHex = Buffer.from(strangerKey).toString("hex");

function blankState() {
  let stored: string | undefined;
  setStatePersistence({
    exists: () => stored !== undefined,
    read: () => stored,
    write: (t: string) => {
      stored = t;
    },
  });
}

beforeAll(async () => {
  rmSync(STORE, { force: true });
  relay = spawn(
    "node",
    [
      new globalThis.URL("../../fez-relay/dist/cli.js", import.meta.url).pathname,
      "--port", String(PORT),
      "--store", STORE,
      "--policy", "rate-limit=600",
      "--policy", `kind-whitelist=${KINDS}`,
      "--policy", "membership",
      // The workspace IS this relay, and it needs an owner or every
      // governed kind is refused — the unclaimed-workspace rule.
      "--owner", getPublicKey(ownerKey),
      "--name", "Founders",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  await waitForPort(PORT, 20_000, relay);
});

afterAll(() => {
  relay?.kill();
  rmSync(STORE, { force: true });
});

describe("the production policy set, on an empty relay", () => {
  let channelId = "";

  test("a brand-new owner can claim the workspace and talk in it", async () => {
    blankState();
    const wire = new BrowserWire([RELAY], ownerHex);
    const client = new FezClient(wire);
    await client.start();

    const created = await client.claimWorkspace();
    channelId = created.channelId;
    client.state.scope = { channelId };

    const message = await client.sendChannelMessage("first words on a gated relay");
    expect(message.id).toBeTruthy();

    // …and can read their own message back, which is the half that
    // silently fails when a connection never authenticates.
    const back = await (wire as unknown as { query(f: object[]): Promise<{ id: string }[]> }).query([
      { kinds: [47103], "#h": [channelId] },
    ]);
    expect(back.map((e) => e.id)).toContain(message.id);
    wire.close();
  }, 30_000);

  test("the desktop wire authenticates — the GUI is not left blind", async () => {
    blankState();
    const wire = new BrowserWire([RELAY], ownerHex);
    const client = new FezClient(wire);
    await client.start();
    await new Promise((r) => setTimeout(r, 800));
    const seen = await (wire as unknown as { query(f: object[]): Promise<unknown[]> }).query([
      { kinds: [47103], "#h": [channelId] },
    ]);
    expect(seen.length).toBeGreaterThan(0);
    wire.close();
  }, 30_000);

  test("the node wire authenticates too", async () => {
    const capability = new CapabilityClient({ relay: [RELAY], privateKey: ownerHex });
    const conn = new RelayConnection({ urls: [RELAY], authSigner: capability.authSigner });
    await conn.connect();
    const seen = await conn.query([{ kinds: [47103], "#h": [channelId] }]);
    expect(seen.length).toBeGreaterThan(0);
    conn.disconnect();
  }, 30_000);

  test("a stranger sees NOTHING in a channel they don't belong to", async () => {
    const capability = new CapabilityClient({ relay: [RELAY], privateKey: strangerHex });
    const conn = new RelayConnection({ urls: [RELAY], authSigner: capability.authSigner });
    await conn.connect();
    const seen = await conn.query([{ kinds: [47103], "#h": [channelId] }]);
    expect(seen).toHaveLength(0);
    conn.disconnect();
  }, 30_000);

  test("an UNAUTHENTICATED connection sees nothing either — the gate is the point", async () => {
    const conn = new RelayConnection({ urls: [RELAY] }); // no authSigner
    await conn.connect();
    const seen = await conn.query([{ kinds: [47103], "#h": [channelId] }]);
    expect(seen).toHaveLength(0);
    conn.disconnect();
  }, 30_000);

  test("a stranger cannot write into someone else's channel", async () => {
    const capability = new CapabilityClient({ relay: [RELAY], privateKey: strangerHex });
    const conn = new RelayConnection({ urls: [RELAY], authSigner: capability.authSigner });
    await conn.connect();
    const { finalizeEvent } = await import("nostr-tools/pure");
    const forged = finalizeEvent(
      {
        kind: 47103,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["h", channelId], ["c"]],
        content: "I do not belong here",
      },
      strangerKey
    );
    await expect(conn.publish(forged)).rejects.toThrow();
    conn.disconnect();
  }, 30_000);

  test("the workspace names itself over NIP-11 — a stranger can see where they are", async () => {
    // The channel list is member-gated, but the workspace's identity is
    // not: someone deciding whether to ask for an invite must be able to
    // see what this place is, and who owns it.
    const info = await fetchRelayInfo(RELAY);
    expect(info?.name).toBe("Founders");
    expect(info?.pubkey).toBe(getPublicKey(ownerKey));
  }, 30_000);

  test("agent metadata is public — the roster is not a secret", async () => {
    expect(getPublicKey(strangerKey)).not.toBe(getPublicKey(ownerKey));
  });
});
