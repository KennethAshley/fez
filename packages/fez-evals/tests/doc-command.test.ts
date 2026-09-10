import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import docs from "../../fez-docs/src/index.js";
import type { FezExtensionAPI } from "../../fez-docs/src/api-types.js";

afterEach(() => vi.restoreAllMocks());

it("the doc command sends Markdown and the version it read through the shared writer", async () => {
  vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
  vi.spyOn(fs, "watch").mockImplementation(() => { throw new Error("No disk mirror in this command test"); });
  let command: ((args: string, ctx: { reply: (text: string) => void }) => void | Promise<void>) | undefined;
  const writes: { channel: string; content: string; base: string | undefined }[] = [];
  const handle = { setAuthor() {}, setContent() {}, setFooter() {}, setMeta() {} };
  const api: FezExtensionAPI = {
    client: {
      state: { currentChannel: () => ({ channel: { id: "ch", name: "general" }, community: { id: "workspace" } }) },
      docsByChannel: () => new Map(), on() {},
      docVersions: async () => [{ id: "version-one", content: "Existing text" }],
      publishDoc: async (channel: string, content: string, base?: string) => { writes.push({ channel, content, base }); },
    },
    registerCommand: (_name, handler) => { command = handler; }, registerInputHandler() {}, registerUrlHandler() {},
    ui: { createSidePanel: () => ({ setText() {} }), clearLog() {}, notify() {}, setStatus() {}, appendMessage: () => handle, prependMessage: () => handle, onLogScrollTop() {}, viewBus: { owner: () => "", claim() {}, release() {}, onChange() {} } },
  };
  docs(api);
  await command!("append More notes", { reply() {} });
  expect(writes).toEqual([{ channel: "ch", content: "Existing text\n\nMore notes", base: "version-one" }]);
});
