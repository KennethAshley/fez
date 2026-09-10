import { afterEach, describe, expect, it, vi } from "vitest";
import { FezClient, K, setStatePersistence, type Wire, type WireEvent } from "../../fez-client/src/index.js";
import { invitePersona } from "../../fez-desktop/src/invite-persona";

const OWNER = "a".repeat(64);
const PERSON = "b".repeat(64);
const AGENT = "c".repeat(64);

function setup() {
  setStatePersistence({ exists: () => false, read: () => undefined, write: () => {} });
  const published: WireEvent[] = [];
  const wire: Wire = {
    pubkey: OWNER,
    publish: vi.fn(async (template) => {
      const event = { created_at: Math.floor(Date.now() / 1000), ...template,
        id: String(published.length).padStart(64, "0"), pubkey: OWNER, sig: "" };
      published.push(event);
      return event;
    }),
    subscribe: () => () => {}, query: async () => [],
    encrypt: (_pk, text) => text, decrypt: (_pk, text) => text,
    sendDm: async () => "", unwrapDm: () => undefined,
  };
  const client = new FezClient(wire);
  client.state.open("wss://workspace.test");
  client.state.describe({ owner: OWNER });
  client.state.workspace.members.set(OWNER, "owner");
  return { client, wire, published };
}

afterEach(() => vi.unstubAllGlobals());

describe("workspace action stability", () => {
  it("keeps both a person and an agent when invitations overlap", async () => {
    const { client, published } = setup();
    await Promise.all([client.invite(PERSON, "member"), client.invite(AGENT, "bot")]);
    expect([...client.state.workspace.members]).toEqual([[OWNER, "owner"], [PERSON, "member"], [AGENT, "bot"]]);
    expect(published[1].created_at).toBeGreaterThan(published[0].created_at);
  });

  it("does not resurrect a kicked member when an invitation overlaps", async () => {
    const { client } = setup();
    client.state.workspace.members.set(PERSON, "member");
    await Promise.all([client.kick(PERSON), client.invite(AGENT, "bot")]);
    expect([...client.state.workspace.members]).toEqual([[OWNER, "owner"], [AGENT, "bot"]]);
  });

  it("continues inviting after a publish fails without adding the failed invite", async () => {
    const { client, wire } = setup();
    vi.mocked(wire.publish).mockRejectedValueOnce(new Error("relay unavailable"));
    const results = await Promise.allSettled([client.invite(PERSON, "member"), client.invite(AGENT, "bot")]);
    expect(results.map(r => r.status)).toEqual(["rejected", "fulfilled"]);
    expect([...client.state.workspace.members]).toEqual([[OWNER, "owner"], [AGENT, "bot"]]);
  });

  it("does not apply queued invitations to a different workspace", async () => {
    const { client, published } = setup();
    const pending = client.invite(PERSON, "member");
    client.state.open("wss://other.test");
    client.state.describe({ owner: OWNER });
    await expect(pending).rejects.toThrow(/workspace changed/i);
    expect(published).toHaveLength(0);
  });

  it("preserves an existing roster when initializing its first channel", async () => {
    const { client } = setup();
    client.state.workspace.members.set(PERSON, "member");
    await client.claimWorkspace();
    expect(client.state.isMember(PERSON)).toBe(true);
  });

  it("refuses to reinitialize an existing workspace without publishing or losing members", async () => {
    const { client, published } = setup();
    client.state.workspace.members.set(PERSON, "member");
    const channelId = await client.createChannel("general");
    const count = published.length;
    await expect(client.claimWorkspace("another workspace")).rejects.toThrow(/already|existing/i);
    expect(published).toHaveLength(count);
    expect(client.state.workspace.members.has(PERSON)).toBe(true);
    expect([...client.state.workspace.channels.keys()]).toEqual([channelId]);
  });

  it("does not claim success on a relay with no verified owner", async () => {
    const { client, published } = setup();
    client.state.describe({ owner: undefined });
    await expect(client.claimWorkspace()).rejects.toThrow(/owner/i);
    expect(published).toHaveLength(0);
  });

  it("rejects blank channel names without publishing", async () => {
    const { client, published } = setup();
    await expect(client.createChannel("   ")).rejects.toThrow(/name/i);
    expect(published).toHaveLength(0);
  });

  it("keeps the current channel when creation fails", async () => {
    const { client, wire } = setup();
    const channelId = await client.createChannel("general");
    vi.mocked(wire.publish).mockRejectedValueOnce(new Error("relay unavailable"));
    await expect(client.createChannel("new")).rejects.toThrow("relay unavailable");
    expect(client.state.scope?.channelId).toBe(channelId);
    expect(client.state.workspace.channels.size).toBe(1);
  });

  it.each([
    ["not-a-key", "member", /key/i],
    [PERSON, "invalid", /role/i],
  ])("rejects invalid invitation %s / %s before publishing", async (key, role, error) => {
    const { client, published } = setup();
    await expect(client.invite(key, role as "member")).rejects.toThrow(error);
    expect(published).toHaveLength(0);
  });

  it("reports that a banned person must be unbanned before inviting", async () => {
    const { client, published } = setup();
    client.state.workspace.banned.set(PERSON, undefined);
    await expect(client.invite(PERSON, "member")).rejects.toThrow(/unban|banned/i);
    expect(published).toHaveLength(0);
  });
});

describe("local agent invitation errors", () => {
  it("preserves keychain access failures instead of reporting a missing key", async () => {
    const { client } = setup();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: async (cmd: string) => {
      if (cmd === "list_personas") return ["drift"];
      throw new Error("keychain access denied");
    } } });
    await expect(invitePersona(client, "@drift")).rejects.toThrow("keychain access denied");
  });

  it("preserves relay failures instead of reporting a missing agent key", async () => {
    const { client, wire } = setup();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: async (cmd: string) => {
      if (cmd === "list_personas") return ["drift"];
      if (cmd === "get_pubkey") return AGENT;
      throw new Error(`unexpected command: ${cmd}`);
    } } });
    vi.mocked(wire.publish).mockRejectedValueOnce(new Error("relay unavailable"));
    await expect(invitePersona(client, "@Drift")).rejects.toThrow("relay unavailable");
    expect(client.state.isMember(AGENT)).toBe(false);
  });

  it("reports a missing key without publishing an invitation", async () => {
    const { client, published } = setup();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: async (cmd: string) => {
      if (cmd === "list_personas") return ["drift"];
      throw new Error('no fez identity in the keychain for account "agent:drift"');
    } } });
    expect(await invitePersona(client, "@drift")).toEqual({ kind: "no-key", persona: "drift" });
    expect(published.filter(e => e.kind === K.MEMBERSHIP)).toHaveLength(0);
  });
});
