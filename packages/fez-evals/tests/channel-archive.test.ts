import { describe, it, expect, beforeEach } from "vitest";
import { WorkspaceState } from "../../fez-client/dist/workspace-state.js";

/**
 * Owner-signed channel archive. A channel is created but never destroyed —
 * its events are real history — so "remove it" is the owner republishing
 * the same 47101 with `archived: true`. Latest-wins carries it, only the
 * owner's signature counts, and it reverses. These pin exactly that.
 */

const OWNER = "a".repeat(64);
const STRANGER = "f".repeat(64);
const RELAY = "wss://archive.example";
const CHAN = "chan-1";
const KIND_CHANNEL = 47101;

let idc = 0;
function ev(pubkey: string, content: string, created_at: number) {
  return { id: `e${idc++}`.padEnd(64, "0"), kind: KIND_CHANNEL, pubkey, created_at, content, tags: [["d", CHAN]] };
}

describe("channel archive", () => {
  let ws: WorkspaceState;
  beforeEach(() => {
    ws = new WorkspaceState();
    ws.open(RELAY);
    ws.describe({ owner: OWNER });
  });

  it("a fresh channel is visible, not archived", () => {
    ws.absorb(ev(OWNER, JSON.stringify({ name: "todo-app" }), 1000));
    const c = ws.workspace.channels.get(CHAN);
    expect(c?.name).toBe("todo-app");
    expect(c?.archived).toBeUndefined();
  });

  it("the owner archives by republishing with archived:true (latest-wins)", () => {
    ws.absorb(ev(OWNER, JSON.stringify({ name: "todo-app" }), 1000));
    ws.absorb(ev(OWNER, JSON.stringify({ name: "todo-app", archived: true }), 1001));
    expect(ws.workspace.channels.get(CHAN)?.archived).toBe(true);
  });

  it("archiving preserves the channel's source and meta", () => {
    ws.absorb(ev(OWNER, JSON.stringify({ name: "todo-app", source: "fez-git", meta: { branch: "main" } }), 1000));
    ws.absorb(ev(OWNER, JSON.stringify({ name: "todo-app", source: "fez-git", meta: { branch: "main" }, archived: true }), 1001));
    const c = ws.workspace.channels.get(CHAN);
    expect(c?.archived).toBe(true);
    expect(c?.source).toBe("fez-git");
    expect(c?.meta?.branch).toBe("main");
  });

  it("a stranger cannot archive a channel", () => {
    ws.absorb(ev(OWNER, JSON.stringify({ name: "todo-app" }), 1000));
    const applied = ws.absorb(ev(STRANGER, JSON.stringify({ name: "todo-app", archived: true }), 2000));
    expect(applied).toBe(false);
    expect(ws.workspace.channels.get(CHAN)?.archived).toBeUndefined();
  });

  it("reverses — the owner unarchives by republishing without the flag", () => {
    ws.absorb(ev(OWNER, JSON.stringify({ name: "todo-app" }), 1000));
    ws.absorb(ev(OWNER, JSON.stringify({ name: "todo-app", archived: true }), 1001));
    ws.absorb(ev(OWNER, JSON.stringify({ name: "todo-app" }), 1002));
    expect(ws.workspace.channels.get(CHAN)?.archived).toBeUndefined();
  });

  it("an older archive replayed cannot un-see a newer unarchive", () => {
    ws.absorb(ev(OWNER, JSON.stringify({ name: "todo-app", archived: true }), 1001));
    ws.absorb(ev(OWNER, JSON.stringify({ name: "todo-app" }), 1002)); // newer: unarchived
    ws.absorb(ev(OWNER, JSON.stringify({ name: "todo-app", archived: true }), 1000)); // stale replay
    expect(ws.workspace.channels.get(CHAN)?.archived).toBeUndefined();
  });
});
