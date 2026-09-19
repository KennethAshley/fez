// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { FezClient } from "../../fez-client/src/index.js";

const native = vi.hoisted(() => ({ files: [] as [string, string, string][] }));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({
  invoke: async (command: string, args?: { extension?: string; bin?: string; args?: string[] }) => {
    if (command === "list_gui_extensions") return native.files;
    if (command === "read_extension_grants") return JSON.stringify(
      Object.fromEntries(native.files.map(([name]) => [name, ["ui", "commands", "processes"]])),
    );
    if (command === "run_extension_bin") {
      if (args?.extension !== "mesh" || args.bin !== "fez-mesh" || args.args?.join(" ") !== "state --json") throw Error("Unexpected mesh command");
      return { code: 0, stdout: JSON.stringify({ configured: true, provider: "ext-mesh-mini", model: "fez-mini-qwen3-4b", label: "Mac mini", machine: "mini.local", status: "offline", callersVerified: true, callers: [] }), stderr: "" };
    }
    throw new Error(`Unexpected native call: ${command}`);
  },
}));

afterEach(async () => {
  native.files = [];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  await host.reloadGuiExtensions({} as FezClient);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reports a GUI extension loaded only after asynchronous activation finishes", async () => {
  let finish!: () => void;
  vi.stubGlobal("finishActivation", new Promise<void>((resolve) => { finish = resolve; }));
  native.files = [["probe", "var __fezExt = { default: async function(api) { await globalThis.finishActivation; api.registerSettingsPanel('probe', function() {}); } };", ""]];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  // This extension uses only the registration seam, never client state.
  const loading = host.reloadGuiExtensions({} as FezClient);
  let completed = false;
  void loading.then(() => { completed = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(false);
  } finally {
    finish();
    await loading;
  }
  expect(await loading).toEqual(["probe"]);
  expect(host.guiExtensionStatus()).toEqual([{ name: "probe", ok: true }]);
  expect(host.extensionSettingsPanels().map((panel) => panel.name)).toEqual(["probe"]);
});

it("reports asynchronous activation failures and continues loading other extensions", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  native.files = [
    ["broken", "var __fezExt = { default: async function() { await Promise.resolve(); throw new Error('setup failed'); } };", ""],
    ["probe", "var __fezExt = { default: function(api) { api.registerSettingsPanel('probe', function() {}); } };", ""],
  ];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  expect(await host.reloadGuiExtensions({} as FezClient)).toEqual(["probe"]);
  expect(host.guiExtensionStatus()).toEqual([
    { name: "broken", ok: false, error: "setup failed" },
    { name: "probe", ok: true },
  ]);
});

it("loads agent profile sections and removes them on extension unload", async () => {
  native.files = [["probe", "var __fezExt = { default: function(api) { api.registerAgentProfileSection('stake', function(props) { return props.pubkey; }); } };", ""]];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  expect(await host.reloadGuiExtensions({} as FezClient)).toEqual(["probe"]);
  const sections = host.extensionAgentProfileSections();
  expect(sections).toHaveLength(1);
  expect(sections[0].source).toBe("probe");
  expect(sections[0].render({ pubkey: "agent", persona: "local-agent" })).toBe("agent");
  native.files = [];
  await host.reloadGuiExtensions({} as FezClient);
  expect(host.extensionAgentProfileSections()).toEqual([]);
});

it("loads a source-owned model provider and removes it on extension unload", async () => {
  native.files = [["mesh", "var __fezExt = { default: function(api) { api.registerModelProvider({ id: 'ext-mesh-mini', label: 'Mini', listModels: async function() { return [{ id: 'local/llama', label: 'Llama', status: 'offline' }]; }, prepare: async function() {} }); } };", ""]];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  const models = await import("../../fez-desktop/src/model-providers.js");
  expect(await host.reloadGuiExtensions({} as FezClient)).toEqual(["mesh"]);
  expect((await models.listModelProviders())[0].models).toEqual([{ id: "local/llama", label: "Llama", status: "offline" }]);
  native.files = [];
  await host.reloadGuiExtensions({} as FezClient);
  expect(await models.listModelProviders()).toEqual([]);
});

