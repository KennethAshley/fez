import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { FezClient, K, setStatePersistence, type Wire, type WireEvent } from "../../fez-client/src/index.js";
import { makeChannels } from "../../../src/protocol/channels.js";

// Real client/state and signed events; only the transport is in memory.
function setup() {
  const key = generateSecretKey();
  const events: WireEvent[] = [];
  const signEvent = (template: Parameters<Wire["publish"]>[0]) =>
    finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...template }, key);
  const wire = {
    pubkey: getPublicKey(key),
    signEvent,
    publish: vi.fn(async (template: Parameters<Wire["publish"]>[0]) => {
      const event = signEvent(template);
      events.push(event);
      return event;
    }),
    query: async () => events,
    subscribe: () => () => {},
    encrypt: (_peer: string, text: string) => text,
    decrypt: (_peer: string, text: string) => text,
    sendDm: async () => { throw new Error("unexpected DM"); },
    unwrapDm: () => undefined,
  } satisfies Wire;
  setStatePersistence({ exists: () => false, read: () => undefined, write: () => {} });
  const client = new FezClient(wire);
  client.state.open("ws://channel-selection.test");
  client.state.describe({ owner: wire.pubkey });
  const seed = (id: string, content: Record<string, unknown>, created_at = 100) => {
    const event = signEvent({ kind: K.CHANNEL, tags: [["d", id]], content: JSON.stringify(content), created_at });
    events.push(event);
    client.state.absorb(event);
    return event;
  };
  return { client, wire, seed, events };
}

afterEach(() => vi.restoreAllMocks());

