// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { FezClient } from "../../fez-client/src/index.js";
import type { GuiExtensionApi } from "../../fez-desktop/src/gui-extensions.js";

const native = vi.hoisted(() => ({ files: [] as [string, string, string][], grants: ["ui"] }));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({
  invoke: async (command: string) => {
    if (command === "list_gui_extensions") return native.files;
    if (command === "read_extension_grants") return JSON.stringify({ workspace: native.grants });
    throw new Error(`Unexpected native call: ${command}`);
  },
}));

afterEach(async () => {
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  native.files = [];
  native.grants = ["ui"];
  await host.reloadGuiExtensions({} as FezClient);
  host.setPanelOpener(undefined);
  host.setChannelOpener(undefined);
  host.setThreadOpener(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function load(code = "") {
  let api!: GuiExtensionApi;
  vi.stubGlobal("captureWorkspaceApi", (value: GuiExtensionApi) => { api = value; });
  native.files = [["workspace", `var __fezExt = { default: function(api) {
    globalThis.captureWorkspaceApi(api);
    ${code}
  } };`, ""]];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  await host.reloadGuiExtensions({} as FezClient);
  return { host, api };
}

it("replaces a structured message body while preserving additive decorations and the plain-text fallback", async () => {
  const { host, api } = await load();
  api.registerMessageDecorator(() => true, () => "receipt");
  api.registerMessageDecorator(content => content === "structured", () => "summary", { replaceBody: true });
  api.registerMessageDecorator(content => content === "unavailable", () => null, { replaceBody: true });
  const props = { content: "structured", msgId: "m", channelId: "c", authorName: "You" };
  expect(host.messagePresentation(props)).toEqual({ body: "summary", decorations: ["receipt"] });
  for (const content of ["ordinary", "unavailable"]) {
    expect(host.messagePresentation({ ...props, content })).toEqual({ body: undefined, decorations: ["receipt"] });
  }
});

it("keeps the binding live and removes workspace tabs/summary with their extension", async () => {
  const { host, api } = await load();
  let channelId: string | undefined = "room-a";
  const workspace = {
    getChannelId: () => channelId,
    tabs: [{ id: "records", label: "Records", render: () => "records" }],
    summary: () => "summary",
  };
  api.registerNavView("workspace", { glyph: "W", label: "Workspace", channelWorkspace: workspace }, () => "setup");
  const nav = host.extensionNavViews()[0];
  expect(nav.channelWorkspace).toBe(workspace);
  expect(host.navChannelId(nav)).toBe("room-a");
  channelId = "renamed-room";
  expect(host.navChannelId(nav)).toBe("renamed-room");
  channelId = undefined;
  expect(host.navChannelId(nav)).toBeUndefined();
  expect(nav.render()).toBe("setup");
  native.files = [];
  await host.reloadGuiExtensions({} as FezClient);
  expect(host.extensionNavViews()).toEqual([]);
});

it("forwards navigation at the app boundary and disposes each pane opening on replacement/unload", async () => {
  const { host, api } = await load();
  const channel = vi.fn(), thread = vi.fn(), closeFirst = vi.fn(), closeSecond = vi.fn();
  const open = vi.fn().mockReturnValueOnce(closeFirst).mockReturnValueOnce(closeSecond);
  host.setChannelOpener(channel);
  host.setThreadOpener(thread);
  host.setPanelOpener(open);
  api.openChannel!("room-a");
  api.openThread("room-b", "root-b");
  expect(channel).toHaveBeenCalledWith("room-a");
  expect(thread).toHaveBeenCalledWith("room-b", "root-b");
  const first = () => "first", second = () => "second";
  api.openPanel!("Same title", first);
  api.openPanel!("Same title", second);
  expect(open.mock.calls).toEqual([["Same title", first], ["Same title", second]]);
  expect(closeFirst).toHaveBeenCalledTimes(1);
  expect(closeSecond).not.toHaveBeenCalled();
  native.files = [];
  await host.reloadGuiExtensions({} as FezClient);
  expect(closeSecond).toHaveBeenCalledTimes(1);
  api.openPanel!("stale", first);
  api.openChannel!("stale");
  expect(open).toHaveBeenCalledTimes(2);
  expect(channel).toHaveBeenCalledTimes(1);
});

it("forwards a workspace layout request so an extension can share the main working area", async () => {
  const { host, api } = await load();
  const open = vi.fn();
  host.setPanelOpener(open);
  const render = () => "browser";
  api.openPanel!("Browser", render, { layout: "workspace" });
  expect(open).toHaveBeenCalledWith("Browser", render, { layout: "workspace" });
});

it.each(["unload", "reload"])("ignores a delayed thread callback from before extension %s", async (change) => {
  const { host, api } = await load();
  const navigate = vi.fn();
  host.setThreadOpener(navigate);
  let finish!: () => void;
  const delayed = new Promise<void>(resolve => { finish = resolve; })
    .then(() => api.openThread("stale-room", "stale-root"));
  if (change === "unload") {
    native.files = [];
    await host.reloadGuiExtensions({} as FezClient);
  } else {
    const replacement = await load();
    replacement.api.openThread("current-room", "current-root");
  }
  finish();
  await delayed;
  expect(navigate.mock.calls).toEqual(change === "unload" ? [] : [["current-room", "current-root"]]);
});

it("withholds the optional capabilities and workspace registration without ui", async () => {
  native.grants = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { host, api } = await load();
  expect(api.openChannel).toBeUndefined();
  expect(api.openPanel).toBeUndefined();
  api.registerNavView("workspace", { glyph: "W", label: "Workspace", channelWorkspace: { getChannelId: () => "room-a", tabs: [] } }, () => {});
  expect(host.extensionNavViews()).toEqual([]);
});

it("closes a panel from failed activation and isolates a throwing binding callback", async () => {
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  const close = vi.fn();
  host.setPanelOpener(() => close);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await load('api.openPanel("Failed", function() {}); throw new Error("broken");');
  expect(close).toHaveBeenCalledTimes(1);
  expect(host.guiExtensionStatus()).toEqual([{ name: "workspace", ok: false, error: "broken" }]);
  expect(host.navChannelId({ name: "broken", glyph: "W", label: "Broken", render: () => {}, channelWorkspace: {
    getChannelId: () => { throw new Error("unavailable"); }, tabs: [],
  } })).toBeUndefined();
});
