// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { FezClient } from "../../fez-client/src/index.js";

// The GUI loader registers a model provider straight from the installed
// manifest (`fez.modelProvider`) and drives it through run_extension_bin —
// so an extension whose GUI part lives in an isolated webview still shows
// up in Agents → model without running any code in the host page.
const decl = { id: "mini", label: "Shared Models", bin: "fez-mesh", list: ["models", "--json"],
  prepare: ["prepare", "--name", "{persona}", "--model", "{model}"] };
const bundle = "var __fezExt = { default: function(api) { api.registerSettingsPanel('Shared Models', function() {}); } };";
const models = [{ id: "fez-mini-qwen3-4b", label: "Qwen3 4B · Mac mini", status: "ready" }];

const native = vi.hoisted(() => ({
  files: [] as unknown[][],
  grants: {} as Record<string, string[]>,
  runs: [] as { extension?: string; bin?: string; args?: string[] }[],
}));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({
  invoke: async (command: string, args?: { extension?: string; bin?: string; args?: string[] }) => {
    if (command === "list_gui_extensions") return native.files;
    if (command === "read_extension_grants") return JSON.stringify(native.grants);
    if (command === "run_extension_bin") {
      native.runs.push(args ?? {});
      return { code: 0, stdout: JSON.stringify(models), stderr: "" };
    }
    throw new Error(`Unexpected native call: ${command}`);
  },
}));

afterEach(async () => {
  native.files = []; native.grants = {}; native.runs = [];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  await host.reloadGuiExtensions({} as FezClient);
});

it("registers a manifest-declared provider and lists its models through the extension's bin", async () => {
  native.files = [["mesh", bundle, "", null, null, null, decl]];
  native.grants = { mesh: ["ui", "processes"] };
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  const providers = await import("../../fez-desktop/src/model-providers.js");
  expect(await host.reloadGuiExtensions({} as FezClient)).toEqual(["mesh"]);
  expect(host.guiExtensionStatus()).toEqual([{ name: "mesh", ok: true }]);
  const listed = await providers.listModelProviders();
  expect(listed.map(entry => entry.provider.id)).toEqual(["ext-mesh-mini"]);
  expect(listed[0].models).toEqual(models);
  expect(listed[0].error).toBeUndefined();
  expect(native.runs).toEqual([{ extension: "mesh", bin: "fez-mesh", args: ["models", "--json"] }]);
});

it("does not register a provider whose extension lacks the processes grant, and says why", async () => {
  native.files = [["mesh", bundle, "", null, null, null, decl]];
  native.grants = { mesh: ["ui"] };
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  const providers = await import("../../fez-desktop/src/model-providers.js");
  await host.reloadGuiExtensions({} as FezClient);
  expect((await providers.listModelProviders()).map(entry => entry.provider.id)).toEqual([]);
  expect(host.guiExtensionStatus()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "mesh", ok: false, error: expect.stringContaining("processes") })]));
  expect(native.runs).toEqual([]);
});

it("reports a malformed declaration without losing the extension's settings panel", async () => {
  native.files = [["mesh", bundle, "", null, null, null, { ...decl, prepare: ["no", "placeholders"] }]];
  native.grants = { mesh: ["ui", "processes"] };
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  const providers = await import("../../fez-desktop/src/model-providers.js");
  await host.reloadGuiExtensions({} as FezClient);
  expect((await providers.listModelProviders()).length).toBe(0);
  expect(host.guiExtensionStatus()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "mesh", ok: false, error: expect.stringContaining("modelProvider") })]));
  expect(host.extensionSettingsPanels().map(panel => panel.name)).toEqual(["mesh"]);
});

it("drops the provider again when the extension is unloaded", async () => {
  native.files = [["mesh", bundle, "", null, null, null, decl]];
  native.grants = { mesh: ["ui", "processes"] };
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  const providers = await import("../../fez-desktop/src/model-providers.js");
  await host.reloadGuiExtensions({} as FezClient);
  native.files = [];
  await host.reloadGuiExtensions({} as FezClient);
  expect((await providers.listModelProviders()).length).toBe(0);
});
