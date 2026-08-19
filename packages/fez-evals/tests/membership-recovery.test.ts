import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { BrowserWire } from "../../fez-desktop/src/wire.js";
import { FezClient, setStatePersistence } from "../../fez-client/dist/index.js";
import { MiniRelay } from "./mini-relay.js";

/**
 * Losing local state must not lose your communities.
 *
 * Found the hard way: a real client came up with empty local state,
 * concluded the user belonged to no communities, created them a fresh
 * empty "Home", and showed no documents and no DMs — while every
 * document they had ever written sat on the relay, in communities they
 * were still a member of. Four "Home" communities on one relay is what
 * that looks like after it has happened a few times.
 *
 * The cause was treating a CACHE as the record. Membership is a signed
 * event naming your pubkey; the client's local copy is a convenience.
 * So: a client with nothing stored must rebuild from the relay — and
 * must still honour removal, because silently rejoining a community you
 * were removed from is a worse bug than the one being fixed.
 */

const relay = new MiniRelay(7821);
const creator = generateSecretKey();
const me = generateSecretKey();
const myPubkey = getPublicKey(me);
const myKeyHex = Buffer.from(me).toString("hex");

const COMMUNITY = "11111111-1111-1111-1111-111111111111";
const CHANNEL = "22222222-2222-2222-2222-222222222222";

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
  await relay.start();
  await publish({ kind: 47100, tags: [["d", COMMUNITY]], content: JSON.stringify({ name: "Recovered" }) });
  await publish({
    kind: 47101,
    tags: [["d", CHANNEL], ["c", COMMUNITY]],
    content: JSON.stringify({ name: "general", visibility: "open" }),
  });
});
afterAll(async () => {
  await relay.stop();
});

describe("membership recovery", () => {
  test("a client with nothing stored rebuilds its communities from the relay", async () => {
    await publish({
      kind: 47102,
      tags: [["d", CHANNEL], ["c", COMMUNITY], ["p", myPubkey, "member"]],
      at: 1000,
    });

    const { client, wire } = await boot();
    expect([...client.state.joined]).toContain(COMMUNITY);
    expect(client.state.communities.get(COMMUNITY)?.name).toBe("Recovered");
    wire.close();
  }, 20_000);

  test("it does NOT invent a fresh Home when the relay knows who you are", async () => {
    const { client, wire } = await boot();
    const names = [...client.state.communities.values()].map((c) => c.name);
    // The first-run bootstrap creates a community called "Home"; a
    // returning user must never trigger it.
    expect(names).not.toContain("Home");
    expect(client.state.joined.size).toBe(1);
    wire.close();
  }, 20_000);

  test("removal is honoured — a later roll without you does not rejoin you", async () => {
    // The creator rewrites the roll without this pubkey.
    await publish({
      kind: 47102,
      tags: [["d", CHANNEL], ["c", COMMUNITY], ["p", getPublicKey(creator), "owner"]],
      at: 2000,
    });

    const { client, wire } = await boot();
    expect([...client.state.joined]).not.toContain(COMMUNITY);
    wire.close();
  }, 20_000);
});