it("loads the compiled mesh GUI with the installed name and keeps its display label", async () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../fez-mesh/package.json"), "utf8")) as { name: string; fez: { parts: { gui: string } } };
  const installedName = pkg.name.split("/").at(-1)!;
  expect(installedName).toBe("mesh");
  expect(pkg.fez.parts.gui).toBe("dist/gui.js");
  const compiled = execFileSync(resolve(__dirname, "../node_modules/esbuild/bin/esbuild"), [resolve(__dirname, "../../fez-mesh/src/gui.ts"), "--bundle", "--platform=browser", "--format=iife", "--global-name=__fezExt"], { encoding: "utf8" });
  native.files = [[installedName, compiled, ""]];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  const models = await import("../../fez-desktop/src/model-providers.js");
  expect(await host.reloadGuiExtensions({} as FezClient)).toEqual(["mesh"]);
  expect(host.guiExtensionStatus()).toEqual([{ name: "mesh", ok: true }]);
  expect(host.extensionSettingsPanels().map(p => ({ name: p.name, label: p.label }))).toEqual([{ name: "mesh", label: "Shared Models" }]);
  expect((await models.listModelProviders())[0].models).toEqual([{
    id: "fez-mini-qwen3-4b", label: "Qwen3 4B · Mac mini", status: "offline",
    detail: expect.stringMatching(/Tools run on this Mac.*Saving grants this agent access/),
  }]);
});

it("rejects a provider claiming another extension's prefix and rolls back earlier registrations", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  native.files = [["mesh", "var __fezExt = { default: function(api) { api.registerModelProvider({ id: 'ext-mesh-mini', label: 'Mini', listModels: async function() { return []; }, prepare: async function() {} }); api.registerModelProvider({ id: 'ext-other-mini', label: 'Other', listModels: async function() { return []; }, prepare: async function() {} }); } };", ""]];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  const models = await import("../../fez-desktop/src/model-providers.js");
  expect(await host.reloadGuiExtensions({} as FezClient)).toEqual([]);
  expect(await models.listModelProviders()).toEqual([]);
  expect(host.guiExtensionStatus()[0].error).toMatch(/provider.*extension|extension.*provider/i);
});

it("rolls back registrations added or replaced by a failed asynchronous activation", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  native.files = [
    ["healthy", `var __fezExt = { default: function(api) {
      api.registerGuiCommand('shared', function() { return 'healthy'; });
      api.registerNavView('shared', { glyph: 'H', label: 'Healthy' }, function() {});
      api.registerMarkdownPlugin('healthy');
      api.registerBlockRenderer('shared', function() { return 'healthy'; });
      api.registerArtifactViewer('shared', function() { return 'healthy'; });
    } };`, ""],
    ["broken", `var __fezExt = { default: async function(api) {
      api.registerGuiCommand('shared', function() { return 'broken'; });
      api.registerGuiCommand('broken', function() { return 'broken'; });
      api.registerNavView('shared', { glyph: 'B', label: 'Broken' }, function() {});
      api.registerMessageDecorator(function() { return true; }, function() {});
      api.registerSettingsPanel('broken', function() {});
      api.registerAgentProfileSection('broken', function() {});
      api.registerMarkdownPlugin('broken');
      api.registerBlockRenderer('shared', function() { return 'broken'; }, { label: 'Broken', template: 'broken' });
      api.registerThreadView('broken', function() { return true; }, function() {});
      api.registerPageView('broken', function() { return true; }, function() {});
      await Promise.resolve();
      api.registerArtifactAction('broken', function() {});
      api.registerTheme('broken', { '--probe': 'broken' });
      api.registerArtifactViewer('shared', function() { return 'broken'; });
      api.registerArtifactViewer('broken', function() {});
      throw new Error('setup failed');
    } };`, ""],
    ["probe", "var __fezExt = { default: function(api) { api.registerSettingsPanel('probe', function() {}); } };", ""],
  ];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  const { viewerFor } = await import("../../fez-desktop/src/artifact-viewers.js");
  expect(await host.reloadGuiExtensions({} as FezClient)).toEqual(["healthy", "probe"]);
  expect(host.guiCommand("shared")?.("")).toBe("healthy");
  expect(host.guiCommand("broken")).toBeUndefined();
  expect(host.extensionNavViews().map((view) => view.label)).toEqual(["Healthy"]);
  expect(host.messageDecorators()).toEqual([]);
  expect(host.extensionSettingsPanels().map((panel) => panel.name)).toEqual(["probe"]);
  expect(host.extensionAgentProfileSections()).toEqual([]);
  expect(host.docMarkdownPlugins()).toEqual(["healthy"]);
  expect(host.blockRenderer("shared")?.({ info: "", body: "", raw: "", channelId: "" })).toBe("healthy");
  expect(host.extensionBlockMenu()).toEqual([]);
  expect(host.threadViewFor("anything")).toBeUndefined();
  expect(host.pageViewsFor("anything").views).toEqual([]);
  expect(host.extensionArtifactActions()).toEqual([]);
  expect(host.themeNames()).toEqual([]);
  expect(viewerFor("shared")?.({ artifact: { type: "shared" } })).toBe("healthy");
  expect(viewerFor("broken")).toBeUndefined();
  expect(host.guiExtensionStatus()).toEqual([
    { name: "healthy", ok: true },
    { name: "broken", ok: false, error: "setup failed" },
    { name: "probe", ok: true },
  ]);
});