describe("stable channel selection", () => {
  it("normalizes visibility consistently in client state and headless listings", async () => {
    const { client, wire, seed } = setup();
    for (const [index, visibility] of [undefined, "open", "closed", "invalid", true].entries()) {
      seed(String(index), { name: `channel-${index}`, visibility });
    }
    const expected = ["open", "open", "closed", "open", "open"];
    expect(client.channelsFrom().map(channel => channel.visibility)).toEqual(expected);
    expect((await makeChannels(wire, wire.pubkey).list()).map(channel => channel.visibility)).toEqual(expected);
  });

  it("lists all channels without a source and retains binding state when filtering", () => {
    const { client, seed } = setup();
    seed("ordinary", { name: "general", visibility: "open" });
    seed("bound", { name: "renamed", source: "mining", meta: { miningWorkspace: "true" }, archived: true, visibility: "closed" });
    expect(client.channelsFrom().map(channel => channel.id)).toEqual(["ordinary", "bound"]);
    expect(client.channelsFrom("mining")).toEqual([{
      id: "bound", name: "renamed", source: "mining", meta: { miningWorkspace: "true" }, archived: true, visibility: "closed",
    }]);
    expect(client.channelsFrom("missing")).toEqual([]);
  });

  it("renames by ID even when the new name belongs to another channel, preserving omitted fields", async () => {
    const { client, wire, seed } = setup();
    const original = seed("bound", { name: "old", source: "mining", meta: { miningWorkspace: "true", unrelated: "keep" }, visibility: "closed", archived: true }, Math.floor(Date.now() / 1000) + 60);
    seed("other", { name: "new", meta: { unrelated: "other" } });
    expect(await client.ensureChannel({ id: "bound", name: "new" })).toBe("bound");
    expect(client.state.workspace.channels.get("bound")).toMatchObject({
      name: "new", source: "mining", meta: { miningWorkspace: "true", unrelated: "keep" }, visibility: "closed", archived: true,
    });
    expect(client.state.workspace.channels.get("other")?.meta).toEqual({ unrelated: "other" });
    const update = await wire.publish.mock.results[0].value;
    expect(update.created_at).toBeGreaterThan(original.created_at);
    client.state.absorb(original);
    expect(client.state.workspace.channels.get("bound")?.name).toBe("new");
  });

  it("creates an explicit unknown ID without adopting an unrelated name match", async () => {
    const { client, seed } = setup();
    seed("unrelated", { name: "mining", meta: { unrelated: "keep" } });
    expect(await client.ensureChannel({ id: "requested", name: "mining", meta: { miningWorkspace: "true" } })).toBe("requested");
    expect(client.state.workspace.channels.size).toBe(2);
    expect(client.state.workspace.channels.get("unrelated")?.meta).toEqual({ unrelated: "keep" });
    expect(client.state.workspace.channels.get("requested")?.meta).toEqual({ miningWorkspace: "true" });
  });

  it("leaves omitted fields alone, applies explicit metadata replacement, and advances every edit", async () => {
    const { client, wire, seed } = setup();
    seed("bound", { name: "mining", source: "mining", meta: { old: "value" }, visibility: "closed" }, Math.floor(Date.now() / 1000) + 60);
    expect(await client.ensureChannel({ name: "MINING" })).toBe("bound");
    expect(wire.publish).not.toHaveBeenCalled();
    await client.ensureChannel({ id: "bound", name: "mining", meta: { miningWorkspace: "true" } });
    const first = client.state.workspace.channels.get("bound")!;
    expect(first).toMatchObject({ source: "mining", visibility: "closed", meta: { miningWorkspace: "true" } });
    await client.ensureChannel({ id: "bound", name: "mining", visibility: "open", meta: {} });
    const second = client.state.workspace.channels.get("bound")!;
    expect(second).toMatchObject({ source: "mining", visibility: "open" });
    expect(second.meta).toBeUndefined();
    expect(second.createdAt).toBeGreaterThan(first.createdAt);
    await client.ensureChannel({ id: "bound", name: "mining", visibility: "closed" });
    expect(client.state.workspace.channels.get("bound")?.visibility).toBe("closed");
  });

  it("lets non-owners resolve an ID but never edit it or fall back from an unknown ID", async () => {
    const { client, wire, seed } = setup();
    seed("bound", { name: "renamed", meta: { keep: "yes" } });
    client.state.workspace.owner = getPublicKey(generateSecretKey());
    expect(await client.ensureChannel({ id: "bound", name: "old", meta: {} })).toBe("bound");
    expect(await client.ensureChannel({ id: "unknown", name: "renamed" })).toBeUndefined();
    expect(client.state.workspace.channels.get("bound")?.meta).toEqual({ keep: "yes" });
    expect(wire.publish).not.toHaveBeenCalled();
  });

  it("trims names, reuses normalized names without editing them, and moves scope", async () => {
    const { client, wire } = setup();
    const id = await client.createChannel("  Mining  ");
    expect(client.state.workspace.channels.get(id)?.name).toBe("Mining");
    client.leaveScope();
    expect(await client.createChannel(" mining ")).toBe(id);
    expect(client.state.scope?.channelId).toBe(id);
    expect(client.state.workspace.channels.size).toBe(1);
    expect(wire.publish).toHaveBeenCalledTimes(1);
  });

  it("rejects blank names before publishing", async () => {
    const { client, wire } = setup();
    await expect(client.createChannel(" \t\n ")).rejects.toThrow(/name/i);
    expect(wire.publish).not.toHaveBeenCalled();
    expect(client.state.workspace.channels.size).toBe(0);
  });

  it("coalesces concurrent same-name creates through the asynchronous publish", async () => {
    const { client, wire } = setup();
    const ids = await Promise.all([client.createChannel("Mining"), client.createChannel(" mining "), client.createChannel("MINING")]);
    expect(new Set(ids).size).toBe(1);
    expect(client.state.workspace.channels.size).toBe(1);
    expect(wire.publish).toHaveBeenCalledTimes(1);
  });

  it("allows retrying a failed creation", async () => {
    const { client, wire } = setup();
    wire.publish.mockRejectedValueOnce(new Error("relay unavailable"));
    const failed = await Promise.allSettled([client.createChannel("Mining"), client.createChannel(" mining ")]);
    expect(failed.map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(wire.publish).toHaveBeenCalledTimes(1);
    expect(client.state.workspace.channels.size).toBe(0);
    const id = await client.createChannel("Mining");
    expect(client.state.workspace.channels.get(id)?.name).toBe("Mining");
  });

  it("applies an ensure's metadata when it races a same-name create", async () => {
    const { client } = setup();
    const [created, bound] = await Promise.all([
      client.createChannel("Mining"),
      client.ensureChannel({ name: "mining", meta: { miningWorkspace: "true" } }),
    ]);
    expect(bound).toBe(created);
    expect(client.state.workspace.channels.size).toBe(1);
    expect(client.state.workspace.channels.get(created)?.meta).toEqual({ miningWorkspace: "true" });
  });

  it("retains closed visibility across archive and unarchive", async () => {
    const { client, seed } = setup();
    seed("bound", { name: "mining", visibility: "closed", source: "mining", meta: { miningWorkspace: "true" } });
    await client.archiveChannel("bound");
    expect(client.channelsFrom("mining")[0]).toMatchObject({ archived: true, visibility: "closed" });
    await client.archiveChannel("bound", false);
    expect(client.channelsFrom("mining")[0]).toMatchObject({ visibility: "closed", meta: { miningWorkspace: "true" } });
    expect(client.channelsFrom("mining")[0].archived).toBeUndefined();
  });
});

it("headless channel listing exposes the latest rename, binding, archive and visibility", async () => {
  const { wire, seed, events } = setup();
  seed("bound", { name: "old", source: "mining", visibility: "open" }, 100);
  seed("bound", { name: "renamed", source: "mining", meta: { miningWorkspace: "true" }, archived: true, visibility: "closed" }, 200);
  seed("ordinary", { name: "general" });
  events.reverse();
  const channels = makeChannels(wire, wire.pubkey);
  expect((await channels.list()).find(channel => channel.id === "bound")).toEqual({
    id: "bound", name: "renamed", source: "mining", meta: { miningWorkspace: "true" }, archived: true, visibility: "closed",
  });
  expect(await channels.ensure({ name: "general" })).toBe("ordinary");
  expect(wire.publish).not.toHaveBeenCalled();
});
