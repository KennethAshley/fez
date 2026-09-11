// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import SkillsView from "../../fez-desktop/src/SkillsView.js";
import type { FezClient } from "../../fez-client/src/index.js";
import type { BrowserWire } from "../../fez-desktop/src/wire.js";

let dom: JSDOM;
let root: ReturnType<typeof createRoot>;
let catalog: Record<string, Record<string, unknown>>;
let persona: string;
let relayFails = false;
let listings: unknown[] = [];
let secrets: Record<string, string>;
const published: unknown[] = [];
const wire = {
  query: async (filters: { kinds: number[] }[]) => { if (relayFails) throw Error("Relay unavailable"); return filters[0].kinds[0] === 40200 ? listings : []; },
  publish: async (event: unknown) => { published.push(event); },
} as unknown as BrowserWire;

beforeEach(() => {
  dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("localStorage", dom.window.localStorage);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  catalog = {};
  persona = "---\nharness: pi\n---\nResearch carefully.\n";
  relayFails = false;
  listings = [];
  secrets = {};
  published.length = 0;
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (cmd: string, args: Record<string, string> = {}) => {
    if (cmd === "read_skills") return JSON.stringify(catalog);
    if (cmd === "list_personas") return ["quill"];
    if (cmd === "read_persona") return persona;
    if (cmd === "update_persona") { persona = args.content; return; }
    if (cmd === "write_skill") { catalog[args.name] = JSON.parse(args.configJson); return; }
    if (cmd === "list_installed_skills") return "[]";
    if (cmd === "list_local_extensions") return [];
    if (cmd === "has_skill_secret") return !!secrets[`${args.skill}.${args.key}`];
    if (cmd === "set_skill_secret") { secrets[`${args.skill}.${args.key}`] = args.value; return; }
    if (["read_extension_grants", "read_extension_versions", "read_keymap"].includes(cmd)) return "{}";
    throw Error(`Unexpected native call: ${cmd}`);
  } } });
  vi.stubGlobal("fetch", async (url: string) => ({ ok: true, json: async () => url.includes("/-/v1/search") ? {
    objects: [{ package: { name: "@example/search", version: "1.0.0", description: "Search the web", publisher: { username: "example" } } }],
  } : {} }));
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(React.createElement(SkillsView, { only: "skills", client: {} as FezClient, wire })));
const button = (name: string) => [...document.querySelectorAll("button")].find(el => el.textContent?.trim() === name)!;
const click = (name: string) => act(async () => { expect(button(name), name).toBeDefined(); button(name).click(); });
const fill = (label: string, value: string) => act(async () => {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(input, label).not.toBeNull();
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
});

it("adds a package without relay listings, asks for review, and assigns it without publishing", async () => {
  await render();
  await click("Add tools");
  await click("Search packages");
  await click("use this…");
  expect(catalog).toEqual({});
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("npx -y @example/search");
  await click("Add tool");
  expect(catalog["@example/search"]).toMatchObject({ command: "npx", args: ["-y", "@example/search"], source: "npm:@example/search" });
  await click("@quill");
  expect(persona).toContain("mcpServers: [@example/search=npm:@example/search]");
  expect(published).toEqual([]);
});

it("validates a server source and prevents replacing a saved tool through Add tools", async () => {
  catalog = { search: { command: "existing" } };
  await render();
  await click("Add tools");
  await fill("Tool name", "search");
  await fill("Package or server URL", "https://tools.example/mcp");
  expect(button("Review setup").disabled).toBe(true);
  await fill("Tool name", "remote-search");
  await fill("Package or server URL", "https://user:secret@tools.example/mcp");
  expect(button("Review setup").disabled).toBe(true);
  await fill("Package or server URL", "https://tools.example/mcp");
  await click("Review setup");
  await click("Add tool");
  expect(catalog["remote-search"]).toMatchObject({ type: "http", url: "https://tools.example/mcp" });
  expect(catalog.search).toEqual({ command: "existing" });
});

it("keeps discovery usable when the relay fails and offers a retry", async () => {
  relayFails = true;
  await render();
  await click("Add tools");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Relay unavailable");
  expect(button("Search packages")).toBeDefined();
  relayFails = false;
  await click("Retry");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.body.textContent).toContain("No tools shared here yet");
});

it("configures missing credentials in the keychain and shares only setup when explicitly requested", async () => {
  catalog = { search: { command: "npx", args: ["-y", "@example/search"], env: { API_KEY: "" }, source: "npm:@example/search" } };
  persona = "---\nmcpServers: [web=npm:@example/search]\n---\nResearch.\n";
  await render();
  expect(document.querySelector(".tool-access")?.textContent).toContain("Assigned to @quill");
  expect(document.querySelector("summary")?.textContent).toContain("Needs setup");
  await fill("search API_KEY", "test-secret-value");
  await click("🔒 save");
  expect(secrets["search.API_KEY"]).toBe("test-secret-value");
  expect(catalog.search.env).toEqual({ API_KEY: "" });
  expect(document.querySelector("summary")?.textContent).toContain("Credentials saved");
  expect(published).toEqual([]);
  await click("Share tool setup");
  await fill("Tool description", "Search public pages");
  await click("Share tool setup");
  expect(published).toHaveLength(1);
  const event = published[0] as { kind: number; content: string };
  expect(event.kind).toBe(40200);
  expect(JSON.parse(event.content)).toMatchObject({ command: "npx", args: ["-y", "@example/search"], envKeys: ["API_KEY"] });
  expect(event.content).not.toContain("test-secret-value");
});

it("saves remote authentication as headers and does not offer agent listings as tools", async () => {
  catalog = { remote: { type: "http", url: "https://tools.example/mcp", headers: [] } };
  listings = [{ pubkey: "ab".repeat(32), created_at: 1, content: JSON.stringify({ name: "Other agent", artifact: "persona" }) }];
  await render();
  const input = document.querySelector<HTMLInputElement>(".tool-key-form input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "Authorization");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await click("Add credential");
  expect(catalog.remote.headers).toEqual([{ name: "Authorization", value: "" }]);
  await fill("remote Authorization", "Bearer test-token");
  await click("🔒 save");
  expect(secrets["remote.Authorization"]).toBe("Bearer test-token");
  expect(JSON.stringify(catalog)).not.toContain("test-token");
  await click("Add tools");
  expect(document.body.textContent).not.toContain("Other agent");
});

it("removes an old plaintext header after saving a replacement so runtime uses the keychain", async () => {
  catalog = { remote: { type: "http", url: "https://tools.example/mcp", headers: [{ name: "Authorization", value: "Bearer old-test-token" }] } };
  await render();
  await fill("remote Authorization", "Bearer replacement-test-token");
  await click("🔒 save");
  expect(secrets["remote.Authorization"]).toBe("Bearer replacement-test-token");
  expect(catalog.remote.headers).toEqual([{ name: "Authorization", value: "" }]);
});
