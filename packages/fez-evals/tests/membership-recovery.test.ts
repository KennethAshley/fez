import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { BrowserWire } from "../../fez-desktop/src/wire.js";
import { FezClient, setStatePersistence } from "../../fez-client/dist/index.js";
import { MiniRelay } from "./mini-relay.js";

/**
 * Losing local state must not lose your workspace.
 *
 * Found the hard way: a real client came up with empty local state,
 * concluded the user belonged nowhere, created them a fresh empty
 * "Home", and showed no documents and no DMs — while every document
 * they had ever written sat on the relay. Three "Home" communities from
 * one creator on one relay is what that looks like after it has
 * happened a few times.
 *
 * The flat model deletes the bug rather than patching it: a relay IS
 * the workspace, so a client with nothing stored is not placeless — it
 * is on whatever relay its wire points at, and the roster is fetched
 * fresh from there. Nothing is minted on first run because there is
 * nothing to mint.
 *
 * Removal still has to be honoured, because silently re-seating someone
 * who was removed would be a worse bug than the one being fixed.
 */

const relay = new MiniRelay(7821);
const creator = generateSecretKey();
const me = generateSecretKey();
const myPubkey = getPublicKey(me);
const myKeyHex = Buffer.from(me).toString("hex");

const CHANNEL = "22222222-2222-2222-2222-222222222222";
const ROSTER = "roster";

/** Nothing stored, every time — a fresh install / cleared browser. */
function blankState() {
  let stored: string | undefined;
  setStatePersistence({
    exists: () => stored !== undefined,
    read: () => stored,
    write: (text: string) => {
      stored = text;
    },
  });
}

async function publish(template: { kind: number; tags: string[][]; content?: string; at?: number }) {
  const event = finalizeEvent(
    {
      kind: template.kind,
      created_at: template.at ?? Math.floor(Date.now() / 1000),
      tags: template.tags,
      content: template.content ?? "",
    },
    creator
  );
  const wire = new BrowserWire([relay.url], myKeyHex);
  await (wire as unknown as { publishSigned(e: unknown): Promise<void> }).publishSigned(event);
  wire.close();
  return event;
}

async function boot() {
  blankState();
  const wire = new BrowserWire([relay.url], myKeyHex);
  const client = new FezClient(wire);
  await client.start();
  await new Promise((r) => setTimeout(r, 400));
  return { client, wire };
}

beforeAll(async () => {
  relay.workspace = { name: "Recovered", owner: getPublicKey(creator) };
  await relay.start();
  await publish({
    kind: 47101,
    tags: [["d", CHANNEL]],
    content: JSON.stringify({ name: "general", visibility: "open" }),
  });
});
afterAll(async () => {
  await relay.stop();
});

describe("a client with nothing stored", () => {
  test("lands on the relay its wire points at — it is never placeless", async () => {
    await publish({
      kind: 47102,
      tags: [["d", ROSTER], ["p", getPublicKey(creator), "owner"], ["p", myPubkey, "member"]],
      at: 1000,
    });

    const { client, wire } = await boot();
    expect(client.state.workspace.relay).toBe(relay.url);
    expect(client.state.workspace.owner).toBe(getPublicKey(creator));
    expect(client.state.workspace.channels.get(CHANNEL)?.name).toBe("general");
    expect(client.state.isMember(myPubkey)).toBe(true);
    wire.close();
  }, 20_000);

  test("mints nothing — the duplicate-Home bug has no way to happen", async () => {
    const { client, wire } = await boot();
    // There is no workspace event to create, so a returning user cannot
    // trigger a bootstrap that invents one. The old first-run path made
    // a community called "Home" every time local state was empty.
    expect(relay.events.filter((e) => e.kind === 47100)).toHaveLength(0);
    expect(relay.events.filter((e) => e.kind === 47101)).toHaveLength(1);
    expect(client.state.workspace.channels.size).toBe(1);
    wire.close();
  }, 20_000);

  test("removal is honoured — a later roster without you does not re-seat you", async () => {
    // The owner rewrites the roster without this pubkey.
    await publish({
      kind: 47102,
      tags: [["d", ROSTER], ["p", getPublicKey(creator), "owner"]],
      at: 2000,
    });

    const { client, wire } = await boot();
    expect(client.state.isMember(myPubkey)).toBe(false);
    wire.close();
  }, 20_000);
});
