import { beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceState,
  nameFromRelay,
  setStatePersistence,
} from "../../fez-client/dist/workspace-state.js";

/**
 * A relay IS a workspace. These pin the rules that flattening depends on:
 * one owner decides, one roster covers every channel, and switching
 * workspaces never destroys the one you left — the bug that started all
 * of this, where changing the relay in settings made a real user believe
 * his account was gone.
 */

const OWNER = "a".repeat(64);
const IMPOSTOR = "b".repeat(64);
const ALICE = "c".repeat(64);
const BOB = "d".repeat(64);

const RELAY = "wss://raleigh.example";

let id = 0;
const event = (over: Partial<{ kind: number; pubkey: string; created_at: number; content: string; tags: string[][]; id: string }>) => ({
  id: over.id ?? `e${++id}`.padEnd(64, "0"),
  kind: over.kind ?? 47101,
  pubkey: over.pubkey ?? OWNER,
  created_at: over.created_at ?? 1000,
  content: over.content ?? "",
  tags: over.tags ?? [],
});

const channel = (cid: string, name: string, over: Partial<{ pubkey: string; created_at: number }> = {}) =>
  event({ kind: 47101, tags: [["d", cid]], content: JSON.stringify({ name }), ...over });

const roster = (members: [string, string][], over: Partial<{ pubkey: string; created_at: number; id: string }> = {}) =>
  event({ kind: 47102, tags: [["d", "roster"], ...members.map(([pk, role]) => ["p", pk, role])], ...over });

function freshState(): WorkspaceState {
  let stored: string | undefined;
  setStatePersistence({
    exists: () => stored !== undefined,
    read: () => stored,
    write: (t: string) => { stored = t; },
  });
  const state = new WorkspaceState();
  state.open(RELAY);
  return state;
}

let state: WorkspaceState;
beforeEach(() => {
  state = freshState();
});

describe("the owner is the only authority", () => {
  it("absorbs nothing until the relay says who owns it", () => {
    // An unclaimed workspace: the first passer-by must not be able to
    // seize it by publishing a roster naming themselves.
    expect(state.absorb(channel("c1", "food"))).toBe(false);
    expect(state.absorb(roster([[IMPOSTOR, "owner"]], { pubkey: IMPOSTOR }))).toBe(false);
    expect(state.workspace.channels.size).toBe(0);
    expect(state.isMember(IMPOSTOR)).toBe(false);
  });

  it("takes channels and rosters from the owner", () => {
    state.describe({ owner: OWNER, name: "Raleigh, NC" });
    expect(state.absorb(channel("c1", "food"))).toBe(true);
    expect(state.absorb(roster([[ALICE, "member"]]))).toBe(true);
    expect(state.workspace.channels.get("c1")?.name).toBe("food");
    expect(state.isMember(ALICE)).toBe(true);
    expect(state.workspace.name).toBe("Raleigh, NC");
  });

  it("ignores a channel or roster signed by anyone else", () => {
    state.describe({ owner: OWNER });
    expect(state.absorb(channel("c9", "hijack", { pubkey: IMPOSTOR }))).toBe(false);
    expect(state.absorb(roster([[IMPOSTOR, "owner"]], { pubkey: IMPOSTOR }))).toBe(false);
    expect(state.workspace.channels.size).toBe(0);
    expect(state.isMember(IMPOSTOR)).toBe(false);
  });
});

describe("one roster covers every channel", () => {
  beforeEach(() => {
    state.describe({ owner: OWNER });
    state.absorb(channel("food", "food"));
    state.absorb(channel("sports", "sports"));
    state.absorb(channel("weather", "weather"));
    state.absorb(roster([[ALICE, "member"]]));
  });

  it("an invited member sees the whole workspace, not one channel", () => {
    // The requirement in one line: joins by invite, sees all channels.
    expect(state.workspace.channels.size).toBe(3);
    expect(state.isMember(ALICE)).toBe(true);
    for (const id of ["food", "sports", "weather"]) {
      expect(state.workspace.channels.has(id)).toBe(true);
    }
  });

  it("a stranger is in no channel", () => {
    expect(state.isMember(BOB)).toBe(false);
  });

  it("rejects a per-channel roster — that is the old model leaking", () => {
    const perChannel = event({ kind: 47102, tags: [["d", "food"], ["p", BOB, "member"]], created_at: 2000 });
    expect(state.absorb(perChannel)).toBe(false);
    expect(state.isMember(BOB)).toBe(false);
  });

  it("the owner is a member without being listed", () => {
    expect(state.isMember(OWNER)).toBe(true);
    expect(state.roleOf(OWNER)).toBe("owner");
  });
});

