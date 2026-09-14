// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { FezClient, type Wire } from "../../fez-client/src/index.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseDeclarativeGui } from "../../fez-desktop/src/declarative-gui.js";
import { PINNED, voiceFor } from "../../fez-elevenlabs/src/voices.js";

const native = vi.hoisted(() => ({
  files: [] as [string, string, string, null, string][],
  grants: { probe: ["ui", "processes", "read:agents"] } as Record<string, string[]>,
  calls: [] as { command: string; args: Record<string, unknown> }[],
  prefs: {} as Record<string, unknown>,
  writeError: "",
}));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "list_gui_extensions") return native.files;
    if (command === "read_extension_grants") return JSON.stringify(native.grants);
    native.calls.push({ command, args });
    if (command === "run_extension_bin") return { code: 0, stdout: '{"phase":"missing","message":"Set up first"}', stderr: "" };
    if (command === "spawn_extension_agent") throw Error("Download unavailable");
    if (command === "extension_storage_read") return JSON.stringify({ prefs: native.prefs });
    if (command === "extension_storage_write") {
      if (native.writeError) throw Error(native.writeError);
      native.prefs[args.key as string] = JSON.parse(args.value as string);
      return;
    }
    throw new Error(`Unexpected native call: ${command}`);
  },
}));
const processSettings = { settings: [{ type: "process", description: "Prepare the service", bin: "probe-bin", job: "probe-setup",
  status: { args: ["status"], labels: { missing: "Setup needed", working: "Setting up", ready: "Ready", error: "Needs attention" }, checkingMessage: "Checking…", stoppedMessage: "Setup stopped. Retry." },
  actions: [{ operation: "spawn", label: "Set up", env: { PROBE_ACTION: "setup" }, enabledWhen: ["missing", "error"], successMessage: "Starting…" }],
}] };
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => {
  await act(async () => root.unmount());
  native.files = []; native.calls = [];
  native.prefs = {}; native.writeError = "";
  native.grants = { probe: ["ui", "processes", "read:agents"] };
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  await host.reloadGuiExtensions(new FezClient({ pubkey: "owner" } as Wire));
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

const voiceData = JSON.parse(readFileSync(resolve(__dirname, "../../fez-elevenlabs/src/gui.json"), "utf8"));
async function renderVoices(permissions = ["ui", "read:agents", "network:storage.googleapis.com"]) {
  native.grants = { probe: permissions };
  native.files = [["probe", JSON.stringify(voiceData), "", null, "declarative"]];
  const client = new FezClient({ pubkey: "owner" } as Wire);
  const agents = vi.spyOn(client, "agents").mockReturnValue(new Map([["00".repeat(32), "quill"], ["01".repeat(32), "atlas"]]));
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  await host.loadGuiExtensions(client);
  const panel = host.extensionSettingsPanels()[0];
  if (panel) await act(async () => root.render(panel.render() as React.ReactNode));
  return { agents, host };
}
async function select(name: string, id: string) {
  const picker = document.querySelector<HTMLSelectElement>(`select[aria-label="Voice for @${name}"]`)!;
  await act(async () => { picker.value = id; picker.dispatchEvent(new Event("change", { bubbles: true })); });
}

it.each([["ui"], ["read:agents"]])("does not read agents or preferences without both recorded ui and read:agents grants (%j)", async (...[permissions]) => {
  const { agents, host } = await renderVoices(permissions);
  expect(agents).not.toHaveBeenCalled();
  expect(native.calls).toEqual([]);
  expect(document.querySelector("select")).toBeNull();
  if (permissions.includes("ui")) expect(document.querySelector('[role="alert"]')?.textContent).toContain("read:agents");
  else expect(host.guiExtensionStatus()[0].ok).toBe(false);
});

it("preserves all pinned voice IDs, URLs and the original stable assignment algorithm", () => {
  expect(voiceData.settings[0].options).toEqual(PINNED);
  const choices = Array.from({ length: 64 }, (_, i) => voiceFor(i.toString(16).padStart(2, "0").repeat(32)).id);
  // Captured before sharing the old hash; this locks exact default choices.
  expect(createHash("sha256").update(JSON.stringify(choices)).digest("hex"))
    .toBe("10ef39158d67541cffbf2b41da1a13daacee4322b246a233f177363ed6041ef8");
});

it("shows stable defaults and persists overrides by agent name without losing other preferences", async () => {
  native.prefs = { voices: { absent: "custom-id" } };
  await renderVoices();
  expect([...document.querySelectorAll("select")].map(select => select.getAttribute("aria-label"))).toEqual(["Voice for @atlas", "Voice for @quill"]);
  expect(document.querySelector('select[aria-label="Voice for @quill"] option')?.textContent).toBe("Alice (default)");
  await select("quill", PINNED[0].id);
  expect(native.prefs.voices).toEqual({ absent: "custom-id", quill: PINNED[0].id });
  expect(native.calls.find(call => call.command === "extension_storage_write")?.args).toMatchObject({ name: "probe", key: "voices" });
  await select("quill", "");
  expect(native.prefs.voices).toEqual({ absent: "custom-id" });
});

it("keeps the saved selection when writing fails and blocks malformed saved data from being overwritten", async () => {
  native.prefs = { voices: { quill: PINNED[1].id } }; native.writeError = "Disk unavailable";
  await renderVoices();
  await select("quill", PINNED[0].id);
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="Voice for @quill"]')?.value).toBe(PINNED[1].id);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Disk unavailable");
  await act(async () => root.render(null));
  native.prefs = { voices: ["invalid"] };
  await renderVoices();
  expect(document.querySelector<HTMLSelectElement>("select")?.disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("not been overwritten");
});

it("previews only declared granted URLs and stops host audio when leaving settings", async () => {
  const players: { src: string; crossOrigin: string; pause: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal("Audio", class {
    src = ""; crossOrigin = ""; pause = vi.fn(); play = async () => {};
    constructor() { players.push(this); }
  });
  await renderVoices();
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Preview Alice"]')!.click());
  expect(players[0].src).toBe("https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/d10f7534-11f6-41fe-a012-2de1e482d336.mp3");
  expect(players[0].crossOrigin).toBe("anonymous");
  await act(async () => root.render(null));
  expect(players[0].pause).toHaveBeenCalled();
  await renderVoices(["ui", "read:agents"]);
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Preview Alice"]')!.click());
  expect(players).toHaveLength(1);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("network permission");
});

it.each([
  { settings: [] },
  { settings: Array(9).fill(processSettings.settings[0]) },
  { settings: [{ ...processSettings.settings[0], script: "alert(1)" }] },
  { settings: [{ ...processSettings.settings[0], bin: "../other-bin" }] },
  { settings: [{ ...processSettings.settings[0], actions: [{ ...processSettings.settings[0].actions[0], env: { NODE_OPTIONS: "--import=other.js" } }] }] },
  { settings: [{ ...processSettings.settings[0], actions: [{ ...processSettings.settings[0].actions[0], enabledWhen: ["anything"] }] }] },
  { settings: [{ ...processSettings.settings[0], status: { ...processSettings.settings[0].status, args: Array(33).fill("x") } }] },
  ...["javascript:alert(1)", "http://example.com/voice.mp3", "https://user:password@example.com/voice.mp3"].map(previewUrl => ({ settings: [{ ...voiceData.settings[0], options: [{ id: "voice", name: "Voice", previewUrl }] }] })),
  { settings: [{ ...voiceData.settings[0], options: [PINNED[0], PINNED[0]] }] },
  { settings: [{ ...voiceData.settings[0], defaults: "eval-code" }] },
])("rejects malformed settings before any registration or native action (%#)", async data => {
  expect(() => parseDeclarativeGui(JSON.stringify(data))).toThrow();
  native.files = [["probe", JSON.stringify({ ...data, themes: { ignored: { light: { "--bg0": "#fff" }, dark: { "--bg0": "#000" } } } }), "", null, "declarative"]];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  expect(await host.loadGuiExtensions(new FezClient({ pubkey: "owner" } as Wire))).toEqual([]);
  expect(host.extensionSettingsPanels()).toEqual([]);
  expect(host.themeNames()).not.toContain("ignored");
  expect(native.calls).toEqual([]);
});
it("renders process actions from data and surfaces package-owned background failures", async () => {
  native.files = [["probe", JSON.stringify(processSettings), "body {display:none}", null, "declarative"]];
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  expect(await host.loadGuiExtensions(new FezClient({ pubkey: "owner" } as Wire))).toEqual(["probe"]);
  await act(async () => root.render(host.extensionSettingsPanels()[0].render() as React.ReactNode));
  expect(document.body.textContent).toContain("Set up first");
  await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
  expect(native.calls.find(call => call.command === "spawn_extension_agent")?.args).toMatchObject({ extension: "probe", bin: "probe-bin", name: "probe-setup", env: [["PROBE_ACTION", "setup"]] });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Download unavailable");
  expect(document.querySelector("style[data-fez-ext='probe']")).toBeNull();
});

it("loads both shipped GUI parts using their actual manifest runtime declarations", async () => {
  native.grants = {};
  native.files = ["browser", "elevenlabs"].map(name => {
    const directory = resolve(__dirname, `../../fez-${name}`);
    const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
    native.grants[name] = manifest.fez.permissions;
    return [name, readFileSync(resolve(directory, manifest.fez.parts.gui), "utf8"), "", null, manifest.fez.guiRuntime];
  });
  const host = await import("../../fez-desktop/src/gui-extensions.js");
  expect(await host.loadGuiExtensions(new FezClient({ pubkey: "owner" } as Wire))).toEqual(["browser", "elevenlabs"]);
  expect(host.extensionSettingsPanels().map(panel => panel.name)).toEqual(["browser", "elevenlabs"]);
  expect(native.calls).toEqual([]);
});
