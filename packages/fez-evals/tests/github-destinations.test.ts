import { beforeEach, expect, it, vi } from "vitest";
import github from "../../fez-github/src/headless.js";
import { parseConfig, type Config } from "../../fez-github/src/config.js";
import type { FezExtensionAPI, ScheduledTaskContext } from "../../fez-github/src/api-types.js";
import type { State } from "../../fez-github/src/state.js";
import { makeChannels } from "../../../src/protocol/channels.js";

const fixture = vi.hoisted(() => ({ state: {} as State, items: [] as unknown[] }));
vi.mock("../../fez-github/src/github.js", async importOriginal => ({
  ...await importOriginal<object>(),
  ready: async () => ({ ok: true, login: "fixture" }),
  installedRepos: async () => [],
  recentItems: async () => fixture.items,
  checksFor: async () => undefined,
}));
vi.mock("../../fez-github/src/state.js", async importOriginal => ({
  ...await importOriginal<object>(),
  readJson: async () => structuredClone(fixture.state),
  writeJson: async (_path: string, state: State) => { fixture.state = structuredClone(state); },
}));

beforeEach(() => { fixture.state = {}; fixture.items = []; });

function harness(initial: Config, channels: Awaited<ReturnType<ScheduledTaskContext["channels"]["list"]>>) {
  let config = initial;
  let tick!: (ctx: ScheduledTaskContext) => void | Promise<void>;
  let command!: Parameters<FezExtensionAPI["registerCommand"]>[1];
  const nostr = {
    pubkey: "owner", encrypt: (_pk: string, text: string) => text, decrypt: (_pk: string, text: string) => text,
    query: async () => [{ id: "config", pubkey: "owner", kind: 30078, content: JSON.stringify(config), tags: [], sig: "", created_at: 1 }],
    publish: vi.fn(async (event) => { config = JSON.parse(event.content); return { ...event, id: "saved", pubkey: "owner", sig: "", created_at: 2 }; }),
    subscribe: () => () => {},
  } satisfies ScheduledTaskContext["nostr"];
  const access = { list: async () => channels, ensure: vi.fn(async () => "unwanted"), say: vi.fn(async () => "new-root") };
  github({ nostr, channels: access, registerScheduledTask: (_name, _ms, fn) => { tick = fn; }, registerCommand: (_name, fn) => { command = fn; } } as FezExtensionAPI);
  return {
    access, config: () => config,
    move: (next: Config) => { config = next; },
    tick: () => tick({ nostr, channels: access, ownerPubkey: "owner", missedWindow: false }),
    command: async (args: string) => { const reply = vi.fn(); await command(args, { reply }); return reply; },
  };
}

it("keeps only watched repo destinations with nonempty channel IDs", () => {
  expect(parseConfig({ repos: ["a/docs", "b/docs"], channelIds: { "a/docs": "channel-a", "b/docs": 1, "c/docs": "other" } }).channelIds)
    .toEqual({ "a/docs": "channel-a" });
});

it("the headless channel picker excludes archived channels after resolving edits", async () => {
  const channel = (created_at: number, archived = false) => ({ id: `event-${created_at}`, pubkey: "owner", sig: "", kind: 47101,
    created_at, tags: [["d", "channel"]], content: JSON.stringify({ name: "work", archived }) });
  const nostr = { query: async () => [channel(2, true), channel(1)] } as Parameters<typeof makeChannels>[0];
  expect(await makeChannels(nostr, "owner").list()).toEqual([]);
});

it("routes same-name repositories to the selected IDs without editing channel metadata", async () => {
  const h = harness({ repos: ["a/docs", "b/docs"], channelIds: { "a/docs": "one", "b/docs": "two" } }, [
    { id: "one", name: "general" }, { id: "two", name: "general", source: "git", meta: { repo: "unrelated" } },
  ]);
  await h.tick();
  expect(h.access.say.mock.calls.map(call => call[0])).toEqual(["one", "two"]);
  expect(h.access.ensure).not.toHaveBeenCalled();
});

it("migrates a legacy watch by exact repository metadata and keeps existing thread roots", async () => {
  fixture.state = {
    "a/docs#!": { updatedAt: "old", state: "watching", comments: 0, rootId: "" },
    "a/docs#1": { updatedAt: "old", state: "open", comments: 0, rootId: "old-root" },
  };
  fixture.items = [{ number: 1, kind: "issue", title: "one", state: "closed", comments: 0, updatedAt: "new", author: "a", url: "https://github.com/a/docs/issues/1" }];
  const h = harness({ repos: ["a/docs"] }, [{ id: "existing", name: "renamed", source: "github", meta: { repo: "a/docs" } }]);
  await h.tick();
  expect(h.config().channelIds).toEqual({ "a/docs": "existing" });
  expect(h.access.say).toHaveBeenCalledWith("existing", "closed", { threadRoot: "old-root" });
  expect(h.access.ensure).not.toHaveBeenCalled();
});

it.each([false, true])("never guesses a destination by channel name or ambiguous metadata (ambiguous: %s)", async ambiguous => {
  const channels = [{ id: "one", name: "docs", ...(ambiguous ? { source: "github", meta: { repo: "a/docs" } } : {}) }];
  if (ambiguous) channels.push({ ...channels[0], id: "two" });
  const h = harness({ repos: ["a/docs"] }, channels);
  await h.tick();
  expect(h.access.say).not.toHaveBeenCalled();
  expect(h.access.ensure).not.toHaveBeenCalled();
});

it("moving a watch opens the next changed item's thread in its new channel", async () => {
  fixture.state = {
    "a/docs#!": { updatedAt: "old", state: "watching", comments: 0, rootId: "", channelId: "old-channel" },
    "a/docs#1": { updatedAt: "old", state: "open", comments: 0, rootId: "old-root" },
  };
  fixture.items = [{ number: 1, kind: "issue", title: "one", state: "closed", comments: 0, updatedAt: "new", author: "a", url: "https://github.com/a/docs/issues/1" }];
  const h = harness({ repos: ["a/docs"], channelIds: { "a/docs": "new-channel" } }, [{ id: "new-channel", name: "work" }]);
  await h.tick();
  expect(h.access.say).toHaveBeenCalledWith("new-channel", "closed", { threadRoot: "new-root" });
  expect(h.access.say.mock.calls.some(call => JSON.stringify(call).includes("old-root"))).toBe(false);
});

it("the command requires an explicit existing destination and forget removes the binding", async () => {
  const h = harness({ repos: [] }, [{ id: "channel-id", name: "work" }]);
  await h.command("watch a/docs");
  expect(h.config().repos).toEqual([]);
  await h.command("watch a/docs channel-id");
  expect(h.config().channelIds).toEqual({ "a/docs": "channel-id" });
  await h.command("forget a/docs");
  expect(h.config().channelIds?.["a/docs"]).toBeUndefined();
});


it("legacy discovery cannot undo a destination change or restart a stopped watch", async () => {
  for (const latest of [
    { repos: [] },
    { repos: ["a/docs"], channelIds: { "a/docs": "new-channel" } },
  ]) {
    fixture.state = {};
    const channels = [{ id: "legacy", name: "docs", source: "github", meta: { repo: "a/docs" } }, { id: "new-channel", name: "work" }];
    const h = harness({ repos: ["a/docs"] }, channels);
    h.access.list = async () => { h.move(latest); return channels; };
    await h.tick();
    expect(h.config()).toEqual(latest);
    expect(h.access.say.mock.calls.every(call => call[0] === "new-channel")).toBe(true);
    if (latest.repos.length === 0) expect(h.access.say).not.toHaveBeenCalled();
  }
});
