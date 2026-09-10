import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { BrowserWire } from "../../fez-desktop/src/wire.js";
import { FezClient, setStatePersistence } from "../../fez-client/dist/index.js";
import { waitForPort } from "./mini-relay.js";

/**
 * The requirement, end to end, against the real relay binary:
 *
 *   "a second person who joins, joins by invite to the workspace and
 *    sees all the channels and messages"
 *
 * Every word of that is load-bearing:
 *
 *  - **by invite to the WORKSPACE**, not to a channel. There is one
 *    roster, so there is no per-channel invite to forget.
 *  - **all the channels** — including ones created before they arrived,
 *    and ones created after.
 *  - **and messages** — which means the relay's read gate must let them
 *    through, the half that fails silently and looks like an empty app.
 *
 * The relay runs with the production policy set and a real owner, so
 * this exercises ingest gating, NIP-42 read gating and owner resolution
 * over NIP-11 together.
 */

const PORT = 7834;
const RELAY = `ws://127.0.0.1:${PORT}`;
const STORE = "/tmp/fez-workspace-invite.sqlite";

const ownerKey = generateSecretKey();
const ownerHex = Buffer.from(ownerKey).toString("hex");
const ownerPk = getPublicKey(ownerKey);

const guestKey = generateSecretKey();
const guestHex = Buffer.from(guestKey).toString("hex");
const guestPk = getPublicKey(guestKey);

let relay: ChildProcess;

/** Nothing stored — a fresh install, which is how a second person arrives. */
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
      "--policy", "membership",
      "--policy", "moderation",
      "--owner", ownerPk,
      "--name", "Raleigh, NC",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  await waitForPort(PORT, 20_000, relay);
}, 30_000);

afterAll(() => {
  relay?.kill();
  rmSync(STORE, { force: true });
});

