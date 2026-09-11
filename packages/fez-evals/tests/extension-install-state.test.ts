// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import SkillsView from "../../fez-desktop/src/SkillsView.js";
import { InstallOffer } from "../../fez-desktop/src/InstallOffer.js";
import { reloadConfig } from "../../fez-desktop/src/config-store.js";
import { subscribe } from "../../fez-desktop/src/toast.js";
import type { FezClient } from "../../fez-client/src/index.js";
import type { BrowserWire } from "../../fez-desktop/src/wire.js";

vi.mock("../../fez-desktop/src/gui-extensions.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../fez-desktop/src/gui-extensions.js")>(),
  reloadGuiExtensions: vi.fn(async () => {}),
}));

let root: ReturnType<typeof createRoot>;
let versions: Record<string, string>;
let skills: Record<string, unknown>;
let installs: string[];
const client = {} as FezClient;
const wire = { query: async () => [] } as unknown as BrowserWire;
const button = (name: string, within: ParentNode = document) => [...within.querySelectorAll("button")].find(el => el.textContent?.trim() === name)!;
const click = (el: HTMLButtonElement) => act(async () => { expect(el).toBeDefined(); el.click(); });
const card = () => [...document.querySelectorAll(".gallery-card")].find(el => el.querySelector(".gallery-name")?.textContent === "@fezchat/web")!;
const renderGallery = () => act(async () => root.render(React.createElement(SkillsView, { only: "extensions", client, wire })));

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  versions = {};
  skills = {};
  installs = [];
  localStorage.clear();
  Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (cmd: string, args: Record<string, string> = {}) => {
    if (cmd === "read_extension_versions") return JSON.stringify(versions);
    if (cmd === "read_skills") return JSON.stringify(skills);
    // Web ships only an MCP tool: native part discovery returns no GUI row.
    if (["list_local_extensions", "list_personas", "list_gui_extensions"].includes(cmd)) return [];
    if (cmd === "list_installed_skills") return "[]";
    if (["read_extension_grants", "read_keymap", "package_info"].includes(cmd)) return "{}";
    if (cmd === "latest_version") return "0.1.0";
    if (cmd === "install_package") {
      installs.push(args.name);
      versions.web = "0.1.0";
      skills.web = { command: "node", args: ["/fixture/packages/web/dist/mcp.js"], package: "@fezchat/web" };
      return "installed";
    }
    if (cmd === "remove_extension") { delete versions.web; delete skills.web; return "removed"; }
    throw Error(`Unexpected native call: ${cmd}`);
  } } });
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }));
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  await reloadConfig();
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it("shows Web installed after its success toast and keeps that state after reopening the gallery", async () => {
  const notices: string[] = [];
  const unsubscribe = subscribe(items => notices.push(...items.map(item => item.message)));
  try {
    await renderGallery();
    await click(button("review & install", card()));
    await click(button("install & grant"));
    expect(installs).toEqual(["@fezchat/web"]);
    expect(notices.some(message => message.includes("Web installed"))).toBe(true);
    expect(card().querySelector(".installed")?.textContent).toContain("installed");
    expect(button("review & install", card())).toBeUndefined();
    await act(async () => root.render(null));
    await renderGallery();
    expect(card().querySelector(".installed")).not.toBeNull();
    await click(button("uninstall", card()));
    expect(button("review & install", card())).toBeDefined();
  } finally { unsubscribe(); }
});

it("recognizes an installed tool-only package in chat and reacts when it is removed", async () => {
  versions.web = "0.1.0";
  await reloadConfig();
  await act(async () => root.render(React.createElement(InstallOffer, { content: "fez:install @fezchat/web", authorName: "fez", client })));
  expect(document.querySelector(".install-offer .installed")?.textContent).toBe("installed");
  versions = {};
  await act(async () => { await reloadConfig(); });
  expect(button("review & install")).toBeDefined();
});

it("opens the install review from the Web detail page", async () => {
  await renderGallery();
  await click(card().querySelector<HTMLButtonElement>(".gallery-main")!);
  await click(button("review & install"));
  expect(document.querySelector(".consent-modal")?.textContent).toContain("Web");
  await click(button("install & grant"));
  expect(button("uninstall")).toBeDefined();
});
