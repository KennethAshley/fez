import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { kindWhitelistPolicy } from "../../fez-relay/src/policies.js";
import { readTeamMemory, teamMemoryHeads, buildTeamMemory } from "../../fez-client/src/memory.js";
import { WorkspaceState } from "../../fez-client/src/workspace-state.js";
import type { WireEvent } from "../../fez-client/src/index.js";

const root: WireEvent = { id: "root", kind: 47210, pubkey: "agent", created_at: 100, content: "Original", tags: [["h", "channel"]], sig: "verified-upstream" };
const update = (id: string, pubkey: string, content: string, ts = 101): WireEvent =>
  ({ ...root, id, kind: 47211, pubkey, created_at: ts, content, tags: [["h", "channel"], ["e", root.id]] });

it.each(["fez-relay.service", "Dockerfile"])("%s accepts memory writes and corrections", file => {
  const config = readFileSync(new URL(`../../../deploy/${file}`, import.meta.url), "utf8");
  const kinds = config.match(/(?:kind-whitelist|FEZ_KINDS)=([\d,]+)/)![1].split(",").map(Number);
  const policy = kindWhitelistPolicy(kinds);
  expect(policy.onEvent(root, { query: () => [] })).toEqual({ accept: true });
  expect(policy.onEvent(update("update", "agent", "Corrected"), { query: () => [] })).toEqual({ accept: true });
});

it("folds authorized corrections deterministically, retaining tombstones and rejecting forged targets", () => {
  const state = new WorkspaceState();
  state.workspace.owner = "owner";
  state.workspace.members = new Map([["agent", "bot"], ["peer", "bot"], ["admin", "admin"]]);
  const events = [root, update("b", "agent", "Author correction"), update("a", "admin", "Moderator correction"),
    update("intruder", "peer", "Forged correction", 999), update("backdated", "agent", "Backdated", 100),
    { ...update("wrong-channel", "agent", "Wrong channel", 1000), tags: [["h", "elsewhere"], ["e", root.id]] }];
  for (const ordered of [events, [...events].reverse()]) {
    expect(teamMemoryHeads(ordered, "channel", state).get(root.id)?.content).toBe("Moderator correction");
  }
  const channel = { id: "channel", name: "general", createdAt: 1 };
  const deletion = buildTeamMemory({ state, channel, events, windowed: false }, "admin", "", root.id);
  expect(deletion).toMatchObject({ kind: 47211, content: "", tags: [["h", "channel"], ["e", root.id]] });
  expect(deletion.created_at).toBeGreaterThan(101);
  const forgotten = [...events, { ...deletion, id: "tombstone", pubkey: "admin", sig: "verified-upstream" }];
  expect(teamMemoryHeads(forgotten, "channel", state).get(root.id)?.content).toBe("");
  state.workspace.banned.set("admin", undefined);
  expect(teamMemoryHeads(forgotten, "channel", state).get(root.id)?.content).toBe("Author correction");
  state.workspace.removed.add(root.id);
  expect(teamMemoryHeads(forgotten, "channel", state).size).toBe(0);
});

it("fails closed for unknown ownership, missing status support, and a memory-only read failure", async () => {
  await expect(readTeamMemory({}, undefined, "general", "owner")).rejects.toThrow(/owner/i);
  await expect(readTeamMemory({}, "owner", "general", "owner")).rejects.toThrow(/backend/i);
  const channel = { ...root, id: "channel", kind: 47101, pubkey: "owner", content: '{"name":"general"}', tags: [["d", "channel"]] };
  const wire = { queryWithStatus: async (filters: { kinds?: number[] }[]) => filters.some(f => f.kinds?.includes(47210))
    ? { events: [root], failures: [{ url: "relay", reason: "CLOSED" }] }
    : { events: [channel], failures: [] } };
  await expect(readTeamMemory(wire, "owner", "general", "owner")).rejects.toThrow(/incomplete/i);
});