describe("a second person joins the workspace", () => {
  const channels: Record<string, string> = {};

  test("the owner claims the relay and builds out the place", async () => {
    blankState();
    const wire = new BrowserWire([RELAY], ownerHex);
    const client = new FezClient(wire);
    await client.start();

    // Claiming publishes the first channel + a roster naming the owner.
    // No workspace event: the relay already exists, which is why this
    // can't mint a duplicate.
    const { channelId } = await client.claimWorkspace("food");
    channels.food = channelId;
    channels.sports = await client.createChannel("sports");
    channels.weather = await client.createChannel("weather");

    client.setScope(channels.food);
    await client.sendChannelMessage("best biscuits in town?");
    client.setScope(channels.sports);
    await client.sendChannelMessage("canes in 4");

    expect(client.state.workspace.name).toBe("Raleigh, NC");
    expect(client.state.workspace.channels.size).toBe(3);
    wire.close();
  }, 30_000);

  test("before the invite, the guest sees the workspace but none of its rooms", async () => {
    blankState();
    const wire = new BrowserWire([RELAY], guestHex);
    const client = new FezClient(wire);
    await client.start();

    // They can tell WHERE they are and who runs it — that is public, so
    // a stranger can decide whether to ask for an invite.
    expect(client.state.workspace.name).toBe("Raleigh, NC");
    expect(client.state.workspace.owner).toBe(ownerPk);
    expect(client.state.isMember(guestPk)).toBe(false);

    // …but the rooms are gated. Fail-closed on the read side is the one
    // protection clients cannot provide for each other.
    expect(client.messages(channels.food)).toHaveLength(0);
    wire.close();
  }, 30_000);

  test("the owner invites them to the workspace — one roster, not one channel", async () => {
    blankState();
    const wire = new BrowserWire([RELAY], ownerHex);
    const client = new FezClient(wire);
    await client.start();

    await client.invite(guestPk, "member");
    expect(client.state.isMember(guestPk)).toBe(true);

    // The invite names no channel at all. That is the whole point.
    // NIP-01 serves newest-first, so sort rather than trusting order.
    const rosters = await (wire as unknown as {
      query(f: object[]): Promise<{ tags: string[][]; created_at: number }[]>;
    }).query([{ kinds: [47102], "#d": ["roster"] }]);
    const roster = [...rosters].sort((a, b) => b.created_at - a.created_at)[0]!;
    expect(roster.tags.filter((t) => t[0] === "h")).toHaveLength(0);
    expect(roster.tags.some((t) => t[0] === "p" && t[1] === guestPk)).toBe(true);
    wire.close();
  }, 30_000);

  test("the guest lands and sees ALL the channels and their messages", async () => {
    blankState();
    const wire = new BrowserWire([RELAY], guestHex);
    const client = new FezClient(wire);
    await client.start();

    expect(client.state.isMember(guestPk)).toBe(true);

    // Every channel, including the two made after #food.
    const names = [...client.state.workspace.channels.values()].map((c) => c.name).sort();
    expect(names).toEqual(["food", "sports", "weather"]);

    // And the history in them — the half that silently fails when a
    // connection never authenticates, leaving an app that looks empty.
    await client.loadChannelHistory(channels.food);
    await client.loadChannelHistory(channels.sports);
    expect(client.messages(channels.food).map((m) => m.content)).toContain("best biscuits in town?");
    expect(client.messages(channels.sports).map((m) => m.content)).toContain("canes in 4");
    wire.close();
  }, 30_000);

  test("they can speak, and a channel made after they joined is theirs too", async () => {
    // Owner adds a room while the guest is already a member.
    blankState();
    const ownerWire = new BrowserWire([RELAY], ownerHex);
    const owner = new FezClient(ownerWire);
    await owner.start();
    channels.music = await owner.createChannel("music");
    ownerWire.close();

    blankState();
    const wire = new BrowserWire([RELAY], guestHex);
    const guest = new FezClient(wire);
    await guest.start();

    // No second invite was needed for the new room.
    expect([...guest.state.workspace.channels.values()].map((c) => c.name)).toContain("music");

    guest.setScope(channels.music);
    const said = await guest.sendChannelMessage("first!");
    expect(said.id).toBeTruthy();
    wire.close();
  }, 30_000);

  test("a stranger still cannot write — the roster is the gate", async () => {
    const strangerHex = Buffer.from(generateSecretKey()).toString("hex");
    blankState();
    const wire = new BrowserWire([RELAY], strangerHex);
    const client = new FezClient(wire);
    await client.start();
    client.state.scope = { channelId: channels.food };
    await expect(client.sendChannelMessage("let me in")).rejects.toThrow();
    wire.close();
  }, 30_000);

  test("overlapping person and agent invites grant live access without losing either member", async () => {
    const personKey = generateSecretKey();
    const agentKey = generateSecretKey();
    const personPk = getPublicKey(personKey);
    const agentPk = getPublicKey(agentKey);
    blankState();
    const ownerWire = new BrowserWire([RELAY], ownerHex);
    const personWire = new BrowserWire([RELAY], Buffer.from(personKey).toString("hex"));
    const agentWire = new BrowserWire([RELAY], Buffer.from(agentKey).toString("hex"));
    try {
      const owner = new FezClient(ownerWire);
      const person = new FezClient(personWire);
      const agent = new FezClient(agentWire);
      await owner.start();
      await person.start();
      await agent.start();
      expect(person.state.isMember(personPk)).toBe(false);
      expect(agent.state.isMember(agentPk)).toBe(false);

      await Promise.all([owner.invite(personPk, "member"), owner.invite(agentPk, "bot")]);
      await expect.poll(() => person.state.roleOf(personPk)).toBe("member");
      await expect.poll(() => agent.state.roleOf(agentPk)).toBe("bot");
      expect(owner.state.isMember(guestPk)).toBe(true);

      for (const client of [person, agent]) {
        await client.loadChannelHistory(channels.food);
        expect(client.messages(channels.food).map(m => m.content)).toContain("best biscuits in town?");
        client.setScope(channels.food);
        await client.sendChannelMessage(`joined as ${client.state.roleOf(client.pubkey)}`);
      }
      owner.setScope(channels.food);
      await owner.sendChannelMessage("welcome person and agent");
      await expect.poll(() => person.messages(channels.food).map(m => m.content)).toContain("welcome person and agent");
      await expect.poll(() => agent.messages(channels.food).map(m => m.content)).toContain("welcome person and agent");
    } finally {
      ownerWire.close();
      personWire.close();
      agentWire.close();
    }
  }, 30_000);
});