describe("roster ordering", () => {
  beforeEach(() => state.describe({ owner: OWNER }));

  it("a later roster replaces an earlier one", () => {
    state.absorb(roster([[ALICE, "member"]], { created_at: 1000 }));
    state.absorb(roster([[BOB, "member"]], { created_at: 2000 }));
    expect(state.isMember(ALICE)).toBe(false);
    expect(state.isMember(BOB)).toBe(true);
  });

  it("an older roster replayed does not resurrect a removed member", () => {
    state.absorb(roster([[ALICE, "member"], [BOB, "member"]], { created_at: 2000 }));
    state.absorb(roster([[ALICE, "member"]], { created_at: 1000 })); // stale replay
    expect(state.isMember(BOB)).toBe(true);
  });

  it("breaks a same-second tie by lowest id, so every client converges", () => {
    const a = roster([[ALICE, "member"]], { created_at: 5000, id: "a".repeat(64) });
    const b = roster([[BOB, "member"]], { created_at: 5000, id: "f".repeat(64) });
    const forward = freshState();
    forward.describe({ owner: OWNER });
    forward.absorb(a);
    forward.absorb(b);
    const backward = freshState();
    backward.describe({ owner: OWNER });
    backward.absorb(b);
    backward.absorb(a);
    expect(forward.isMember(ALICE)).toBe(backward.isMember(ALICE));
    expect(forward.isMember(BOB)).toBe(backward.isMember(BOB));
  });
});

describe("bans", () => {
  beforeEach(() => {
    state.describe({ owner: OWNER });
    state.absorb(roster([[ALICE, "member"]]));
  });

  it("a banned member is a non-member without leaving the roster", () => {
    state.absorb(event({ kind: 30047, tags: [["d", "bans"], ["p", ALICE]], created_at: 2000 }));
    expect(state.isMember(ALICE)).toBe(false);
    expect(state.isBanned(ALICE)).toBe(true);
    expect(state.workspace.members.has(ALICE)).toBe(true); // roster untouched — unban restores instantly
  });

  it("only the owner's ban list counts", () => {
    state.absorb(event({ kind: 30047, pubkey: IMPOSTOR, tags: [["d", "bans"], ["p", ALICE]], created_at: 2000 }));
    expect(state.isMember(ALICE)).toBe(true);
  });
});

describe("the rail — switching must never feel like losing", () => {
  it("keeps every workspace you have added", () => {
    state.open("wss://other.example");
    expect(state.known.map((w) => w.relay)).toEqual([RELAY, "wss://other.example"]);
  });

  it("returns you to the channel you were in", () => {
    state.describe({ owner: OWNER });
    state.absorb(channel("food", "food"));
    state.scope = { channelId: "food" };
    state.save();

    state.open("wss://other.example");
    expect(state.scope).toBeNull(); // never been there

    state.open(RELAY);
    expect(state.scope).toEqual({ channelId: "food" });
  });

  it("survives a reload — the rail is what settings replaced before", () => {
    state.open("wss://other.example");
    state.scope = { channelId: "x" };
    state.save();

    const reloaded = new WorkspaceState();
    reloaded.load();
    expect(reloaded.known.map((w) => w.relay).sort()).toEqual([RELAY, "wss://other.example"].sort());
    expect(reloaded.workspace.relay).toBe("wss://other.example");
    expect(reloaded.scope).toEqual({ channelId: "x" });
  });

  it("forgetting one leaves the others", () => {
    state.open("wss://other.example");
    state.forget(RELAY);
    expect(state.known.map((w) => w.relay)).toEqual(["wss://other.example"]);
  });
});

describe("naming a workspace when the relay offers none", () => {
  it("reads like a place, not a URL", () => {
    expect(nameFromRelay("ws://localhost:7777")).toBe("Local");
    expect(nameFromRelay("wss://raleigh.example.com")).toBe("raleigh");
    expect(nameFromRelay("wss://relay.buzz.example")).toBe("buzz");
  });
});
