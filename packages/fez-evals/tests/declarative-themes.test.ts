// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import paletteData from "../../fez-themes/src/gui.js";
import type { FezClient } from "../../fez-client/src/index.js";

const native = vi.hoisted(() => ({
  files: [] as [string, string, string, null, string][],
  grants: { probe: ["ui"] } as Record<string, string[]>,
}));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({
  invoke: async (command: string) => {
    if (command === "list_gui_extensions") return native.files;
    if (command === "read_extension_grants") return JSON.stringify(native.grants);
    throw new Error(`Unexpected native call: ${command}`);
  },
}));

const probe = { themes: { probe: { light: { "--bg0": "#ffffff" }, dark: { "--bg0": "#111111" } } } };

afterEach(async () => {
  native.files = [];
  native.grants = { probe: ["ui"] };
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  await host.reloadGuiExtensions({} as FezClient);
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("loads declarative themes without evaluating JavaScript or injecting companion CSS", async () => {
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  const factory = vi.fn(() => { throw Error("JavaScript evaluation forbidden"); });
  vi.stubGlobal("Function", factory);
  native.files = [["probe", JSON.stringify(probe), "body { display: none }", null, "declarative"]];
  expect(await host.loadGuiExtensions({} as FezClient)).toEqual(["probe"]);
  expect(factory).not.toHaveBeenCalled();
  expect(host.themeNames()).toContain("probe");
  expect(host.themePalette("probe", "light")["--bg0"]).toBe("#ffffff");
  expect(host.themePalette("probe", "dark")["--bg0"]).toBe("#111111");
  vi.unstubAllGlobals();
  expect(document.querySelector("style[data-fez-ext='probe']")).toBeNull();
  native.files = [];
  await host.reloadGuiExtensions({} as FezClient);
  expect(host.themeNames()).not.toContain("probe");
});

it.each([undefined, [], ["read:channels"]])("requires a recorded ui grant (%j)", async (grant) => {
  native.grants = grant ? { probe: grant } : {};
  native.files = [["probe", JSON.stringify(probe), "", null, "declarative"]];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  expect(await host.loadGuiExtensions({} as FezClient)).toEqual([]);
  expect(host.guiExtensionStatus()[0].ok).toBe(false);
  expect(host.themeNames()).not.toContain("probe");
});

it.each([
  "globalThis.declarativeExecuted = true; var __fezExt = { default() {} };",
  " ".repeat(256 * 1024) + JSON.stringify(probe),
  JSON.stringify({ themes: [] }),
  JSON.stringify({ themes: {} }),
  JSON.stringify({ ...probe, css: "body { display: none }" }),
  JSON.stringify({ themes: Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`theme-${n}`, probe.themes.probe])) }),
  JSON.stringify({ themes: { default: probe.themes.probe } }),
  JSON.stringify({ themes: { ["x".repeat(65)]: probe.themes.probe } }),
  JSON.stringify({ themes: { probe: { dark: { "--bg0": "#ffffff" } } } }),
  JSON.stringify({ themes: { probe: { light: [], dark: {} } } }),
  ...[
    { "--bg0": "url(https://attacker.invalid/image)" },
    { "--bg0": "#fff; background: red" },
    { "--bg0": "var(--unknown)" },
    { "--unknown": "#ffffff" },
    { "--font-mono": "url(https://attacker.invalid/font)" },
    { "--measure-read": "100000px" },
    { "--bg0": 10 },
  ].map((light) => JSON.stringify({ themes: { probe: { light, dark: { "--bg0": "#000000" } } } })),
])("rejects malformed or unsafe theme data without evaluating it (%#)", async (raw) => {
  native.files = [["probe", raw, "", null, "declarative"]];
  vi.stubGlobal("declarativeExecuted", false);
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  expect(await host.loadGuiExtensions({} as FezClient)).toEqual([]);
  expect(host.guiExtensionStatus()[0].ok).toBe(false);
  expect(host.themeNames()).not.toContain("probe");
  expect(Reflect.get(globalThis, "declarativeExecuted")).toBe(false);
});

it("validates the whole file before registering any palette", async () => {
  native.files = [["probe", JSON.stringify({ themes: { ...probe.themes, broken: {} } }), "", null, "declarative"]];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  expect(await host.loadGuiExtensions({} as FezClient)).toEqual([]);
  expect(host.themeNames()).not.toContain("probe");
});

it("preserves all nineteen pre-migration light/dark palettes exactly", async () => {
  // Captured from the former activate() registrations before converting
  // the source. Sorting removes object-order changes from this comparison.
  const canonical = (value: unknown): unknown => value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]))
    : value;
  expect(createHash("sha256").update(JSON.stringify(canonical(paletteData))).digest("hex"))
    .toBe("432a255477f27484cefdf834dc13ee4fbb80641e76e16d6418529a2b96fbae77");
  native.files = [["probe", JSON.stringify(paletteData), "", null, "declarative"]];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  expect(await host.loadGuiExtensions({} as FezClient)).toEqual(["probe"]);
  expect(host.themeNames()).toHaveLength(19);
  for (const [name, pack] of Object.entries(paletteData.themes)) {
    expect(host.themePalette(name, "light")).toMatchObject(pack.light);
    expect(host.themePalette(name, "dark")).toMatchObject(pack.dark);
  }
});
