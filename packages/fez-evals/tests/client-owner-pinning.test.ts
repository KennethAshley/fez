import { beforeEach, describe, expect, it } from "vitest";
import * as clientApi from "../../fez-client/src/index.js";
import { FezClient, WorkspaceState, setStatePersistence, type Wire, type WireEvent } from "../../fez-client/src/index.js";

const OWNER = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const MEMBER = "ef".repeat(32);
const RELAY = "wss://relay.example";
let stored: string | undefined;
let writeFailure = false;

beforeEach(() => {
  stored = undefined;
  writeFailure = false;
  setStatePersistence({
    exists: () => stored !== undefined,
    read: () => stored,
    write: text => { if (writeFailure) throw new Error("disk full"); stored = text; },
  });
});

function roster(owner = OWNER): WireEvent {
  return { id: "01".repeat(32), sig: "", kind: 47102, pubkey: owner, created_at: 1,
    content: "", tags: [["d", "roster"], ["p", MEMBER, "member"]] };
}
function wire(overrides: Partial<Wire> = {}): Wire {
  return { pubkey: MEMBER, relays: [RELAY], query: async () => [], subscribe: () => () => {},
    publish: async () => { throw new Error("unexpected publish"); },
    encrypt: (_key, text) => text, decrypt: (_key, text) => text,
    sendDm: async () => "", unwrapDm: () => undefined, ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("durable client workspace authority", () => {
  it("restores the owner after restart and rejects a changed advertised owner before admitting its roster", async () => {
    const initial = new FezClient(wire({ relayInfo: async () => ({ pubkey: OWNER }) }));
    await initial.openWorkspace(RELAY);
    const restarted = new FezClient(wire({ relayInfo: async () => ({ pubkey: OTHER }), query: async () => [roster(OTHER)] }));
    await expect(restarted.start()).rejects.toThrow(/owner/i);
    expect(restarted.state.workspace.owner).toBe(OWNER);
    expect(restarted.state.isMember(MEMBER)).toBe(false);
  });

  it("preserves the pin and accepts only its signed roster during metadata outage", async () => {
    const state = new WorkspaceState();
    state.open(RELAY);
    state.describe({ owner: OWNER });
    const client = new FezClient(wire({ relayInfo: async () => { throw new Error("offline"); }, query: async () => [roster(OTHER), roster()] }));
    await client.start();
    expect(client.state.workspace.owner).toBe(OWNER);
    expect(client.state.isMember(MEMBER)).toBe(true);
    client.state.open("wss://elsewhere.example");
    client.state.open("WSS://RELAY.example:443/");
    expect(client.state.workspace.owner).toBe(OWNER);
    expect(client.state.known.filter(entry => entry.relay === RELAY)).toHaveLength(1);
  });

  it("pins a trusted invite even without metadata and never lets expected owner replace a pin", async () => {
    const client = new FezClient(wire());
    expect(await client.openWorkspace(RELAY, OWNER.toUpperCase())).toBe(true);
    expect(client.state.workspace.owner).toBe(OWNER);
    await expect(client.openWorkspace(RELAY, OTHER)).rejects.toThrow(/owner/i);
    expect(client.state.workspace.owner).toBe(OWNER);
  });

  it("rejects a first invite when discovery names another owner", async () => {
    const client = new FezClient(wire({ relayInfo: async () => ({ pubkey: OTHER }) }));
    await expect(client.openWorkspace(RELAY, OWNER)).rejects.toThrow(/owner/i);
    expect(client.state.isMember(OTHER)).toBe(false);
  });

  it("does not install or retain a new authority when persistence fails", () => {
    const state = new WorkspaceState();
    state.open(RELAY);
    writeFailure = true;
    expect(() => state.describe({ owner: OWNER })).toThrow("disk full");
    expect(state.workspace.owner).toBeUndefined();
    expect(state.absorb(roster())).toBe(false);
  });

  it.each(["{", "null", '{"workspaces":{}}', JSON.stringify({ workspaces: [{ relay: RELAY, owner: "bad" }], active: RELAY }),
    JSON.stringify({ workspaces: [{ relay: RELAY, owner: OWNER }, { relay: "WSS://RELAY.example:443/", owner: OTHER }] })])("rejects corrupt persisted trust: %s", value => {
    stored = value;
    expect(() => new WorkspaceState().load()).toThrow();
  });

  it("loads an existing pin when opening directly without start", async () => {
    const initial = new FezClient(wire({ relayInfo: async () => ({ pubkey: OWNER }) }));
    await initial.openWorkspace(RELAY);
    const restarted = new FezClient(wire({ relayInfo: async () => ({ pubkey: OTHER }) }));
    await expect(restarted.openWorkspace(RELAY)).rejects.toThrow(/owner/i);
  });

  it("can forget an unclaimed active workspace without corrupting persisted state", async () => {
    const client = new FezClient(wire());
    await client.openWorkspace(RELAY);
    client.forgetWorkspace(RELAY);
    const state = new WorkspaceState();
    expect(() => state.load()).not.toThrow();
    expect(state.known).toEqual([]);
  });

  it("retains authority after forgetting and rejoining a workspace", async () => {
    const client = new FezClient(wire());
    await client.openWorkspace(RELAY, OWNER);
    client.forgetWorkspace(RELAY);
    expect(client.workspaces()).toEqual([]);
    const restarted = new FezClient(wire({ relayInfo: async () => ({ pubkey: OTHER }) }));
    await expect(restarted.openWorkspace(RELAY)).rejects.toThrow(/owner/i);
  });

  it("restores a host pin when client storage is empty and fails closed on host storage errors", async () => {
    const client = new FezClient(wire({ pinWorkspaceOwner: async () => OWNER }));
    await client.openWorkspace(RELAY);
    expect(client.state.workspace.owner).toBe(OWNER);
    const failed = new FezClient(wire({ relayInfo: async () => ({ pubkey: OTHER }), pinWorkspaceOwner: async () => { throw new Error("host trust unreadable"); } }));
    await expect(failed.openWorkspace("wss://fresh.example")).rejects.toThrow("host trust unreadable");
    expect(failed.state.workspace.owner).toBeUndefined();
  });

  it("refuses conflicting host and client pins", async () => {
    const client = new FezClient(wire({ pinWorkspaceOwner: async () => OTHER }));
    await expect(client.openWorkspace(RELAY, OWNER)).rejects.toThrow(/owner/i);
    expect(client.state.workspace.owner).toBe(OWNER);
    expect(client.state.absorb(roster(OTHER))).toBe(false);
  });

  it("ignores a delayed live roster from the previous workspace", async () => {
    const listeners: ((event: WireEvent) => void)[] = [];
    const client = new FezClient(wire({ relayInfo: async () => ({ pubkey: OWNER }), subscribe: (_filters, listener) => {
      listeners.push(listener);
      return () => {};
    } }));
    await client.openWorkspace(RELAY);
    await client.openWorkspace("wss://other.example");
    listeners[0](roster());
    expect(client.state.isMember(MEMBER)).toBe(false);
  });

  it("cannot overwrite corrupt trust by retrying open after a failed reload", () => {
    const state = new WorkspaceState();
    state.open(RELAY, undefined, OWNER);
    stored = "{";
    expect(() => state.load()).toThrow();
    expect(() => state.open(RELAY, undefined, OTHER)).toThrow();
    expect(stored).toBe("{");
  });

  it("does not overwrite another workspace with late metadata", async () => {
    const slow = deferred<{ pubkey: string }>();
    const client = new FezClient(wire({ relayInfo: async relay => relay === RELAY ? slow.promise : { pubkey: OTHER } }));
    const first = client.openWorkspace(RELAY);
    await client.openWorkspace("wss://other.example");
    slow.resolve({ pubkey: OWNER });
    await expect(first).rejects.toThrow(/workspace changed/i);
    expect(client.state.workspace.owner).toBe(OTHER);
  });

  it("discards a previous workspace's roster even if the new workspace has the same owner", async () => {
    const slow = deferred<WireEvent[]>();
    let calls = 0;
    const querying = deferred<void>();
    const client = new FezClient(wire({ relayInfo: async () => ({ pubkey: OWNER }), query: async () => {
      if (++calls === 1) { querying.resolve(); return slow.promise; }
      return [];
    } }));
    const first = client.openWorkspace(RELAY);
    await querying.promise;
    await client.openWorkspace("wss://other.example");
    slow.resolve([roster()]);
    await expect(first).rejects.toThrow(/workspace changed/i);
    expect(client.state.isMember(MEMBER)).toBe(false);
  });
});

describe("shared workspace identity rules", () => {
  it("canonicalizes only relay URL identity, preserving case-sensitive paths and queries", () => {
    expect(clientApi.normalizeWorkspaceRelay(" WSS://Relay.Example:443/ ")).toBe(RELAY);
    expect(clientApi.normalizeWorkspaceRelay("wss://Relay.Example/Team/?Token=AbC")).toBe("wss://relay.example/Team/?Token=AbC");
    for (const bad of ["https://relay.example", "hello", "wss://user:secret@relay.example", "wss://relay.example/#fragment"]) {
      expect(() => clientApi.normalizeWorkspaceRelay(bad)).toThrow();
    }
  });

  it("resolves expected, pinned and advertised keys without permitting rotation or malformed keys", () => {
    expect(clientApi.resolveWorkspaceOwner(undefined, OWNER.toUpperCase())).toBe(OWNER);
    expect(clientApi.resolveWorkspaceOwner(OWNER, undefined)).toBe(OWNER);
    expect(clientApi.resolveWorkspaceOwner(undefined, undefined, OWNER)).toBe(OWNER);
    expect(clientApi.resolveWorkspaceOwner(undefined, undefined)).toBeUndefined();
    for (const args of [[OWNER, OTHER], [OWNER, undefined, OTHER], [undefined, OTHER, OWNER], ["bad", undefined], [undefined, ""], [undefined, undefined, "bad"]] as const) {
      expect(() => clientApi.resolveWorkspaceOwner(...args)).toThrow(/owner|pubkey/i);
    }
  });
});
