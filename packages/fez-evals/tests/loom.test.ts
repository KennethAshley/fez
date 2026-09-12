// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { keepTool, keptTools, unkeepTool, refreshTools, recoverableTools, type ArtifactLike } from "../../fez-loom/src/store.js";
import { latestArtifacts } from "../../fez-client/src/artifacts.js";

const scope = { pubkey: "alice", relay: "wss://one" };
const artifact: ArtifactLike = {
  id: "original", channelId: "general", authorPk: "builder", authorName: "Builder",
  rootId: "thread", type: "live", title: "Task board", content: "<p>original</p>", ts: 100,
};
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it("keeps artifacts per identity and workspace, retaining their author and thread", () => {
  keepTool(scope, artifact);
  expect(keptTools(scope)).toMatchObject([artifact]);
  expect(keptTools({ ...scope, pubkey: "bob" })).toEqual([]);
  expect(keptTools({ ...scope, relay: "wss://two" })).toEqual([]);
  keepTool(scope, { ...artifact, id: "other-channel", channelId: "another" });
  expect(keptTools(scope)).toHaveLength(2);
  unkeepTool(scope, "original");
  expect(keptTools(scope).map(t => t.id)).toEqual(["other-channel"]);
});

it("updates one live tool when its author refines it, keeping other authors and threads distinct", () => {
  keepTool(scope, artifact);
  keepTool(scope, { ...artifact, id: "revision", ts: 101, content: "<p>revised</p>" });
  expect(keptTools(scope)).toMatchObject([{ id: "revision", content: "<p>revised</p>", ts: 101 }]);
  keepTool(scope, artifact);
  expect(keptTools(scope)[0].id).toBe("revision");
  keepTool(scope, { ...artifact, id: "another-author", authorPk: "someone-else" });
  keepTool(scope, { ...artifact, id: "another-thread", rootId: "another-thread" });
  expect(keptTools(scope)).toHaveLength(3);
});

it("reports damaged storage and failed writes without overwriting saved artifacts", () => {
  keepTool(scope, artifact);
  const key = localStorage.key(0)!;
  const saved = localStorage.getItem(key);
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("storage full"); });
  expect(() => unkeepTool(scope, artifact.id)).toThrow("storage full");
  expect(localStorage.getItem(key)).toBe(saved);
  fail.mockRestore();
  localStorage.setItem(key, "{broken");
  expect(() => keepTool(scope, artifact)).toThrow();
  expect(localStorage.getItem(key)).toBe("{broken");
});

it("refreshes only saved artifacts and uses the same live identities as the channel timeline", () => {
  keepTool(scope, artifact);
  const before = keptTools(scope)[0];
  const revision = { ...artifact, id: "revision", content: "new", ts: 101 };
  const otherAuthor = { ...artifact, id: "other", authorPk: "different", ts: 102 };
  const staticArtifact = { ...artifact, id: "static", type: "html", ts: 103 };
  expect(latestArtifacts([artifact, revision, otherAuthor, staticArtifact]).map(a => a.id)).toEqual(["revision", "other", "static"]);
  expect(refreshTools(scope, [revision, otherAuthor, staticArtifact])).toMatchObject([
    { ...revision, keptAt: before.keptAt },
  ]);
  expect(refreshTools(scope, [])).toMatchObject([revision]);
  expect(keptTools(scope)).toHaveLength(1);
});

it("recovers legacy saves only from known workspace artifacts, on explicit import, keeping the original store", () => {
  const legacy = JSON.stringify([{ id: artifact.id, content: "legacy" }, { id: "another-workspace", content: "private" }, null]);
  localStorage.setItem("fez-tools", legacy);
  expect(keptTools(scope)).toEqual([]);
  expect(recoverableTools(scope, [])).toEqual([]);
  expect(recoverableTools(scope, [artifact])).toEqual([artifact]);
  for (const recovered of recoverableTools(scope, [artifact])) keepTool(scope, recovered);
  expect(recoverableTools(scope, [artifact])).toEqual([]);
  expect(keptTools(scope)).toMatchObject([artifact]);
  expect(keptTools({ ...scope, pubkey: "bob" })).toEqual([]);
  expect(localStorage.getItem("fez-tools")).toBe(legacy);
});