it.each(["loadGuiExtensions", "reloadGuiExtensions"] as const)(
  "finishes %s before a later reload replaces its registrations",
  async (start) => {
    let finish!: () => void;
    vi.stubGlobal("finishActivation", new Promise<void>((resolve) => { finish = resolve; }));
    let started!: () => void;
    const activated = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("activationStarted", started);
    native.files = [["probe", "var __fezExt = { default: async function(api) { globalThis.activationStarted(); await globalThis.finishActivation; api.registerMarkdownPlugin('old'); } };", ""]];
    const host = await import("../../fez-desktop/src/gui-extensions.js");
    const first = host[start]({} as FezClient);
    let second: Promise<string[]> | undefined;
    try {
      await activated;
      native.files = [["probe", "var __fezExt = { default: function(api) { api.registerMarkdownPlugin('new'); } };", ""]];
      second = host.reloadGuiExtensions({} as FezClient);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      finish();
      await Promise.all([first, second]);
    }
    expect(host.docMarkdownPlugins()).toEqual(["new"]);
    expect(host.guiExtensionStatus()).toEqual([{ name: "probe", ok: true }]);
  },
);

it("removes extension artifact viewers and restores replaced host viewers on reload", async () => {
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  const { viewerFor } = await import("../../fez-desktop/src/artifact-viewers.js");
  const originalHtml = viewerFor("html");
  native.files = [["probe", "var __fezExt = { default: function(api) { api.registerArtifactViewer('probe', function() { return 'custom'; }); api.registerArtifactViewer('html', function() { return 'override'; }); } };", ""]];
  expect(await host.reloadGuiExtensions({} as FezClient)).toEqual(["probe"]);
  expect(viewerFor("probe")).toBeTypeOf("function");
  expect(viewerFor("html")).not.toBe(originalHtml);

  native.files = [];
  await host.reloadGuiExtensions({} as FezClient);
  expect(viewerFor("probe")).toBeUndefined();
  expect(viewerFor("html")).toBe(originalHtml);
});

it("restores overwritten core registrations when extensions are removed", async () => {
  vi.resetModules();
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  host.registerGuiCommand("core", () => "core");
  host.registerNavView("core", { glyph: "C", label: "Core" }, () => {});
  native.files = [["healthy", `var __fezExt = { default: function(api) {
    api.registerGuiCommand('core', function() { return 'extension'; });
    api.registerNavView('core', { glyph: 'E', label: 'Extension' }, function() {});
  } };`, ""]];
  await host.loadGuiExtensions({} as FezClient);
  expect(host.guiCommand("core")?.("")).toBe("extension");
  expect(host.extensionNavViews().map((view) => view.label)).toEqual(["Extension"]);

  native.files = [];
  await host.reloadGuiExtensions({} as FezClient);
  expect(host.guiCommand("core")?.("")).toBe("core");
  expect(host.extensionNavViews().map((view) => view.label)).toEqual(["Core"]);
});
